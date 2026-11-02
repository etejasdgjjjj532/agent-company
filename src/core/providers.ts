import { KNOWN_CLIS } from "./charter.ts";

export interface ApiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  models: string[];
  defaultModel: string;
}

export type PublicProvider = Omit<ApiProvider, "apiKey"> & { hasKey: boolean };

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  needsKey: boolean;
  models: string[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true, models: ["gpt-4.1", "gpt-4.1-mini"] },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, models: [] },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", needsKey: true, models: [] },
  { id: "ollama", name: "Ollama (ローカル)", baseUrl: "http://localhost:11434/v1", needsKey: false, models: [] },
  { id: "lmstudio", name: "LM Studio (ローカル)", baseUrl: "http://localhost:1234/v1", needsKey: false, models: [] },
];

const API_PREFIX = "api:";

export type Engine = { kind: "cli"; cli: string } | { kind: "api"; providerId: string; model?: string };

export function parseEngine(name: string): Engine | null {
  if ((KNOWN_CLIS as readonly string[]).includes(name)) return { kind: "cli", cli: name };
  if (!name.startsWith(API_PREFIX)) return null;
  const rest = name.slice(API_PREFIX.length);
  const split = rest.indexOf(":");
  const providerId = split < 0 ? rest : rest.slice(0, split);
  const model = split < 0 ? undefined : rest.slice(split + 1);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(providerId)) return null;
  if (model !== undefined && model === "") return null;
  return { kind: "api", providerId, model };
}

export function isKnownEngine(name: string): boolean {
  return parseEngine(name) !== null;
}

export function engineName(providerId: string, model?: string): string {
  return model ? `${API_PREFIX}${providerId}:${model}` : `${API_PREFIX}${providerId}`;
}

export function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "provider";
}

export function normalizeProvider(input: Record<string, unknown>, existing?: ApiProvider): ApiProvider {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("名前を入力してください");
  const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Base URL が正しくありません (例: https://api.openai.com/v1)");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Base URL は http か https で始めてください");
  const id = existing?.id ?? slugify(String(input.id ?? name));
  const models = (Array.isArray(input.models) ? input.models : String(input.models ?? "").split(/[\s,、]+/))
    .map((m) => String(m).trim())
    .filter(Boolean);
  const defaultModel = String(input.defaultModel ?? "").trim() || models[0] || existing?.defaultModel || "";
  if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
  const apiKeyEnv = String(input.apiKeyEnv ?? "").trim();
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error("環境変数名が正しくありません");
  const typedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  return {
    id,
    name,
    baseUrl,
    apiKey: apiKeyEnv ? undefined : typedKey || existing?.apiKey || undefined,
    apiKeyEnv: apiKeyEnv || undefined,
    models,
    defaultModel,
  };
}

export function toPublic(provider: ApiProvider): PublicProvider {
  const { apiKey, ...rest } = provider;
  return { ...rest, hasKey: Boolean(apiKey) || Boolean(provider.apiKeyEnv) };
}

export interface OpencodeProviderSetup {
  config: Record<string, unknown>;
  model: string;
  hasSecret: boolean;
}

// opencode runs config loading in a separate process, so {env:VAR} references are not reliable.
// The key is written into a short-lived 0600 config file that the adapter removes when the run ends.
export function opencodeProviderSetup(provider: ApiProvider, model?: string, source: NodeJS.ProcessEnv = process.env): OpencodeProviderSetup {
  const chosen = model || provider.defaultModel;
  if (!chosen) throw new Error(`プロバイダ ${provider.name} にモデルが設定されていません`);
  const models = [...new Set([...provider.models, chosen])];
  const key = provider.apiKeyEnv ? source[provider.apiKeyEnv] : provider.apiKey;
  if (provider.apiKeyEnv && !key) throw new Error(`環境変数 ${provider.apiKeyEnv} が設定されていません`);
  return {
    config: {
      provider: {
        [provider.id]: {
          npm: "@ai-sdk/openai-compatible",
          name: provider.name,
          options: { baseURL: provider.baseUrl, apiKey: key || "not-needed" },
          models: Object.fromEntries(models.map((m) => [m, { name: m }])),
        },
      },
    },
    model: `${provider.id}/${chosen}`,
    hasSecret: Boolean(key),
  };
}
