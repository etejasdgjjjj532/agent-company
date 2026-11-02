import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, escapeCmdArgument, escapeCmdCommand, findOnPath, resolveSpawn } from "../src/core/platform.ts";

test("dataHome honours overrides and per-OS defaults", () => {
  assert.equal(dataHome("linux", { AGENT_COMPANY_HOME: "/x" }), "/x");
  assert.match(dataHome("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }), /agent-company$/);
  assert.match(dataHome("darwin", {}), /Library.Application Support.agent-company$/);
  assert.match(dataHome("linux", { XDG_DATA_HOME: "/data" }), /agent-company$/);
});

test("cmd.exe escaping quotes spaces and shell metacharacters", () => {
  assert.equal(escapeCmdArgument("plain"), '^"plain^"');
  assert.equal(escapeCmdArgument("a b"), '^"a^ b^"');
  assert.equal(escapeCmdArgument('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(escapeCmdArgument("dir\\"), '^"dir\\\\^"');
  assert.equal(escapeCmdCommand("C:\\Program Files\\x.cmd"), "C:\\Program^ Files\\x.cmd");
});

test("resolveSpawn is a passthrough on posix", () => {
  assert.deepEqual(resolveSpawn("claude", ["-p"], {}, "linux"), { file: "claude", args: ["-p"] });
});

test("resolveSpawn wraps .cmd shims through cmd.exe on windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-plat-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "codex.cmd"), "@echo off\r\n");
    writeFileSync(join(dir, "bin", "claude.exe"), "");
    const env = { PATH: join(dir, "bin"), PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "cmd.exe" };
    const wrapped = resolveSpawn("codex", ["exec", "--json"], env, "win32");
    assert.equal(wrapped.file, "cmd.exe");
    assert.deepEqual(wrapped.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(wrapped.windowsVerbatimArguments, true);
    assert.match(wrapped.args[3], /codex\.cmd/);
    const direct = resolveSpawn("claude", ["-p"], env, "win32");
    assert.match(direct.file, /claude\.exe$/);
    assert.deepEqual(direct.args, ["-p"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findOnPath returns null for missing commands", () => {
  assert.equal(findOnPath("definitely-not-a-real-command-xyz", { PATH: "/nonexistent" }, "linux"), null);
});
