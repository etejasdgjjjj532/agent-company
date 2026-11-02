# 設計

## 目的

複数のエージェント CLI と GPT 互換 API を階層状に束ね、ユーザーは最上位のエージェント (Root) とだけ会話する。

## 全体像

```
Electron シェル (メニュー、フォルダ選択、通知、ウィンドウ状態)
   └─ 画面 (HTML / JS、依存なし)  ←  HTTP + SSE (127.0.0.1、トークン認証、CSP)
          └─ Hub (設定、プロバイダ、セッション一覧)
                └─ Session ── Orchestrator ──┬─ Registry (ノードツリー)
                                              ├─ Limits (深さ / 子の数 / 総数 / 予算)
                                              ├─ MCP サーバー (ノードごとのトークンで出し分け)
                                              ├─ Worktree (ノードごとに git worktree)
                                              └─ Adapter (claude / codex / gemini / opencode / api:*)
```

## 主な部品

| 部品 | 役割 |
|---|---|
| `core/limits.ts` | 子を作ってよいかの検査 |
| `core/charter.ts` | 設計書 (プリセット、検証、TOML の読み書き) |
| `core/providers.ts` | GPT 互換 API の登録と opencode 設定の生成 |
| `core/platform.ts` | OS 差 (保存先、Windows のコマンド解決、プロセスツリー停止、ブラウザ起動) |
| `adapters/*` | CLI ごとの起動方法と出力の読み取り。プロンプトは標準入力で渡す |
| `mcp/http.ts` | 各エージェントに渡す制御ツール (spawn_child, wait_children, report など) |
| `orchestrator.ts` | ノードの生成・実行・再試行・統合・承認 |
| `hub.ts` | セッションと設定の管理 |
| `web/server.ts` | 画面の配信、API、イベントストリーム |
| `secretary.ts` | 設立前の相談 (規模のおすすめ、設計書の作成) |

## 原則

- ツリーは LLM ではなくデーモンが管理する。LLM は「子を作りたい」と頼むだけで、上限検査・起動・記録はデーモンが行う。
- `can_spawn = false` の階層には `spawn_child` ツール自体を渡さない。
- 通信は共有コンテキストではなくメッセージ渡し。子の結果は 2000 文字以内に要約して親へ返す。
- 子は自分の worktree でだけ書き込む。コミットはオーケストレーターが行う。
- 統合は Root が提案し、ユーザーが承認したときだけ行う。承認待ちの間も MCP の呼び出しがタイムアウトしないよう、一定時間で「まだ未回答」と返し、再度の呼び出しで続きを処理する。
- 全イベントを JSONL に記録する。書き込み前にキーやトークンらしい文字列を伏せる。

## エンジンの名前

- CLI: `claude`, `codex`, `gemini`, `opencode`
- GPT 互換 API: `api:<プロバイダID>` または `api:<プロバイダID>:<モデル>`。opencode に OpenAI 互換のプロバイダ設定を渡して実行する。

## charter (設計書)

```toml
name = "agent-company"

[limits]
max_depth = 2
max_total_nodes = 8
max_concurrent = 3
max_retries = 2
max_node_minutes = 20
max_total_tokens = 0   # 0 は無制限

[root]
cli = "claude"

[level.0]
max_children = 4
allowed_cli = ["claude"]
can_spawn = true

[level.1]
max_children = 2
allowed_cli = ["claude", "codex", "api:openrouter"]
can_spawn = true

[level.2]
max_children = 0
allowed_cli = ["claude", "codex", "api:openrouter"]
can_spawn = false
```

## 制御ツール (MCP)

| ツール | 渡す対象 |
|---|---|
| `report` | 全ノード |
| `spawn_child`, `list_children`, `wait_children`, `stop_child`, `get_child_diff`, `merge_child` | `can_spawn = true` のノード |
| `get_tree_status` | Root |

`wait_children` の間は同時実行の枠を手放すので、親子が枠を取り合って止まることはない。

## 画面

- 左: セッション一覧。中央: チャット (ツールの実行や子の完了も流れる)。右: グラフ / ノード詳細 / 設計。
- 導入画面 (秘書): フォルダ、目的、エンジン、規模のおすすめ、組織の形のプレビュー。
- 設定: 用語、GPT 互換 API の登録 (接続テストとモデルの取得)、環境の点検。
- Obsidian のグラフビュー風の力学グラフ。実行中は脈動、承認待ちは点滅。

## 未実装

- 兄弟間の通信
- 再開時に、途中だったノードを自動でやり直す機能
- Gemini CLI の実機確認、Windows / macOS の実機確認
- 署名付きインストーラ
