import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { opencodeAdapter } from "./adapters/opencode.ts";
import type { Adapter } from "./adapters/types.ts";
import { createSession, type Session } from "./app.ts";
import { parseCharter, serializeCharter, type Charter, type PresetName, type SessionMode } from "./core/charter.ts";
import { normalizeEngine, type EngineSettings } from "./core/engines.ts";
import { isGitRepo, git } from "./core/worktree.ts";
import type { OrchEvent } from "./core/events.ts";
import { dataHome } from "./core/platform.ts";
import { isKnownEngine, normalizeProvider, parseEngine, slugify, toPublic, type ApiProvider, type PublicProvider } from "./core/providers.ts";
import { readJsonl } from "./core/store.ts";

export interface SessionMeta {
  id: string;
  name: string;
  repoDir: string;
  rootCli: string;
  mode?: SessionMode;
  startedAt: number;
  endedAt?: number;
  active: boolean;
}

export interface Template {
  id: string;
  name: string;
  mode: SessionMode;
  rootCli: string;
  childClis: string[];
  preset?: PresetName;
  maxDepth?: number;
  maxConcurrent?: number;
  goal?: string;
}

export interface Settings {
  engines: Record<string, Partial<EngineSettings>>;
  templates: Template[];
  terms: "tech" | "company";
  recentProjects: string[];
  providers: ApiProvider[];
}

export interface HubOptions {
  adapters: Record<string, Adapter>;
  apiAdapterFactory?: (provider: ApiProvider, model?: string) => Adapter;
  home?: string;
}

export class Hub extends EventEmitter {
  readonly adapters: Record<string, Adapter>;
  readonly home: string;
  active: Session | null = null;
  activeMeta: SessionMeta | null = null;

  constructor(options: HubOptions) {
    super();
    const base = options.adapters;
    this.adapters = new Proxy(base, {
      get: (target, prop) => {
        if (typeof prop !== "string") return undefined;
        if (prop in target) return target[prop];
        const engine = parseEngine(prop);
        if (!engine || engine.kind !== "api") return undefined;
        const provider = this.settings().providers.find((p) => p.id === engine.providerId);
        if (!provider) return undefined;
        if (options.apiAdapterFactory) return options.apiAdapterFactory(provider, engine.model);
        return opencodeAdapter(undefined, { provider, model: engine.model });
      },
    });
    this.home = options.home ?? dataHome();
    mkdirSync(join(this.home, "runs"), { recursive: true });
  }

  private settingsFile(): string {
    return join(this.home, "settings.json");
  }

  settings(): Settings {
    try {
      const raw = JSON.parse(readFileSync(this.settingsFile(), "utf8")) as Partial<Settings>;
      return {
        terms: raw.terms === "company" ? "company" : "tech",
        recentProjects: (raw.recentProjects ?? []).slice(0, 12),
        providers: Array.isArray(raw.providers) ? raw.providers : [],
        engines: raw.engines && typeof raw.engines === "object" ? raw.engines : {},
        templates: Array.isArray(raw.templates) ? raw.templates : [],
      };
    } catch {
      return { terms: "tech", recentProjects: [], providers: [], engines: {}, templates: [] };
    }
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch };
    if (next.terms !== "company") next.terms = "tech";
    next.recentProjects = [...new Set(next.recentProjects)].slice(0, 12);
    writeFileSync(this.settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  }

  publicSettings(): Omit<Settings, "providers"> & { providers: PublicProvider[] } {
    const settings = this.settings();
    return { ...settings, providers: settings.providers.map(toPublic) };
  }

  saveProvider(input: Record<string, unknown>): PublicProvider {
    const settings = this.settings();
    const wanted = typeof input.id === "string" ? input.id : "";
    const existing = settings.providers.find((p) => p.id === wanted);
    const provider = normalizeProvider(input, existing);
    if (!existing && settings.providers.some((p) => p.id === provider.id)) {
      throw new Error(`同じ ID (${provider.id}) のプロバイダが既にあります`);
    }
    const providers = existing ? settings.providers.map((p) => (p.id === provider.id ? provider : p)) : [...settings.providers, provider];
    this.saveSettings({ providers });
    return toPublic(provider);
  }

  engineSettings(name: string): EngineSettings {
    return normalizeEngine(this.settings().engines[name]);
  }

  saveEngine(name: string, input: unknown): EngineSettings {
    if (!isKnownEngine(name)) throw new Error(`不明なエンジンです: ${name}`);
    const next = normalizeEngine(input, this.engineSettings(name));
    this.saveSettings({ engines: { ...this.settings().engines, [name]: next } });
    return next;
  }

  saveTemplate(input: Record<string, unknown>): Template {
    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("テンプレート名を入力してください");
    const rootCli = String(input.rootCli ?? "");
    if (!isKnownEngine(rootCli)) throw new Error("Root のエンジンが正しくありません");
    const int = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
    const template: Template = {
      id: typeof input.id === "string" && input.id ? input.id : slugify(name) + "-" + Date.now().toString(36),
      name,
      mode: input.mode === "normal" ? "normal" : "multi",
      rootCli,
      childClis: (Array.isArray(input.childClis) ? input.childClis : []).map(String).filter(isKnownEngine),
      preset: input.preset === "light" || input.preset === "standard" || input.preset === "large" ? input.preset : undefined,
      maxDepth: int(input.maxDepth),
      maxConcurrent: int(input.maxConcurrent),
      goal: typeof input.goal === "string" && input.goal.trim() ? input.goal.trim().slice(0, 2000) : undefined,
    };
    const rest = this.settings().templates.filter((t) => t.id !== template.id);
    this.saveSettings({ templates: [...rest, template].slice(-50) });
    return template;
  }

  deleteTemplate(id: string): void {
    this.saveSettings({ templates: this.settings().templates.filter((t) => t.id !== id) });
  }

  setMode(mode: SessionMode): SessionMeta {
    if (!this.active || !this.activeMeta) throw new Error("セッションが開始されていません");
    this.active.orch.setMode(mode);
    this.activeMeta = { ...this.activeMeta, mode };
    writeFileSync(join(this.active.runDir, "charter.toml"), serializeCharter(this.active.orch.charter));
    this.writeMeta(this.activeMeta, this.active.runDir);
    return this.activeMeta;
  }

  search(query: string, limit = 40): Array<{ sessionId: string; name: string; ts: number; role: string; snippet: string }> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: Array<{ sessionId: string; name: string; ts: number; role: string; snippet: string }> = [];
    for (const meta of this.sessions()) {
      for (const event of this.readEvents(meta.id)) {
        if (event.type !== "chat.user" && event.type !== "chat.reply") continue;
        const text = String(event.data?.text ?? "");
        const at = text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        out.push({ sessionId: meta.id, name: meta.name, ts: event.ts, role: event.type === "chat.user" ? "user" : "root", snippet: text.slice(Math.max(0, at - 40), at + 100) });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  private repoRoot(): string {
    if (!this.activeMeta) throw new Error("セッションが開始されていません");
    return this.activeMeta.repoDir;
  }

  listFiles(): string[] {
    const dir = this.repoRoot();
    if (isGitRepo(dir)) {
      return git(dir, ["ls-files", "-co", "--exclude-standard"]).split("\n").filter(Boolean).slice(0, 5000);
    }
    const out: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        if (name === ".git" || name === "node_modules") continue;
        const full = join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (out.length < 5000) out.push(relative(dir, full).split(sep).join("/"));
      }
    };
    walk(dir);
    return out;
  }

  readFile(rel: string): { path: string; binary: boolean; truncated: boolean; text: string } {
    const root = realpathSync(this.repoRoot());
    const full = resolve(root, rel);
    if (!full.startsWith(root + sep)) throw new Error("リポジトリの外は読めません");
    const real = realpathSync(full);
    if (!real.startsWith(root + sep)) throw new Error("リポジトリの外は読めません");
    const stat = statSync(real);
    if (!stat.isFile()) throw new Error("ファイルではありません");
    const buf = readFileSync(real).subarray(0, 200_000);
    if (buf.includes(0)) return { path: rel, binary: true, truncated: false, text: "" };
    return { path: rel, binary: false, truncated: stat.size > 200_000, text: buf.toString("utf8") };
  }

  deleteProvider(id: string): void {
    this.saveSettings({ providers: this.settings().providers.filter((p) => p.id !== id) });
  }

  private writeMeta(meta: SessionMeta, runDir: string): void {
    writeFileSync(join(runDir, "session.json"), JSON.stringify(meta, null, 2));
  }

  async start(input: { repoDir: string; charter: Charter; name?: string }): Promise<SessionMeta> {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
    const id = `${stamp}-${process.pid}`;
    const runDir = join(this.home, "runs", id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "charter.toml"), serializeCharter(input.charter));
    const meta: SessionMeta = {
      id,
      name: input.name ?? (basename(input.repoDir) || input.repoDir),
      repoDir: input.repoDir,
      rootCli: input.charter.rootCli,
      mode: input.charter.mode,
      startedAt: Date.now(),
      active: true,
    };
    return this.launch(meta, runDir, input.charter);
  }

  async resume(id: string): Promise<SessionMeta> {
    if (!/^[\w-]+$/.test(id)) throw new Error("bad session id");
    const runDir = join(this.home, "runs", id);
    const metaFile = join(runDir, "session.json");
    const charterFile = join(runDir, "charter.toml");
    if (!existsSync(metaFile) || !existsSync(charterFile)) throw new Error("このセッションは再開できません (設計書の記録がありません)");
    const saved = JSON.parse(readFileSync(metaFile, "utf8")) as SessionMeta;
    if (!existsSync(saved.repoDir)) throw new Error(`作業フォルダが見つかりません: ${saved.repoDir}`);
    const charter = parseCharter(readFileSync(charterFile, "utf8"));
    const meta: SessionMeta = { ...saved, active: true, endedAt: undefined };
    return this.launch(meta, runDir, charter, this.readEvents(id));
  }

  private async launch(meta: SessionMeta, runDir: string, charter: Charter, restore?: OrchEvent[]): Promise<SessionMeta> {
    if (this.active) throw new Error("a session is already running; stop it first");
    const session = await createSession({ charter, adapters: this.adapters, repoDir: meta.repoDir, runDir, restore, engineSettings: (name) => this.engineSettings(name) });
    this.active = session;
    this.activeMeta = meta;
    this.writeMeta(meta, runDir);
    this.saveSettings({ recentProjects: [meta.repoDir, ...this.settings().recentProjects] });
    if (restore) session.orch.bus.emit("session.resumed", "root", { interrupted: session.orch.restoredInterrupted });
    this.emit("session", meta);
    return meta;
  }

  async stop(): Promise<void> {
    const session = this.active;
    const meta = this.activeMeta;
    if (!session || !meta) return;
    this.active = null;
    this.activeMeta = null;
    await session.close();
    this.writeMeta({ ...meta, active: false, endedAt: Date.now() }, session.runDir);
    this.emit("session", null);
  }

  sessions(): SessionMeta[] {
    const root = join(this.home, "runs");
    const out: SessionMeta[] = [];
    for (const name of readdirSync(root)) {
      const file = join(root, name, "session.json");
      if (!existsSync(file)) continue;
      try {
        const meta = JSON.parse(readFileSync(file, "utf8")) as SessionMeta;
        out.push({ ...meta, active: this.activeMeta?.id === meta.id });
      } catch {
        // skip unreadable metadata
      }
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  readEvents(id: string): OrchEvent[] {
    if (!/^[\w-]+$/.test(id)) throw new Error("bad session id");
    const file = join(this.home, "runs", id, "events.jsonl");
    return existsSync(file) ? readJsonl(file) : [];
  }
}
