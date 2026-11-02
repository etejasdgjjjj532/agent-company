import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSpawn, type Limits } from "../src/core/limits.ts";

const limits: Limits = {
  maxDepth: 3,
  maxTotalNodes: 5,
  levels: {
    0: { maxChildren: 2, allowedCli: ["claude"], canSpawn: true },
    1: { maxChildren: 2, allowedCli: ["claude", "codex"], canSpawn: true },
    2: { maxChildren: 1, allowedCli: ["codex", "opencode"], canSpawn: true },
    3: { maxChildren: 0, allowedCli: ["opencode"], canSpawn: false },
  },
};

const base = { parentDepth: 0, parentChildCount: 0, totalNodes: 1, cli: "codex" };

test("allows a spawn within all limits", () => {
  assert.deepEqual(checkSpawn(limits, { ...base, parentDepth: 1, totalNodes: 2 }), { ok: true });
});

test("rejects a child deeper than max_depth", () => {
  const r = checkSpawn(limits, { ...base, parentDepth: 3, cli: "opencode" });
  assert.equal(r.ok, false);
});

test("rejects when the parent level cannot spawn", () => {
  const r = checkSpawn({ ...limits, maxDepth: 4 }, { ...base, parentDepth: 3, cli: "opencode" });
  assert.equal(r.ok, false);
});

test("rejects when the parent already has max_children", () => {
  const r = checkSpawn(limits, { ...base, parentDepth: 1, parentChildCount: 2, totalNodes: 2 });
  assert.equal(r.ok, false);
});

test("rejects when the tree is at max_total_nodes", () => {
  const r = checkSpawn(limits, { ...base, parentDepth: 1, totalNodes: 5 });
  assert.equal(r.ok, false);
});

test("rejects a cli not allowed at the child depth", () => {
  const r = checkSpawn(limits, { ...base, parentDepth: 0, cli: "opencode" });
  assert.equal(r.ok, false);
});
