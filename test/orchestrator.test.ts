import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { autoApprove, startHarness } from "./helpers.ts";
import { ROOT_ID } from "../src/orchestrator.ts";

const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function rootToken(h: Awaited<ReturnType<typeof startHarness>>): string {
  return h.orch.registry.get(ROOT_ID)!.token;
}

test("root delegates to two children, waits, and merges with approval", async () => {
  const h = await startHarness();
  autoApprove(h.bus, h.orch);
  try {
    const reply = await h.orch.chat(
      [
        "FAKE: spawn fake FAKE: write a.txt from-a\\nFAKE: say child-a-done",
        "FAKE: spawn fake FAKE: write b.txt from-b\\nFAKE: say child-b-done",
        "FAKE: wait",
        "FAKE: merge 0",
        "FAKE: merge 1",
        "FAKE: say all merged",
      ].join("\n"),
    );
    assert.match(reply, /child-a-done/);
    assert.match(reply, /child-b-done/);
    assert.match(reply, /all merged/);
    assert.equal(read(join(h.repoDir, "a.txt")), "from-a\n");
    assert.equal(read(join(h.repoDir, "b.txt")), "from-b\n");
    const tree = h.orch.tree();
    assert.deepEqual(tree.filter((n) => n.id !== ROOT_ID).map((n) => n.status), ["done", "done"]);
  } finally {
    await h.close();
  }
});

test("declined merge leaves the main branch untouched", async () => {
  const h = await startHarness();
  autoApprove(h.bus, h.orch, false);
  try {
    const reply = await h.orch.chat(
      ["FAKE: spawn fake FAKE: write a.txt x", "FAKE: wait", "FAKE: merge 0"].join("\n"),
    );
    assert.match(reply, /declined/);
    assert.equal(existsSync(join(h.repoDir, "a.txt")), false);
  } finally {
    await h.close();
  }
});

test("limits: too many children and disallowed cli are rejected by the daemon", async () => {
  const h = await startHarness({ preset: "light", maxChildren: 1 });
  try {
    const token = rootToken(h);
    const ok = await h.orch.call(token, "spawn_child", { cli: "fake", task: "FAKE: say hi" });
    assert.equal(ok.isError, false);
    const tooMany = await h.orch.call(token, "spawn_child", { cli: "fake", task: "FAKE: say hi" });
    assert.equal(tooMany.isError, true);
    assert.match(tooMany.text, /max_children/);
    const badCli = await h.orch.call(token, "spawn_child", { cli: "codex", task: "x" });
    assert.equal(badCli.isError, true);
  } finally {
    await h.close();
  }
});

test("a child at the deepest level gets no spawn tools", async () => {
  const h = await startHarness({ preset: "light" });
  try {
    const spawned = await h.orch.call(rootToken(h), "spawn_child", { cli: "fake", task: "FAKE: say hi" });
    const child = h.orch.registry.get(JSON.parse(spawned.text).id)!;
    const names = h.orch.toolsFor(child.token)!.map((t) => t.name);
    assert.deepEqual(names, ["report"]);
    const denied = await h.orch.call(child.token, "spawn_child", { cli: "fake", task: "x" });
    assert.equal(denied.isError, true);
  } finally {
    await h.close();
  }
});

test("failed children are retried and then succeed", async () => {
  const h = await startHarness();
  try {
    const reply = await h.orch.chat(["FAKE: spawn fake FAKE: failuntil 1\\nFAKE: say recovered", "FAKE: wait"].join("\n"));
    const parsed = JSON.parse(reply.slice(reply.indexOf("{")));
    assert.equal(parsed.children[0].status, "done");
    assert.equal(parsed.children[0].attempts, 2);
  } finally {
    await h.close();
  }
});

test("children that keep failing end as failed after max retries", async () => {
  const h = await startHarness({ maxRetries: 1 });
  try {
    const reply = await h.orch.chat(["FAKE: spawn fake FAKE: fail", "FAKE: wait"].join("\n"));
    const parsed = JSON.parse(reply.slice(reply.indexOf("{")));
    assert.equal(parsed.children[0].status, "failed");
    assert.equal(parsed.children[0].attempts, 2);
  } finally {
    await h.close();
  }
});

test("nested delegation works with a single concurrency slot", async () => {
  const h = await startHarness({ preset: "standard", maxConcurrent: 1 });
  try {
    const reply = await h.orch.chat(
      [
        "FAKE: spawn fake FAKE: spawn fake FAKE: write deep.txt leaf\\\\nFAKE: say leaf-done\\nFAKE: wait\\nFAKE: say mid-done",
        "FAKE: wait",
      ].join("\n"),
    );
    assert.match(reply, /mid-done/);
    const ids = h.orch.tree().map((n) => n.id).sort();
    assert.deepEqual(ids, ["c1", "c1.1", "root"]);
    assert.ok(h.orch.tree().every((n) => n.id === ROOT_ID || n.status === "done"));
  } finally {
    await h.close();
  }
});

test("a direct user instruction continues a finished child and notifies the parent", async () => {
  const h = await startHarness();
  try {
    const token = rootToken(h);
    const spawned = JSON.parse((await h.orch.call(token, "spawn_child", { cli: "fake", task: "FAKE: say first" })).text);
    await h.orch.call(token, "wait_children", {});
    const again = await h.orch.messageNode(spawned.id, "FAKE: say second");
    assert.match(again, /second/);
    const waited = JSON.parse((await h.orch.call(token, "wait_children", {})).text);
    assert.match(waited.notes[0], /direct instruction/);
  } finally {
    await h.close();
  }
});

test("stop_child stops a running child", async () => {
  const h = await startHarness();
  try {
    const token = rootToken(h);
    const spawned = JSON.parse((await h.orch.call(token, "spawn_child", { cli: "fake", task: "FAKE: sleep 30000" })).text);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await h.orch.call(token, "stop_child", { id: spawned.id });
    const waited = JSON.parse((await h.orch.call(token, "wait_children", { timeout_sec: 10 })).text);
    assert.equal(waited.children[0].status, "stopped");
  } finally {
    await h.close();
  }
});

test("token budget stops new spawns", async () => {
  const h = await startHarness({ maxTotalTokens: 1 });
  try {
    const token = rootToken(h);
    await h.orch.call(token, "spawn_child", { cli: "fake", task: "FAKE: say a" });
    await h.orch.call(token, "wait_children", {});
    const blocked = await h.orch.call(token, "spawn_child", { cli: "fake", task: "FAKE: say b" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /budget/);
  } finally {
    await h.close();
  }
});

test("works without a git repository (no worktrees)", async () => {
  const h = await startHarness({}, false);
  try {
    const reply = await h.orch.chat(["FAKE: spawn fake FAKE: say plain", "FAKE: wait"].join("\n"));
    assert.match(reply, /plain/);
  } finally {
    await h.close();
  }
});

test("merge_child returns a pending message while approval is open, then merges after approval", async () => {
  const h = await startHarness();
  try {
    (h.orch as any).approvalWaitMs = 50;
    const token = rootToken(h);
    const spawned = JSON.parse((await h.orch.call(token, "spawn_child", { cli: "fake", task: "FAKE: write p.txt pending" })).text);
    await h.orch.call(token, "wait_children", {});
    const first = await h.orch.call(token, "merge_child", { id: spawned.id });
    assert.match(first.text, /not answered yet/);
    assert.equal(h.orch.pendingApprovals().length, 1);
    assert.equal(existsSync(join(h.repoDir, "p.txt")), false);
    h.orch.resolveApproval(h.orch.pendingApprovals()[0].id, true);
    const second = await h.orch.call(token, "merge_child", { id: spawned.id });
    assert.match(second.text, /merged/);
    assert.equal(read(join(h.repoDir, "p.txt")), "pending\n");
  } finally {
    await h.close();
  }
});

test("an instruction sent to a running child is queued and applied when it finishes", async () => {
  const h = await startHarness();
  try {
    const token = rootToken(h);
    const spawned = JSON.parse((await h.orch.call(token, "spawn_child", { cli: "fake", task: "FAKE: sleep 700\nFAKE: say first" })).text);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const queued = await h.orch.messageNode(spawned.id, "FAKE: say second");
    assert.match(queued, /queued/);
    const waited = JSON.parse((await h.orch.call(token, "wait_children", {})).text);
    assert.match(waited.notes[0], /while it was running/);
    const deadline = Date.now() + 10000;
    while (h.orch.registry.get(spawned.id)!.result !== "second" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.orch.registry.get(spawned.id)!.result, "second");
    assert.equal(h.orch.registry.get(spawned.id)!.status, "done");
  } finally {
    await h.close();
  }
});

test("restoring from recorded events rebuilds the tree and marks interrupted nodes", async () => {
  const h = await startHarness();
  try {
    const reply = await h.orch.chat(["FAKE: spawn fake FAKE: say kept", "FAKE: wait", "FAKE: say root-done"].join("\n"));
    assert.match(reply, /root-done/);
    const token = rootToken(h);
    await h.orch.call(token, "spawn_child", { cli: "fake", task: "FAKE: sleep 30000" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const events = [...h.bus.history];
    const { EventBus } = await import("../src/core/events.ts");
    const { Orchestrator } = await import("../src/orchestrator.ts");
    const { fakeAdapter } = await import("../src/adapters/fake.ts");
    const second = new Orchestrator({
      charter: h.orch.charter,
      adapters: { fake: fakeAdapter("fake") },
      repoDir: h.repoDir,
      dataDir: h.dataDir,
      bus: new EventBus(undefined, events),
      mcpBaseUrl: () => "http://127.0.0.1:1",
      restore: events,
    });
    const byId = Object.fromEntries(second.tree().map((n) => [n.id, n]));
    assert.equal(byId.c1.status, "done");
    assert.equal(byId.c2.status, "stopped");
    assert.equal(second.registry.get("c1")!.result, "kept");
    assert.ok(second.registry.get("c1")!.branch);
    assert.ok(second.registry.get("root")!.sessionId);
    assert.match(second.registry.get("root")!.inbox[0], /c2/);
    const next = await second.call(second.registry.get("root")!.token, "spawn_child", { cli: "fake", task: "FAKE: say again" });
    assert.equal(JSON.parse(next.text).id, "c3");
    await second.shutdown();
  } finally {
    await h.close();
  }
});
