import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clip, parseJson, type Adapter, type AdapterEvent, type Invocation, type RunOptions } from "./types.ts";

const WORKER_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git *)", "Bash(npm *)", "Bash(node *)", "Bash(ls *)", "Bash(cat *)", "mcp__orch"];
const ROOT_TOOLS = ["Read", "Glob", "Grep", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "mcp__orch"];

export function claudeAdapter(bin = process.env.AGENT_COMPANY_CLAUDE_BIN ?? "claude"): Adapter {
  return {
    name: "claude",
    verified: true,
    supportsResume: true,
    invoke(opts: RunOptions): Invocation {
      mkdirSync(opts.workDir, { recursive: true });
      const args = ["-p", "--output-format", "stream-json", "--verbose"];
      if (opts.mcpUrl) {
        const file = join(opts.workDir, "claude-mcp.json");
        writeFileSync(file, JSON.stringify({ mcpServers: { orch: { type: "http", url: opts.mcpUrl } } }));
        args.push("--mcp-config", file, "--strict-mcp-config");
      }
      args.push("--permission-mode", "acceptEdits", "--disable-slash-commands");
      args.push("--disallowedTools", "WebFetch,WebSearch");
      if (opts.model) args.push("--model", opts.model);
      if (opts.sessionId) args.push("--resume", opts.sessionId);
      args.push("--allowedTools", (opts.profile === "root" ? ROOT_TOOLS : WORKER_TOOLS).join(","));
      return { cmd: bin, args, env: opts.env ?? {}, stdin: opts.prompt };
    },
    parseLine(line: string): AdapterEvent[] {
      const event = parseJson(line);
      if (!event) return [];
      const out: AdapterEvent[] = [];
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        out.push({ kind: "session", sessionId: String(event.session_id) });
      } else if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "text" && block.text) out.push({ kind: "text", text: String(block.text) });
          else if (block.type === "tool_use") {
            out.push({ kind: "tool", name: String(block.name), summary: clip(JSON.stringify(block.input ?? {})) });
          }
        }
      } else if (event.type === "result") {
        const usage = event.usage ?? {};
        out.push({
          kind: "usage",
          inputTokens: Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
        });
        out.push({ kind: "final", text: String(event.result ?? ""), isError: Boolean(event.is_error) || event.subtype !== "success" });
      }
      return out;
    },
  };
}
