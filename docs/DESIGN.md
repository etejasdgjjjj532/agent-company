# 設計

## 目的

複数のエージェントCLIを階層状に束ね、ユーザーは最上位のエージェント(Root)とだけ会話する。

## 全体像

```
会長(ユーザー)
   │ ① 設立前の相談
   ▼
 秘書 (Setup Agent) ── 組織設計を提案 ──► charter.toml
                                          │ ② 承認
                                          ▼
                              orchd が charter から組織を設立
                                          │
会長 ◄──── ③ 運用中の会話 ────► 社長 (Root Agent)
                                          ├ 子
                                          │  └ 孫
                                          │     └ ひ孫 ...
```

| | 秘書 (Setup Agent) | Root Agent |
|---|---|---|
| いつ | 設立前、組織改編のとき | 運用中ずっと |
| 仕事 | 目的を聞いて組織設計を提案する | 設計された組織で仕事を進める |
| 触るもの | 設定と charter のみ(コードは触らない) | リポジトリと配下のエージェント |
| 権限 | 読み取りと設定ファイル生成のみ | 子の生成、指示、統合 |

## コンポーネント

```
orchd (常駐デーモン)
 ├ Node Registry   ツリーの現在状態(唯一の正)
 ├ Event Bus       spawn / start / output / wait / approve / done / fail / cost
 ├ Limits          深さ・子の数・総数・予算の強制
 ├ Adapters        CLIごとの差を吸収 (claude, codex, gemini, opencode)
 ├ MCP server      各エージェントに渡す制御ツール(ノードごとに絞る)
 └ Monitor         イベントを購読して描画 (Web グラフビュー / TUI / Replay)
```

### 原則

- ツリーは LLM ではなくデーモンが管理する。LLM は「子を作りたい」と頼むだけで、上限検査・起動・記録はデーモンが行う。
- `can_spawn = false` の階層には `spawn_child` ツール自体を渡さない。見えないものは呼べない。
- 通信は共有コンテキストではなくメッセージ渡し。子は `result.md` と短い要約だけを返す。結果は階層ごとに圧縮して上へ上げる。
- ノードごとに git worktree を作る。完了したノードは変更を統合した後に掃除する。
- 子の承認要求は Root を経由してユーザーに集約する。非可逆操作は必ずユーザー承認。

## charter(組織設計書)

秘書が会長と相談して作り、会長が承認する。人が読める TOML で、git に入れる。

```toml
[limits]
max_depth       = 3     # 0=Root, 1=子, 2=孫, 3=ひ孫
max_total_nodes = 12
max_concurrent  = 4

[root]
cli = "claude"

[level.1]
max_children = 4
allowed_cli  = ["claude", "codex", "gemini", "opencode"]
can_spawn    = true

[level.2]
max_children = 3
allowed_cli  = ["codex", "opencode"]
can_spawn    = true

[level.3]
max_children = 0
allowed_cli  = ["opencode"]
can_spawn    = false
```

### 起動時の選択(秘書が提示)

- サブエージェントの数: おすすめ値(`min(独立サブタスク数, 同時実行上限, 予算から逆算した数)`)/ 少なめ / 数値入力 / おまかせ
- 深さ: 子まで / 孫まで / ひ孫まで / 数値入力
- 下位の自動増殖: 上限内は自動 / 増やすたびに確認

## 制御ツール(MCP)

| ツール | 渡す対象 |
|---|---|
| `report(result)`, `ask_parent(question)` | 全ノード |
| `spawn_child(cli, role, task)`, `ask_child`, `list_children`, `stop_child` | `can_spawn = true` のノードのみ |
| `get_tree_status`, `get_node_summary` | Root |

`spawn_child` は、深さ・親の `max_children`・`max_total_nodes` を順に検査し、超えていればエラーを返す。

## Adapter

共通インターフェースは `start / send / events / stop`。最初は各CLIの非対話モードを使う。コマンドと出力形式は実装前に各CLIの最新ヘルプで確認する(未検証)。

| CLI | 想定する起動 |
|---|---|
| Claude Code | `claude -p --output-format stream-json` |
| Codex | `codex exec --json` |
| Gemini CLI | `gemini -p` |
| OpenCode | `opencode run` |

## ビジュアライズ

イベントバスを唯一のデータ源にして、Monitor が描画する。

- Web: Obsidian のグラフビュー風の力学グラフ。ノードの大きさは子の数、色は状態、実行中は脈動と流れる点、承認待ちは点滅。ホバーで関連をハイライト、深さスライダー、ズームとパン。`127.0.0.1` のみで配信する。
- TUI: ツリーと承認操作に絞った最小限の表示。
- Replay: JSONL を時系列に流して過去セッションを再生する。

## 安全

- 上限は深さ・子の数・総数・予算(トークン/時間)の4種類。デーモンが強制する。
- 全イベントを JSONL に記録し、再開できるようにする。
- シークレットはログに残さない。各CLIの既存認証を使う。
- 停止はノード単位とツリー全体の両方に対応する。
- Web UI は認証なしで外部公開しない。

## 技術選定

- TypeScript で、デーモン・MCP・Web UI を統一する。
- 作業対象は git リポジトリ前提。
- 状態保存は JSONL(必要になれば SQLite)。

## 段階

1. **MVP**: orchd の骨組み(ノードツリー、イベントバス、JSONL、Limits)/ Adapter 2種(claude, codex)/ 秘書と charter 生成 / Web グラフビュー / Root 用 MCP ツール
2. ネスト(孫以降)の動作確認、gemini と opencode の Adapter、承認の中継
3. worktree のマージ支援、予算制御、再開、ACP Adapter

## リスク

- 深くするほどコストとレート制限が膨らむ。上限を最初から入れる。
- worktree 分離でも、統合時に衝突する。
- 非対話モードでは承認プロンプトを扱えないことがある。
- CLIごとに挙動が違う。Adapter は薄く保つ。
