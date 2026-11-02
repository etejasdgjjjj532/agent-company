import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Hub } from "./hub.ts";
import { startWebServer } from "./web/server.ts";
import { defaultAdapters } from "./adapters/index.ts";
import { fakeAdapter } from "./adapters/fake.ts";
import type { Adapter } from "./adapters/types.ts";
import { KNOWN_CLIS, parseCharter } from "./core/charter.ts";
import { dataHome, openAppWindow, openUrl } from "./core/platform.ts";
import { readJsonl } from "./core/store.ts";
import { isGitRepo } from "./core/worktree.ts";
import { detectClis, doctorPasses, formatChecks, runDoctor } from "./doctor.ts";
import { describeCharter, makeAdvisor, runWizard } from "./secretary.ts";

const HELP = `agent-company: 複数のコーディングエージェントをツリー状に束ねる司令塔

使い方:
  agent-company desktop     デスクトップアプリのウィンドウで起動する (おすすめ)
  agent-company [start]     サーバーだけ起動して Web UI の URL を表示する
  agent-company init        ターミナルで秘書と相談して agent-company.toml を作る
  agent-company doctor      環境を点検する (Node / git / 各エージェント CLI)
  agent-company replay <events.jsonl>   過去の実行記録を表示する

start のオプション:
  --repo <dir>        作業対象の git リポジトリ (既定: 現在のフォルダ)
  --charter <file>    設計書 (既定: <repo>/agent-company.toml)
  --goal "<text>"     起動直後に Root へ渡す依頼
  --port <n>          Web UI のポート (既定: 4317、使用中なら自動)
  --open              start 時に既定のブラウザを開く
  --host <addr> --allow-lan   LAN に公開する (暗号化なし。信頼できるネットワークだけで)
  --fake              実際の AI を使わず、スクリプト動作のダミーで試す
  --no-web            Web UI を起動しない
`;

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["repo", "charter", "goal", "port", "host"]);

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) flags.set(name, inline);
      else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) flags.set(name, argv[++i]);
      else flags.set(name, true);
    } else positional.push(arg);
  }
  const first = positional[0];
  const known = ["start", "desktop", "init", "doctor", "replay", "help"];
  const command = first && known.includes(first) ? positional.shift()! : "start";
  return { command, positional, flags };
}

function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function terminalIO() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    io: {
      ask: (question: string, fallback = "") =>
        new Promise<string>((resolveAnswer) => {
          rl.question(`${question}${fallback ? ` (${fallback})` : ""}: `, (answer) => resolveAnswer(answer.trim() === "" ? fallback : answer));
        }),
      say: (text: string) => console.log(text),
    },
    close: () => rl.close(),
  };
}

function charterPath(args: Args, repoDir: string): string {
  return resolve(flag(args, "charter") ?? join(repoDir, "agent-company.toml"));
}

async function init(args: Args): Promise<boolean> {
  const repoDir = resolve(flag(args, "repo") ?? process.cwd());
  const target = charterPath(args, repoDir);
  const available = detectClis();
  const adapters = defaultAdapters();
  const terminal = terminalIO();
  try {
    if (existsSync(target)) {
      const again = await terminal.io.ask(`${target} は既にあります。作り直しますか? [y/N]`, "n");
      if (!/^y/i.test(again)) return true;
    }
    const advisorDir = join(dataHome(), "advisor");
    mkdirSync(advisorDir, { recursive: true });
    const result = await runWizard({ io: terminal.io, available, advisor: makeAdvisor(adapters, repoDir, advisorDir) });
    if (!result) return false;
    writeFileSync(target, result.toml);
    console.log(`保存しました: ${target}`);
    return true;
  } finally {
    terminal.close();
  }
}

async function start(args: Args, desktop: boolean): Promise<void> {
  const repoDir = resolve(flag(args, "repo") ?? process.cwd());
  const fake = args.flags.has("fake");
  if (fake) process.env.AGENT_COMPANY_FAKE = "1";
  const adapters: Record<string, Adapter> = fake
    ? Object.fromEntries(KNOWN_CLIS.map((name) => [name, fakeAdapter(name)]))
    : defaultAdapters();
  const hub = new Hub({ adapters });
  const port = flag(args, "port") !== undefined ? Number(flag(args, "port")) : 4317;
  const listenOptions = { hub, host: flag(args, "host"), allowLan: args.flags.has("allow-lan") };
  let web;
  try {
    web = await startWebServer({ ...listenOptions, port });
  } catch (error: any) {
    if (error?.code !== "EADDRINUSE" || port === 0) throw error;
    web = await startWebServer({ ...listenOptions, port: 0 });
  }

  const target = charterPath(args, repoDir);
  if (existsSync(target)) {
    const charter = parseCharter(readFileSync(target, "utf8"));
    if (!fake && !detectClis().includes(charter.rootCli)) {
      await web.close();
      throw new Error(`Root の CLI "${charter.rootCli}" が見つかりません。agent-company doctor で確認してください`);
    }
    if (!isGitRepo(repoDir)) console.log("注意: git リポジトリではないので、各エージェントは同じフォルダで作業します (衝突に注意)。");
    await hub.start({ repoDir, charter });
    console.log(`\n${describeCharter(charter)}\n`);
    const goal = flag(args, "goal");
    if (goal) void hub.active!.orch.chat(goal).catch((error) => console.log(`エラー: ${error.message}`));
  } else {
    console.log("設計書 (agent-company.toml) がないので、画面の案内に従って組織を作ってください。");
  }

  console.log(`Web UI: ${web.url}`);
  console.log(`データ: ${hub.home}`);
  if (flag(args, "host") && !["127.0.0.1", "localhost", "::1"].includes(flag(args, "host")!)) {
    console.log("警告: LAN に公開しています。通信は暗号化されません。信頼できるネットワークだけで使ってください。");
  }
  if (desktop) {
    const mode = openAppWindow(web.url, join(hub.home, "app-profile"));
    if (mode === "browser") console.log("Chrome / Edge が見つからないので、既定のブラウザで開きました。");
  } else if (args.flags.has("open")) openUrl(web.url);

  let unsubscribe: (() => void) | null = null;
  const attach = () => {
    unsubscribe?.();
    unsubscribe = hub.active?.orch.bus.subscribe((event) => {
      if (event.type === "node.status" && event.nodeId !== "root") console.log(`  [${event.nodeId}] ${event.data?.status}`);
      else if (event.type === "node.created" && event.nodeId !== "root") {
        const node = event.data?.node as { cli?: string; role?: string } | undefined;
        console.log(`  [${event.nodeId}] 作成 (${node?.cli} / ${node?.role})`);
      } else if (event.type === "approval.requested") {
        console.log(`\n承認が必要です (id ${event.data?.id}):\n${event.data?.description}\n  Web UI で承認、または /approve ${event.data?.id} /deny ${event.data?.id}`);
      } else if (event.type === "chat.reply") console.log(`\nRoot> ${event.data?.text}\n`);
    }) ?? null;
  };
  hub.on("session", attach);
  attach();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("\n終了します...");
    await hub.stop();
    await web.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (process.stdin.isTTY) {
    console.log("ここに入力しても Root と会話できます。/tree 状態、/quit 終了、/help ヘルプ\n");
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
    rl.prompt();
    rl.on("line", (line) => {
      const text = line.trim();
      const orch = hub.active?.orch;
      if (text === "/quit" || text === "/exit") return void shutdown();
      if (text === "/help") console.log("/tree 状態 / /approve [id] / /deny [id] / /quit");
      else if (!orch && text) console.log("セッションがまだ始まっていません。Web UI で開始してください。");
      else if (orch && text === "/tree") {
        for (const n of orch.tree()) console.log(`  ${"  ".repeat(n.depth)}${n.id} ${n.cli} ${n.status} ${n.inputTokens + n.outputTokens}tok`);
      } else if (orch && /^\/(approve|deny)\b/.test(text)) {
        const [cmd, id] = text.split(/\s+/);
        const approvalId = id ?? orch.pendingApprovals()[0]?.id;
        if (!approvalId || !orch.resolveApproval(approvalId, cmd === "/approve")) console.log("対象の承認がありません");
      } else if (orch && text) {
        void orch.chat(text).catch((error) => console.log(`エラー: ${error.message}`));
      }
      rl.prompt();
    });
    rl.on("close", () => void shutdown());
  } else {
    console.log("Ctrl+C で終了します。");
  }
}

function replay(args: Args): void {
  const file = args.positional[0];
  if (!file) throw new Error("使い方: agent-company replay <events.jsonl>");
  for (const event of readJsonl(resolve(file))) {
    const time = new Date(event.ts).toISOString().slice(11, 19);
    console.log(`${time} #${event.seq} ${event.type} ${event.nodeId ?? ""} ${event.data ? JSON.stringify(event.data).slice(0, 160) : ""}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has("help") || args.command === "help") {
    console.log(HELP);
    return 0;
  }
  if (args.flags.has("version")) {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  try {
    switch (args.command) {
      case "doctor": {
        const checks = runDoctor();
        console.log(formatChecks(checks));
        return doctorPasses(checks) ? 0 : 1;
      }
      case "init":
        return (await init(args)) ? 0 : 1;
      case "replay":
        replay(args);
        return 0;
      case "desktop":
        await start(args, true);
        return -1;
      default:
        await start(args, false);
        return -1;
    }
  } catch (error: any) {
    console.error(`エラー: ${error?.message ?? error}`);
    return 1;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url) || process.env.AGENT_COMPANY_RUN_MAIN === "1") {
  main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  });
}
