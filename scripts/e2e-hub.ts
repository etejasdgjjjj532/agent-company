import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAdapters } from "../src/adapters/index.ts";
import { Hub } from "../src/hub.ts";
import { startWebServer } from "../src/web/server.ts";
import { makeRepo } from "../test/helpers.ts";

const [rootCli = "claude", childCli = "codex", preset = "light", ...goalWords] = process.argv.slice(2);
const base = mkdtempSync(join(tmpdir(), "ac-hub-e2e-"));
const repo = join(base, "repo");
mkdirSync(repo);
makeRepo(repo);
const hub = new Hub({ adapters: defaultAdapters(), home: join(base, "home") });
const web = await startWebServer({ hub, port: 0 });
const root = web.url.split("/?")[0];
const call = async (path: string, body?: unknown) => {
  const res = await fetch(`${root}${path}${path.includes("?") ? "&" : "?"}t=${web.token}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json() as Promise<any>;
};
const started = await call("/api/session/start", {
  repo, rootCli, childClis: childCli.split(","), preset,
  goal: goalWords.length ? goalWords.join(" ") : `Delegate to ONE sub-agent (cli ${childCli}) the task: create a file greeting.txt containing exactly the word hello. Wait for it, then merge its work with merge_child, and tell me the result in one line.`,
});
console.log("started", started.meta?.id ?? started);
const id = started.meta.id;
const deadline = Date.now() + 270_000;
let approved = false;
let last = 0;
while (Date.now() < deadline) {
  const { events } = await call(`/api/sessions/${id}/events`);
  for (const e of events.slice(last)) {
    if (["node.status", "node.created", "approval.requested", "approval.resolved", "chat.reply", "node.merged", "chat.error"].includes(e.type)) console.log(e.type, e.nodeId, JSON.stringify(e.data).slice(0, 140));
  }
  last = events.length;
  const pending = hub.active?.orch.pendingApprovals() ?? [];
  if (pending.length && !approved) {
    approved = true;
    console.log("approving", pending[0].id);
    await call(`/api/approval/${pending[0].id}`, { approved: true });
  }
  if (events.some((e: any) => e.type === "chat.reply")) break;
  await new Promise((r) => setTimeout(r, 1500));
}
const file = join(repo, "greeting.txt");
console.log("greeting.txt exists:", existsSync(file), existsSync(file) ? JSON.stringify(readFileSync(file, "utf8")) : "");
console.log("git log:", execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).trim().replace(/\n/g, " | "));
await hub.stop();
await web.close();
