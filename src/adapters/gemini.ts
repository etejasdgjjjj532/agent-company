import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clip, parseJson, type Adapter, type AdapterEvent, type Invocation, type RunOptions } from "./types.ts";

// Not verified against a live account: the installed CLI had no auth configured when this was written.
export function geminiAdapter(bin = process.env.AGENT_COMPANY_GEMINI_BIN ?? "gemini"): Adapter {
  return {
    name: "gemini",
    verified: false,
    supportsResume: false,
    invoke(opts: RunOptions): Invocation {
      mkdirSync(opts.workDir, { recursive: true });
      const settings: Record<string, unknown> = { tools: { exclude: ["web_fetch", "google_web_search"] } };
      if (opts.mcpUrl) settings.mcpServers = { orch: { httpUrl: opts.mcpUrl, trust: true } };
      const file = join(opts.workDir, "gemini-settings.json");
      writeFileSync(file, JSON.stringify(settings));
      const mode = opts.profile === "root" ? "plan" : "auto_edit";
      const args = ["-p", opts.prompt, "-o", "stream-json", "--approval-mode", mode];
      if (opts.model) args.push("-m", opts.model);
      return { cmd: bin, args, env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: file, ...(opts.env ?? {}) } };
    },
    parseLine(line: string): AdapterEvent[] {
      const event = parseJson(line);
      if (!event) return [];
      const out: AdapterEvent[] = [];
      const sessionId = event.session_id ?? event.sessionId;
      if (event.type === "init" && sessionId) out.push({ kind: "session", sessionId: String(sessionId) });
      if (event.type === "message" && event.role !== "user" && event.content) {
        out.push({ kind: "text", text: String(event.content) });
      } else if (event.type === "tool_use") {
        out.push({ kind: "tool", name: String(event.tool_name ?? event.name ?? "tool"), summary: clip(JSON.stringify(event.parameters ?? {})) });
      } else if (event.type === "result") {
        const stats = event.stats ?? {};
        out.push({ kind: "usage", inputTokens: Number(stats.input_tokens ?? 0), outputTokens: Number(stats.output_tokens ?? 0) });
        if (event.status === "error" || event.error) {
          out.push({ kind: "final", text: String(event.error?.message ?? "gemini failed"), isError: true });
        }
      }
      return out;
    },
  };
}
