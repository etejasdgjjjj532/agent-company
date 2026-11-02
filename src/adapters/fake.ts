import { fileURLToPath } from "node:url";
import { parseJson, type Adapter, type AdapterEvent, type Invocation, type RunOptions } from "./types.ts";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.ts", import.meta.url));

export function fakeAdapter(name = "fake"): Adapter {
  return {
    name,
    verified: true,
    supportsResume: true,
    invoke(opts: RunOptions): Invocation {
      const env: Record<string, string> = { ...(opts.env ?? {}) };
      if (opts.mcpUrl) env.FAKE_MCP_URL = opts.mcpUrl;
      return { cmd: process.execPath, args: [FAKE_CLI, opts.prompt, opts.sessionId ?? ""], env };
    },
    parseLine(line: string): AdapterEvent[] {
      const event = parseJson(line);
      if (!event) return [];
      switch (event.type) {
        case "session":
          return [{ kind: "session", sessionId: String(event.id) }];
        case "text":
          return [{ kind: "text", text: String(event.text) }];
        case "tool":
          return [{ kind: "tool", name: String(event.name), summary: String(event.summary ?? "") }];
        case "usage":
          return [{ kind: "usage", inputTokens: Number(event.input ?? 0), outputTokens: Number(event.output ?? 0) }];
        case "final":
          return [{ kind: "final", text: String(event.text ?? ""), isError: Boolean(event.isError) }];
        default:
          return [];
      }
    },
  };
}
