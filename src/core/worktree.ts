import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const IDENTITY = ["-c", "user.name=agent-company", "-c", "user.email=agent-company@localhost"];

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function isGitRepo(dir: string): boolean {
  try {
    git(dir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

export function createWorktree(repoDir: string, path: string, branch: string, base: string): void {
  mkdirSync(dirname(path), { recursive: true });
  git(repoDir, ["worktree", "add", "-q", "-b", branch, path, base]);
  const modules = join(repoDir, "node_modules");
  if (existsSync(modules) && !existsSync(join(path, "node_modules"))) {
    symlinkSync(modules, join(path, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
}

export function commitAll(dir: string, message: string): boolean {
  const status = git(dir, ["status", "--porcelain"]);
  const changed = status
    .split("\n")
    .filter((line) => line.trim() !== "" && !/\bnode_modules\/?$/.test(line));
  if (changed.length === 0) return false;
  git(dir, ["add", "-A", "--", ".", ":(exclude)node_modules"]);
  git(dir, ["commit", "-q", "-m", message]);
  return true;
}

export function diffAgainst(dir: string, branch: string, maxChars = 4000): string {
  const stat = git(dir, ["diff", "--stat", `HEAD...${branch}`]);
  const patch = git(dir, ["diff", `HEAD...${branch}`]);
  const clipped = patch.length > maxChars ? `${patch.slice(0, maxChars)}\n... (diff truncated)` : patch;
  return `${stat}\n${clipped}`.trim();
}

export function mergeBranch(dir: string, branch: string, message: string): { ok: boolean; output: string } {
  try {
    const output = git(dir, ["merge", "--no-ff", "-m", message, branch]);
    return { ok: true, output: output.trim() };
  } catch (error: any) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    try {
      git(dir, ["merge", "--abort"]);
    } catch {
      // nothing to abort
    }
    return { ok: false, output };
  }
}

export function removeWorktree(repoDir: string, path: string, branch?: string): void {
  try {
    git(repoDir, ["worktree", "remove", "--force", path]);
  } catch {
    // already gone
  }
  if (branch) {
    try {
      git(repoDir, ["branch", "-D", branch]);
    } catch {
      // branch kept when it cannot be deleted
    }
  }
}
