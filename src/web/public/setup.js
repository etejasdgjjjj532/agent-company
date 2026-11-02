import { api, debounce, desktop, el, term } from "./util.js";

const PRESETS = {
  light: { label: "軽量", depth: 1, concurrent: 2, total: 4, note: "小さな作業向け" },
  standard: { label: "標準", depth: 2, concurrent: 3, total: 8, note: "ふつうの開発向け" },
  large: { label: "大規模", depth: 3, concurrent: 4, total: 12, note: "大きな作業向け" },
};

const form = { mode: "multi", repo: "", goal: "", rootCli: "", childClis: null, preset: null, maxDepth: "", maxConcurrent: "", saveCharter: false, allowNonGit: false };

export async function renderSetup(root, ctx) {
  root.replaceChildren(el("div", { class: "page" }, el("p", { class: "muted" }, "読み込み中…")));
  const [{ engines }, repo0] = await Promise.all([api("/api/engines"), Promise.resolve(null)]);
  void repo0;
  const usable = engines.filter((e) => e.available);
  if (!form.rootCli || !usable.some((e) => e.name === form.rootCli)) form.rootCli = (usable.find((e) => e.name === "claude") ?? usable[0])?.name ?? "";
  if (!form.childClis) form.childClis = new Set(usable.map((e) => e.name));
  if (!form.repo) form.repo = ctx.state.settings.recentProjects[0] ?? "";

  const status = el("div");
  const repoNote = el("div", { class: "small" });
  const presetBox = el("div", { class: "presets" });
  const taskNote = el("div", { class: "small muted" });
  const treeBox = el("pre", { class: "tree" }, "…");
  const errorBox = el("div");
  const startButton = el("button", { class: "primary", type: "button", onclick: start }, "この組織で開始");
  let recommended = null;
  let advice = null;

  const repoInput = el("input", { type: "text", list: "recent-projects", placeholder: "/path/to/your/repository", value: form.repo, oninput: (e) => { form.repo = e.target.value; form.allowNonGit = false; checkRepo(); } });
  const goalInput = el("textarea", { rows: 3, placeholder: "例: ログイン機能を作る、テストを書く、ドキュメントを更新する", value: form.goal, oninput: (e) => { form.goal = e.target.value; advice = null; preview(); } });
  const rootSelect = el("select", { onchange: (e) => { form.rootCli = e.target.value; preview(); } }, usable.map((e) => el("option", { value: e.name, selected: e.name === form.rootCli }, e.label)));
  const depthInput = el("input", { type: "number", min: 1, max: 6, placeholder: "プリセット", value: form.maxDepth, oninput: (e) => { form.maxDepth = e.target.value; preview(); } });
  const concInput = el("input", { type: "number", min: 1, max: 16, placeholder: "プリセット", value: form.maxConcurrent, oninput: (e) => { form.maxConcurrent = e.target.value; preview(); } });

  const childChecks = el("div", { class: "checks" }, engines.map((e) => {
    const box = el("input", { type: "checkbox", checked: form.childClis.has(e.name) && e.available, disabled: !e.available, onchange: (ev) => { ev.target.checked ? form.childClis.add(e.name) : form.childClis.delete(e.name); preview(); } });
    return el("label", { class: `check${e.available ? "" : " disabled"}`, title: e.reason ?? "" }, box, e.label);
  }));

  const checkRepo = debounce(async () => {
    if (!form.repo.trim()) return void repoNote.replaceChildren();
    try {
      const info = await api(`/api/repo?path=${encodeURIComponent(form.repo)}`);
      if (!info.exists) repoNote.replaceChildren(el("span", { class: "chip bad" }, "フォルダが見つかりません"));
      else if (info.isGit) repoNote.replaceChildren(el("span", { class: "chip ok" }, "git リポジトリ: 各エージェントは専用の作業ブランチで作業します"));
      else {
        repoNote.replaceChildren(
          el("div", { class: "notice" }, "git リポジトリではありません。全員が同じフォルダで作業するため、変更が衝突することがあります。",
            el("label", { class: "check" }, el("input", { type: "checkbox", checked: form.allowNonGit, onchange: (e) => { form.allowNonGit = e.target.checked; } }), "それでも続ける")),
        );
      }
    } catch (error) {
      repoNote.replaceChildren(el("span", { class: "chip bad" }, error.message));
    }
  }, 300);

  const preview = debounce(async (withAdvice = false) => {
    if (!form.rootCli) return;
    try {
      const body = { mode: form.mode, goal: form.goal, rootCli: form.rootCli, childClis: [...form.childClis], preset: form.preset ?? undefined, maxDepth: form.maxDepth || undefined, maxConcurrent: form.maxConcurrent || undefined, advise: withAdvice === true };
      const result = await api("/api/setup/preview", body);
      recommended = result.recommended;
      if (withAdvice === true) advice = result.advice;
      if (!form.preset) form.preset = null;
      draw(result);
      errorBox.replaceChildren();
    } catch (error) {
      errorBox.replaceChildren(el("div", { class: "notice bad" }, error.message));
    }
  }, 250);

  function draw(result) {
    const selected = form.preset ?? recommended;
    presetBox.replaceChildren(...Object.entries(PRESETS).map(([key, p]) =>
      el("button", { type: "button", class: `preset${key === selected ? " selected" : ""}`, onclick: () => { form.preset = key; preview(); } },
        recommended === key ? el("span", { class: "badge" }, "おすすめ") : null,
        el("strong", {}, p.label), el("div", { class: "small muted" }, `深さ ${p.depth} / 同時 ${p.concurrent} / 最大 ${p.total} 体`), el("div", { class: "small muted" }, p.note))));
    taskNote.textContent = `独立して進められる作業は約 ${result.tasks} 件${advice ? ` (${advice.reason})` : ""}。`;
    treeBox.textContent = result.tree;
  }

  async function start() {
    errorBox.replaceChildren();
    startButton.disabled = true;
    try {
      const { meta } = await api("/api/session/start", {
        mode: form.mode, repo: form.repo, goal: form.goal, rootCli: form.rootCli, childClis: [...form.childClis], preset: form.preset ?? recommended ?? "standard",
        maxDepth: form.maxDepth || undefined, maxConcurrent: form.maxConcurrent || undefined, allowNonGit: form.allowNonGit, saveCharter: form.saveCharter,
      });
      form.goal = "";
      await ctx.refresh();
      ctx.go({ name: "session", id: meta.id });
    } catch (error) {
      errorBox.replaceChildren(el("div", { class: "notice bad" }, error.message));
      if (error.needsGit) checkRepo();
    } finally {
      startButton.disabled = false;
    }
  }

  if (usable.length === 0) {
    status.replaceChildren(el("div", { class: "notice bad" },
      el("strong", {}, "使えるエージェントがありません。"), " Claude Code / Codex / Gemini CLI / OpenCode のどれかを入れるか、設定で GPT 互換 API を登録してください。",
      el("div", { class: "row", style: "margin-top:8px" }, el("button", { type: "button", onclick: () => ctx.go({ name: "settings", tab: "env" }) }, "環境を確認"), el("button", { type: "button", onclick: () => ctx.go({ name: "settings", tab: "api" }) }, "API を登録"))));
  }

  const modeCards = el("div", { class: "mode-cards" }, [
    ["normal", "通常モード", "1体のエージェントと、普通のコーディングアシスタントのように会話します。"],
    ["multi", "マルチエージェントモード", "Root が子や孫に仕事を分担させ、結果をまとめます。"],
  ].map(([key, title, note]) => el("button", { type: "button", class: `preset${form.mode === key ? " selected" : ""}`, onclick: () => { form.mode = key; renderSetup(root, ctx); } }, el("strong", {}, title), el("div", { class: "small muted" }, note))));
  const templates = ctx.state.settings.templates ?? [];
  const templateSelect = el("select", { onchange: (e) => {
    const t = templates.find((x) => x.id === e.target.value);
    if (!t) return;
    Object.assign(form, { mode: t.mode, rootCli: t.rootCli, childClis: new Set(t.childClis), preset: t.preset ?? null, maxDepth: t.maxDepth ?? "", maxConcurrent: t.maxConcurrent ?? "", goal: t.goal ?? form.goal });
    renderSetup(root, ctx);
  } }, el("option", { value: "" }, templates.length ? "テンプレートから選ぶ…" : "テンプレートはまだありません"), templates.map((t) => el("option", { value: t.id }, `${t.name} (${t.mode === "normal" ? "通常" : "マルチ"})`)));
  const saveTemplateButton = el("button", { type: "button", class: "small", onclick: async () => {
    const name = prompt("テンプレートの名前");
    if (!name) return;
    try {
      await api("/api/templates", { name, mode: form.mode, rootCli: form.rootCli, childClis: [...form.childClis], preset: form.preset ?? recommended ?? undefined, maxDepth: form.maxDepth || undefined, maxConcurrent: form.maxConcurrent || undefined, goal: form.goal });
      await ctx.refresh();
      ctx.toast("テンプレートを保存しました");
      renderSetup(root, ctx);
    } catch (error) {
      ctx.toast(error.message, true);
    }
  } }, "テンプレートとして保存");
  const multiOnly = el("div", { class: form.mode === "normal" ? "hidden" : "" },
    el("div", { class: "row wrap" },
      el("div", { class: "field grow" }, el("label", {}, "最大の深さ (手動)"), depthInput),
      el("div", { class: "field grow" }, el("label", {}, "同時に動かす数 (手動)"), concInput)),
    el("div", { class: "field" }, el("label", {}, `${term("child")}以下で使うエンジン`), childChecks),
    el("div", { class: "field" },
      el("div", { class: "row" }, el("label", { class: "grow" }, "規模"), taskNote,
        el("button", { type: "button", class: "small", title: "AI に目的を読ませて規模を見積もります (トークンを少し使います)", onclick: () => { preview(true); } }, "AI に相談")),
      presetBox));

  const pickButton = desktop?.pickFolder
    ? el("button", { type: "button", onclick: async () => { const picked = await desktop.pickFolder(); if (picked) { repoInput.value = picked; form.repo = picked; form.allowNonGit = false; checkRepo(); } } }, "選択…")
    : null;

  root.replaceChildren(
    el("div", { class: "page" },
      el("div", { class: "row" }, el("h1", { class: "grow" }, "新しいセッション"), templateSelect, saveTemplateButton),
      el("p", { class: "muted" }, "秘書が、作業フォルダと目的から組織の形を提案します。決めたあとはいつでも Root に話しかけるだけです。"),
      status,
      el("div", { class: "field" }, el("label", {}, "作業フォルダ"), el("div", { class: "row" }, el("div", { class: "grow" }, repoInput), pickButton), repoNote,
        el("datalist", { id: "recent-projects" }, ctx.state.settings.recentProjects.map((p) => el("option", { value: p })))),
      el("div", { class: "field" }, el("label", {}, "やりたいこと (空でも開始できます)"), goalInput),
      el("div", { class: "field" }, el("div", { class: "label" }, "モード"), modeCards),
      el("div", { class: "field" }, el("label", {}, `${form.mode === "normal" ? "使う" : term("root") + " の"}エンジン`), rootSelect),
      multiOnly,
      el("div", { class: "field" }, el("div", { class: "label" }, "構成"), treeBox),
      el("label", { class: "check", style: "display:inline-flex;margin-bottom:12px" }, el("input", { type: "checkbox", checked: form.saveCharter, onchange: (e) => { form.saveCharter = e.target.checked; } }), "設計書 (agent-company.toml) をフォルダに保存する"),
      errorBox,
      el("div", { class: "row" }, startButton),
    ),
  );
  checkRepo();
  preview();
}
