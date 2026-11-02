import { term } from "./util.js";

const TIMELINE_LIMIT = 800;

export class Store {
  constructor() {
    this.nodes = new Map();
    this.approvals = new Map();
    this.timeline = [];
    this.lastSeq = 0;
    this.rootBusy = false;
    this.listeners = new Set();
    this.scheduled = false;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const fn of this.listeners) fn();
    });
  }

  upsertNode(data, task) {
    if (!data) return null;
    let node = this.nodes.get(data.id);
    if (!node) {
      const parent = this.nodes.get(data.parentId);
      const angle = Math.random() * Math.PI * 2;
      node = { log: [], x: (parent ? parent.x : 0) + Math.cos(angle) * 40, y: (parent ? parent.y : 0) + Math.sin(angle) * 40, vx: 0, vy: 0 };
      this.nodes.set(data.id, node);
    }
    Object.assign(node, data);
    if (task) node.task = task;
    return node;
  }

  loadSnapshot(info) {
    for (const n of info.nodes ?? []) this.upsertNode(n);
    for (const a of info.approvals ?? []) this.approvals.set(a.id, a);
    this.changed();
  }

  push(entry) {
    this.timeline.push({ ts: Date.now(), ...entry });
    if (this.timeline.length > TIMELINE_LIMIT) this.timeline.shift();
  }

  log(node, kind, text) {
    if (!node) return;
    node.log.push({ kind, text });
    if (node.log.length > 300) node.log.shift();
  }

  apply(event) {
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    const d = event.data || {};
    const node = this.nodes.get(event.nodeId);
    const ts = event.ts;
    switch (event.type) {
      case "node.created":
        this.upsertNode(d.node, d.task);
        if (event.nodeId !== "root") {
          this.push({ ts, kind: "activity", text: `${event.nodeId} を作成 (${d.node?.cli} / ${d.node?.role || "worker"})`, nodeId: event.nodeId });
        }
        break;
      case "node.status":
        if (node) {
          node.status = d.status;
          node.error = d.error;
          if (d.attempt) node.attempts = d.attempt;
        }
        if (event.nodeId === "root") this.rootBusy = d.status === "running";
        else if (d.status === "done") this.push({ ts, kind: "activity", tone: "ok", text: `${event.nodeId} が完了`, nodeId: event.nodeId });
        else if (d.status === "failed") this.push({ ts, kind: "activity", tone: "bad", text: `${event.nodeId} が失敗: ${d.error ?? ""}`.slice(0, 200), nodeId: event.nodeId });
        else if (d.status === "stopped") this.push({ ts, kind: "activity", text: `${event.nodeId} を停止`, nodeId: event.nodeId });
        break;
      case "node.usage":
        if (node) Object.assign(node, { inputTokens: d.inputTokens, outputTokens: d.outputTokens, costUsd: d.costUsd });
        break;
      case "node.output":
        this.log(node, d.kind === "tool" ? "tool" : "text", d.kind === "tool" ? `[${d.name}] ${d.text}` : d.text);
        if (event.nodeId === "root") {
          if (d.kind === "tool") this.push({ ts, kind: "activity", text: `Root: ${d.name}`, nodeId: "root" });
          else this.push({ ts, kind: "thinking", text: d.text });
        }
        break;
      case "node.retry":
        this.log(node, "tool", `retry after attempt ${d.attempt}: ${d.error || ""}`);
        this.push({ ts, kind: "activity", tone: "bad", text: `${event.nodeId} を再試行 (${d.attempt} 回目の失敗)`, nodeId: event.nodeId });
        break;
      case "node.warning":
        this.log(node, "tool", d.message);
        break;
      case "session.resumed":
        this.push({ ts, kind: "activity", tone: "ok", text: d.interrupted?.length ? `セッションを再開しました (中断されたノード: ${d.interrupted.join(", ")})` : "セッションを再開しました" });
        break;
      case "node.merged":
        this.push({ ts, kind: "activity", tone: "ok", text: `${event.nodeId} を統合しました` });
        break;
      case "node.user_intervention":
        this.log(node, "text", `(ユーザーからの直接指示) ${d.text}`);
        this.push({ ts, kind: "activity", text: `${event.nodeId} へ直接指示: ${d.text}`.slice(0, 160), nodeId: event.nodeId });
        break;
      case "chat.user":
        this.push({ ts, kind: "user", text: d.text });
        break;
      case "chat.reply": {
        const last = this.timeline[this.timeline.length - 1];
        if (last && last.kind === "thinking" && last.text === d.text) this.timeline.pop();
        this.push({ ts, kind: "assistant", text: d.text, ok: d.ok !== false });
        this.rootBusy = false;
        break;
      }
      case "chat.error":
        this.push({ ts, kind: "error", text: d.message });
        break;
      case "approval.requested":
        this.approvals.set(d.id, { id: d.id, nodeId: event.nodeId, description: d.description });
        this.push({ ts, kind: "approval", approvalId: d.id });
        break;
      case "approval.resolved":
        this.approvals.delete(d.id);
        this.push({ ts, kind: "activity", tone: d.approved ? "ok" : undefined, text: d.approved ? "統合を承認しました" : "統合を却下しました" });
        break;
      default:
        return;
    }
    this.changed();
  }

  stats() {
    const all = [...this.nodes.values()];
    const known = all.filter((n) => typeof n.costUsd === "number");
    return {
      count: all.length,
      running: all.filter((n) => n.status === "running").length,
      tokens: all.reduce((s, n) => s + (n.inputTokens || 0) + (n.outputTokens || 0), 0),
      cost: known.length ? known.reduce((s, n) => s + n.costUsd, 0) : null,
      costPartial: known.length > 0 && known.length < all.length,
    };
  }

  rootLabel() {
    return term("root");
  }
}
