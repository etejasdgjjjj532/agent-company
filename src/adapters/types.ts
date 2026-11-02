export type AdapterEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { kind: "final"; text: string; isError: boolean };

export type Profile = "root" | "worker";

export interface RunOptions {
  cwd: string;
  prompt: string;
  profile: Profile;
  mcpUrl?: string;
  sessionId?: string;
  model?: string;
  workDir: string;
  env?: Record<string, string>;
}

export interface Invocation {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  stdin?: string;
  cleanup?: () => void;
}

export interface Adapter {
  name: string;
  verified: boolean;
  supportsResume: boolean;
  invoke(opts: RunOptions): Invocation;
  parseLine(line: string): AdapterEvent[];
}

export function parseJson(line: string): Record<string, any> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, any>;
  } catch {
    return null;
  }
}

export function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
