import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAdapters } from "../src/adapters/index.ts";
import { buildCharter } from "../src/core/charter.ts";
import { EventBus } from "../src/core/events.ts";
import { createMcpServer } from "../src/mcp/http.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { makeRepo } from "../test/helpers.ts";

const [rootCli = "claude", childCli = "claude", ...rest] = process.argv.slice(2);
const message = rest.join(" ") || `Delegate to ONE sub-agent (cli ${childCli}) the task: create a file hello.txt containing the word hi. Then wait for it and tell me its result in one line.`;

const base = mkdtempSync(join(tmpdir(), "ac-e2e-"));
const repoDir = join(base, "repo");
execFileSync("mkdir", ["-p", repoDir]);
makeRepo(repoDir);
const charter = buildCharter({ rootCli, childClis: [childCli], preset: "light", maxChildren: 2 });
const bus = new EventBus((e) => {
  if (["node.output", "node.status", "node.created", "node.retry", "node.warning"].includes(e.type)) {
    console.log(`[${e.type}] ${e.nodeId} ${JSON.stringify(e.data).slice(0, 200)}`);
  }
});
const holder: { orch?: Orchestrator } = {};
const server = createMcpServer({
  toolsFor: (t) => holder.orch!.toolsFor(t),
  call: (t, n, a) => holder.orch!.call(t, n, a),
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const orch = new Orchestrator({ charter, adapters: defaultAdapters(), repoDir, dataDir: join(base, "data"), bus, mcpBaseUrl: () => `http://127.0.0.1:${port}` });
holder.orch = orch;
const reply = await orch.chat(message);
console.log("=== REPLY:", reply);
console.log("=== TREE:", JSON.stringify(orch.tree().map((n) => ({ id: n.id, cli: n.cli, status: n.status, tok: n.inputTokens + n.outputTokens }))));
console.log("=== BASE:", base);
await orch.shutdown();
server.close();
