import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { Hub } from "../src/hub.ts";
import { startWebServer } from "../src/web/server.ts";
import { makeRepo } from "./helpers.ts";

process.env.AGENT_COMPANY_FAKE = "1";

interface Ctx {
  base: string;
  token: string;
  hub: Hub;
  repo: string;
  post(path: string, body?: unknown): Promise<Response>;
  get(path: string): Promise<Response>;
}

async function withWeb(run: (ctx: Ctx) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ac-web-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  makeRepo(repo);
  const hub = new Hub({
    adapters: { claude: fakeAdapter("claude"), codex: fakeAdapter("codex"), opencode: fakeAdapter("opencode") },
    home: join(dir, "home"),
    apiAdapterFactory: (provider, model) => fakeAdapter(`api:${provider.id}${model ? `:${model}` : ""}`),
  });
  const web = await startWebServer({ hub, port: 0 });
  const base = web.url.split("/?")[0];
  const headers = { "content-type": "application/json" };
  try {
    await run({
      base,
      token: web.token,
      hub,
      repo,
      post: (path, body = {}) => fetch(`${base}${path}?t=${web.token}`, { method: "POST", headers, body: JSON.stringify(body) }),
      get: (path) => fetch(`${base}${path}${path.includes("?") ? "&" : "?"}t=${web.token}`),
    });
  } finally {
    await hub.stop();
    await web.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor(check: () => boolean, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(check(), "condition not met in time");
}

test("web: rejects requests without the token", async () => {
  await withWeb(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  });
});

test("web: serves the page, sets a cookie, and the cookie authorises the API", async () => {
  await withWeb(async ({ base, token }) => {
    const page = await fetch(`${base}/?t=${token}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /agent-company/);
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^ac_token=/);
    const state = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(state.status, 200);
    assert.equal(((await state.json()) as any).active, null);
  });
});

test("web: refuses non-loopback hosts unless LAN is explicitly allowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-web-"));
  const hub = new Hub({ adapters: {}, home: dir });
  try {
    await assert.rejects(startWebServer({ hub, host: "0.0.0.0", port: 0 }), /allow-lan/);
    const web = await startWebServer({ hub, host: "0.0.0.0", port: 0, allowLan: true });
    assert.equal((await fetch(web.url.replace("/?t=", "/api/state?t="))).status, 200);
    assert.equal((await fetch(web.url.split("/?")[0] + "/api/state")).status, 401);
    await web.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("web: setup preview recommends a preset and returns a charter", async () => {
  await withWeb(async ({ post }) => {
    const res = await post("/api/setup/preview", { goal: "API、画面、テスト、文書、CI、移行", rootCli: "claude", childClis: ["claude", "codex"] });
    const body = (await res.json()) as any;
    assert.equal(res.status, 200);
    assert.equal(body.recommended, "standard");
    assert.equal(body.charter.limits.maxDepth, 2);
    assert.match(body.toml, /max_depth = 2/);
    const manual = (await (await post("/api/setup/preview", { goal: "x", rootCli: "claude", preset: "light", maxDepth: 3 })).json()) as any;
    assert.equal(manual.charter.limits.maxDepth, 3);
  });
});

test("web: a session starts from the setup form, runs the goal, stops, and can be replayed", async () => {
  await withWeb(async ({ post, get, hub, repo }) => {
    const started = await post("/api/session/start", {
      repo, rootCli: "claude", childClis: ["claude"], preset: "light", goal: "FAKE: spawn claude FAKE: say kid\\nFAKE: wait\nFAKE: say done-root",
    });
    assert.equal(started.status, 200);
    await waitFor(() => hub.active!.orch.bus.history.some((e) => e.type === "chat.reply"));
    const state = (await (await get("/api/state")).json()) as any;
    assert.equal(state.active.rootCli, "claude");
    assert.equal(state.nodes.length, 2);
    assert.equal((await post("/api/session/start", { repo, rootCli: "claude" })).status, 400);
    const id = state.active.id;
    assert.equal((await post("/api/session/stop")).status, 200);
    const past = (await (await get(`/api/sessions/${id}/events`)).json()) as any;
    assert.ok(past.events.some((e: any) => e.type === "chat.reply"));
    assert.equal(past.meta.active, false);
    assert.equal(((await (await get("/api/state")).json()) as any).sessions.length, 1);
  });
});

test("web: bad or non-git folders are rejected, and non-git can be allowed explicitly", async () => {
  await withWeb(async ({ post, repo }) => {
    assert.equal((await post("/api/session/start", { repo: join(repo, "nope"), rootCli: "claude" })).status, 400);
    const plain = join(repo, "..", "plain");
    mkdirSync(plain);
    const refused = await post("/api/session/start", { repo: plain, rootCli: "claude" });
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as any).needsGit, true);
    assert.equal((await post("/api/session/start", { repo: plain, rootCli: "claude", allowNonGit: true })).status, 200);
  });
});

test("web: chat reaches the event stream", async () => {
  await withWeb(async ({ base, token, post, repo }) => {
    await post("/api/session/start", { repo, rootCli: "claude", preset: "light" });
    const stream = await fetch(`${base}/events?t=${token}`);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    assert.equal((await post("/api/chat", { text: "FAKE: say hello-from-root" })).status, 202);
    const deadline = Date.now() + 15000;
    while (!seen.includes("chat.reply") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    await reader.cancel();
    assert.match(seen, /event: hub/);
    assert.match(seen, /hello-from-root/);
  });
});

test("web: chat without a session is a 409, empty text a 400, unknown node a 404", async () => {
  await withWeb(async ({ post, repo }) => {
    assert.equal((await post("/api/chat", { text: "hi" })).status, 409);
    await post("/api/session/start", { repo, rootCli: "claude", preset: "light" });
    assert.equal((await post("/api/chat", {})).status, 400);
    assert.equal((await post("/api/node/nope/stop")).status, 404);
  });
});

test("web: api providers are stored without leaking the key, usable as engines, and deletable", async () => {
  await withWeb(async ({ post, get, repo, hub }) => {
    const saved = (await (await post("/api/providers", {
      name: "My Proxy", baseUrl: "https://example.test/v1/", apiKey: "sk-test-secret-123456", models: "gpt-x, gpt-y",
    })).json()) as any;
    assert.equal(saved.provider.id, "my-proxy");
    assert.equal(saved.provider.hasKey, true);
    assert.equal(saved.provider.baseUrl, "https://example.test/v1");
    assert.equal(saved.provider.defaultModel, "gpt-x");
    const state = JSON.stringify(await (await get("/api/state")).json());
    const providers = JSON.stringify(await (await get("/api/providers")).json());
    assert.ok(!state.includes("sk-test-secret-123456"));
    assert.ok(!providers.includes("sk-test-secret-123456"));
    assert.equal(hub.settings().providers[0].apiKey, "sk-test-secret-123456");

    const engines = (await (await get("/api/engines")).json()) as any;
    assert.ok(engines.engines.some((e: any) => e.name === "api:my-proxy" && e.available));

    const started = await post("/api/session/start", { repo, rootCli: "api:my-proxy", childClis: ["api:my-proxy:gpt-y"], preset: "light" });
    assert.equal(started.status, 200);
    await post("/api/session/stop");

    await post("/api/providers", { id: "my-proxy", name: "My Proxy", baseUrl: "https://example.test/v1", models: ["gpt-x"] });
    assert.equal(hub.settings().providers[0].apiKey, "sk-test-secret-123456");
    assert.equal((await post("/api/providers", { name: "bad", baseUrl: "not a url" })).status, 400);
    await post("/api/providers/delete", { id: "my-proxy" });
    assert.equal(hub.settings().providers.length, 0);
    assert.equal((await post("/api/session/start", { repo, rootCli: "api:my-proxy", preset: "light" })).status, 400);
  });
});

test("web: provider test lists models and reports bad keys", async () => {
  const upstream = createServer((req, res) => {
    const ok = req.headers.authorization === "Bearer good-key";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(ok ? JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }) : "{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  try {
    await withWeb(async ({ post }) => {
      const good = (await (await post("/api/providers/test", { baseUrl, apiKey: "good-key" })).json()) as any;
      assert.equal(good.ok, true);
      assert.deepEqual(good.models, ["m1", "m2"]);
      const bad = (await (await post("/api/providers/test", { baseUrl, apiKey: "nope" })).json()) as any;
      assert.equal(bad.ok, false);
      assert.match(bad.error, /APIキー/);
      const down = (await (await post("/api/providers/test", { baseUrl: "http://127.0.0.1:9/v1" })).json()) as any;
      assert.equal(down.ok, false);
    });
  } finally {
    upstream.closeAllConnections();
    upstream.close();
  }
});
