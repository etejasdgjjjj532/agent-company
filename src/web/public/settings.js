import { api, el, getTerms, setTerms } from "./util.js";

const put = (parent, ...nodes) => parent.append(...nodes.flat().filter(Boolean));

let tab = "general";
let editing = null;

export async function renderSettings(root, ctx, wantedTab) {
  if (wantedTab) tab = wantedTab;
  const body = el("div");
  const tabs = el("div", { class: "tabs" }, [["general", "一般"], ["api", "GPT互換 API"], ["env", "環境"]].map(([key, label]) =>
    el("button", { class: `tab${tab === key ? " active" : ""}`, onclick: () => { tab = key; editing = null; renderSettings(root, ctx); } }, label)));
  root.replaceChildren(el("div", { class: "page" }, el("h1", {}, "設定"), tabs, body));
  if (tab === "general") general(body, ctx);
  else if (tab === "api") await providers(body, ctx, root);
  else await environment(body);
}

function general(body, ctx) {
  const select = el("select", { onchange: async (e) => {
    const next = await api("/api/settings", { terms: e.target.value });
    setTerms(next.terms);
    ctx.state.settings = { ...ctx.state.settings, ...next };
    ctx.rerender();
  } }, el("option", { value: "tech", selected: getTerms() === "tech" }, "技術用語 (Root / 子 / 孫)"), el("option", { value: "company", selected: getTerms() === "company" }, "会社メタファー (社長 / 部下)"));
  put(body, 
    el("div", { class: "field" }, el("label", {}, "画面の用語"), select, el("div", { class: "small muted" }, "表示だけが変わります。設計書や記録の内容は変わりません。")),
    el("div", { class: "field" }, el("div", { class: "label" }, "データの保存先"), el("code", {}, ctx.state.home ?? "")),
  );
}

async function environment(body) {
  put(body, el("p", { class: "muted" }, "確認中…"));
  const { checks } = await api("/api/doctor");
  body.replaceChildren(
    el("p", { class: "muted" }, "各エージェント CLI のログイン (認証) は、それぞれのコマンドを一度起動して済ませておいてください。"),
    ...checks.map((c) => el("div", { class: "provider" },
      el("span", { class: `dot ${c.ok ? "done" : c.required ? "failed" : ""}` }),
      el("strong", { style: "min-width:90px" }, c.name),
      el("div", { class: "grow small" }, c.detail, c.ok || !c.hint ? null : el("div", { class: "muted" }, c.hint)))),
  );
}

async function providers(body, ctx, root) {
  const [{ providers: list, presets }, { opencodeReady }] = await Promise.all([api("/api/providers"), api("/api/engines")]);
  const refresh = () => renderSettings(root, ctx);
  put(body, 
    el("p", { class: "muted" }, "OpenAI 互換の API (OpenAI / OpenRouter / Groq / Ollama / LM Studio / 社内プロキシなど) を、opencode 経由でエージェントとして使えます。"),
    opencodeReady ? null : el("div", { class: "notice" }, "API の呼び出しには opencode が必要です。入っていません: ", el("code", {}, "npm install -g opencode-ai")),
  );
  if (editing) return void put(body, providerForm(presets, ctx, refresh));
  put(body, 
    ...list.map((p) => el("div", { class: "provider" },
      el("span", { class: `dot ${p.hasKey || p.baseUrl.includes("localhost") ? "done" : "failed"}` }),
      el("div", { class: "grow" }, el("strong", {}, p.name), el("div", { class: "small muted" }, `${p.baseUrl} / ${p.defaultModel || "モデル未設定"}${p.hasKey ? "" : " / キーなし"}`), el("div", { class: "small muted" }, `エンジン名: api:${p.id}`)),
      el("button", { class: "small", onclick: () => { editing = p; refresh(); } }, "編集"))),
    list.length === 0 ? el("p", { class: "muted" }, "まだ登録がありません。") : null,
    el("div", { class: "row", style: "margin-top:14px" }, el("button", { class: "primary", onclick: () => { editing = {}; refresh(); } }, "API を追加")),
  );
}

function providerForm(presets, ctx, refresh) {
  const p = editing;
  const isNew = !p.id;
  const state = { env: Boolean(p.apiKeyEnv), models: [...(p.models ?? [])] };
  const name = el("input", { type: "text", value: p.name ?? "", placeholder: "例: OpenRouter" });
  const baseUrl = el("input", { type: "text", value: p.baseUrl ?? "", placeholder: "https://api.openai.com/v1" });
  const key = el("input", { type: "password", autocomplete: "off", placeholder: p.hasKey && !p.apiKeyEnv ? "保存済み (変える時だけ入力)" : "sk-..." });
  const keyEnv = el("input", { type: "text", value: p.apiKeyEnv ?? "", placeholder: "OPENAI_API_KEY" });
  const models = el("input", { type: "text", value: state.models.join(", "), placeholder: "gpt-4.1, gpt-4.1-mini", oninput: (e) => { state.models = e.target.value.split(/[\s,、]+/).filter(Boolean); } });
  const defaultModel = el("input", { type: "text", value: p.defaultModel ?? "", placeholder: "最初のモデルが既定になります" });
  const result = el("div");
  const keyRow = el("div");
  const drawKey = () => keyRow.replaceChildren(state.env
    ? el("div", {}, keyEnv, el("div", { class: "small muted" }, "起動時に、この環境変数の値を読みます。キーはファイルに保存されません。"))
    : el("div", {}, key, el("div", { class: "small muted" }, "このパソコンの設定ファイルに保存されます (所有者のみ読み書き)。画面や記録には出ません。")));
  drawKey();

  const payload = () => ({ id: p.id, name: name.value, baseUrl: baseUrl.value, apiKey: key.value, apiKeyEnv: state.env ? keyEnv.value : "", models: models.value, defaultModel: defaultModel.value });
  const toast = ctx.toast;

  return el("div", {},
    isNew ? el("div", { class: "field" }, el("div", { class: "label" }, "プリセット"), el("div", { class: "row wrap" }, presets.map((preset) =>
      el("button", { class: "small", onclick: () => { name.value = preset.name; baseUrl.value = preset.baseUrl; if (!preset.needsKey) { state.env = false; drawKey(); } if (preset.models.length) { models.value = preset.models.join(", "); state.models = [...preset.models]; } } }, preset.name)))) : null,
    el("div", { class: "field" }, el("label", {}, "名前"), name),
    el("div", { class: "field" }, el("label", {}, "Base URL"), baseUrl),
    el("div", { class: "field" }, el("div", { class: "row" }, el("label", { class: "grow" }, "API キー"),
      el("label", { class: "check small" }, el("input", { type: "checkbox", checked: state.env, onchange: (e) => { state.env = e.target.checked; drawKey(); } }), "環境変数から読む")), keyRow,
      el("div", { class: "small muted" }, "Ollama や LM Studio のようなローカルサーバーはキーなしで使えます。")),
    el("div", { class: "field" }, el("label", {}, "モデル (カンマ区切り)"), models),
    el("div", { class: "field" }, el("label", {}, "既定のモデル"), defaultModel),
    result,
    el("div", { class: "row", style: "margin-top:12px" },
      el("button", { onclick: async () => {
        result.replaceChildren(el("span", { class: "muted" }, "接続しています…"));
        try {
          const r = await api("/api/providers/test", { ...payload(), id: p.id });
          if (!r.ok) return void result.replaceChildren(el("div", { class: "notice bad" }, r.error));
          result.replaceChildren(el("div", { class: "notice" }, `接続できました。モデル ${r.models.length} 件`,
            el("div", { class: "row wrap", style: "margin-top:6px" }, r.models.slice(0, 24).map((m) => el("button", { class: "small", onclick: () => { if (!state.models.includes(m)) state.models.push(m); models.value = state.models.join(", "); if (!defaultModel.value) defaultModel.value = m; } }, m)))));
        } catch (error) {
          result.replaceChildren(el("div", { class: "notice bad" }, error.message));
        }
      } }, "接続テスト"),
      el("button", { class: "primary", onclick: async () => {
        try {
          await api("/api/providers", payload());
          editing = null;
          toast("保存しました");
          await ctx.refresh();
          refresh();
        } catch (error) {
          result.replaceChildren(el("div", { class: "notice bad" }, error.message));
        }
      } }, "保存"),
      el("button", { onclick: () => { editing = null; refresh(); } }, "キャンセル"),
      isNew ? null : el("button", { class: "danger", onclick: async () => {
        if (!confirm(`${p.name} を削除しますか?`)) return;
        await api("/api/providers/delete", { id: p.id });
        editing = null;
        await ctx.refresh();
        refresh();
      } }, "削除")),
  );
}
