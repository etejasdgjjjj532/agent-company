import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { opencodeAdapter } from "./adapters/opencode.ts";
import type { Adapter } from "./adapters/types.ts";
import { createSession, type Session } from "./app.ts";
import type { Charter } from "./core/charter.ts";
import type { OrchEvent } from "./core/events.ts";
import { dataHome } from "./core/platform.ts";
import { normalizeProvider, parseEngine, toPublic, type ApiProvider, type PublicProvider } from "./core/providers.ts";
import { readJsonl } from "./core/store.ts";

export interface SessionMeta {
  id: string;
  name: string;
  repoDir: string;
  rootCli: string;
  startedAt: number;
  endedAt?: number;
  active: boolean;
}

export interface Settings {
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
      };
    } catch {
      return { terms: "tech", recentProjects: [], providers: [] };
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

  deleteProvider(id: string): void {
    this.saveSettings({ providers: this.settings().providers.filter((p) => p.id !== id) });
  }

  private writeMeta(meta: SessionMeta, runDir: string): void {
    writeFileSync(join(runDir, "session.json"), JSON.stringify(meta, null, 2));
  }

  async start(input: { repoDir: string; charter: Charter; name?: string }): Promise<SessionMeta> {
    if (this.active) throw new Error("a session is already running; stop it first");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
    const id = `${stamp}-${process.pid}`;
    const runDir = join(this.home, "runs", id);
    mkdirSync(runDir, { recursive: true });
    const session = await createSession({ charter: input.charter, adapters: this.adapters, repoDir: input.repoDir, runDir });
    const meta: SessionMeta = {
      id,
      name: input.name ?? (basename(input.repoDir) || input.repoDir),
      repoDir: input.repoDir,
      rootCli: input.charter.rootCli,
      startedAt: Date.now(),
      active: true,
    };
    this.active = session;
    this.activeMeta = meta;
    this.writeMeta(meta, runDir);
    const settings = this.settings();
    this.saveSettings({ recentProjects: [input.repoDir, ...settings.recentProjects] });
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
