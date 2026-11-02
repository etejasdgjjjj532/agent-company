import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface McpHost {
  toolsFor(token: string): ToolDef[] | null;
  call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function handleMessage(host: McpHost, token: string, message: any): Promise<any | null> {
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) return null;
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agent-company", version: "0.1.0" },
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": {
      const tools = host.toolsFor(token);
      return tools ? { jsonrpc: "2.0", id, result: { tools } } : fail(-32001, "unknown node");
    }
    case "tools/call": {
      if (!host.toolsFor(token)) return fail(-32001, "unknown node");
      const result = await host.call(token, String(params?.name ?? ""), (params?.arguments ?? {}) as Record<string, unknown>);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result.text }], isError: result.isError } };
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export function createMcpServer(host: McpHost): Server {
  return createServer(async (req, res) => {
    const match = /^\/mcp\/([A-Za-z0-9]+)$/.exec((req.url ?? "").split("?")[0]);
    if (!match) return send(res, 404);
    if (req.method === "GET") return send(res, 405);
    if (req.method === "DELETE") return send(res, 200);
    if (req.method !== "POST") return send(res, 405);
    try {
      const parsed = JSON.parse(await readBody(req));
      if (Array.isArray(parsed)) {
        const replies = (await Promise.all(parsed.map((m) => handleMessage(host, match[1], m)))).filter((r) => r !== null);
        return replies.length > 0 ? send(res, 200, replies) : send(res, 202);
      }
      const reply = await handleMessage(host, match[1], parsed);
      return reply ? send(res, 200, reply) : send(res, 202);
    } catch (error: any) {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error?.message ?? error) } });
    }
  });
}
