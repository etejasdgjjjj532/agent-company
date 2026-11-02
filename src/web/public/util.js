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
