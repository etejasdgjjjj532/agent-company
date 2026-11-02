import { clip, parseJson, type Adapter, type AdapterEvent, type Invocation, type RunOptions } from "./types.ts";

export function codexAdapter(bin = process.env.AGENT_COMPANY_CODEX_BIN ?? "codex"): Adapter {
  return {
    name: "codex",
    verified: true,
    supportsResume: true,
    invoke(opts: RunOptions): Invocation {
      const engine = opts.engine;
      const sandbox = opts.profile === "root" || engine?.permission === "readonly" ? "read-only" : "workspace-write";
      const args = ["exec"];
      if (opts.sessionId) args.push("resume", opts.sessionId);
      args.push("--json", "--skip-git-repo-check", "--ignore-user-config");
      args.push("-c", `sandbox_mode="${sandbox}"`, "-c", 'approval_policy="never"');
      if (opts.mcpUrl) args.push("-c", `mcp_servers.orch.url=${JSON.stringify(opts.mcpUrl)}`);
      if (engine?.allowWeb && sandbox === "workspace-write") args.push("-c", "sandbox_workspace_write.network_access=true");
      for (const s of engine?.mcpServers ?? []) {
        if (s.url) args.push("-c", `mcp_servers.${s.name}.url=${JSON.stringify(s.url)}`);
        else {
          args.push("-c", `mcp_servers.${s.name}.command=${JSON.stringify(s.command)}`);
          if (s.args?.length) args.push("-c", `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
        }
      }
      const model = opts.model || engine?.model;
      if (model) args.push("-m", model);
      return { cmd: bin, args, env: opts.env ?? {}, stdin: opts.prompt };
    },
    parseLine(line: string): AdapterEvent[] {
      const event = parseJson(line);
      if (!event) return [];
      if (event.type === "thread.started" && event.thread_id) {
        return [{ kind: "session", sessionId: String(event.thread_id) }];
      }
      if (event.type === "item.completed" && event.item) {
        const item = event.item;
        if (item.type === "agent_message" && item.text) return [{ kind: "text", text: String(item.text) }];
        if (item.type === "command_execution") return [{ kind: "tool", name: "shell", summary: clip(String(item.command ?? "")) }];
        if (item.type === "mcp_tool_call") {
          return [{ kind: "tool", name: `${item.server ?? "mcp"}.${item.tool ?? ""}`, summary: clip(JSON.stringify(item.arguments ?? {})) }];
        }
        return [];
      }
      if (event.type === "turn.completed") {
        const usage = event.usage ?? {};
        return [{ kind: "usage", inputTokens: Number(usage.input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0) }];
      }
      if (event.type === "turn.failed" || event.type === "error") {
        const message = event.error?.message ?? event.message ?? "codex failed";
        return [{ kind: "final", text: String(message), isError: true }];
      }
      return [];
    },
  };
}
