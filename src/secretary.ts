import { buildCharter, KNOWN_CLIS, PRESETS, recommendPreset, serializeCharter, validateCharter, type Charter, type PresetName } from "./core/charter.ts";
import { runAgent } from "./adapters/runner.ts";
import type { Adapter } from "./adapters/types.ts";

export interface WizardIO {
  ask(question: string, fallback?: string): Promise<string>;
  say(text: string): void;
}

export interface WizardOptions {
  io: WizardIO;
  available: string[];
  advisor?: (goal: string, rootCli: string) => Promise<ScaleAdvice | null>;
  existing?: string;
}

export interface ScaleAdvice {
  independentTasks: number;
  reason: string;
}

export interface WizardResult {
  charter: Charter;
  toml: string;
}

const PRESET_LABEL: Record<PresetName, string> = { light: "軽量", standard: "標準", large: "大規模" };

export function heuristicTasks(goal: string): number {
  const parts = goal.split(/[\n、,;；・]|(?:\s(?:and|と)\s)|(?:と(?=[^\s]))/).map((s) => s.trim()).filter((s) => s.length > 1);
  return Math.max(1, parts.length);
}

export function describeCharter(charter: Charter): string {
  const { limits } = charter;
  const lines: string[] = [];
  const names = ["Root", "子", "孫", "ひ孫", "玄孫", "来孫"];
  lines.push(`Root (${charter.rootCli})`);
  for (let depth = 1; depth <= limits.maxDepth; depth++) {
    const above = limits.levels[depth - 1];
    const level = limits.levels[depth];
    const indent = "   ".repeat(depth - 1);
    lines.push(`${indent}└─ ${names[depth] ?? `深さ${depth}`}: 最大${above.maxChildren}体/親 (${level.allowedCli.join(", ")})${level.canSpawn ? "" : " 末端"}`);
  }
  lines.push("");
  lines.push(`深さ ${limits.maxDepth} / 総ノード上限 ${limits.maxTotalNodes} / 同時実行 ${charter.maxConcurrent} / 再試行 ${charter.maxRetries} 回 / 1ノード ${charter.maxNodeMinutes} 分`);
  return lines.join("\n");
}

function pickList(input: string, allowed: string[]): string[] {
  const picked = input.split(/[\s,、]+/).map((s) => s.trim().toLowerCase()).filter((s) => allowed.includes(s));
  return [...new Set(picked)];
}

function positiveInt(input: string): number | undefined {
  const n = Number(input);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function runWizard(options: WizardOptions): Promise<WizardResult | null> {
  const { io, available } = options;
  io.say("秘書です。新しい組織の設計を一緒に決めましょう。");
  if (available.length === 0) {
    io.say(`使えるエージェントCLIが見つかりません (${KNOWN_CLIS.join(", ")})。先にインストールして、agent-company doctor を実行してください。`);
    return null;
  }
  const goal = (await io.ask("何をやりたいですか? (空でも可。台数のおすすめに使います)", "")).trim();
  const defaultRoot = available.includes("claude") ? "claude" : available[0];
  let rootCli = (await io.ask(`Root に使う CLI [${available.join("/")}]`, defaultRoot)).trim().toLowerCase();
  if (!available.includes(rootCli)) {
    io.say(`${rootCli} は使えないので ${defaultRoot} にします。`);
    rootCli = defaultRoot;
  }
  let childClis = pickList(await io.ask(`子以下で使う CLI (複数ならカンマ区切り) [${available.join(",")}]`, available.join(",")), available);
  if (childClis.length === 0) childClis = [...available];

  let advice: ScaleAdvice | null = null;
  if (goal && options.advisor) {
    const useAi = (await io.ask("AI に規模を相談しますか? (トークンを少し使います) [y/N]", "n")).trim().toLowerCase();
    if (useAi === "y" || useAi === "yes") {
      io.say("相談中です...");
      advice = await options.advisor(goal, rootCli).catch(() => null);
      if (!advice) io.say("相談に失敗したので、目的の文面から見積もります。");
    }
  }
  const tasks = advice?.independentTasks ?? heuristicTasks(goal);
  const recommended = recommendPreset(tasks);
  io.say(`独立して進められる作業は約 ${tasks} 件${advice ? ` (${advice.reason})` : ""}。おすすめは「${PRESET_LABEL[recommended]}」です。`);
  io.say((Object.keys(PRESETS) as PresetName[]).map((name) => {
    const p = PRESETS[name];
    return `  ${name.padEnd(8)} ${PRESET_LABEL[name]}: 深さ${p.maxDepth} / 同時${p.maxConcurrent} / 総数${p.maxTotalNodes}`;
  }).join("\n"));

  let preset = (await io.ask("規模 [light/standard/large]", recommended)).trim().toLowerCase() as PresetName;
  if (!(preset in PRESETS)) preset = recommended;
  const maxDepth = positiveInt(await io.ask(`深さを数字で指定 (Enter で ${PRESETS[preset].maxDepth})`, ""));
  const maxConcurrent = positiveInt(await io.ask(`同時に動かす数 (Enter で ${PRESETS[preset].maxConcurrent})`, ""));

  const charter = buildCharter({ name: "agent-company", rootCli, childClis, preset, maxDepth, maxConcurrent });
  validateCharter(charter);
  io.say(`\nこの組織でよいですか?\n${describeCharter(charter)}\n`);
  const approve = (await io.ask("承認して保存します [Y/n]", "y")).trim().toLowerCase();
  if (approve === "n" || approve === "no") {
    io.say("保存しませんでした。");
    return null;
  }
  return { charter, toml: serializeCharter(charter) };
}

export function parseAdvice(text: string): ScaleAdvice | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]) as { independent_tasks?: unknown; reason?: unknown };
    const n = Number(value.independent_tasks);
    if (!Number.isFinite(n) || n < 1) return null;
    return { independentTasks: Math.round(n), reason: String(value.reason ?? "").slice(0, 120) };
  } catch {
    return null;
  }
}

export function makeAdvisor(adapters: Record<string, Adapter>, cwd: string, workDir: string): WizardOptions["advisor"] {
  return async (goal, rootCli) => {
    const adapter = adapters[rootCli];
    if (!adapter) return null;
    const prompt = [
      "Estimate how many independent subtasks can be worked on in parallel for the goal below.",
      'Answer with JSON only, like {"independent_tasks": 3, "reason": "short reason in Japanese"}. Do not use any tools.',
      "",
      `Goal: ${goal}`,
    ].join("\n");
    const run = runAgent(adapter, { cwd, prompt, profile: "root", workDir }, () => undefined, { timeoutMs: 120_000 });
    const result = await run.promise;
    return result.ok ? parseAdvice(result.text) : null;
  };
}
