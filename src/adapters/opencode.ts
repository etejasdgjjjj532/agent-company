import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clip, parseJson, type Adapter, type AdapterEvent, type Invocation, type RunOptions } from "./types.ts";

export function opencodeAdapter(bin = process.env.AGENT_COMPANY_OPENCODE_BIN ?? "opencode"): Adapter {
  return {
    name: "opencode",
    verified: true,
    supportsResume: true,
    invoke(opts: RunOptions): Invocation {
      mkdirSync(opts.workDir, { recursive: true });
      const config: Record<string, unknown> = {
        permission: {
          edit: opts.profile === "root" ? "deny" : "allow",
          bash: opts.profile === "root" ? "deny" : "allow",
          webfetch: "deny",
        },
      };
      if (opts.mcpUrl) config.mcp = { orch: { type: "remote", url: opts.mcpUrl, enabled: true } };
      const file = join(opts.workDir, "opencode.json");
      writeFileSync(file, JSON.stringify(config));
      const args = ["run", "--format", "json"];
      if (opts.sessionId) args.push("--session", opts.sessionId);
      if (opts.model) args.push("--model", opts.model);
      args.push(opts.prompt);
      return { cmd: bin, args, env: { OPENCODE_CONFIG: file, ...(opts.env ?? {}) } };
    },
    parseLine(line: string): AdapterEvent[] {
      const event = parseJson(line);
      if (!event) return [];
      const out: AdapterEvent[] = [];
      if (event.sessionID) out.push({ kind: "session", sessionId: String(event.sessionID) });
      const part = event.part ?? {};
      if (event.type === "text" && part.text) out.push({ kind: "text", text: String(part.text) });
      else if (event.type === "tool_use" || part.type === "tool") {
        out.push({ kind: "tool", name: String(part.tool ?? "tool"), summary: clip(JSON.stringify(part.state?.input ?? {})) });
      } else if (event.type === "step_finish") {
        const tokens = part.tokens ?? {};
        out.push({
          kind: "usage",
          inputTokens: Number(tokens.input ?? 0),
          outputTokens: Number(tokens.output ?? 0),
          costUsd: typeof part.cost === "number" ? part.cost : undefined,
        });
      } else if (event.type === "error") {
        out.push({ kind: "final", text: String(event.error?.message ?? event.message ?? "opencode failed"), isError: true });
      }
      return out;
    },
  };
}
