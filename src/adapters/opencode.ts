import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineName, opencodeProviderSetup, type ApiProvider } from "../core/providers.ts";
import { clip, parseJson, type Adapter, type AdapterEvent, type Invocation, type RunOptions } from "./types.ts";

export interface ApiBinding {
  provider: ApiProvider;
  model?: string;
}

export function opencodeAdapter(bin = process.env.AGENT_COMPANY_OPENCODE_BIN ?? "opencode", api?: ApiBinding): Adapter {
  return {
    name: api ? engineName(api.provider.id, api.model) : "opencode",
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
      const setup = api ? opencodeProviderSetup(api.provider, api.model) : null;
      if (setup) Object.assign(config, setup.config, { model: setup.model });
      const file = join(opts.workDir, "opencode.json");
      writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
      const args = ["run", "--format", "json"];
      if (opts.sessionId) args.push("--session", opts.sessionId);
      if (opts.model || setup) args.push("--model", opts.model ?? setup!.model);
      return {
        cmd: bin,
        args,
        env: { OPENCODE_CONFIG: file, ...(opts.env ?? {}) },
        stdin: opts.prompt,
        cleanup: setup?.hasSecret ? () => rmSync(file, { force: true }) : undefined,
      };
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
