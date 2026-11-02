import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { buildCharter, type CharterInput } from "../src/core/charter.ts";
import { EventBus } from "../src/core/events.ts";
import { createMcpServer } from "../src/mcp/http.ts";
import { Orchestrator } from "../src/orchestrator.ts";

export interface Harness {
  orch: Orchestrator;
  bus: EventBus;
  repoDir: string;
  dataDir: string;
  baseDir: string;
  close(): Promise<void>;
}

export function makeRepo(dir: string): void {
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "test");
  run("config", "user.email", "test@example.com");
  writeFileSync(join(dir, "README.md"), "hello\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
}

export async function startHarness(input: Partial<CharterInput> = {}, withRepo = true): Promise<Harness> {
  const baseDir = mkdtempSync(join(tmpdir(), "ac-test-"));
  const repoDir = join(baseDir, "repo");
  const dataDir = join(baseDir, "data");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  if (withRepo) makeRepo(repoDir);
  const charter = buildCharter({ rootCli: "fake", childClis: ["fake"], preset: "standard", ...input });
  const bus = new EventBus();
  let port = 0;
  const holder: { orch?: Orchestrator } = {};
  const server = createMcpServer({
    toolsFor: (token) => holder.orch!.toolsFor(token),
    call: (token, name, args) => holder.orch!.call(token, name, args),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  const orch = new Orchestrator({
    charter,
    adapters: { fake: fakeAdapter("fake") },
    repoDir,
    dataDir,
    bus,
    mcpBaseUrl: () => `http://127.0.0.1:${port}`,
  });
  holder.orch = orch;
  return {
    orch,
    bus,
    repoDir,
    dataDir,
    baseDir,
    async close() {
      await orch.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "ignore" });
      } catch {
        // repo may not exist
      }
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

export function autoApprove(bus: EventBus, orch: Orchestrator, answer = true): void {
  bus.subscribe((event) => {
    if (event.type === "approval.requested") {
      queueMicrotask(() => orch.resolveApproval(String(event.data?.id), answer));
    }
  });
}
