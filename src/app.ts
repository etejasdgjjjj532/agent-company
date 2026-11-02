import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createJsonlSink } from "./core/store.ts";
import { EventBus, type OrchEvent } from "./core/events.ts";
import type { Charter } from "./core/charter.ts";
import type { Adapter } from "./adapters/types.ts";
import { createMcpServer } from "./mcp/http.ts";
import { Orchestrator } from "./orchestrator.ts";

export interface SessionOptions {
  charter: Charter;
  adapters: Record<string, Adapter>;
  repoDir: string;
  runDir: string;
  restore?: OrchEvent[];
  engineSettings?: (cli: string) => import("./core/engines.ts").EngineSettings;
}

export interface Session {
  orch: Orchestrator;
  runDir: string;
  close(): Promise<void>;
}

async function listen(server: ReturnType<typeof createMcpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

export async function createSession(options: SessionOptions): Promise<Session> {
  const bus = new EventBus(createJsonlSink(join(options.runDir, "events.jsonl")), options.restore);
  const holder: { orch?: Orchestrator } = {};
  const mcp = createMcpServer({
    toolsFor: (token) => holder.orch!.toolsFor(token),
    call: (token, name, args) => holder.orch!.call(token, name, args),
  });
  const mcpPort = await listen(mcp);
  const orch = new Orchestrator({
    charter: options.charter,
    adapters: options.adapters,
    repoDir: options.repoDir,
    dataDir: options.runDir,
    bus,
    mcpBaseUrl: () => `http://127.0.0.1:${mcpPort}`,
    restore: options.restore,
    engineSettings: options.engineSettings,
  });
  holder.orch = orch;
  return {
    orch,
    runDir: options.runDir,
    async close() {
      await orch.shutdown();
      mcp.closeAllConnections();
      await new Promise<void>((resolve) => mcp.close(() => resolve()));
    },
  };
}
