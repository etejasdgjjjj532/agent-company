import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { claudeAdapter } from "../src/adapters/claude.ts";
import { codexAdapter } from "../src/adapters/codex.ts";
import { geminiAdapter } from "../src/adapters/gemini.ts";
import { opencodeAdapter } from "../src/adapters/opencode.ts";
import type { Adapter, RunOptions } from "../src/adapters/types.ts";
import { buildCharter, parseCharter, serializeCharter, validateCharter } from "../src/core/charter.ts";
import { DEFAULT_ENGINE, normalizeEngine, normalizeMcp, type EngineSettings } from "../src/core/engines.ts";
import { Hub } from "../src/hub.ts";
import { startWebServer } from "../src/web/server.ts";
import { makeRepo, rmrf } from "./helpers.ts";

process.env.AGENT_COMPANY_FAKE = "1";

function spy(name: string): { adapter: Adapter; calls: RunOptions[] } {
  const base = fakeAdapter(name);
  const calls: RunOptions[] = [];
  return { adapter: { ...base, invoke: (opts) => (calls.push(opts), base.invoke(opts)) }, calls };
}

async function withHub(run: (ctx: { hub: Hub; repo: string; calls: RunOptions[]; dir: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ac-feat-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  makeRepo(repo);
  const claude = spy("claude");
  const hub = new Hub({ adapters: { claude: claude.adapter, codex: fakeAdapter("codex"), opencode: fakeAdapter("opencode") }, home: join(dir, "home") });
  try {
    await run({ hub, repo, calls: claude.calls, dir });
  } finally {
    await hub.stop();
    rmrf(dir);
  }
}

test("normal mode charter validates, round-trips and has no spawn rights", () => {
  const c = buildCharter({ rootCli: "claude", mode: "normal" });
  validateCharter(c);
  assert.equal(c.mode, "normal");
  assert.deepEqual(parseCharter(serializeCharter(c)), c);
  assert.equal(c.limits.levels[0].canSpawn, false);
});

test("normal mode: the root works directly with worker rights and no orchestration tools", async () => {
  await withHub(async ({ hub, repo, calls }) => {
    await hub.start({ repoDir: repo, charter: buildCharter({ rootCli: "claude", mode: "normal" }) });
    const reply = await hub.active!.orch.chat("FAKE: say normal-ok");
    assert.equal(reply, "normal-ok");
    assert.equal(calls[0].profile, "worker");
    assert.equal(calls[0].mcpUrl, undefined);
    assert.equal(calls[0].cwd, repo);
    assert.deepEqual(hub.active!.orch.toolsFor(hub.active!.orch.registry.get("root")!.token)!.map((t) => t.name), ["report"]);
    assert.equal(hub.activeMeta!.mode, "normal");
  });
});

test("switching modes: blocked while children run, announced to the root, persisted and restored", async () => {
  await withHub(async ({ hub, repo, calls }) => {
    const meta = await hub.start({ repoDir: repo, charter: buildCharter({ rootCli: "claude", childClis: ["claude"], preset: "light" }) });
    const orch = hub.active!.orch;
    await orch.chat("FAKE: say warmup");
    const token = orch.registry.get("root")!.token;
    const child = JSON.parse((await orch.call(token, "spawn_child", { cli: "claude", task: "FAKE: sleep 1500" })).text);
    assert.throws(() => hub.setMode("normal"), /通常モード/);
    await orch.call(token, "wait_children", {});
    hub.setMode("normal");
    assert.equal(orch.mode, "normal");
    assert.equal(hub.activeMeta!.mode, "normal");
    assert.match(readFileSync(join(hub.active!.runDir, "charter.toml"), "utf8"), /mode = "normal"/);
    await orch.chat("FAKE: say first");
    assert.match(calls.at(-1)!.prompt, /Mode switched to NORMAL/);
    assert.equal(calls.at(-1)!.profile, "worker");
    await orch.chat("FAKE: say second");
    assert.doesNotMatch(calls.at(-1)!.prompt, /Mode switched/);
    hub.setMode("multi");
    await orch.chat("FAKE: say third");
    assert.match(calls.at(-1)!.prompt, /MULTI-AGENT/);
    assert.equal(calls.at(-1)!.profile, "root");
    assert.ok(orch.registry.get(child.id));
    hub.setMode("normal");
    await hub.stop();
    const again = await hub.resume(meta.id);
    assert.equal(again.mode, "normal");
    assert.equal(hub.active!.orch.mode, "normal");
  });
});

test("engine settings normalise, validate and reject reserved or duplicate MCP names", () => {
  assert.deepEqual(normalizeEngine({}), DEFAULT_ENGINE);
  const e = normalizeEngine({ enabled: false, model: " m ", permission: "extended", allowWeb: true, mcpServers: [{ name: "docs", url: "https://x.test/mcp" }, { name: "fs", command: "npx", args: "-y srv" }] });
  assert.equal(e.enabled, false);
  assert.equal(e.model, "m");
  assert.deepEqual(e.mcpServers[1], { name: "fs", command: "npx", args: ["-y", "srv"] });
  assert.throws(() => normalizeMcp({ name: "orch", url: "https://x.test" }), /予約/);
  assert.throws(() => normalizeMcp({ name: "a", url: "ftp://x" }));
  assert.throws(() => normalizeMcp({ name: "a" }));
  assert.throws(() => normalizeEngine({ mcpServers: [{ name: "a", url: "https://x.test" }, { name: "A", url: "https://y.test" }] }), /重複/);
  assert.equal(normalizeEngine({ permission: "bogus" }).permission, "standard");
});

test("engine settings reach the agent: instructions in the prompt, settings in the options, disabled engines refuse", async () => {
  await withHub(async ({ hub, repo, calls }) => {
    hub.saveEngine("claude", { model: "special-model", instructions: "Always answer in haiku.", permission: "readonly" });
    await hub.start({ repoDir: repo, charter: buildCharter({ rootCli: "claude", childClis: ["claude", "codex"], preset: "light" }) });
    const orch = hub.active!.orch;
    await orch.chat("FAKE: say hi");
    assert.match(calls[0].prompt, /Always answer in haiku\./);
    assert.equal(calls[0].engine!.model, "special-model");
    assert.equal(calls[0].engine!.permission, "readonly");
    hub.saveEngine("codex", { enabled: false });
    const blocked = await orch.call(orch.registry.get("root")!.token, "spawn_child", { cli: "codex", task: "x" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /無効/);
    hub.saveEngine("claude", { enabled: false });
    await assert.rejects(orch.chat("hello"), /無効/);
    assert.throws(() => hub.saveEngine("nope", {}));
  });
});

test("adapters turn engine settings into model, permission, web and MCP options", () => {
  const engine: EngineSettings = { enabled: true, model: "m-1", instructions: "", permission: "extended", allowWeb: true, mcpServers: [{ name: "docs", url: "https://x.test/mcp" }, { name: "fs", command: "npx", args: ["-y", "srv"] }] };
  const base = { cwd: ".", prompt: "p", profile: "worker" as const, workDir: mkdtempSync(join(tmpdir(), "ac-ad-")), engine };
  try {
    const c = claudeAdapter("claude").invoke(base);
    assert.equal(c.args[c.args.indexOf("--model") + 1], "m-1");
    const tools = c.args[c.args.indexOf("--allowedTools") + 1];
    assert.match(tools, /(^|,)Bash(,|$)/);
    assert.match(tools, /mcp__docs/);
    assert.match(tools, /WebFetch/);
    assert.ok(!c.args.includes("--disallowedTools"));
    const mcpFile = JSON.parse(readFileSync(c.args[c.args.indexOf("--mcp-config") + 1], "utf8"));
    assert.deepEqual(mcpFile.mcpServers.fs, { type: "stdio", command: "npx", args: ["-y", "srv"] });
    const ro = claudeAdapter("claude").invoke({ ...base, engine: { ...engine, permission: "readonly", allowWeb: false, mcpServers: [] } });
    assert.ok(!/Edit/.test(ro.args[ro.args.indexOf("--allowedTools") + 1]));
    assert.ok(ro.args.includes("--disallowedTools"));

    const x = codexAdapter("codex").invoke(base);
    assert.ok(x.args.includes('sandbox_mode="workspace-write"'));
    assert.ok(x.args.includes("sandbox_workspace_write.network_access=true"));
    assert.ok(x.args.includes('mcp_servers.docs.url="https://x.test/mcp"'));
    assert.ok(x.args.includes('mcp_servers.fs.command="npx"'));
    assert.ok(x.args.includes('mcp_servers.fs.args=["-y","srv"]'));
    assert.equal(x.args[x.args.indexOf("-m") + 1], "m-1");
    assert.ok(codexAdapter("codex").invoke({ ...base, engine: { ...engine, permission: "readonly" } }).args.includes('sandbox_mode="read-only"'));

    const o = opencodeAdapter("opencode").invoke(base);
    const ocfg = JSON.parse(readFileSync(o.env.OPENCODE_CONFIG, "utf8"));
    assert.equal(ocfg.permission.webfetch, "allow");
    assert.equal(ocfg.permission.edit, "allow");
    assert.deepEqual(ocfg.mcp.fs.command, ["npx", "-y", "srv"]);
    assert.equal(ocfg.mcp.docs.type, "remote");
    assert.equal(o.args[o.args.indexOf("--model") + 1], "m-1");

    const g = geminiAdapter("gemini").invoke(base);
    const gcfg = JSON.parse(readFileSync(g.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8"));
    assert.deepEqual(gcfg.tools.exclude, []);
    assert.equal(gcfg.mcpServers.docs.httpUrl, "https://x.test/mcp");
    assert.equal(g.args[g.args.indexOf("-m") + 1], "m-1");
  } finally {
    rmrf(base.workDir);
  }
});

async function withWeb(run: (c: { call: (path: string, body?: unknown) => Promise<any>; hub: Hub; repo: string }) => Promise<void>) {
  await withHub(async ({ hub, repo }) => {
    const web = await startWebServer({ hub, port: 0 });
    const root = web.url.split("/?")[0];
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${root}${path}${path.includes("?") ? "&" : "?"}t=${web.token}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, ...((await res.json()) as object) } as any;
    };
    try {
      await run({ call, hub, repo });
    } finally {
      await web.close();
    }
  });
}

test("web: mode switch, engine settings and templates work through the API", async () => {
  await withWeb(async ({ call, repo, hub }) => {
    const started = await call("/api/session/start", { repo, rootCli: "claude", mode: "normal" });
    assert.equal(started.meta.mode, "normal");
    assert.equal((await call("/api/session/mode", { mode: "multi" })).meta.mode, "multi");
    const saved = await call("/api/engines/settings", { name: "claude", model: "x", instructions: "be brief", permission: "extended" });
    assert.equal(saved.settings.permission, "extended");
    const list = await call("/api/engines/settings");
    assert.equal(list.engines.find((e: any) => e.name === "claude").settings.model, "x");
    assert.equal((await call("/api/engines/settings", { name: "zzz" })).status, 400);
    await call("/api/engines/settings", { name: "codex", enabled: false });
    const engines = await call("/api/engines");
    assert.equal(engines.engines.find((e: any) => e.name === "codex").available, false);
    const tpl = await call("/api/templates", { name: "Review team", rootCli: "claude", childClis: ["claude", "bogus"], preset: "standard", goal: "review the diff" });
    assert.deepEqual(tpl.template.childClis, ["claude"]);
    assert.equal((await call("/api/templates")).templates.length, 1);
    await call("/api/templates/delete", { id: tpl.template.id });
    assert.equal(hub.settings().templates.length, 0);
    assert.equal((await call("/api/templates", { name: "", rootCli: "claude" })).status, 400);
  });
});

test("web: session search, diff viewer data and the file browser (with traversal protection)", async () => {
  await withWeb(async ({ call, repo, hub }) => {
    await call("/api/session/start", { repo, rootCli: "claude", childClis: ["claude"], preset: "light" });
    const orch = hub.active!.orch;
    await orch.chat("FAKE: spawn claude FAKE: write note.txt hello-diff\nFAKE: wait\nFAKE: say needle-in-haystack");
    const found = await call("/api/search?q=NEEDLE");
    assert.ok(found.results.some((r: any) => r.snippet.includes("needle-in-haystack")));
    assert.deepEqual((await call("/api/search?q=")).results, []);
    const diff = await call("/api/diff?node=c1");
    assert.match(diff.diff, /note\.txt/);
    assert.match(diff.diff, /\+hello-diff/);
    assert.equal((await call("/api/diff?node=root")).status, 400);
    const files = await call("/api/files");
    assert.ok(files.files.includes("README.md"));
    assert.match((await call("/api/file?path=README.md")).text, /hello/);
    assert.equal((await call("/api/file?path=../../etc/passwd")).status, 400);
    assert.equal((await call("/api/file?path=" + encodeURIComponent(join(repo, "..", "..", "etc", "hosts")))).status, 400);
    writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2]));
    assert.equal((await call("/api/file?path=bin.dat")).binary, true);
  });
});
