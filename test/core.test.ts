import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToml, stringifyToml } from "../src/core/toml.ts";
import { buildCharter, parseCharter, serializeCharter, recommendPreset, validateCharter } from "../src/core/charter.ts";
import { maskSecrets, REDACTED } from "../src/core/mask.ts";
import { EventBus } from "../src/core/events.ts";
import { createJsonlSink, readJsonl } from "../src/core/store.ts";

test("toml: parses tables, arrays, comments and numeric table names", () => {
  const out = parseToml(`
name = "demo" # trailing
[limits]
max_depth = 3
[level.1]
allowed_cli = ["claude", "codex"]
can_spawn = true
`);
  assert.equal(out.name, "demo");
  assert.deepEqual((out.limits as any).max_depth, 3);
  assert.deepEqual((out.level as any)["1"].allowed_cli, ["claude", "codex"]);
  assert.equal((out.level as any)["1"].can_spawn, true);
});

test("toml: round-trips through stringify", () => {
  const source = { name: "x", a: { b: 1, c: ["p", "q"] }, d: { "1": { e: true } } };
  assert.deepEqual(parseToml(stringifyToml(source)), source);
});

test("toml: rejects unsupported values", () => {
  assert.throws(() => parseToml("a = {b = 1}"));
});

test("charter: presets build valid charters and round-trip", () => {
  for (const preset of ["light", "standard", "large"] as const) {
    const charter = buildCharter({ rootCli: "claude", preset, childClis: ["claude", "codex"] });
    validateCharter(charter);
    assert.deepEqual(parseCharter(serializeCharter(charter)), charter);
  }
});

test("charter: manual depth overrides the preset", () => {
  const charter = buildCharter({ rootCli: "claude", preset: "light", maxDepth: 4 });
  assert.equal(charter.limits.maxDepth, 4);
  assert.equal(charter.limits.levels[4].canSpawn, false);
  assert.equal(charter.limits.levels[3].canSpawn, true);
});

test("charter: rejects a deepest level that can spawn", () => {
  const charter = buildCharter({ rootCli: "claude" });
  charter.limits.levels[charter.limits.maxDepth].canSpawn = true;
  assert.throws(() => validateCharter(charter));
});

test("charter: rejects unknown cli names", () => {
  const charter = buildCharter({ rootCli: "claude", childClis: ["nope"] });
  assert.throws(() => validateCharter(charter), /unknown cli/);
});

test("charter: recommends presets by task count", () => {
  assert.equal(recommendPreset(2), "light");
  assert.equal(recommendPreset(5), "standard");
  assert.equal(recommendPreset(12), "large");
});

test("mask: hides common secret shapes", () => {
  const text = "key sk-ant-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstu and API_KEY=abcdef123456 Bearer abcdefghijklmnopqrstuv";
  const out = maskSecrets(text);
  assert.ok(!out.includes("abcdefghijklmnop1234"));
  assert.ok(!out.includes("ghp_abcdefghijklmnopqrstu"));
  assert.ok(!out.includes("abcdef123456"));
  assert.ok(out.includes(REDACTED));
  assert.ok(out.includes("Bearer " + REDACTED));
});

test("mask: leaves ordinary text alone", () => {
  assert.equal(maskSecrets("hello world, tokens: 12"), "hello world, tokens: 12");
});

test("events: bus numbers events and sink writes masked JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-"));
  try {
    const file = join(dir, "e.jsonl");
    const bus = new EventBus(createJsonlSink(file));
    bus.emit("a", "n1", { text: "token=supersecretvalue" });
    bus.emit("b");
    const events = readJsonl(file);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);
    assert.ok(!JSON.stringify(events).includes("supersecretvalue"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
