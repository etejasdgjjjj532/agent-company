import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCharter, PRESETS, recommendPreset, serializeCharter, validateCharter, type PresetName } from "../core/charter.ts";
import type { OrchEvent } from "../core/events.ts";
import { isGitRepo } from "../core/worktree.ts";
import { detectClis, runDoctor } from "../doctor.ts";
import type { Hub } from "../hub.ts";
import { PROVIDER_PRESETS, isKnownEngine, engineName, parseEngine, toPublic } from "../core/providers.ts";
import { describeCharter, heuristicTasks, makeAdvisor, type ScaleAdvice } from "../secretary.ts";

const PUBLIC = new URL("./public/", import.meta.url);
const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

export interface WebOptions {
  hub: Hub;
  host?: string;
  port?: number;
  allowLan?: boolean;
  token?: string;
}

export interface WebHandle {
  server: Server;
  url: string;
  token: string;
  close(): Promise<void>;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 200_000) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function repoInfo(path: string): { exists: boolean; isGit: boolean; resolved: string } {
  const resolved = resolve(path);
  const exists = existsSync(resolved) && statSync(resolved).isDirectory();
  return { exists, isGit: exists && isGitRepo(resolved), resolved };
}

async function testProvider(
  input: { baseUrl: string; apiKey?: string; apiKeyEnv?: string },
): Promise<{ ok: boolean; status?: number; models: string[]; error?: string }> {
  const key = input.apiKey || (input.apiKeyEnv ? process.env[input.apiKeyEnv] : undefined);
  try {
    const url = `${input.baseUrl.replace(/\/+$/, "")}/models`;
    const res = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? "APIキーが違うか、権限がありません" : `HTTP ${res.status}`;
      return { ok: false, status: res.status, models: [], error: hint };
    }
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
    const models = (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).slice(0, 200);
    return { ok: true, status: res.status, models };
  } catch (error: any) {
    return { ok: false, models: [], error: `接続できません: ${error?.cause?.code ?? error?.message ?? error}` };
  }
}

interface SetupInput {
  goal: string;
  rootCli: string;
  childClis: string[];
  preset?: PresetName;
  maxDepth?: number;
  maxConcurrent?: number;
}

function parseSetup(body: Record<string, any>, available: string[]): SetupInput {
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(isKnownEngine) : []);
  const rootCli = typeof body.rootCli === "string" && isKnownEngine(body.rootCli) ? body.rootCli : (available[0] ?? "claude");
  const childClis = list(body.childClis);
  const int = (value: unknown) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined);
  const preset = typeof body.preset === "string" && body.preset in PRESETS ? (body.preset as PresetName) : undefined;
  return {
    goal: String(body.goal ?? ""),
    rootCli,
    childClis: childClis.length > 0 ? childClis : [rootCli],
    preset,
    maxDepth: int(body.maxDepth),
    maxConcurrent: int(body.maxConcurrent),
  };
}

export async function startWebServer(options: WebOptions): Promise<WebHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host) && !options.allowLan) {
    throw new Error(`refusing to listen on ${host}: pass --allow-lan to expose the UI to the network (traffic is not encrypted)`);
  }
  const hub = options.hub;
  const token = options.token ?? randomBytes(24).toString("hex");
  const clients = new Set<ServerResponse>();
  let unsubscribe: (() => void) | null = null;

  const sendEvent = (res: ServerResponse, event: OrchEvent) => {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const sendHub = (res: ServerResponse) => {
    res.write(`event: hub\ndata: ${JSON.stringify({ active: hub.activeMeta })}\n\n`);
  };
  const attach = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (hub.active) {
      unsubscribe = hub.active.orch.bus.subscribe((event) => {
        for (const client of clients) sendEvent(client, event);
      });
    }
  };
  const onSession = () => {
    attach();
    for (const client of clients) sendHub(client);
  };
  hub.on("session", onSession);
  attach();

  const authorised = (req: IncomingMessage, url: URL): boolean => {
    const supplied = url.searchParams.get("t") ?? cookie(req, "ac_token") ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
    return typeof supplied === "string" && safeEqual(supplied, token);
  };

  const treeBody = () => {
    const orch = hub.active?.orch;
    return {
      active: hub.activeMeta,
      nodes: orch?.tree() ?? [],
      approvals: orch?.pendingApprovals() ?? [],
      charter: orch ? { name: orch.charter.name, maxDepth: orch.charter.limits.maxDepth, maxConcurrent: orch.charter.maxConcurrent } : null,
      settings: hub.publicSettings(),
      sessions: hub.sessions(),
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const allowedHost = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (isLoopback(host) && !isLoopback(allowedHost)) return json(res, 403, { error: "bad host" });
    if (!authorised(req, url)) return json(res, 401, { error: "missing or wrong token; open the URL printed at startup" });
    const setCookie = url.searchParams.get("t") ? { "set-cookie": `ac_token=${token}; Path=/; HttpOnly; SameSite=Strict` } : {};

    try {
      if (req.method === "GET" && ASSETS[url.pathname]) {
        const asset = ASSETS[url.pathname];
        res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store", ...setCookie });
        return void res.end(readFileSync(fileURLToPath(new URL(asset.file, PUBLIC))));
      }
      if (req.method === "GET") {
        if (url.pathname === "/api/tree" || url.pathname === "/api/state") return json(res, 200, treeBody());
        if (url.pathname === "/api/providers") {
          return json(res, 200, { providers: hub.publicSettings().providers, presets: PROVIDER_PRESETS });
        }
        if (url.pathname === "/api/engines") {
          const clis = detectClis();
          const opencodeReady = clis.includes("opencode");
          const engines = [
            ...clis.map((name) => ({ name, label: name, kind: "cli", available: true })),
            ...hub.settings().providers.map((p) => ({
              name: engineName(p.id),
              label: `${p.name} (API${p.defaultModel ? `: ${p.defaultModel}` : ""})`,
              kind: "api",
              available: opencodeReady,
              reason: opencodeReady ? undefined : "API を使うには opencode が必要です",
            })),
          ];
          return json(res, 200, { engines, opencodeReady });
        }
        if (url.pathname === "/api/doctor") {
          const checks = runDoctor();
          return json(res, 200, { checks, available: detectClis() });
        }
        if (url.pathname === "/api/repo") return json(res, 200, repoInfo(url.searchParams.get("path") ?? ""));
        const past = /^\/api\/sessions\/([\w-]+)\/events$/.exec(url.pathname);
        if (past) return json(res, 200, { events: hub.readEvents(past[1]), meta: hub.sessions().find((s) => s.id === past[1]) ?? null });
        if (url.pathname === "/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", ...setCookie });
          sendHub(res);
          const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0);
          for (const event of hub.active?.orch.bus.history ?? []) if (event.seq > since) sendEvent(res, event);
          clients.add(res);
          const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
          req.on("close", () => {
            clearInterval(ping);
            clients.delete(res);
          });
          return;
        }
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        if (url.pathname === "/api/settings") {
          hub.saveSettings({ terms: body.terms === "company" ? "company" : "tech" });
          return json(res, 200, hub.publicSettings());
        }
        if (url.pathname === "/api/providers") {
          return json(res, 200, { provider: hub.saveProvider(body) });
        }
        if (url.pathname === "/api/providers/delete") {
          hub.deleteProvider(String(body.id ?? ""));
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/api/providers/test") {
          const stored = typeof body.id === "string" ? hub.settings().providers.find((p) => p.id === body.id) : undefined;
          const baseUrl = String(body.baseUrl ?? stored?.baseUrl ?? "");
          if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: "Base URL が正しくありません" });
          const typed = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
          const result = await testProvider({
            baseUrl,
            apiKey: typed ?? (typeof body.apiKeyEnv === "string" && body.apiKeyEnv ? undefined : stored?.apiKey),
            apiKeyEnv: (typeof body.apiKeyEnv === "string" && body.apiKeyEnv) || stored?.apiKeyEnv,
          });
          return json(res, 200, result);
        }
        if (url.pathname === "/api/setup/preview") {
          const available = detectClis();
          const setup = parseSetup(body, available.length > 0 ? available : ["claude"]);
          let advice: ScaleAdvice | null = null;
          if (body.advise === true && setup.goal.trim()) {
            advice = await makeAdvisor(hub.adapters, process.cwd(), join(hub.home, "advisor"))!(setup.goal, setup.rootCli).catch(() => null);
          }
          const tasks = advice?.independentTasks ?? heuristicTasks(setup.goal);
          const recommended = recommendPreset(tasks);
          const charter = buildCharter({ ...setup, preset: setup.preset ?? recommended });
          validateCharter(charter);
          return json(res, 200, { tasks, recommended, advice, charter, toml: serializeCharter(charter), tree: describeCharter(charter) });
        }
        if (url.pathname === "/api/session/start") {
          const info = repoInfo(String(body.repo ?? ""));
          if (!info.exists) return json(res, 400, { error: "そのフォルダは見つかりません" });
          if (!info.isGit && body.allowNonGit !== true) return json(res, 400, { error: "git リポジトリではありません。git init するか、非 git での実行を許可してください", needsGit: true });
          const setup = parseSetup(body, detectClis());
          const charter = buildCharter({ ...setup, preset: setup.preset ?? recommendPreset(heuristicTasks(setup.goal)) });
          validateCharter(charter);
          for (const cli of new Set([setup.rootCli, ...setup.childClis])) {
            if (!hub.adapters[cli]) return json(res, 400, { error: `${cli} のアダプタがありません` });
          }
          if (body.saveCharter === true) await import("node:fs").then((fs) => fs.writeFileSync(join(info.resolved, "agent-company.toml"), serializeCharter(charter)));
          const meta = await hub.start({ repoDir: info.resolved, charter, name: typeof body.name === "string" && body.name ? body.name : undefined });
          const goal = setup.goal.trim();
          if (goal) void hub.active!.orch.chat(goal).catch((error) => hub.active?.orch.bus.emit("chat.error", "root", { message: String(error?.message ?? error) }));
          return json(res, 200, { meta });
        }
        if (url.pathname === "/api/session/stop") {
          await hub.stop();
          return json(res, 200, { ok: true });
        }
        const orch = hub.active?.orch;
        if (!orch) return json(res, 409, { error: "セッションが開始されていません" });
        if (url.pathname === "/api/chat") {
          const text = String(body.text ?? "").trim();
          if (!text) return json(res, 400, { error: "text is required" });
          void orch.chat(text).catch((error) => orch.bus.emit("chat.error", "root", { message: String(error?.message ?? error) }));
          return json(res, 202, { accepted: true });
        }
        const nodeMatch = /^\/api\/node\/([^/]+)\/(stop|message)$/.exec(url.pathname);
        if (nodeMatch) {
          const id = decodeURIComponent(nodeMatch[1]);
          if (!orch.registry.get(id)) return json(res, 404, { error: "unknown node" });
          if (nodeMatch[2] === "stop") {
            orch.stopNode(id);
            return json(res, 202, { accepted: true });
          }
          const text = String(body.text ?? "").trim();
          if (!text) return json(res, 400, { error: "text is required" });
          orch.messageNode(id, text).catch((error) => orch.bus.emit("chat.error", id, { message: String(error?.message ?? error) }));
          return json(res, 202, { accepted: true });
        }
        const approval = /^\/api\/approval\/([^/]+)$/.exec(url.pathname);
        if (approval) {
          const ok = orch.resolveApproval(decodeURIComponent(approval[1]), body.approved === true);
          return json(res, ok ? 200 : 404, { ok });
        }
      }
      return json(res, 404, { error: "not found" });
    } catch (error: any) {
      return json(res, 400, { error: String(error?.message ?? error) });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 0;
  const display = host === "::1" ? "[::1]" : host === "0.0.0.0" ? "localhost" : host;
  return {
    server,
    token,
    url: `http://${display}:${port}/?t=${token}`,
    async close() {
      hub.off("session", onSession);
      unsubscribe?.();
      for (const client of clients) client.end();
      clients.clear();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
