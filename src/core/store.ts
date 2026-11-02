import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { maskDeep } from "./mask.ts";
import type { OrchEvent } from "./events.ts";

export function createJsonlSink(file: string): (event: OrchEvent) => void {
  mkdirSync(dirname(file), { recursive: true });
  return (event) => {
    appendFileSync(file, `${JSON.stringify(maskDeep(event))}\n`);
  };
}

export function readJsonl(file: string): OrchEvent[] {
  const text = readFileSync(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as OrchEvent);
}
