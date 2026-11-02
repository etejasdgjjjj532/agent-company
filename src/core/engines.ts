export type PermissionLevel = "readonly" | "standard" | "extended";

export interface McpServerSpec {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
}

export interface EngineSettings {
  enabled: boolean;
  model: string;
  instructions: string;
  permission: PermissionLevel;
  allowWeb: boolean;
  mcpServers: McpServerSpec[];
}

export const DEFAULT_ENGINE: EngineSettings = {
  enabled: true,
  model: "",
  instructions: "",
  permission: "standard",
  allowWeb: false,
  mcpServers: [],
};

export const PERMISSION_LABELS: Record<PermissionLevel, string> = {
  readonly: "読み取りのみ",
  standard: "標準 (作業フォルダ内の編集と基本コマンド)",
  extended: "広め (任意のコマンドも実行)",
};

export function normalizeMcp(input: unknown): McpServerSpec {
  const raw = (input ?? {}) as Record<string, unknown>;
  const name = String(raw.name ?? "").trim();
  if (!/^[a-z][a-z0-9_-]{0,30}$/i.test(name)) throw new Error("MCP サーバーの名前は英数字、-、_ で入力してください");
  if (name.toLowerCase() === "orch") throw new Error('"orch" は予約されている名前です');
  const url = String(raw.url ?? "").trim();
  const command = String(raw.command ?? "").trim();
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`MCP サーバー ${name} の URL が正しくありません`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`MCP サーバー ${name} の URL は http か https にしてください`);
    return { name, url };
  }
  if (!command) throw new Error(`MCP サーバー ${name} には URL かコマンドが必要です`);
  const args = (Array.isArray(raw.args) ? raw.args : String(raw.args ?? "").split(/\s+/)).map(String).filter(Boolean);
  return { name, command, args };
}

export function normalizeEngine(input: unknown, base: EngineSettings = DEFAULT_ENGINE): EngineSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const permission = raw.permission === "readonly" || raw.permission === "extended" || raw.permission === "standard" ? raw.permission : base.permission;
  const servers = Array.isArray(raw.mcpServers) ? raw.mcpServers.map(normalizeMcp) : base.mcpServers;
  const names = servers.map((s) => s.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error("MCP サーバーの名前が重複しています");
  return {
    enabled: raw.enabled === undefined ? base.enabled : raw.enabled === true,
    model: raw.model === undefined ? base.model : String(raw.model).trim(),
    instructions: raw.instructions === undefined ? base.instructions : String(raw.instructions).slice(0, 4000),
    permission,
    allowWeb: raw.allowWeb === undefined ? base.allowWeb : raw.allowWeb === true,
    mcpServers: servers,
  };
}
