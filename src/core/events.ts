export type NodeStatus = "pending" | "running" | "waiting" | "done" | "failed" | "stopped";

export interface OrchEvent {
  seq: number;
  ts: number;
  type: string;
  nodeId?: string;
  data?: Record<string, unknown>;
}

type Listener = (event: OrchEvent) => void;

const HISTORY_LIMIT = 5000;

export class EventBus {
  readonly history: OrchEvent[] = [];
  private listeners = new Set<Listener>();
  private seq = 0;
  private sink?: Listener;

  constructor(sink?: Listener) {
    this.sink = sink;
  }

  emit(type: string, nodeId?: string, data?: Record<string, unknown>): OrchEvent {
    const event: OrchEvent = { seq: ++this.seq, ts: Date.now(), type, nodeId, data };
    this.history.push(event);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.sink?.(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
