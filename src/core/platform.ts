import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";

export interface SpawnSpec {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export type Platform = NodeJS.Platform;

export function dataHome(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_COMPANY_HOME) return env.AGENT_COMPANY_HOME;
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agent-company");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "agent-company");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-company");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform): string | null {
  const exts = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()) : [""];
  const hasExt = extname(command) !== "";
  const dirs = isAbsolute(command) || command.includes("/") || command.includes("\\") ? [""] : (env.PATH ?? env.Path ?? "").split(delimiter);
  for (const dir of dirs) {
    const base = dir ? join(dir, command) : command;
    const candidates = platform === "win32" && !hasExt ? exts.map((ext) => base + ext) : [base];
    for (const candidate of candidates) if (isFile(candidate)) return candidate;
  }
  return null;
}

const META = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCmdCommand(arg: string): string {
  return arg.replace(META, "^$1");
}

export function escapeCmdArgument(arg: string): string {
  let out = `${arg}`;
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  out = out.replace(/(?=(\\+?)?)\1$/, "$1$1");
  out = `"${out}"`;
  return out.replace(META, "^$1");
}

export function resolveSpawn(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): SpawnSpec {
  if (platform !== "win32") return { file: command, args };
  const found = findOnPath(command, env, platform) ?? command;
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args };
  const line = [escapeCmdCommand(found), ...args.map(escapeCmdArgument)].join(" ");
  return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

export function killTree(pid: number | undefined, signal: NodeJS.Signals, platform: Platform = process.platform): void {
  if (!pid) return;
  if (platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already exited
    }
  }
}

export function commandExists(command: string): boolean {
  return findOnPath(command) !== null;
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function browserCandidates(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((v): v is string => Boolean(v));
    const rel = [
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    ];
    return roots.flatMap((root) => rel.map((parts) => join(root, ...parts)));
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"];
}

export function findAppBrowser(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of browserCandidates(platform, env)) {
    const found = findOnPath(candidate, env, platform);
    if (found) return found;
  }
  return null;
}

export function openUrl(url: string, platform: Platform = process.platform): void {
  const [cmd, args] =
    platform === "win32" ? ["cmd.exe", ["/c", "start", '""', url.replace(/&/g, "^&")]]
    : platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => console.log(`ブラウザを開けませんでした。次の URL を開いてください:\n${url}`));
  child.unref();
}

export function openAppWindow(url: string, profileDir: string): "app" | "browser" {
  const browser = findAppBrowser();
  if (!browser) {
    openUrl(url);
    return "browser";
  }
  const child = spawn(
    browser,
    [`--app=${url}`, `--user-data-dir=${profileDir}`, "--window-size=1320,860", "--no-first-run", "--no-default-browser-check"],
    { stdio: "ignore", detached: true, windowsHide: false },
  );
  child.on("error", () => openUrl(url));
  child.unref();
  return "app";
}
