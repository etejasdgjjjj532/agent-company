import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { geminiAdapter } from "./gemini.ts";
import { opencodeAdapter } from "./opencode.ts";
import type { Adapter } from "./types.ts";

export function defaultAdapters(): Record<string, Adapter> {
  const adapters = [claudeAdapter(), codexAdapter(), geminiAdapter(), opencodeAdapter()];
  return Object.fromEntries(adapters.map((adapter) => [adapter.name, adapter]));
}

export type { Adapter, AdapterEvent, RunOptions } from "./types.ts";
export { runAgent } from "./runner.ts";
export type { RunResult, AgentRun } from "./runner.ts";
