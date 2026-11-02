const nodes = new Map();
const approvals = new Map();
const messages = [];
let selected = "root";
let lastSeq = 0;

const TERMS = {
  tech: { root: "Root", chat: "Root との会話", child: "子" },
  company: { root: "社長", chat: "社長との会話", child: "部下" },
};
let terms = localStorage.getItem("ac-terms") === "company" ? "company" : "tech";

const $ = (id) => document.getElementById(id);
const canvas = $("graph");
const ctx = canvas.getContext("2d");
const view = { k: 1, x: 0, y: 0 };
const css = {};
let W = 800;
let H = 600;
let hover = null;
let dragging = null;
let panning = null;
let moved = false;
let frame = 0;

function readCss() {
  const s = getComputedStyle(document.documentElement);
  for (const key of ["edge", "text", "muted", "c-root", "c-run", "c-done", "c-pending", "c-failed", "c-stopped", "c-approval"]) {
    css[key] = s.getPropertyValue(`--${key}`).trim();
  }
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  W = rect.width;
  H = rect.height;
  canvas.width = Math.max(1, Math.floor(W * dpr));
  canvas.height = Math.max(1, Math.floor(H * dpr));
}

function upsert(data, task) {
  if (!data) return null;
  let node = nodes.get(data.id);
  if (!node) {
    const parent = nodes.get(data.parentId);
    const angle = Math.random() * Math.PI * 2;
    node = {
      log: [],
      x: (parent ? parent.x : 0) + Math.cos(angle) * 40,
      y: (parent ? parent.y : 0) + Math.sin(angle) * 40,
      vx: 0,
      vy: 0,
    };
    nodes.set(data.id, node);
  }
  Object.assign(node, data);
  if (task) node.task = task;
  return node;
}

function pushLog(node, kind, text) {
  if (!node) return;
  node.log.push({ kind, text });
  if (node.log.length > 300) node.log.shift();
}

function apply(event) {
  lastSeq = Math.max(lastSeq, event.seq);
  const d = event.data || {};
  const node = nodes.get(event.nodeId);
  switch (event.type) {
    case "node.created":
      upsert(d.node, d.task);
      break;
    case "node.status":
      if (node) {
        node.status = d.status;
        node.error = d.error;
        if (d.attempt) node.attempts = d.attempt;
      }
      break;
    case "node.usage":
      if (node) Object.assign(node, { inputTokens: d.inputTokens, outputTokens: d.outputTokens, costUsd: d.costUsd });
      break;
    case "node.output":
      pushLog(node, d.kind === "tool" ? "tool" : "text", d.kind === "tool" ? `[${d.name}] ${d.text}` : d.text);
      break;
    case "node.retry":
      pushLog(node, "tool", `retry after attempt ${d.attempt}: ${d.error || ""}`);
      break;
    case "node.warning":
      pushLog(node, "tool", d.message);
      break;
    case "node.user_intervention":
      pushLog(node, "text", `(ユーザーからの直接指示) ${d.text}`);
      break;
    case "chat.user":
      messages.push({ role: "user", text: d.text });
      break;
    case "chat.reply":
      messages.push({ role: "root", text: d.text });
      break;
    case "chat.error":
      messages.push({ role: "err", text: d.message });
      break;
    case "approval.requested":
      approvals.set(d.id, { id: d.id, nodeId: event.nodeId, description: d.description });
      break;
    case "approval.resolved":
      approvals.delete(d.id);
      break;
    default:
      return;
  }
  dirty = true;
}

let dirty = true;

function recount() {
  for (const node of nodes.values()) node.childCount = 0;
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parentId);
    if (parent) parent.childCount++;
  }
}

function radius(node) {
  return 5 + Math.sqrt(node.childCount || 0) * 3.2 + (node.id === "root" ? 4 : 0);
}

function colorOf(node) {
  if (node.id === "root" && node.status !== "running") return css["c-root"];
  switch (node.status) {
    case "running": return css["c-run"];
    case "done": return css["c-done"];
    case "failed": return css["c-failed"];
    case "stopped": return css["c-stopped"];
    default: return css["c-pending"];
  }
}

function needsApproval(id) {
  for (const a of approvals.values()) if (a.nodeId === id) return true;
  return false;
}

function step() {
  const list = [...nodes.values()];
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
    const parent = nodes.get(a.parentId);
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
    if (a === dragging) continue;
    a.vx *= 0.8;
    a.vy *= 0.8;
    a.x += a.vx;
    a.y += a.vy;
  }
}

function related() {
  const target = hover || nodes.get(selected);
  if (!target || !hover) return null;
  const set = new Set([target.id]);
  if (target.parentId) set.add(target.parentId);
  for (const n of nodes.values()) if (n.parentId === target.id) set.add(n.id);
  return set;
}

function draw(t) {
  frame++;
  if (frame % 60 === 1) readCss();
  step();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2 + view.x, H / 2 + view.y);
  ctx.scale(view.k, view.k);
  const rel = related();
  ctx.lineWidth = 1 / view.k;
  for (const n of nodes.values()) {
    const p = nodes.get(n.parentId);
    if (!p) continue;
    ctx.globalAlpha = !rel || (rel.has(n.id) && rel.has(p.id)) ? 1 : 0.12;
    ctx.strokeStyle = css.edge;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(n.x, n.y);
    ctx.stroke();
    if (n.status === "running") {
      const u = (t / 1600 + n.id.length * 0.13) % 1;
      ctx.fillStyle = css["c-run"];
      ctx.beginPath();
      ctx.arc(p.x + (n.x - p.x) * u, p.y + (n.y - p.y) * u, 2 / view.k + 1, 0, 6.283);
      ctx.fill();
    }
  }
  for (const n of nodes.values()) {
    const on = !rel || rel.has(n.id);
    const r = radius(n);
    ctx.globalAlpha = on ? 1 : 0.15;
    if (n.status === "running") {
      ctx.strokeStyle = css["c-run"];
      ctx.globalAlpha *= 0.35;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 3 + 2 * Math.sin(t / 300), 0, 6.283);
      ctx.stroke();
      ctx.globalAlpha = on ? 1 : 0.15;
    }
    if (needsApproval(n.id)) {
      ctx.strokeStyle = css["c-approval"];
      ctx.lineWidth = 2.5 / view.k;
      ctx.globalAlpha *= 0.3 + 0.7 * Math.abs(Math.sin(t / 350));
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 5, 0, 6.283);
      ctx.stroke();
      ctx.lineWidth = 1 / view.k;
      ctx.globalAlpha = on ? 1 : 0.15;
    }
    ctx.fillStyle = colorOf(n);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, 6.283);
    ctx.fill();
    if (n.id === selected) {
      ctx.strokeStyle = css.text;
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
    if (!(n.id === "root" || n.id === selected || (hover && (n === hover || (rel && rel.has(n.id)))))) continue;
    ctx.fillStyle = css.text;
    ctx.fillText(label(n), n.x, n.y - radius(n) - 7);
  }
  ctx.restore();
  if (dirty) {
    dirty = false;
    renderPanels();
  }
  requestAnimationFrame(draw);
}

function label(n) {
  return n.id === "root" ? TERMS[terms].root : `${n.id} ${n.role || ""}`.trim();
}

function toWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { x: (clientX - rect.left - W / 2 - view.x) / view.k, y: (clientY - rect.top - H / 2 - view.y) / view.k };
}

function nodeAt(clientX, clientY) {
  const p = toWorld(clientX, clientY);
  let found = null;
  for (const n of nodes.values()) {
    const r = radius(n) + 5;
    if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= r * r) found = n;
  }
  return found;
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  moved = false;
  const n = nodeAt(e.clientX, e.clientY);
  if (n) dragging = n;
  else panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
});
canvas.addEventListener("pointermove", (e) => {
  if (dragging) {
    const p = toWorld(e.clientX, e.clientY);
    dragging.x = p.x;
    dragging.y = p.y;
    dragging.vx = dragging.vy = 0;
    moved = true;
  } else if (panning) {
    view.x = panning.vx + (e.clientX - panning.x);
    view.y = panning.vy + (e.clientY - panning.y);
    moved = true;
  } else {
    hover = nodeAt(e.clientX, e.clientY);
    canvas.style.cursor = hover ? "pointer" : "grab";
  }
});
canvas.addEventListener("pointerup", () => {
  if (dragging && !moved) {
    selected = dragging.id;
    dirty = true;
  }
  dragging = null;
  panning = null;
});
canvas.addEventListener("pointerleave", () => {
  hover = null;
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const before = toWorld(e.clientX, e.clientY);
  view.k = Math.min(4, Math.max(0.25, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  const rect = canvas.getBoundingClientRect();
  view.x = e.clientX - rect.left - W / 2 - before.x * view.k;
  view.y = e.clientY - rect.top - H / 2 - before.y * view.k;
}, { passive: false });
canvas.addEventListener("dblclick", () => {
  view.k = 1;
  view.x = 0;
  view.y = 0;
});

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    messages.push({ role: "err", text: info.error || `request failed (${res.status})` });
    dirty = true;
  }
}

function renderPanels() {
  recount();
  $("chat-title").textContent = TERMS[terms].chat;
  const list = $("messages");
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
  list.replaceChildren(...messages.map((m) => el("div", { className: `msg ${m.role}`, textContent: m.text })));
  if (stick) list.scrollTop = list.scrollHeight;

  const all = [...nodes.values()];
  const running = all.filter((n) => n.status === "running").length;
  const tokens = all.reduce((s, n) => s + (n.inputTokens || 0) + (n.outputTokens || 0), 0);
  const known = all.filter((n) => typeof n.costUsd === "number");
  const cost = known.length ? `$${known.reduce((s, n) => s + n.costUsd, 0).toFixed(2)}${known.length < all.length ? " (一部不明)" : ""}` : "不明";
  $("summary").textContent = `ノード ${all.length} / 実行中 ${running} / トークン ${tokens.toLocaleString()} / コスト ${cost}`;

  const box = $("approvals");
  box.replaceChildren(
    ...[...approvals.values()].map((a) =>
      el("div", { className: "card approval" },
        el("h2", { textContent: `承認が必要 (${a.nodeId})` }),
        el("pre", { textContent: a.description }),
        el("div", { className: "row" },
          el("button", { className: "primary", textContent: "承認", onclick: () => post(`/api/approval/${a.id}`, { approved: true }) }),
          el("button", { textContent: "却下", onclick: () => post(`/api/approval/${a.id}`, { approved: false }) }),
        ),
      ),
    ),
  );
  renderDetail();
}

function renderDetail() {
  const box = $("detail");
  const n = nodes.get(selected);
  if (!n) return;
  const kv = el("dl", { className: "kv" });
  const add = (k, v) => kv.append(el("dt", { textContent: k }), el("dd", { textContent: String(v ?? "-") }));
  add("ID", n.id === "root" ? TERMS[terms].root : n.id);
  add("CLI", n.cli);
  add("状態", n.status + (n.attempts > 1 ? ` (試行 ${n.attempts})` : ""));
  add("深さ", n.depth);
  add("トークン", ((n.inputTokens || 0) + (n.outputTokens || 0)).toLocaleString());
  add("コスト", typeof n.costUsd === "number" ? `$${n.costUsd.toFixed(3)}` : "不明");
  if (n.branch) add("ブランチ", n.branch);
  if (n.error) add("エラー", n.error);
  const log = el("div", { id: "log" });
  for (const line of n.log.slice(-60)) log.append(el("div", { className: line.kind, textContent: line.text }));
  const parts = [el("h2", { textContent: `${label(n)} の詳細` }), el("p", { className: "muted", textContent: n.task || "" }), kv, log];
  if (n.status === "running" || n.status === "pending") {
    parts.push(el("button", { textContent: "停止", onclick: () => post(`/api/node/${encodeURIComponent(n.id)}/stop`, {}) }));
  }
  if (n.id !== "root") {
    const input = el("input", { type: "text", placeholder: "このノードへ直接指示 (完了後に送れます)" });
    const form = el("form", { onsubmit: (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      post(`/api/node/${encodeURIComponent(n.id)}/message`, { text });
    } }, input, el("button", { type: "submit", textContent: "送る" }));
    parts.push(form);
  }
  const keepLog = box.querySelector("#log");
  const stickLog = keepLog ? keepLog.scrollTop + keepLog.clientHeight >= keepLog.scrollHeight - 20 : true;
  const typed = box.querySelector("input")?.value;
  box.replaceChildren(...parts);
  const newInput = box.querySelector("input");
  if (newInput && typed) newInput.value = typed;
  if (stickLog) log.scrollTop = log.scrollHeight;
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  post("/api/chat", { text });
});
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("terms").value = terms;
$("terms").addEventListener("change", (e) => {
  terms = e.target.value === "company" ? "company" : "tech";
  localStorage.setItem("ac-terms", terms);
  dirty = true;
});

function connect() {
  const source = new EventSource(`/events?since=${lastSeq}`);
  source.onopen = () => $("conn").classList.remove("off");
  source.onmessage = (message) => apply(JSON.parse(message.data));
  source.onerror = () => {
    $("conn").classList.add("off");
    source.close();
    setTimeout(connect, 2000);
  };
}

async function start() {
  readCss();
  resize();
  window.addEventListener("resize", resize);
  try {
    const res = await fetch("/api/tree");
    if (res.ok) {
      const info = await res.json();
      for (const n of info.nodes) upsert(n);
      for (const a of info.approvals) approvals.set(a.id, a);
      if (info.charter?.name) $("title").textContent = info.charter.name;
    }
  } catch {
    // the event stream will fill the state in
  }
  connect();
  requestAnimationFrame(draw);
}

start();
