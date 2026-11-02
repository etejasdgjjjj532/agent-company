import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Adapter, AdapterEvent, RunOptions } from "./types.ts";

export interface RunResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  exitCode: number | null;
  stopped: boolean;
  stderrTail: string;
}

export interface AgentRun {
  promise: Promise<RunResult>;
  stop(): void;
}

export interface RunnerOptions {
  timeoutMs?: number;
}

export function runAgent(
  adapter: Adapter,
  opts: RunOptions,
  onEvent: (event: AdapterEvent) => void,
  runner: RunnerOptions = {},
): AgentRun {
  const invocation = adapter.invoke(opts);
  const child = spawn(invocation.cmd, invocation.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...invocation.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let lastText = "";
  let finalText: string | undefined;
  let isError = false;
  let sessionId = opts.sessionId;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  let stopped = false;
  let stderr = "";
  let killTimer: NodeJS.Timeout | undefined;

  const handle = (event: AdapterEvent) => {
    if (event.kind === "session") sessionId = event.sessionId;
    else if (event.kind === "text") lastText = event.text;
    else if (event.kind === "usage") {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
      if (event.costUsd !== undefined) costUsd = (costUsd ?? 0) + event.costUsd;
    } else if (event.kind === "final") {
      if (event.isError) isError = true;
      if (!event.isError || finalText === undefined) finalText = event.text;
    }
    onEvent(event);
  };

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    for (const event of adapter.parseLine(line)) handle(event);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  const kill = () => {
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
  };
  const timeout = runner.timeoutMs ? setTimeout(() => { stopped = true; kill(); }, runner.timeoutMs) : undefined;

  const promise = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const text = finalText ?? lastText;
      resolve({
        ok: !stopped && !isError && exitCode === 0,
        text,
        sessionId,
        inputTokens,
        outputTokens,
        costUsd,
        exitCode,
        stopped,
        stderrTail: stderr,
      });
    };
    child.on("error", (error) => {
      stderr += String(error);
      isError = true;
      finish(null);
    });
    child.on("close", (code) => {
      rl.close();
      finish(code);
    });
  });

  return {
    promise,
    stop() {
      stopped = true;
      kill();
    },
  };
}
