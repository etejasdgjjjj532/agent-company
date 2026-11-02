export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) {
      try {
        node[key] = value;
      } catch {
        node.setAttribute(key, value === true ? "" : value);
      }
    } else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export async function api(path, body) {
  const options = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `request failed (${res.status})`);
    Object.assign(error, data);
    throw error;
  }
  return data;
}

const TERM_SETS = {
  tech: { root: "Root", child: "子", chat: "Root との会話", session: "セッション" },
  company: { root: "社長", child: "部下", chat: "社長との会話", session: "プロジェクト" },
};
let terms = "tech";
export function setTerms(value) {
  terms = value === "company" ? "company" : "tech";
}
export function term(key) {
  return TERM_SETS[terms][key];
}
export function getTerms() {
  return terms;
}

export function fmtNumber(n) {
  return Number(n || 0).toLocaleString();
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const desktop = window.desktop ?? null;

function inlineMarkdown(text) {
  const out = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(el("code", {}, m[1].slice(1, -1)));
    else if (m[2]) out.push(el("strong", {}, m[2].slice(2, -2)));
    else {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(m[3]);
      out.push(el("a", { href, target: "_blank", rel: "noopener noreferrer" }, label));
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function renderMarkdown(source) {
  const root = el("div", { class: "md" });
  const lines = String(source).split("\n");
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) root.append(el("p", {}, inlineMarkdown(para.join(" "))));
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      const code = body.join("\n");
      root.append(el("div", { class: "codeblock" },
        el("button", { class: "small copy", type: "button", onclick: async (e) => { const ok = await copyText(code); e.target.textContent = ok ? "コピーしました" : "失敗"; setTimeout(() => { e.target.textContent = "コピー"; }, 1500); } }, "コピー"),
        el("pre", {}, el("code", {}, code))));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      root.append(el("div", { class: "md-h" }, inlineMarkdown(heading[2])));
    } else if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const list = el(ordered ? "ol" : "ul", {});
      while (i < lines.length) {
        const item = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]) : /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        if (!item) break;
        list.append(el("li", {}, inlineMarkdown(item[1])));
        i++;
      }
      root.append(list);
      continue;
    } else if (line.trim() === "") flush();
    else para.push(line);
    i++;
  }
  flush();
  return root;
}

export function renderDiff(text) {
  const box = el("div", { class: "diff" });
  for (const line of String(text).split("\n")) {
    let cls = "ctx";
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) cls = "meta";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    box.append(el("div", { class: `dl ${cls}` }, line || " "));
  }
  return box;
}
