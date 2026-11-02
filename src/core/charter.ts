import { parseToml, stringifyToml, type TomlTable, type TomlValue } from "./toml.ts";
import type { LevelLimits, Limits } from "./limits.ts";

export const KNOWN_CLIS = ["claude", "codex", "gemini", "opencode"] as const;

const isEngine = (name: string): boolean => (KNOWN_CLIS as readonly string[]).includes(name) || /^api:[a-z0-9][a-z0-9-]{0,40}(:.+)?$/.test(name);

export interface Charter {
  name: string;
  rootCli: string;
  secretaryCli: string;
  maxConcurrent: number;
  maxRetries: number;
  maxNodeMinutes: number;
  maxTotalTokens: number;
  limits: Limits;
}

export type PresetName = "light" | "standard" | "large";

interface PresetSpec {
  maxDepth: number;
  maxConcurrent: number;
  maxTotalNodes: number;
  maxChildren: number[];
}

export const PRESETS: Record<PresetName, PresetSpec> = {
  light: { maxDepth: 1, maxConcurrent: 2, maxTotalNodes: 4, maxChildren: [3] },
  standard: { maxDepth: 2, maxConcurrent: 3, maxTotalNodes: 8, maxChildren: [4, 2] },
  large: { maxDepth: 3, maxConcurrent: 4, maxTotalNodes: 12, maxChildren: [4, 3, 2] },
};

export interface CharterInput {
  name?: string;
  rootCli: string;
  secretaryCli?: string;
  preset?: PresetName;
  maxDepth?: number;
  maxConcurrent?: number;
  maxTotalNodes?: number;
  maxChildren?: number;
  maxRetries?: number;
  maxNodeMinutes?: number;
  maxTotalTokens?: number;
  childClis?: string[];
}

export function buildCharter(input: CharterInput): Charter {
  const base = PRESETS[input.preset ?? "standard"];
  const maxDepth = input.maxDepth ?? base.maxDepth;
  const childClis = input.childClis ?? [input.rootCli];
  const levels: Record<number, LevelLimits> = {
    0: { maxChildren: input.maxChildren ?? base.maxChildren[0] ?? 3, allowedCli: [input.rootCli], canSpawn: true },
  };
  for (let depth = 1; depth <= maxDepth; depth++) {
    const isLeaf = depth === maxDepth;
    const maxChildren = input.maxChildren ?? base.maxChildren[depth] ?? 2;
    levels[depth] = { maxChildren: isLeaf ? 0 : maxChildren, allowedCli: childClis, canSpawn: !isLeaf };
  }
  return {
    name: input.name ?? "agent-company",
    rootCli: input.rootCli,
    secretaryCli: input.secretaryCli ?? input.rootCli,
    maxConcurrent: input.maxConcurrent ?? base.maxConcurrent,
    maxRetries: input.maxRetries ?? 2,
    maxNodeMinutes: input.maxNodeMinutes ?? 20,
    maxTotalTokens: input.maxTotalTokens ?? 0,
    limits: { maxDepth, maxTotalNodes: input.maxTotalNodes ?? base.maxTotalNodes, levels },
  };
}

function num(table: TomlTable, key: string, fallback?: number): number {
  const value = table[key];
  if (typeof value === "number") return value;
  if (value === undefined && fallback !== undefined) return fallback;
  throw new Error(`charter: "${key}" must be a number`);
}

function table(value: TomlValue | undefined, name: string): TomlTable {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  throw new Error(`charter: [${name}] is missing`);
}

export function validateCharter(charter: Charter): void {
  const { limits } = charter;
  if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 1) throw new Error("charter: max_depth must be >= 1");
  if (limits.maxTotalNodes < 2) throw new Error("charter: max_total_nodes must be >= 2");
  if (charter.maxConcurrent < 1) throw new Error("charter: max_concurrent must be >= 1");
  for (let depth = 0; depth <= limits.maxDepth; depth++) {
    const level = limits.levels[depth];
    if (!level) throw new Error(`charter: [level.${depth}] is missing`);
    if (level.canSpawn && level.maxChildren < 1) throw new Error(`charter: level.${depth} can_spawn needs max_children >= 1`);
    if (depth > 0 && level.allowedCli.length === 0) throw new Error(`charter: level.${depth} allowed_cli is empty`);
    for (const cli of level.allowedCli) {
      if (!isEngine(cli)) throw new Error(`charter: unknown cli "${cli}"`);
    }
  }
  if (limits.levels[limits.maxDepth].canSpawn) throw new Error("charter: the deepest level must have can_spawn = false");
  if (!isEngine(charter.rootCli)) throw new Error(`charter: unknown root cli "${charter.rootCli}"`);
}

export function parseCharter(source: string): Charter {
  const root = parseToml(source);
  const limitsTable = table(root.limits, "limits");
  const rootTable = table(root.root, "root");
  const levelTable = table(root.level, "level");
  const maxDepth = num(limitsTable, "max_depth");
  const levels: Record<number, LevelLimits> = {};
  for (const [key, value] of Object.entries(levelTable)) {
    const entry = table(value, `level.${key}`);
    levels[Number(key)] = {
      maxChildren: num(entry, "max_children"),
      allowedCli: ((entry.allowed_cli as string[] | undefined) ?? []).map(String),
      canSpawn: entry.can_spawn === true,
    };
  }
  const rootCli = String(rootTable.cli ?? "");
  const secretary = root.secretary && typeof root.secretary === "object" ? (root.secretary as TomlTable) : undefined;
  const charter: Charter = {
    name: typeof root.name === "string" ? root.name : "agent-company",
    rootCli,
    secretaryCli: String(secretary?.cli ?? rootCli),
    maxConcurrent: num(limitsTable, "max_concurrent"),
    maxRetries: num(limitsTable, "max_retries", 2),
    maxNodeMinutes: num(limitsTable, "max_node_minutes", 20),
    maxTotalTokens: num(limitsTable, "max_total_tokens", 0),
    limits: { maxDepth, maxTotalNodes: num(limitsTable, "max_total_nodes"), levels },
  };
  validateCharter(charter);
  return charter;
}

export function serializeCharter(charter: Charter): string {
  const level: TomlTable = {};
  for (const [depth, spec] of Object.entries(charter.limits.levels)) {
    level[depth] = { max_children: spec.maxChildren, allowed_cli: spec.allowedCli, can_spawn: spec.canSpawn };
  }
  return stringifyToml({
    name: charter.name,
    limits: {
      max_depth: charter.limits.maxDepth,
      max_total_nodes: charter.limits.maxTotalNodes,
      max_concurrent: charter.maxConcurrent,
      max_retries: charter.maxRetries,
      max_node_minutes: charter.maxNodeMinutes,
      max_total_tokens: charter.maxTotalTokens,
    },
    root: { cli: charter.rootCli },
    secretary: { cli: charter.secretaryCli },
    level,
  });
}

export function recommendPreset(independentTasks: number): PresetName {
  if (independentTasks <= 3) return "light";
  if (independentTasks <= 8) return "standard";
  return "large";
}
