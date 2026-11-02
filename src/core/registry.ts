import type { NodeStatus } from "./events.ts";

export interface AgentNode {
  id: string;
  parentId: string | null;
  depth: number;
  cli: string;
  role: string;
  task: string;
  status: NodeStatus;
  token: string;
  cwd: string;
  branch?: string;
  sessionId?: string;
  result?: string;
  resultFile?: string;
  error?: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  startedAt?: number;
  endedAt?: number;
  inbox: string[];
}

export interface NodeView {
  id: string;
  parentId: string | null;
  depth: number;
  cli: string;
  role: string;
  task: string;
  status: NodeStatus;
  branch?: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  startedAt?: number;
  endedAt?: number;
  childCount: number;
}

export class Registry {
  private nodes = new Map<string, AgentNode>();
  private byToken = new Map<string, string>();

  add(node: AgentNode): void {
    this.nodes.set(node.id, node);
    this.byToken.set(node.token, node.id);
  }

  get(id: string): AgentNode | undefined {
    return this.nodes.get(id);
  }

  byNodeToken(token: string): AgentNode | undefined {
    const id = this.byToken.get(token);
    return id ? this.nodes.get(id) : undefined;
  }

  children(id: string): AgentNode[] {
    return [...this.nodes.values()].filter((node) => node.parentId === id);
  }

  all(): AgentNode[] {
    return [...this.nodes.values()];
  }

  size(): number {
    return this.nodes.size;
  }

  view(node: AgentNode): NodeView {
    return {
      id: node.id,
      parentId: node.parentId,
      depth: node.depth,
      cli: node.cli,
      role: node.role,
      task: node.task,
      status: node.status,
      branch: node.branch,
      attempts: node.attempts,
      inputTokens: node.inputTokens,
      outputTokens: node.outputTokens,
      costUsd: node.costUsd,
      startedAt: node.startedAt,
      endedAt: node.endedAt,
      childCount: this.children(node.id).length,
    };
  }

  snapshot(): NodeView[] {
    return this.all().map((node) => this.view(node));
  }
}
