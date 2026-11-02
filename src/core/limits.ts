export interface LevelLimits {
  maxChildren: number;
  allowedCli: string[];
  canSpawn: boolean;
}

export interface Limits {
  maxDepth: number;
  maxTotalNodes: number;
  levels: Record<number, LevelLimits>;
}

export interface SpawnRequest {
  parentDepth: number;
  parentChildCount: number;
  totalNodes: number;
  cli: string;
}

export type SpawnCheck = { ok: true } | { ok: false; reason: string };

export function checkSpawn(limits: Limits, req: SpawnRequest): SpawnCheck {
  const childDepth = req.parentDepth + 1;
  if (childDepth > limits.maxDepth) {
    return { ok: false, reason: `max_depth ${limits.maxDepth} exceeded` };
  }
  if (req.totalNodes + 1 > limits.maxTotalNodes) {
    return { ok: false, reason: `max_total_nodes ${limits.maxTotalNodes} exceeded` };
  }
  const parentLevel = limits.levels[req.parentDepth];
  if (!parentLevel || !parentLevel.canSpawn) {
    return { ok: false, reason: `nodes at depth ${req.parentDepth} cannot spawn` };
  }
  if (req.parentChildCount + 1 > parentLevel.maxChildren) {
    return { ok: false, reason: `max_children ${parentLevel.maxChildren} exceeded` };
  }
  const childLevel = limits.levels[childDepth];
  if (!childLevel || !childLevel.allowedCli.includes(req.cli)) {
    return { ok: false, reason: `cli "${req.cli}" not allowed at depth ${childDepth}` };
  }
  return { ok: true };
}
