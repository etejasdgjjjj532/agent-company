const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
];

const ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"']{6,})\3/gi;

export const REDACTED = "[REDACTED]";

export function maskSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, prefix) =>
      typeof prefix === "string" && /^bearer/i.test(prefix) ? `${prefix}${REDACTED}` : REDACTED,
    );
  }
  return out.replace(ASSIGNMENT, (_m, name, sep, quote) => `${name}${sep}${quote}${REDACTED}${quote}`);
}

export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = maskDeep(item);
    return out as T;
  }
  return value;
}
