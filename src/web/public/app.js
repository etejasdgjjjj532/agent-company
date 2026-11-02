import { GraphView } from "./graph.js";
import { renderSession } from "./session.js";
import { renderSettings } from "./settings.js";
import { renderSetup } from "./setup.js";
import { Store } from "./store.js";
import { $, api, desktop, el, fmtNumber, fmtTime, setTerms, term } from "./util.js";

const ctx = {
  state: { active: null, sessions: [], settings: { terms: "tech", recentProjects: [], providers: [] }, nodes: [], approvals: [], home: "" },
  liveStore: new Store(),
  liveId: null,
  history: new Map(),
  route: { name: "setup" },
  cleanup: null,
  graph: null,
  sideTab: "graph",
  selectedNode: "root",
  toast,
  async refresh() {
    ctx.state = { ...ctx.state, ...(await api("/api/state")) };
    setTerms(ctx.state.settings.terms);
    drawSidebar();
  },
  go(route) {
    ctx.route = route;
    render();
  },
  rerender: () => render(),
  toggleSide() {
    $("app").classList.toggle("side-open");
    ctx.graph?.resize();
  },
  selectNode(id) {
    ctx.selectedNode = id;
    ctx.sideTab = "node";
    $("app").classList.add("side-open");
    drawSide();
  },
};

function toast(message, bad = false) {
  const node = el("div", { class: `toast${bad ? " bad" : ""}` }, message);
  $("toasts").append(node);
  setTimeout(() => node.remove(), bad ? 6000 : 3000);
}

function drawSidebar() {
  const box = $("sessions");
  const { sessions, active } = ctx.state;
  const currentId = ctx.route.name === "session" ? ctx.route.id : null;
  const items = sessions.map((s) =>
    el("button", { class: `session-item${s.id === currentId ? " selected" : ""}`, onclick: () => ctx.go({ name: "session", id: s.id }), title: s.repoDir },
      el("span", { class: `dot${s.active ? " active" : ""}` }),
      el("span", { class: "name" }, s.name),
      el("span", { class: "muted small" }, fmtTime(s.startedAt))));
  box.replaceChildren(el("h3", {}, term("session")), ...(items.length ? items : [el("div", { class: "muted small", style: "padding:4px 8px" }, "まだありません")]));
  $("engine-state").textContent = active ? `実行中: ${active.name}` : "";
}

async function loadHistory(id) {
  if (ctx.history.has(id)) return ctx.history.get(id);
  const { events, meta } = await api(`/api/sessions/${id}/events`);
  const store = new Store();
  for (const event of events) store.apply(event);
  const entry = { store, meta };
  ctx.history.set(id, entry);
  return entry;
}

function drawSide() {
  const side = $("side");
  const store = currentStore();
  const tabs = el("div", { class: "side-tabs" },
    [["graph", "グラフ"], ["node", "ノード"], ["info", "設計"]].map(([key, label]) =>
      el("button", { class: `tab${ctx.sideTab === key ? " active" : ""}`, onclick: () => { ctx.sideTab = key; drawSide(); } }, label)),
    el("span", { class: "grow" }), el("button", { class: "small ghost", onclick: () => ctx.toggleSide(), "aria-label": "閉じる" }, "×"));
  const body = el("div", { class: "side-body" });
  side.replaceChildren(tabs, body);
  if (!store) return;
  if (ctx.sideTab === "graph") {
    const canvas = el("canvas", { "aria-label": "エージェントのグラフ" });
    body.append(el("div", { class: "graph-wrap" }, canvas, el("div", { class: "legend" },
      [["run", "実行中"], ["done", "完了"], ["pending", "待機"], ["failed", "失敗"], ["approval", "承認待ち"]].map(([c, l]) => el("span", {}, el("i", { class: `i-${c}` }), l)))));
    ctx.graph?.stop();
    ctx.graph = new GraphView(canvas, store, (id) => { ctx.selectedNode = id; });
    ctx.graph.selected = ctx.selectedNode;
    ctx.graph.start();
  } else {
    ctx.graph?.stop();
    ctx.graph = null;
    if (ctx.sideTab === "node") renderNodeDetail(body, store);
    else renderInfo(body, store);
  }
}

function renderNodeDetail(body, store) {
  const n = store.nodes.get(ctx.selectedNode) ?? store.nodes.get("root");
  if (!n) return void body.append(el("div", { class: "detail muted" }, "ノードがありません"));
  const kv = el("dl", { class: "kv" });
  const add = (k, v) => kv.append(el("dt", {}, k), el("dd", {}, String(v ?? "-")));
  add("ID", n.id === "root" ? "Root" : n.id);
  add("エンジン", n.cli);
  add("状態", n.status + (n.attempts > 1 ? ` (試行 ${n.attempts})` : ""));
  add("深さ", n.depth);
  add("トークン", fmtNumber((n.inputTokens || 0) + (n.outputTokens || 0)));
  add("コスト", typeof n.costUsd === "number" ? `$${n.costUsd.toFixed(3)}` : "不明");
  if (n.branch) add("ブランチ", n.branch);
  if (n.error) add("エラー", n.error);
  const log = el("div", { class: "log" }, n.log.slice(-80).map((line) => el("div", { class: line.kind }, line.text)));
  const parts = [el("h2", {}, n.id === "root" ? "Root" : `${n.id} ${n.role || ""}`), el("p", { class: "muted" }, n.task || ""), kv, log];
  const readOnly = ctx.route.name === "session" && ctx.route.id !== ctx.state.active?.id;
  if (!readOnly && (n.status === "running" || n.status === "pending")) parts.push(el("button", { class: "small", onclick: () => api(`/api/node/${encodeURIComponent(n.id)}/stop`, {}).catch((e) => toast(e.message, true)) }, "このノードを停止"));
  if (!readOnly && n.id !== "root") {
    const input = el("input", { type: "text", placeholder: "このノードへ直接指示 (完了後に送れます)" });
    parts.push(el("form", { class: "row", style: "margin-top:10px", onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      try {
        await api(`/api/node/${encodeURIComponent(n.id)}/message`, { text });
      } catch (error) {
        toast(error.message, true);
      }
    } }, el("div", { class: "grow" }, input), el("button", { type: "submit" }, "送る")));
  }
  body.append(el("div", { class: "detail" }, parts));
  log.scrollTop = log.scrollHeight;
}

function renderInfo(body, store) {
  const charter = ctx.state.charter;
  body.append(el("div", { class: "detail" },
    el("h2", {}, "組織の設計"),
    el("dl", { class: "kv" },
      el("dt", {}, "最大の深さ"), el("dd", {}, String(charter?.maxDepth ?? "-")),
      el("dt", {}, "同時実行"), el("dd", {}, String(charter?.maxConcurrent ?? "-")),
      el("dt", {}, "ノード数"), el("dd", {}, String(store.nodes.size))),
    el("p", { class: "muted small" }, "深さや同時実行数は、新しいセッションの作成画面で変えられます。")));
}

function currentStore() {
  if (ctx.route.name !== "session") return null;
  if (ctx.route.id === ctx.state.active?.id) return ctx.liveStore;
  return ctx.history.get(ctx.route.id)?.store ?? null;
}

async function render() {
  try {
    await renderRoute();
  } catch (error) {
    console.error(error);
    $("main").replaceChildren(el("div", { class: "page" }, el("div", { class: "notice bad" }, `画面の表示に失敗しました: ${error.message}`)));
  }
}

async function renderRoute() {
  ctx.cleanup?.();
  ctx.cleanup = null;
  const main = $("main");
  const route = ctx.route;
  $("app").classList.toggle("side-open", route.name === "session");
  drawSidebar();
  if (route.name === "setup") {
    ctx.graph?.stop();
    $("side").replaceChildren();
    return void (await renderSetup(main, ctx));
  }
  if (route.name === "settings") {
    ctx.graph?.stop();
    $("side").replaceChildren();
    return void (await renderSettings(main, ctx, route.tab));
  }
  const isLive = route.id === ctx.state.active?.id;
  let store = ctx.liveStore;
  let meta = ctx.state.active;
  if (!isLive) {
    try {
      const entry = await loadHistory(route.id);
      store = entry.store;
      meta = entry.meta ?? ctx.state.sessions.find((s) => s.id === route.id);
    } catch (error) {
      toast(error.message, true);
      return void ctx.go({ name: "setup" });
    }
  }
  const sessionCtx = { ...ctx, store, readOnly: !isLive, meta };
  ctx.cleanup = renderSession(main, sessionCtx);
  drawSide();
}

function bindShell() {
  $("new-session").addEventListener("click", () => ctx.go({ name: "setup" }));
  $("open-settings").addEventListener("click", () => ctx.go({ name: "settings", tab: "general" }));
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "n") {
      e.preventDefault();
      ctx.go({ name: "setup" });
    } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
      e.preventDefault();
      ctx.go({ name: "settings", tab: "general" });
    }
  });
  desktop?.onMenu?.((action) => {
    if (action === "new-session") ctx.go({ name: "setup" });
    else if (action === "settings") ctx.go({ name: "settings", tab: "general" });
  });
}

function notifyApproval(description) {
  const text = description.split("\n")[0];
  if (desktop?.notify) desktop.notify("承認が必要です", text);
  else if (document.hidden && "Notification" in window && Notification.permission === "granted") new Notification("承認が必要です", { body: text });
}

function connect() {
  const source = new EventSource(`/events?since=${ctx.liveStore.lastSeq}`);
  source.addEventListener("hub", async (message) => {
    const { active } = JSON.parse(message.data);
    const changed = (active?.id ?? null) !== ctx.liveId;
    ctx.liveId = active?.id ?? null;
    if (changed) ctx.liveStore = new Store();
    await ctx.refresh();
    ctx.liveStore.loadSnapshot(ctx.state);
    if (changed) {
      if (active) ctx.go({ name: "session", id: active.id });
      else if (ctx.route.name === "session" && ctx.route.id !== active?.id) render();
      else render();
    }
  });
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    ctx.liveStore.apply(event);
    if (event.type === "approval.requested") notifyApproval(event.data.description);
    if (event.type === "node.created" || event.type === "node.status") {
      if (!ctx.refreshPending) {
        ctx.refreshPending = true;
        setTimeout(() => { ctx.refreshPending = false; ctx.refresh(); }, 600);
      }
    }
  };
  source.onerror = () => {
    source.close();
    setTimeout(connect, 2000);
  };
}

async function boot() {
  bindShell();
  await ctx.refresh();
  if (ctx.state.active) {
    ctx.liveId = ctx.state.active.id;
    ctx.route = { name: "session", id: ctx.state.active.id };
  } else if (ctx.state.sessions.length === 0) {
    ctx.route = { name: "setup" };
  }
  connect();
  await render();
}

boot().catch((error) => {
  document.body.append(el("pre", { class: "notice bad" }, `起動に失敗しました: ${error.message}`));
});
