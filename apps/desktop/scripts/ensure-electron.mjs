import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// npm may skip install scripts, in which case the Electron binary is missing until this runs.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "electron");
if (!existsSync(join(root, "dist"))) {
  const result = spawnSync(process.execPath, [join(root, "install.js")], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
