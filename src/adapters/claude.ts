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
      const engine = opts.engine;
      const args = ["-p", "--output-format", "stream-json", "--verbose"];
      const servers: Record<string, unknown> = {};
      if (opts.mcpUrl) servers.orch = { type: "http", url: opts.mcpUrl };
      for (const s of engine?.mcpServers ?? []) servers[s.name] = s.url ? { type: "http", url: s.url } : { type: "stdio", command: s.command, args: s.args ?? [] };
      if (Object.keys(servers).length > 0) {
        const file = join(opts.workDir, "claude-mcp.json");
        writeFileSync(file, JSON.stringify({ mcpServers: servers }));
        args.push("--mcp-config", file, "--strict-mcp-config");
      }
      args.push("--permission-mode", "acceptEdits", "--disable-slash-commands");
      if (!engine?.allowWeb) args.push("--disallowedTools", "WebFetch,WebSearch");
      const model = opts.model || engine?.model;
      if (model) args.push("--model", model);
      if (opts.sessionId) args.push("--resume", opts.sessionId);
      let tools = opts.profile === "root" ? ROOT_TOOLS : WORKER_TOOLS;
      if (opts.profile !== "root" && engine?.permission === "readonly") tools = ROOT_TOOLS;
      if (opts.profile !== "root" && engine?.permission === "extended") tools = [...WORKER_TOOLS, "Bash"];
      const extra = (engine?.mcpServers ?? []).map((s) => `mcp__${s.name}`);
      const web = engine?.allowWeb ? ["WebFetch", "WebSearch"] : [];
      args.push("--allowedTools", [...tools, ...extra, ...web].join(","));
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
