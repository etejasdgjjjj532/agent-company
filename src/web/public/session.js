import { api, el, fmtNumber, term } from "./util.js";

export function renderSession(root, ctx) {
  const { store, readOnly, meta } = ctx;
  const timeline = el("div", { class: "timeline" });
  const stats = el("span", { class: "muted small" });
  const busyChip = el("span", { class: "chip" });
  const input = el("textarea", { rows: 1, placeholder: readOnly ? "過去のセッションは読み取り専用です" : `${term("root")} に話しかける (Enter で送信、Shift+Enter で改行)`, disabled: readOnly });
  const send = el("button", { class: "primary", type: "submit", disabled: readOnly }, "送信");
  const stop = el("button", { type: "button", class: "danger", onclick: () => api("/api/node/root/stop", {}).catch((e) => ctx.toast(e.message, true)) }, "停止");

  const form = el("form", { class: "composer", onsubmit: async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || readOnly) return;
    input.value = "";
    autosize();
    try {
      await api("/api/chat", { text });
    } catch (error) {
      ctx.toast(error.message, true);
    }
  } }, el("div", { class: "grow" }, input), stop, send);

  const autosize = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  const head = el("div", { class: "session-head" },
    el("span", { class: "title" }, meta?.name ?? "セッション"),
    el("span", { class: "muted small" }, meta?.repoDir ?? ""),
    el("span", { class: "grow" }), busyChip, stats,
    el("button", { class: "small", onclick: () => ctx.toggleSide() }, "グラフ / 詳細"),
    readOnly && meta?.id ? el("button", { class: "small", onclick: async () => {
      try {
        await api(`/api/sessions/${meta.id}/resume`, {});
        await ctx.refresh();
      } catch (error) {
        ctx.toast(error.message, true);
      }
    } }, "再開") : null,
    !readOnly ? el("button", { class: "small danger", onclick: async () => {
      if (!confirm("このセッションを終了しますか? 動いているエージェントはすべて止まります。")) return;
      await api("/api/session/stop", {});
      await ctx.refresh();
      ctx.go({ name: "session", id: meta.id });
    } }, "終了") : el("span", { class: "chip" }, "読み取り専用"),
  );

  root.replaceChildren(head, timeline, form);

  const render = () => {
    const s = store.stats();
    stats.textContent = `${s.count} ノード / 実行中 ${s.running} / ${fmtNumber(s.tokens)} トークン / コスト ${s.cost === null ? "不明" : `$${s.cost.toFixed(2)}${s.costPartial ? " (一部不明)" : ""}`}`;
    busyChip.textContent = store.rootBusy ? "作業中" : readOnly ? "" : "待機中";
    busyChip.classList.toggle("ok", store.rootBusy);
    stop.hidden = !store.rootBusy || readOnly;
    const stick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
    const items = store.timeline.map((entry) => renderEntry(entry, store, ctx, readOnly)).filter(Boolean);
    if (store.rootBusy) items.push(el("div", { class: "thinking busy" }, "作業中"));
    if (items.length === 0) items.push(el("div", { class: "empty" }, readOnly ? "このセッションの記録はありません。" : `${term("root")} に最初の依頼を送ってみましょう。`));
    timeline.replaceChildren(...items);
    if (stick) timeline.scrollTop = timeline.scrollHeight;
  };
  const off = store.onChange(render);
  render();
  timeline.scrollTop = timeline.scrollHeight;
  if (!readOnly) input.focus();
  return () => off();
}

function renderEntry(entry, store, ctx, readOnly) {
  switch (entry.kind) {
    case "user": return el("div", { class: "msg user" }, entry.text);
    case "assistant": return el("div", { class: "msg assistant" }, entry.text);
    case "error": return el("div", { class: "msg error" }, entry.text);
    case "thinking": return el("div", { class: "thinking" }, entry.text);
    case "activity":
      return el("div", { class: `activity ${entry.tone ?? ""}`, onclick: () => entry.nodeId && ctx.selectNode(entry.nodeId) }, el("span", { class: "dot" }), entry.text);
    case "approval": {
      const approval = store.approvals.get(entry.approvalId);
      if (!approval) return null;
      return el("div", { class: "approval-card" },
        el("strong", {}, "承認が必要です"),
        el("pre", {}, approval.description),
        readOnly ? null : el("div", { class: "row" },
          el("button", { class: "primary", onclick: () => api(`/api/approval/${approval.id}`, { approved: true }).catch((e) => ctx.toast(e.message, true)) }, "承認して統合"),
          el("button", { onclick: () => api(`/api/approval/${approval.id}`, { approved: false }).catch((e) => ctx.toast(e.message, true)) }, "却下")));
    }
    default: return null;
  }
}
