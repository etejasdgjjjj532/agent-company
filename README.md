# Agent Company

複数のコーディングエージェント (Claude Code / Codex / Gemini CLI / OpenCode、さらに GPT 互換 API) を、ツリー状の組織として束ねるデスクトップアプリです。

話しかける相手は最上位の Root だけ。Root が子・孫・ひ孫のエージェントを作って仕事を割り振り、結果をまとめて返します。動いている様子はグラフで見えます。

Windows / macOS / Linux で動くように作っています。

## インストール

### デスクトップアプリ (おすすめ)

[Releases](https://github.com/etejasdgjjjj532/agent-company/releases) から OS に合うものをダウンロードして開きます。

| OS | ファイル |
|---|---|
| Windows | `Agent Company Setup *.exe` |
| macOS | `Agent Company-*.dmg` |
| Linux | `Agent Company-*.AppImage` または `.deb` |

- 署名はまだ付けていません。macOS は「右クリック → 開く」、Windows は SmartScreen で「詳細情報 → 実行」が必要です。
- Linux の AppImage が起動しないときは `--no-sandbox` を付けてください (Ubuntu 24.04 以降の制限のため)。

### コマンドラインから

Node.js 22.18 以上と git が必要です。

```bash
npm install -g github:etejasdgjjjj532/agent-company
agent-company doctor     # 環境の点検
agent-company desktop    # アプリ風のウィンドウで起動 (Chrome / Edge を使用)
```

npm の警告で `prepare` の実行確認が出ても、そのままで大丈夫です。初回の起動時に自動でビルドします。

### 開発用

```bash
git clone https://github.com/etejasdgjjjj532/agent-company
cd agent-company/apps/desktop
npm install
npm start                # Electron で起動
```

## はじめに

1. エージェント CLI を 1 つ以上入れて、各 CLI で一度ログインしておきます (`agent-company doctor` で確認できます)。
   - `npm install -g @anthropic-ai/claude-code` / `@openai/codex` / `@google/gemini-cli` / `opencode-ai`
2. アプリを開いて「新しいセッション」で、作業フォルダ (git リポジトリ) と、やりたいことを入力します。
3. 秘書が規模 (軽量 / 標準 / 大規模) をおすすめします。深さや同時実行数は手で変えられます。
4. 「この組織で開始」を押すと、Root との会話が始まります。

## 仕組み

```
あなた ── Root ─┬─ 子 ─┬─ 孫 ─ ひ孫
                │      └─ 孫
                └─ 子
```

- 各エージェントは専用の git ブランチ (worktree) で作業します。衝突しにくく、完了後に Root が統合を提案します。
- 統合は、差分を見たうえであなたが承認したときだけ行われます。
- 深さ・同時実行数・総数・時間・トークンの上限は、アプリ側 (デーモン) が強制します。エージェントは上限を破れません。
- 失敗した子は 2 回まで自動で再試行し、それでも駄目なら Root に報告されます。
- 兄弟のエージェントは、親 (Root など) が許可した組み合わせだけ、直接メッセージを送り合えます。
- 子にも、画面から直接指示を送れます。実行中なら完了後に実行され、どちらの場合も Root に自動で通知されます。
- 終了したセッションは、過去のセッションの画面から「再開」できます。完了済みのノードと結果、会話はそのまま復元され、途中だったノードは「停止」として扱われます。
- 実行記録は JSONL に残り、過去のセッションをあとから読み返せます。キーやトークンらしい文字列は記録前に伏せられます。

## GPT 互換 API を使う

設定 → 「GPT互換 API」で、OpenAI / OpenRouter / Groq / Ollama / LM Studio / 社内プロキシなどを登録できます。Base URL とキーを入れて「接続テスト」を押すと、使えるモデルの一覧が出ます。

- 呼び出しには opencode (`npm install -g opencode-ai`) を使います。
- 登録すると `api:<名前>` というエンジンとして、Root や子に選べます。
- キーはこのパソコンの設定ファイルに保存されます (所有者のみ読み書き)。環境変数から読む設定もできます。

## コマンド

```text
agent-company desktop   アプリ風のウィンドウで起動
agent-company start     サーバーだけ起動して URL を表示
agent-company init      ターミナルで秘書と相談して設計書を作る
agent-company doctor    環境の点検
agent-company replay <events.jsonl>   記録の表示
```

`--fake` を付けると、AI を使わないスクリプト動作のダミーで画面を試せます。

## 対応状況

| 項目 | 状態 |
|---|---|
| Claude Code / Codex / OpenCode | Linux の実機で、Root と子の組み合わせを確認済み |
| GPT 互換 API (opencode 経由) | 疑似サーバーで接続・認証・モデル指定を確認済み |
| Gemini CLI | 実装済みですが、未認証のため実機では未確認です。公式ドキュメントには、2026 年 6 月に Antigravity CLI へ置き換えられたという注記があり、今後は対応の見直しが必要になるかもしれません |
| Windows / macOS | CI でテストを実行しています。実機の確認はこれからです |

## 既知の制限

- 再開したセッションでは、途中だったノードはやり直されません。必要なら Root に作り直しを頼んでください。
- Gemini CLI は、セッションを引き継げないため、完了後の追加指示は使えません。
- 承認が必要なのは「統合」だけです。ネットワークの遮断は、Codex では強制されますが、Claude Code ではツールの制限による対応です。

## セキュリティ

- 画面は、このパソコンの中だけで待ち受けます。起動ごとのトークンがないと操作できません。
- `--allow-lan` を付けたときだけ LAN に公開します。通信は暗号化されないので、信頼できるネットワークだけで使ってください。
- 画面は、スクリプトを自分のものだけに制限する CSP で配信しています。

## 開発

```bash
npm test          # テスト (Node 標準のテストランナー、依存なし)
npm run build     # dist/ を作る
```

設計は [docs/DESIGN.md](docs/DESIGN.md)、決めたことの記録は [docs/DECISIONS.md](docs/DECISIONS.md) にあります。

## ライセンス

MIT
