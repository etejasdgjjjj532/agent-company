#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "dist", "cli.js");
const entry = existsSync(built) ? built : join(root, "src", "cli.ts");
process.env.AGENT_COMPANY_RUN_MAIN = "1";
await import(pathToFileURL(entry).href);
