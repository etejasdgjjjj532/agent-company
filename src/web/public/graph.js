const COLORS = ["edge", "text", "muted", "c-root", "c-run", "c-done", "c-pending", "c-failed", "c-stopped", "c-approval"];

export class GraphView {
  constructor(canvas, store, onSelect) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.store = store;
    this.onSelect = onSelect;
    this.selected = "root";
    this.view = { k: 1, x: 0, y: 0 };
    this.css = {};
    this.W = 400;
    this.H = 300;
    this.hover = null;
    this.dragging = null;
    this.panning = null;
    this.moved = false;
    this.frame = 0;
    this.running = false;
    this.bind();
    this.resize();
    this.readCss();
  }

  setStore(store) {
    this.store = store;
    this.selected = "root";
    this.view = { k: 1, x: 0, y: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (t) => {
      if (!this.running) return;
      this.draw(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  readCss() {
    const s = getComputedStyle(document.documentElement);
    for (const key of COLORS) this.css[key] = s.getPropertyValue(`--${key}`).trim();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.W = Math.max(rect.width, 1);
    this.H = Math.max(rect.height, 1);
    this.canvas.width = Math.floor(this.W * dpr);
    this.canvas.height = Math.floor(this.H * dpr);
  }

  radius(node) {
    const kids = [...this.store.nodes.values()].filter((n) => n.parentId === node.id).length;
    return 5 + Math.sqrt(kids) * 3.2 + (node.id === "root" ? 4 : 0);
  }

  color(node) {
    if (node.id === "root" && node.status !== "running") return this.css["c-root"];
    switch (node.status) {
      case "running": return this.css["c-run"];
      case "done": return this.css["c-done"];
      case "failed": return this.css["c-failed"];
      case "stopped": return this.css["c-stopped"];
      default: return this.css["c-pending"];
    }
  }

  needsApproval(id) {
    for (const a of this.store.approvals.values()) if (a.nodeId === id) return true;
    return false;
  }

  step() {
    const list = [...this.store.nodes.values()];
    for (const a of list) {
      for (const b of list) {
        if (a === b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy + 0.5;
        const f = 1400 / d2;
        a.vx += dx * f * 0.05;
        a.vy += dy * f * 0.05;
      }
      a.vx -= a.x * 0.006;
      a.vy -= a.y * 0.006;
      const parent = this.store.nodes.get(a.parentId);
      if (parent) {
        const dx = parent.x - a.x;
        const dy = parent.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const k = (d - 70) * 0.02;
        a.vx += (dx / d) * k;
        a.vy += (dy / d) * k;
        parent.vx -= (dx / d) * k;
        parent.vy -= (dy / d) * k;
      }
    }
    for (const a of list) {
      if (a === this.dragging) continue;
      a.vx *= 0.8;
      a.vy *= 0.8;
      a.x += a.vx;
      a.y += a.vy;
    }
  }

  related() {
    if (!this.hover) return null;
    const set = new Set([this.hover.id]);
    if (this.hover.parentId) set.add(this.hover.parentId);
    for (const n of this.store.nodes.values()) if (n.parentId === this.hover.id) set.add(n.id);
    return set;
  }

  label(n) {
    return n.id === "root" ? "Root" : `${n.id} ${n.role || ""}`.trim();
  }

  draw(t) {
    this.frame++;
    if (this.frame % 90 === 1) this.readCss();
    this.step();
    const { ctx, W, H, view } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2 + view.x, H / 2 + view.y);
    ctx.scale(view.k, view.k);
    const rel = this.related();
    const nodes = this.store.nodes;
    ctx.lineWidth = 1 / view.k;
    for (const n of nodes.values()) {
      const p = nodes.get(n.parentId);
      if (!p) continue;
      ctx.globalAlpha = !rel || (rel.has(n.id) && rel.has(p.id)) ? 1 : 0.12;
      ctx.strokeStyle = this.css.edge;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
      if (n.status === "running") {
        const u = (t / 1600 + n.id.length * 0.13) % 1;
        ctx.fillStyle = this.css["c-run"];
        ctx.beginPath();
        ctx.arc(p.x + (n.x - p.x) * u, p.y + (n.y - p.y) * u, 2 / view.k + 1, 0, 6.283);
        ctx.fill();
      }
    }
    for (const n of nodes.values()) {
      const on = !rel || rel.has(n.id);
      const r = this.radius(n);
      ctx.globalAlpha = on ? 1 : 0.15;
      if (n.status === "running") {
        ctx.strokeStyle = this.css["c-run"];
        ctx.globalAlpha *= 0.35;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 3 + 2 * Math.sin(t / 300), 0, 6.283);
        ctx.stroke();
        ctx.globalAlpha = on ? 1 : 0.15;
      }
      if (this.needsApproval(n.id)) {
        ctx.strokeStyle = this.css["c-approval"];
        ctx.lineWidth = 2.5 / view.k;
        ctx.globalAlpha *= 0.3 + 0.7 * Math.abs(Math.sin(t / 350));
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 5, 0, 6.283);
        ctx.stroke();
        ctx.lineWidth = 1 / view.k;
        ctx.globalAlpha = on ? 1 : 0.15;
      }
      ctx.fillStyle = this.color(n);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 6.283);
      ctx.fill();
      if (n.id === this.selected) {
        ctx.strokeStyle = this.css.text;
        ctx.lineWidth = 1.5 / view.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 2.5, 0, 6.283);
        ctx.stroke();
        ctx.lineWidth = 1 / view.k;
      }
    }
    ctx.globalAlpha = 1;
    ctx.font = `${12 / Math.max(view.k, 0.6)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    for (const n of nodes.values()) {
      if (!(n.id === "root" || n.id === this.selected || (this.hover && (n === this.hover || (rel && rel.has(n.id)))))) continue;
      ctx.fillStyle = this.css.text;
      ctx.fillText(this.label(n), n.x, n.y - this.radius(n) - 7);
    }
    ctx.restore();
  }

  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - this.W / 2 - this.view.x) / this.view.k, y: (clientY - rect.top - this.H / 2 - this.view.y) / this.view.k };
  }

  nodeAt(clientX, clientY) {
    const p = this.toWorld(clientX, clientY);
    let found = null;
    for (const n of this.store.nodes.values()) {
      const r = this.radius(n) + 5;
      if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= r * r) found = n;
    }
    return found;
  }

  bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.moved = false;
      const n = this.nodeAt(e.clientX, e.clientY);
      if (n) this.dragging = n;
      else this.panning = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
    });
    c.addEventListener("pointermove", (e) => {
      if (this.dragging) {
        const p = this.toWorld(e.clientX, e.clientY);
        this.dragging.x = p.x;
        this.dragging.y = p.y;
        this.dragging.vx = this.dragging.vy = 0;
        this.moved = true;
      } else if (this.panning) {
        this.view.x = this.panning.vx + (e.clientX - this.panning.x);
        this.view.y = this.panning.vy + (e.clientY - this.panning.y);
        this.moved = true;
      } else {
        this.hover = this.nodeAt(e.clientX, e.clientY);
        c.style.cursor = this.hover ? "pointer" : "grab";
      }
    });
    c.addEventListener("pointerup", () => {
      if (this.dragging && !this.moved) {
        this.selected = this.dragging.id;
        this.onSelect?.(this.selected);
      }
      this.dragging = null;
      this.panning = null;
    });
    c.addEventListener("pointerleave", () => {
      this.hover = null;
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const before = this.toWorld(e.clientX, e.clientY);
      this.view.k = Math.min(4, Math.max(0.25, this.view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      const rect = c.getBoundingClientRect();
      this.view.x = e.clientX - rect.left - this.W / 2 - before.x * this.view.k;
      this.view.y = e.clientY - rect.top - this.H / 2 - before.y * this.view.k;
    }, { passive: false });
    c.addEventListener("dblclick", () => {
      this.view = { k: 1, x: 0, y: 0 };
    });
    new ResizeObserver(() => this.resize()).observe(c);
  }
}
