import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const out = join(root, "dist");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

rmSync(out, { recursive: true, force: true });
for (const file of walk(src)) {
  const target = join(out, file.slice(src.length + 1));
  mkdirSync(dirname(target), { recursive: true });
  if (extname(file) === ".ts") {
    const code = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
    writeFileSync(target.replace(/\.ts$/, ".js"), code.replace(/(\.{1,2}\/[\w./-]*)\.ts(["'])/g, "$1.js$2"));
  } else {
    cpSync(file, target);
  }
}
console.log("built dist/");
