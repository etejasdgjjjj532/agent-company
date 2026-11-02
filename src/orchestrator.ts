import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type AgentRun, type RunResult } from "./adapters/runner.ts";
import type { Adapter, AdapterEvent, Profile } from "./adapters/types.ts";
import type { Charter } from "./core/charter.ts";
import type { EventBus, NodeStatus, OrchEvent } from "./core/events.ts";
import { checkSpawn } from "./core/limits.ts";
import { Registry, type AgentNode, type NodeView } from "./core/registry.ts";
import { commitAll, createWorktree, diffAgainst, git, isGitRepo, mergeBranch } from "./core/worktree.ts";
import type { McpHost, ToolDef, ToolResult } from "./mcp/http.ts";

export const ROOT_ID = "root";
const RESULT_LIMIT = 2000;
const TERMINAL: NodeStatus[] = ["done", "failed", "stopped"];

export interface OrchestratorOptions {
  charter: Charter;
  adapters: Record<string, Adapter>;
  repoDir: string;
  dataDir: string;
  bus: EventBus;
  mcpBaseUrl: () => string;
  approvalWaitMs?: number;
  restore?: OrchEvent[];
}

class Semaphore {
  private waiters: Array<() => void> = [];
  private free: number;

  constructor(size: number) {
    this.free = size;
  }

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

function clipResult(text: string): string {
  return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n... (truncated, full text in result file)` : text;
}

export class Orchestrator implements McpHost {
  readonly registry = new Registry();
  readonly charter: Charter;
  readonly bus: EventBus;
  private adapters: Record<string, Adapter>;
  private repoDir: string;
  private dataDir: string;
  private mcpBaseUrl: () => string;
  private useWorktrees: boolean;
  private slots: Semaphore;
  private holdsSlot = new Set<string>();
  private runs = new Map<string, AgentRun>();
  private reported = new Map<string, string>();
  private changes = new EventEmitter();
  private chatQueue: Promise<unknown> = Promise.resolve();
  private approvals = new Map<string, { nodeId: string; description: string; resolve: (ok: boolean) => void }>();
  private counters = new Map<string, number>();
  private runTag = randomBytes(3).toString("hex");
  private closed = false;
  private links = new Set<string>();
  private approvalWaitMs: number;
  private mergeApprovals = new Map<string, { state: "pending" | "approved" | "declined"; promise: Promise<boolean> }>();

  constructor(options: OrchestratorOptions) {
    this.charter = options.charter;
    this.adapters = options.adapters;
    this.repoDir = options.repoDir;
    this.dataDir = options.dataDir;
    this.bus = options.bus;
    this.mcpBaseUrl = options.mcpBaseUrl;
    this.approvalWaitMs = options.approvalWaitMs ?? 45_000;
    this.useWorktrees = isGitRepo(options.repoDir);
    this.slots = new Semaphore(options.charter.maxConcurrent);
    this.changes.setMaxListeners(0);
    this.registry.add({
      id: ROOT_ID,
      parentId: null,
      depth: 0,
      cli: this.charter.rootCli,
      role: "root",
      task: "Talk with the user and coordinate the team",
      status: "waiting",
      token: randomBytes(16).toString("hex"),
      cwd: this.repoDir,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      inbox: [],
      queued: [],
      messages: [],
    });
    if (options.restore) this.restoreFrom(options.restore);
    else this.bus.emit("node.created", ROOT_ID, { node: this.view(ROOT_ID) });
  }

  view(id: string): NodeView {
    return this.registry.view(this.registry.get(id) as AgentNode);
  }

  tree(): NodeView[] {
    return this.registry.snapshot();
  }

  pendingApprovals(): Array<{ id: string; nodeId: string; description: string }> {
    return [...this.approvals.entries()].map(([id, a]) => ({ id, nodeId: a.nodeId, description: a.description }));
  }

  totalTokens(): number {
    return this.registry.all().reduce((sum, node) => sum + node.inputTokens + node.outputTokens, 0);
  }

  private setStatus(node: AgentNode, status: NodeStatus, extra: Record<string, unknown> = {}): void {
    node.status = status;
    this.bus.emit("node.status", node.id, { status, ...extra });
    this.changes.emit("change");
  }

  private onAdapterEvent(node: AgentNode, event: AdapterEvent): void {
    if (event.kind === "session") {
      if (node.sessionId !== event.sessionId) {
        node.sessionId = event.sessionId;
        this.bus.emit("node.session", node.id, { sessionId: event.sessionId });
      }
    }
    else if (event.kind === "text") this.bus.emit("node.output", node.id, { kind: "text", text: event.text });
    else if (event.kind === "tool") this.bus.emit("node.output", node.id, { kind: "tool", name: event.name, text: event.summary });
    else if (event.kind === "usage") {
      node.inputTokens += event.inputTokens;
      node.outputTokens += event.outputTokens;
      if (event.costUsd !== undefined) node.costUsd = (node.costUsd ?? 0) + event.costUsd;
      this.bus.emit("node.usage", node.id, {
        inputTokens: node.inputTokens,
        outputTokens: node.outputTokens,
        costUsd: node.costUsd,
      });
    }
  }

  private async acquire(node: AgentNode): Promise<void> {
    await this.slots.acquire();
    this.holdsSlot.add(node.id);
  }

  private release(node: AgentNode): void {
    if (this.holdsSlot.delete(node.id)) this.slots.release();
  }

  private nextId(parent: AgentNode): string {
    const count = (this.counters.get(parent.id) ?? 0) + 1;
    this.counters.set(parent.id, count);
    return parent.id === ROOT_ID ? `c${count}` : `${parent.id}.${count}`;
  }

  private nodeDir(node: AgentNode): string {
    const dir = join(this.dataDir, "nodes", node.id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private mcpUrl(node: AgentNode): string {
    return `${this.mcpBaseUrl()}/mcp/${node.token}`;
  }

  private limitsText(node: AgentNode): string {
    const level = this.charter.limits.levels[node.depth];
    const child = this.charter.limits.levels[node.depth + 1];
    if (!level?.canSpawn || !child) return "You cannot create sub-agents; do the work yourself.";
    return `You may create up to ${level.maxChildren} sub-agents (allowed cli: ${child.allowedCli.join(", ")}) with spawn_child, then collect them with wait_children. Delegate only when it clearly speeds the work up.`;
  }

  private rootPrompt(message: string, first: boolean): string {
    if (!first) return message;
    return [
      "You are the Root agent of a team of coding agents. The user talks only to you.",
      "Split the work into independent subtasks and delegate them with the MCP tools of server \"orch\" (spawn_child, wait_children, get_child_diff, merge_child, get_tree_status).",
      "If sub-agents must coordinate, link them with link_children so they can send_message / read_messages to each other.",
      "Do not edit files yourself. After children finish, read their results, check get_child_diff, then call merge_child (it asks the user for approval).",
      this.limitsText(this.registry.get(ROOT_ID) as AgentNode),
      "Keep answers to the user short and concrete.",
      "",
      "--- USER REQUEST ---",
      message,
    ].join("\n");
  }

  private childPrompt(node: AgentNode): string {
    return [
      `You are a ${node.role} agent at depth ${node.depth} in a tree of coding agents.`,
      "Work only inside the current directory, which is your own git worktree. Do not use the network.",
      this.limitsText(node),
      "If your parent linked you with siblings, you may use send_message and read_messages to coordinate with them.",
      "Do not run git commit, merge, checkout or branch commands: your changes are committed for you when you finish.",
      `When finished, reply with a concise summary (under 1500 characters): what you did, files changed, anything blocking. You may also call the report tool with that summary.`,
      "",
      "--- TASK ---",
      node.task,
    ].join("\n");
  }

  async chat(message: string): Promise<string> {
    const turn = this.chatQueue.then(() => this.rootTurn(message));
    this.chatQueue = turn.catch(() => undefined);
    return turn;
  }

  private async rootTurn(message: string): Promise<string> {
    const root = this.registry.get(ROOT_ID) as AgentNode;
    this.bus.emit("chat.user", ROOT_ID, { text: message });
    const first = !root.sessionId;
    const adapter = this.adapters[root.cli];
    if (!adapter) throw new Error(`no adapter for ${root.cli}`);
    root.attempts++;
    root.startedAt ??= Date.now();
    this.setStatus(root, "running");
    const result = await this.execute(root, adapter, "root", this.rootPrompt(message, first || !adapter.supportsResume), root.sessionId);
    const text = result.text || (result.ok ? "(no reply)" : `Root failed: ${result.stderrTail.trim() || "unknown error"}`);
    this.setStatus(root, result.stopped ? "stopped" : "waiting");
    this.bus.emit("chat.reply", ROOT_ID, { text, ok: result.ok });
    return text;
  }

  private execute(node: AgentNode, adapter: Adapter, profile: Profile, prompt: string, sessionId?: string): Promise<RunResult> {
    const run = runAgent(
      adapter,
      {
        cwd: node.cwd,
        prompt,
        profile,
        mcpUrl: this.mcpUrl(node),
        sessionId,
        workDir: this.nodeDir(node),
        env: { AGENT_COMPANY_ATTEMPT: String(node.attempts), AGENT_COMPANY_NODE: node.id },
      },
      (event) => this.onAdapterEvent(node, event),
      { timeoutMs: this.charter.maxNodeMinutes * 60_000 },
    );
    this.runs.set(node.id, run);
    return run.promise.finally(() => this.runs.delete(node.id));
  }

  private spawnChild(parent: AgentNode, cli: string, role: string, task: string): AgentNode {
    const children = this.registry.children(parent.id);
    const check = checkSpawn(this.charter.limits, {
      parentDepth: parent.depth,
      parentChildCount: children.length,
      totalNodes: this.registry.size(),
      cli,
    });
    if (!check.ok) throw new Error(check.reason);
    if (!this.adapters[cli]) throw new Error(`no adapter for "${cli}"`);
    const budget = this.charter.maxTotalTokens;
    if (budget > 0 && this.totalTokens() >= budget) throw new Error(`token budget ${budget} exhausted`);
    const id = this.nextId(parent);
    const node: AgentNode = {
      id,
      parentId: parent.id,
      depth: parent.depth + 1,
      cli,
      role: role || "worker",
      task,
      status: "pending",
      token: randomBytes(16).toString("hex"),
      cwd: this.repoDir,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      inbox: [],
      queued: [],
      messages: [],
    };
    this.registry.add(node);
    this.bus.emit("node.created", id, { node: this.registry.view(node), task });
    this.changes.emit("change");
    void this.runNode(node, parent);
    return node;
  }

  private async runNode(node: AgentNode, parent: AgentNode): Promise<void> {
    await this.acquire(node);
    try {
      if (node.status === "stopped" || this.closed) return;
      if (this.useWorktrees) {
        node.cwd = join(this.dataDir, "worktrees", node.id);
        node.branch = `agent/${this.runTag}/${node.id}`;
        createWorktree(this.repoDir, node.cwd, node.branch, parent.branch ?? "HEAD");
        this.bus.emit("node.branch", node.id, { branch: node.branch, cwd: node.cwd });
      }
      node.startedAt = Date.now();
      const adapter = this.adapters[node.cli];
      const maxAttempts = 1 + this.charter.maxRetries;
      let result: RunResult | undefined;
      while (node.attempts < maxAttempts) {
        node.attempts++;
        this.setStatus(node, "running", { attempt: node.attempts });
        result = await this.execute(node, adapter, "worker", this.childPrompt(node));
        if (result.ok || result.stopped) break;
        this.bus.emit("node.retry", node.id, { attempt: node.attempts, error: result.text || result.stderrTail });
      }
      await this.finishNode(node, result);
      await this.drainQueue(node);
    } catch (error: any) {
      node.error = String(error?.message ?? error);
      node.endedAt = Date.now();
      this.setStatus(node, "failed", { error: node.error });
    } finally {
      this.release(node);
      this.changes.emit("change");
    }
  }

  private async finishNode(node: AgentNode, result: RunResult | undefined): Promise<void> {
    node.endedAt = Date.now();
    if (node.sessionId === undefined) node.sessionId = result?.sessionId;
    const reported = this.reported.get(node.id);
    const text = reported ?? result?.text ?? "";
    node.result = clipResult(text);
    const dir = this.nodeDir(node);
    node.resultFile = join(dir, "result.md");
    writeFileSync(node.resultFile, `${text}\n`);
    if (node.branch) {
      try {
        commitAll(node.cwd, `agent ${node.id}: ${node.role}`);
      } catch (error: any) {
        this.bus.emit("node.warning", node.id, { message: `commit failed: ${error?.message ?? error}` });
      }
    }
    if (result?.stopped) {
      this.setStatus(node, "stopped");
    } else if (result?.ok) {
      this.bus.emit("node.result", node.id, { result: node.result });
      this.setStatus(node, "done");
    } else {
      node.error = result?.text || result?.stderrTail || "failed";
      this.setStatus(node, "failed", { error: node.error });
    }
  }

  stopNode(id: string): void {
    const node = this.registry.get(id);
    if (!node) return;
    for (const child of this.registry.children(id)) this.stopNode(child.id);
    this.runs.get(id)?.stop();
    if (node.status === "pending") this.setStatus(node, "stopped");
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const pending = [...this.runs.values()];
    for (const run of pending) run.stop();
    await Promise.allSettled(pending.map((run) => run.promise));
    for (const approval of this.approvals.values()) approval.resolve(false);
    this.approvals.clear();
  }

  async messageNode(id: string, text: string): Promise<string> {
    if (id === ROOT_ID) return this.chat(text);
    const node = this.registry.get(id);
    if (!node) throw new Error(`unknown node ${id}`);
    const adapter = this.adapters[node.cli];
    if (!adapter.supportsResume) throw new Error(`${node.cli} cannot take a follow-up instruction`);
    const parent = this.registry.get(node.parentId ?? ROOT_ID) as AgentNode;
    if (!TERMINAL.includes(node.status)) {
      node.queued.push(text);
      this.bus.emit("node.user_intervention", id, { text, queued: true });
      parent.inbox.push(`The user sent a direct instruction to ${id} while it was running; it will be applied when it finishes: ${text}`);
      return "queued: the instruction runs when the node finishes its current work";
    }
    if (!node.sessionId) throw new Error(`${node.cli} cannot continue a finished session`);
    this.bus.emit("node.user_intervention", id, { text });
    parent.inbox.push(`The user sent a direct instruction to ${id}: ${text}`);
    node.attempts++;
    await this.acquire(node);
    try {
      this.setStatus(node, "running");
      const result = await this.execute(node, adapter, "worker", text, node.sessionId);
      this.reported.delete(node.id);
      await this.finishNode(node, result);
      return node.result ?? "";
    } finally {
      this.release(node);
    }
  }

  private async drainQueue(node: AgentNode): Promise<void> {
    const adapter = this.adapters[node.cli];
    while (node.queued.length > 0 && node.status !== "stopped") {
      const text = node.queued.shift() as string;
      if (!adapter.supportsResume || !node.sessionId) {
        this.bus.emit("node.warning", node.id, { message: `queued instruction dropped: ${node.cli} cannot continue a session` });
        node.queued.length = 0;
        break;
      }
      node.attempts++;
      this.setStatus(node, "running");
      const result = await this.execute(node, adapter, "worker", text, node.sessionId);
      this.reported.delete(node.id);
      await this.finishNode(node, result);
    }
  }

  private restoreFrom(events: OrchEvent[]): void {
    for (const event of events) {
      const d = (event.data ?? {}) as Record<string, any>;
      const node = event.nodeId ? this.registry.get(event.nodeId) : undefined;
      switch (event.type) {
        case "node.created": {
          if (event.nodeId === ROOT_ID || !d.node) break;
          const view = d.node as NodeView;
          this.registry.add({
            id: view.id,
            parentId: view.parentId,
            depth: view.depth,
            cli: view.cli,
            role: view.role,
            task: String(d.task ?? view.task ?? ""),
            status: "pending",
            token: randomBytes(16).toString("hex"),
            cwd: this.repoDir,
            attempts: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: null,
            inbox: [],
            queued: [],
            messages: [],
          });
          const index = Number(view.id.slice(view.id.lastIndexOf(".") + 1).replace(/^c/, ""));
          const parentId = view.parentId ?? ROOT_ID;
          if (Number.isFinite(index)) this.counters.set(parentId, Math.max(this.counters.get(parentId) ?? 0, index));
          break;
        }
        case "node.status":
          if (node) {
            node.status = d.status;
            node.error = d.error;
            if (d.attempt) node.attempts = d.attempt;
          }
          break;
        case "node.usage":
          if (node) Object.assign(node, { inputTokens: d.inputTokens ?? 0, outputTokens: d.outputTokens ?? 0, costUsd: d.costUsd ?? null });
          break;
        case "node.session":
          if (node) node.sessionId = d.sessionId;
          break;
        case "node.branch":
          if (node) Object.assign(node, { branch: d.branch, cwd: d.cwd });
          break;
        case "node.result":
          if (node) node.result = d.result;
          break;
        case "node.linked":
          for (const a of d.ids as string[]) for (const b of d.ids as string[]) if (a < b) this.links.add(`${a}|${b}`);
          break;
        default:
          break;
      }
    }
    const interrupted: string[] = [];
    for (const node of this.registry.all()) {
      if (node.id === ROOT_ID) node.status = "waiting";
      else if (node.status === "running" || node.status === "pending") {
        node.status = "stopped";
        node.error = "interrupted by a restart";
        interrupted.push(node.id);
      }
    }
    const root = this.registry.get(ROOT_ID) as AgentNode;
    if (interrupted.length > 0) {
      root.inbox.push(`The app was restarted. These sub-agents were interrupted and did not finish: ${interrupted.join(", ")}. Re-create them if the work is still needed.`);
    }
    this.restoredInterrupted = interrupted;
  }

  restoredInterrupted: string[] = [];

  requestApproval(nodeId: string, description: string): Promise<boolean> {
    const id = randomBytes(4).toString("hex");
    return new Promise((resolve) => {
      this.approvals.set(id, { nodeId, description, resolve });
      this.bus.emit("approval.requested", nodeId, { id, description });
    });
  }

  resolveApproval(id: string, approved: boolean): boolean {
    const approval = this.approvals.get(id);
    if (!approval) return false;
    this.approvals.delete(id);
    this.bus.emit("approval.resolved", approval.nodeId, { id, approved });
    approval.resolve(approved);
    return true;
  }

  toolsFor(token: string): ToolDef[] | null {
    const node = this.registry.byNodeToken(token);
    if (!node) return null;
    const tools: ToolDef[] = [
      {
        name: "report",
        description: "Report your final result summary (under 1500 characters). Your final reply is used if you do not call this.",
        inputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
      },
    ];
    if (node.depth >= 1) {
      tools.push(
        {
          name: "send_message",
          description: "Send a short message to a sibling agent. Works only for siblings your parent has linked with you.",
          inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] },
        },
        {
          name: "read_messages",
          description: "Read and clear messages other agents sent you.",
          inputSchema: { type: "object", properties: {} },
        },
      );
    }
    const level = this.charter.limits.levels[node.depth];
    if (!level?.canSpawn) return tools;
    const childClis = this.charter.limits.levels[node.depth + 1]?.allowedCli ?? [];
    tools.push(
      {
        name: "spawn_child",
        description: "Create a sub-agent that works on a task in its own git worktree. Returns its id immediately; collect the result with wait_children.",
        inputSchema: {
          type: "object",
          properties: {
            cli: { type: "string", enum: childClis },
            role: { type: "string", description: "Short role name, e.g. api, tests" },
            task: { type: "string", description: "Complete, self-contained instructions for the sub-agent" },
          },
          required: ["cli", "task"],
        },
      },
      {
        name: "list_children",
        description: "List your sub-agents and their status.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "wait_children",
        description: "Wait until sub-agents finish and return their results. Defaults to all of your sub-agents.",
        inputSchema: {
          type: "object",
          properties: { ids: { type: "array", items: { type: "string" } }, timeout_sec: { type: "number" } },
        },
      },
      {
        name: "link_children",
        description: "Allow your sub-agents to message each other directly (send_message / read_messages). Pass two or more of their ids.",
        inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, minItems: 2 } }, required: ["ids"] },
      },
      {
        name: "stop_child",
        description: "Stop a sub-agent and its descendants.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
      {
        name: "get_child_diff",
        description: "Show the diff a finished sub-agent produced.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
      {
        name: "merge_child",
        description: node.id === ROOT_ID
          ? "Merge a finished sub-agent's branch. Asks the user for approval first."
          : "Merge a finished sub-agent's branch into your own worktree.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    );
    if (node.id === ROOT_ID) {
      tools.push({
        name: "get_tree_status",
        description: "Show every agent in the tree with status and token usage.",
        inputSchema: { type: "object", properties: {} },
      });
    }
    return tools;
  }

  async call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const node = this.registry.byNodeToken(token);
    if (!node) return { text: "unknown node", isError: true };
    const allowed = this.toolsFor(token)?.some((tool) => tool.name === name);
    if (!allowed) return { text: `tool ${name} is not available to this agent`, isError: true };
    try {
      return { text: await this.dispatch(node, name, args), isError: false };
    } catch (error: any) {
      return { text: String(error?.message ?? error), isError: true };
    }
  }

  private ownChild(node: AgentNode, id: unknown): AgentNode {
    const child = this.registry.get(String(id));
    if (!child || child.parentId !== node.id) throw new Error(`${id} is not your sub-agent`);
    return child;
  }

  private summary(child: AgentNode): Record<string, unknown> {
    return {
      id: child.id,
      role: child.role,
      cli: child.cli,
      status: child.status,
      attempts: child.attempts,
      result: child.result,
      error: child.error,
      branch: child.branch,
    };
  }

  private async dispatch(node: AgentNode, name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "report": {
        this.reported.set(node.id, String(args.result ?? ""));
        return "recorded";
      }
      case "spawn_child": {
        const child = this.spawnChild(node, String(args.cli ?? ""), String(args.role ?? ""), String(args.task ?? ""));
        return JSON.stringify({ id: child.id, status: child.status });
      }
      case "list_children":
        return JSON.stringify(this.registry.children(node.id).map((c) => this.summary(c)));
      case "get_tree_status":
        return JSON.stringify(this.tree());
      case "stop_child": {
        const child = this.ownChild(node, args.id);
        this.stopNode(child.id);
        return `stopping ${child.id}`;
      }
      case "wait_children":
        return this.waitChildren(node, args);
      case "link_children": {
        const ids = (Array.isArray(args.ids) ? args.ids : []).map(String);
        if (ids.length < 2) throw new Error("pass at least two sub-agent ids");
        for (const id of ids) this.ownChild(node, id);
        for (const a of ids) for (const b of ids) if (a < b) this.links.add(`${a}|${b}`);
        this.bus.emit("node.linked", node.id, { ids });
        return `linked: ${ids.join(", ")}`;
      }
      case "send_message": {
        const to = this.registry.get(String(args.to ?? ""));
        const key = [node.id, to?.id ?? ""].sort().join("|");
        if (!to || !this.links.has(key)) throw new Error(`you are not linked with ${args.to}; ask your parent to link you`);
        const text = String(args.text ?? "").slice(0, 2000);
        to.messages.push({ from: node.id, text });
        this.bus.emit("node.message", node.id, { to: to.id, text: text.slice(0, 200) });
        return `sent to ${to.id}`;
      }
      case "read_messages":
        return JSON.stringify(node.messages.splice(0));
      case "get_child_diff": {
        const child = this.ownChild(node, args.id);
        if (!child.branch) throw new Error("worktrees are not enabled for this run");
        if (!TERMINAL.includes(child.status)) throw new Error(`${child.id} is still ${child.status}`);
        return diffAgainst(node.cwd, child.branch) || "(no changes)";
      }
      case "merge_child":
        return this.mergeChild(node, this.ownChild(node, args.id));
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  private async waitChildren(node: AgentNode, args: Record<string, unknown>): Promise<string> {
    const ids = Array.isArray(args.ids) && args.ids.length > 0 ? args.ids.map(String) : this.registry.children(node.id).map((c) => c.id);
    const targets = ids.map((id) => this.ownChild(node, id));
    const timeout = Math.min(Math.max(Number(args.timeout_sec ?? 600), 1), 3600) * 1000;
    const deadline = Date.now() + timeout;
    const held = this.holdsSlot.has(node.id);
    if (held) this.release(node);
    try {
      while (!targets.every((c) => TERMINAL.includes(c.status)) && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(deadline - Date.now(), 0));
          this.changes.once("change", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } finally {
      if (held) await this.acquire(node);
    }
    const notes = node.inbox.splice(0);
    return JSON.stringify({ children: targets.map((c) => this.summary(c)), notes });
  }

  private async mergeChild(node: AgentNode, child: AgentNode): Promise<string> {
    if (!child.branch) throw new Error("worktrees are not enabled for this run");
    if (child.status !== "done") throw new Error(`${child.id} is ${child.status}, not done`);
    if (node.id === ROOT_ID) {
      let entry = this.mergeApprovals.get(child.id);
      if (!entry) {
        const diff = diffAgainst(node.cwd, child.branch, 1500);
        const created: { state: "pending" | "approved" | "declined"; promise: Promise<boolean> } = {
          state: "pending",
          promise: Promise.resolve(false),
        };
        created.promise = this.requestApproval(node.id, `Merge ${child.id} (${child.role}) into the main branch?\n${diff}`).then((ok) => {
          created.state = ok ? "approved" : "declined";
          return ok;
        });
        this.mergeApprovals.set(child.id, created);
        entry = created;
      }
      await Promise.race([entry.promise, new Promise((resolve) => setTimeout(resolve, this.approvalWaitMs))]);
      if (entry.state === "pending") {
        return `The user has not answered yet. Tell the user you are waiting for their approval to merge ${child.id}; call merge_child again later to continue.`;
      }
      this.mergeApprovals.delete(child.id);
      if (entry.state === "declined") return `the user declined to merge ${child.id}`;
    } else {
      commitAll(node.cwd, `agent ${node.id}: before merging ${child.id}`);
    }
    const merged = mergeBranch(node.cwd, child.branch, `Merge ${child.id} (${child.role})`);
    if (!merged.ok) throw new Error(`merge conflict, merge aborted:\n${merged.output}`);
    this.bus.emit("node.merged", child.id, { into: node.id });
    return `merged ${child.id}`;
  }

  currentBranch(): string {
    return git(this.repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  }
}
