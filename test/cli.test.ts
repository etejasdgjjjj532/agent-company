import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import { parseCharter } from "../src/core/charter.ts";
import { describeCharter, heuristicTasks, parseAdvice, runWizard, type WizardIO } from "../src/secretary.ts";
import { Hub } from "../src/hub.ts";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { buildCharter } from "../src/core/charter.ts";
import { makeRepo } from "./helpers.ts";
import { readJsonl } from "../src/core/store.ts";
import { versionAtLeast } from "../src/doctor.ts";

function scripted(answers: string[]): { io: WizardIO; said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    said,
    asked,
    io: {
      say: (text) => said.push(text),
      ask: async (question, fallback = "") => {
        asked.push(question);
        const next = queue.shift();
        return next === undefined || next === "" ? fallback : next;
      },
    },
  };
}

test("parseArgs: defaults to start and reads value flags", () => {
  const a = parseArgs(["--repo", "/x", "--fake", "--goal=do it"]);
  assert.equal(a.command, "start");
  assert.equal(a.flags.get("repo"), "/x");
  assert.equal(a.flags.get("fake"), true);
  assert.equal(a.flags.get("goal"), "do it");
  assert.equal(parseArgs(["doctor"]).command, "doctor");
  assert.deepEqual(parseArgs(["replay", "f.jsonl"]).positional, ["f.jsonl"]);
});

test("doctor: version comparison", () => {
  assert.equal(versionAtLeast("22.18.0", [22, 18]), true);
  assert.equal(versionAtLeast("22.17.9", [22, 18]), false);
  assert.equal(versionAtLeast("26.8.2", [22, 18]), true);
});

test("secretary: recommends a preset from the goal and writes a valid charter", async () => {
  const goal = "API を作る、画面を作る、テストを書く、ドキュメントを書く、CI を整える";
  assert.ok(heuristicTasks(goal) >= 5);
  const { io, said } = scripted([goal, "claude", "claude,codex", "", "", "", "y"]);
  const result = await runWizard({ io, available: ["claude", "codex"] });
  assert.ok(result);
  assert.match(said.join("\n"), /おすすめは「標準」/);
  const charter = parseCharter(result.toml);
  assert.equal(charter.limits.maxDepth, 2);
  assert.deepEqual(charter.limits.levels[1].allowedCli, ["claude", "codex"]);
  assert.match(describeCharter(charter), /Root \(claude\)/);
});

test("secretary: manual depth and concurrency override the preset", async () => {
  const { io } = scripted(["", "claude", "claude", "light", "3", "2", "y"]);
  const result = await runWizard({ io, available: ["claude"] });
  const charter = parseCharter(result!.toml);
  assert.equal(charter.limits.maxDepth, 3);
  assert.equal(charter.maxConcurrent, 2);
  assert.equal(charter.limits.levels[3].canSpawn, false);
});

test("secretary: unavailable root falls back, decline saves nothing, no CLIs aborts", async () => {
  const fallback = scripted(["", "gemini", "", "", "", "", "y"]);
  const result = await runWizard({ io: fallback.io, available: ["claude"] });
  assert.equal(parseCharter(result!.toml).rootCli, "claude");
  const declined = scripted(["", "", "", "", "", "", "n"]);
  assert.equal(await runWizard({ io: declined.io, available: ["claude"] }), null);
  const none = scripted([]);
  assert.equal(await runWizard({ io: none.io, available: [] }), null);
});

test("secretary: advisor result is used when the user opts in", async () => {
  const { io, said } = scripted(["大きな目標", "claude", "claude", "y", "", "", "", "y"]);
  const result = await runWizard({
    io,
    available: ["claude"],
    advisor: async () => ({ independentTasks: 12, reason: "モジュールが多い" }),
  });
  assert.match(said.join("\n"), /おすすめは「大規模」/);
  assert.equal(parseCharter(result!.toml).limits.maxDepth, 3);
});

test("parseAdvice: extracts JSON from chatty output and rejects garbage", () => {
  assert.deepEqual(parseAdvice('sure: {"independent_tasks": 4, "reason": "ok"} done'), { independentTasks: 4, reason: "ok" });
  assert.equal(parseAdvice("no json"), null);
  assert.equal(parseAdvice('{"independent_tasks": 0}'), null);
});

test("hub: a started session records masked events and is listed after it stops", async () => {
  const base = mkdtempSync(join(tmpdir(), "ac-hub-"));
  const repoDir = join(base, "repo");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(repoDir);
  makeRepo(repoDir);
  const hub = new Hub({ adapters: { claude: fakeAdapter("claude") }, home: join(base, "home") });
  try {
    const meta = await hub.start({ repoDir, charter: buildCharter({ rootCli: "claude", childClis: ["claude"], preset: "light" }) });
    await hub.active!.orch.chat("FAKE: say token=supersecretvalue99");
    const file = join(base, "home", "runs", meta.id, "events.jsonl");
    assert.ok(existsSync(file));
    assert.ok(!readFileSync(file, "utf8").includes("supersecretvalue99"));
    assert.ok(readJsonl(file).some((e) => e.type === "chat.reply"));
    assert.equal(hub.sessions()[0].active, true);
    await hub.stop();
    assert.equal(hub.sessions()[0].active, false);
    assert.ok(hub.readEvents(meta.id).length > 0);
    assert.throws(() => hub.readEvents("../etc"));
  } finally {
    await hub.stop();
    rmSync(base, { recursive: true, force: true });
  }
});
