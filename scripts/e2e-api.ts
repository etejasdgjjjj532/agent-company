import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeAdapter } from "../src/adapters/opencode.ts";
import { runAgent } from "../src/adapters/runner.ts";
import { normalizeProvider } from "../src/core/providers.ts";

const seen: Array<{ url: string; auth: string | undefined; model?: string }> = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let model: string | undefined;
    try { model = JSON.parse(body).model; } catch { /* not json */ }
    seen.push({ url: req.url ?? "", auth: req.headers.authorization ?? "(none)", model, hdr: Object.keys(req.headers).join(",") } as any);
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    const stream = body.includes('"stream":true');
    const chunk = (delta: object, finish: string | null = null) => ({
      id: "c1", object: "chat.completion.chunk", created: 1, model: model ?? "mock-model", choices: [{ index: 0, delta, finish_reason: finish }],
    });
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({ content: "mock-api-reply" }))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "c1", object: "chat.completion", created: 1, model: model ?? "mock-model",
        choices: [{ index: 0, message: { role: "assistant", content: "mock-api-reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }));
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const provider = normalizeProvider({ name: "Mock", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-mock-key-123456", models: "mock-model" });
const dir = mkdtempSync(join(tmpdir(), "ac-api-"));
const run = runAgent(opencodeAdapter(undefined, { provider, model: "mock-model" }), { cwd: dir, prompt: "say hi", profile: "worker", workDir: dir }, (e) => console.log("event", JSON.stringify(e).slice(0, 160)), { timeoutMs: 120000 });
const result = await run.promise;
console.log("RESULT", JSON.stringify({ ok: result.ok, text: result.text, tokens: [result.inputTokens, result.outputTokens], exit: result.exitCode, err: result.stderrTail.slice(-300) }));
console.log("SERVER SAW", JSON.stringify(seen));
server.closeAllConnections();
server.close();
