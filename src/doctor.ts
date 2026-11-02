import { spawnSync } from "node:child_process";
import { findOnPath, resolveSpawn } from "./core/platform.ts";
import { KNOWN_CLIS } from "./core/charter.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  required: boolean;
}

const INSTALL_HINT: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  gemini: "npm install -g @google/gemini-cli  (初回に認証が必要: GEMINI_API_KEY かログイン)",
  opencode: "npm install -g opencode-ai",
};

const BIN_ENV: Record<string, string> = {
  claude: "AGENT_COMPANY_CLAUDE_BIN",
  codex: "AGENT_COMPANY_CODEX_BIN",
  gemini: "AGENT_COMPANY_GEMINI_BIN",
  opencode: "AGENT_COMPANY_OPENCODE_BIN",
};

export function versionAtLeast(actual: string, needed: [number, number]): boolean {
  const [major, minor] = actual.split(".").map(Number);
  return major > needed[0] || (major === needed[0] && minor >= needed[1]);
}

function probe(command: string, args: string[]): string | null {
  const spec = resolveSpawn(command, args);
  const result = spawnSync(spec.file, spec.args, {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout}${result.stderr}`.trim().split("\n")[0];
}

export function cliCommand(name: string): string {
  return process.env[BIN_ENV[name]] ?? name;
}

export function detectClis(): string[] {
  if (process.env.AGENT_COMPANY_FAKE === "1") return [...KNOWN_CLIS];
  return KNOWN_CLIS.filter((name) => findOnPath(cliCommand(name)) !== null);
}

export function runDoctor(): Check[] {
  const checks: Check[] = [];
  checks.push({
    name: "Node.js",
    ok: versionAtLeast(process.versions.node, [22, 18]),
    detail: `v${process.versions.node}`,
    hint: "Node.js 22.18 以上が必要です: https://nodejs.org/",
    required: true,
  });
  const gitVersion = probe("git", ["--version"]);
  checks.push({
    name: "git",
    ok: gitVersion !== null,
    detail: gitVersion ?? "見つかりません",
    hint: "git を入れてください: https://git-scm.com/downloads",
    required: true,
  });
  for (const name of KNOWN_CLIS) {
    const command = cliCommand(name);
    const path = findOnPath(command);
    const version = path ? probe(command, ["--version"]) : null;
    checks.push({
      name,
      ok: path !== null,
      detail: path ? `${version ?? "version 不明"}  (${path})` : "未インストール",
      hint: path ? undefined : INSTALL_HINT[name],
      required: false,
    });
  }
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map((c) => {
    const mark = c.ok ? "OK " : c.required ? "NG " : "-- ";
    return `${mark} ${c.name.padEnd(9)} ${c.detail}${c.ok || !c.hint ? "" : `\n      ${c.hint}`}`;
  });
  const clis = checks.filter((c) => KNOWN_CLIS.includes(c.name as never) && c.ok).length;
  lines.push("");
  lines.push(clis === 0 ? "エージェント CLI が 1 つも見つかりません。上の案内でどれか 1 つ入れてください。" : `使える CLI: ${clis} 種類`);
  lines.push("各 CLI のログイン (認証) は、それぞれのコマンドを一度起動して済ませておいてください。");
  return lines.join("\n");
}

export function doctorPasses(checks: Check[]): boolean {
  return checks.filter((c) => c.required).every((c) => c.ok) && checks.some((c) => KNOWN_CLIS.includes(c.name as never) && c.ok);
}
