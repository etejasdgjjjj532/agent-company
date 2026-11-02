import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeAdapter } from "../src/adapters/claude.ts";
import { codexAdapter } from "../src/adapters/codex.ts";
import { geminiAdapter } from "../src/adapters/gemini.ts";
import { opencodeAdapter } from "../src/adapters/opencode.ts";

test("claude adapter reads session, text, tool use, usage and the final result", () => {
  const a = claudeAdapter("claude");
  assert.deepEqual(a.parseLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" })), [{ kind: "session", sessionId: "s1" }]);
  const msg = a.parseLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: { path: "x" } }] } }));
  assert.equal(msg[0].kind, "text");
  assert.equal(msg[1].kind, "tool");
  const done = a.parseLine(JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: 0.5 }));
  assert.deepEqual(done[0], { kind: "usage", inputTokens: 3, outputTokens: 2, costUsd: 0.5 });
  assert.deepEqual(done[1], { kind: "final", text: "ok", isError: false });
  assert.deepEqual(a.parseLine("not json"), []);
});

test("claude adapter passes the prompt on stdin and limits tools by profile", () => {
  const a = claudeAdapter("claude");
  const worker = a.invoke({ cwd: ".", prompt: "do it", profile: "worker", workDir: ".", sessionId: "abc" });
  assert.equal(worker.stdin, "do it");
  assert.ok(worker.args.includes("--resume"));
  assert.match(worker.args[worker.args.indexOf("--allowedTools") + 1], /Edit/);
  const root = a.invoke({ cwd: ".", prompt: "x", profile: "root", workDir: "." });
  assert.ok(!/Edit/.test(root.args[root.args.indexOf("--allowedTools") + 1]));
  assert.ok(worker.args.includes("WebFetch,WebSearch"));
});

test("codex adapter maps thread, messages, commands, mcp calls and failures", () => {
  const a = codexAdapter("codex");
  assert.deepEqual(a.parseLine(JSON.stringify({ type: "thread.started", thread_id: "t1" })), [{ kind: "session", sessionId: "t1" }]);
  assert.equal(a.parseLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x" } }))[0].kind, "text");
  assert.equal(a.parseLine(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls" } }))[0].kind, "tool");
  assert.deepEqual(a.parseLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } })), [{ kind: "usage", inputTokens: 5, outputTokens: 1 }]);
  assert.deepEqual(a.parseLine(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })), [{ kind: "final", text: "boom", isError: true }]);
  const inv = a.invoke({ cwd: ".", prompt: "p", profile: "worker", workDir: ".", sessionId: "t1", mcpUrl: "http://127.0.0.1:1/mcp/x" });
  assert.deepEqual(inv.args.slice(0, 3), ["exec", "resume", "t1"]);
  assert.ok(inv.args.includes("--ignore-user-config"));
  assert.ok(inv.args.some((arg) => arg.startsWith("mcp_servers.orch.url=")));
  assert.ok(inv.args.includes('sandbox_mode="workspace-write"'));
});

test("opencode adapter reads parts and usage, and denies edits for the root", () => {
  const a = opencodeAdapter("opencode");
  assert.equal(a.parseLine(JSON.stringify({ type: "text", sessionID: "o1", part: { text: "hello" } })).length, 2);
  const finish = a.parseLine(JSON.stringify({ type: "step_finish", part: { tokens: { input: 7, output: 3 }, cost: 0.1 } }));
  assert.deepEqual(finish[0], { kind: "usage", inputTokens: 7, outputTokens: 3, costUsd: 0.1 });
});

test("gemini adapter handles the documented event types and streamed chunks", () => {
  const a = geminiAdapter("gemini");
  assert.deepEqual(a.parseLine(JSON.stringify({ type: "init", session_id: "g1" })), [{ kind: "session", sessionId: "g1" }]);
  assert.deepEqual(a.parseLine(JSON.stringify({ type: "message", role: "assistant", content: "ab", delta: true })), [{ kind: "text", text: "ab", append: true }]);
  assert.deepEqual(a.parseLine(JSON.stringify({ type: "message", role: "user", content: "q" })), []);
  assert.equal(a.parseLine(JSON.stringify({ type: "tool_use", tool_name: "read" }))[0].kind, "tool");
  assert.equal(a.verified, false);
});
