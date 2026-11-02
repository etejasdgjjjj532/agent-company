import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Scripted stand-in for an agent CLI, driven by "FAKE: ..." lines in the prompt.
// Used by tests and by `agent-company start --fake` to exercise the orchestrator without any real model.

const prompt = process.argv[2] ?? "";
const resumed = process.argv[3] ?? "";
const mcpUrl = process.env.FAKE_MCP_URL;
const attempt = Number(process.env.AGENT_COMPANY_ATTEMPT ?? "1");

function out(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  if (!mcpUrl) throw new Error("FAKE_MCP_URL is not set");
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = (await response.json()) as any;
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  out({ type: "tool", name, summary: JSON.stringify(args) });
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result.content?.map((part: any) => part.text).join("\n") ?? "";
  if (result.isError) throw new Error(text);
  return text;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  out({ type: "session", id: resumed || `fake-${process.pid}` });
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake", version: "0" } }).catch(() => undefined);
  const said: string[] = [];
  const spawned: string[] = [];
  const lines = prompt.split("\n").filter((line) => line.startsWith("FAKE: ")).map((line) => line.slice(6).trim());
  if (resumed && lines.length === 0) said.push("resumed");
  for (const line of lines) {
    const [command, ...rest] = line.split(" ");
    const arg = rest.join(" ");
    if (command === "say") {
      said.push(arg);
      out({ type: "text", text: arg });
    } else if (command === "sleep") {
      await sleep(Number(arg));
    } else if (command === "write") {
      const [file, ...content] = rest;
      writeFileSync(join(process.cwd(), file), `${content.join(" ")}\n`);
    } else if (command === "spawn") {
      const [cli, ...task] = rest;
      const text = await tool("spawn_child", { cli, role: "worker", task: task.join(" ").replaceAll("\\n", "\n") });
      spawned.push(JSON.parse(text).id);
    } else if (command === "wait") {
      const text = await tool("wait_children", { timeout_sec: 60 });
      said.push(text);
    } else if (command === "merge") {
      const text = await tool("merge_child", { id: spawned[Number(arg || "0")] });
      said.push(text);
    } else if (command === "report") {
      await tool("report", { result: arg });
    } else if (command === "failuntil") {
      if (attempt <= Number(arg)) {
        out({ type: "final", text: `fake failure on attempt ${attempt}`, isError: true });
        process.exit(1);
      }
    } else if (command === "fail") {
      out({ type: "final", text: "fake failure", isError: true });
      process.exit(1);
    }
  }
  out({ type: "usage", input: 10, output: 5 });
  out({ type: "final", text: said.join("\n") || "done", isError: false });
}

main().catch((error) => {
  out({ type: "final", text: String(error?.message ?? error), isError: true });
  process.exit(1);
});
