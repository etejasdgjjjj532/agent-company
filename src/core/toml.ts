export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') current += text[++i] ?? "";
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "[") {
      depth++;
      current += ch;
    } else if (ch === "]") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

function parseValue(raw: string): TomlValue {
  const text = raw.trim();
  if (text.startsWith('"')) return JSON.parse(text) as string;
  if (text.startsWith("'")) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new Error(`unterminated array: ${raw}`);
    return splitTop(text.slice(1, -1)).map(parseValue);
  }
  const num = Number(text.replace(/_/g, ""));
  if (text !== "" && Number.isFinite(num)) return num;
  throw new Error(`unsupported TOML value: ${raw}`);
}

function ensureTable(root: TomlTable, path: string[]): TomlTable {
  let table = root;
  for (const key of path) {
    const next = table[key];
    if (next === undefined) table[key] = {};
    else if (typeof next !== "object" || Array.isArray(next)) throw new Error(`key "${key}" is not a table`);
    table = table[key] as TomlTable;
  }
  return table;
}

function parseKeyPath(text: string): string[] {
  return text.split(".").map((part) => part.trim().replace(/^["']|["']$/g, ""));
}

export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    let line = stripComment(lines[index]).trim();
    if (line === "") continue;
    const header = line.match(/^\[([^\[\]]+)\]$/);
    if (header) {
      current = ensureTable(root, parseKeyPath(header[1]));
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) throw new Error(`line ${index + 1}: expected key = value`);
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    let value = line.slice(eq + 1).trim();
    while (value.startsWith("[") && !balanced(value) && index + 1 < lines.length) {
      value += ` ${stripComment(lines[++index]).trim()}`;
    }
    line = value;
    current[key] = parseValue(line);
  }
  return root;
}

function balanced(text: string): boolean {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return depth === 0;
}

function formatValue(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  return String(value);
}

export function stringifyToml(table: TomlTable, prefix: string[] = []): string {
  const scalars: string[] = [];
  const tables: string[] = [];
  for (const [key, value] of Object.entries(table)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      tables.push(stringifyToml(value, [...prefix, key]));
    } else {
      scalars.push(`${key} = ${formatValue(value)}`);
    }
  }
  const header = prefix.length > 0 && scalars.length > 0 ? `[${prefix.join(".")}]\n` : "";
  const body = scalars.length > 0 ? `${header}${scalars.join("\n")}\n` : "";
  return [body, ...tables].filter((part) => part !== "").join("\n");
}
