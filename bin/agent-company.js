#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "dist", "cli.js");

// npm may skip the prepare script (npm 11 asks for approval), so build on first launch when needed.
if (!existsSync(built) && existsSync(join(root, "scripts", "build.mjs"))) {
  try {
    await import(pathToFileURL(join(root, "scripts", "build.mjs")).href);
  } catch (error) {
    console.error(`初回のビルドに失敗しました: ${error?.message ?? error}`);
    console.error("次を実行してから、もう一度起動してください: npm rebuild -g agent-company --allow-scripts=agent-company");
    process.exit(1);
  }
}

const entry = existsSync(built) ? built : join(root, "src", "cli.ts");
process.env.AGENT_COMPANY_RUN_MAIN = "1";
await import(pathToFileURL(entry).href);
