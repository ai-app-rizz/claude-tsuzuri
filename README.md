# Tsuzuri for Claude Code

> Claude Code に永続記憶を。会話をまたいで文脈を保持する、ローカル完結型メモリシステム。

**Tsuzuri** (綴り) は Claude Code の hooks を使って会話を自動保存し、次のセッションから自然に引き継げるようにします。外部サービス不要・完全ローカル動作・日本語対応。

---

## 特徴

- **自動キャプチャ** — UserPromptSubmit / Stop フックで会話を自動保存
- **セッション起動時に注入** — handoff / project-state を凍結ブロックとして自動注入
- **2層検索** — Tier1: 起動時注入 / Tier2: SQLite FTS5（日本語 trigram 対応）
- **意味検索オプション** — Ollama + [Ruri large](https://huggingface.co/cl-nagoya/ruri-large)（日本製・ローカル無料）でハイブリッド検索
- **構造化記憶** — 決定事項・バグ修正を `decisions.md` / `bugs-and-fixes.md` に蒸留
- **blob 分離** — コード・ログを埋め込み対象から自動除外し、検索精度を向上
- **冪等 capture** — 直近2秒の重複保存を自動スキップ
- **スコープ解決** — global / project / sandbox を自動判定・リネーム耐性あり

---

## インストール

```bash
# プロジェクトルートで実行
node install.js
```

オプション：

```bash
node install.js --with-embeddings   # 意味検索の案内も表示
node install.js --no-embeddings     # FTS5 のみ（Ollama 不要）
```

インストーラが以下を自動配置します：

- `.claude/hooks/` — 全 hook スクリプト
- `.claude/memory/` — メモリディレクトリ（handoff.md, decisions.md 等）
- `.claude/settings.local.json` — hooks 登録

---

## 使い方

インストール後は **何もしなくて OK**。Claude Code を使うだけで自動的に記憶が積み上がります。

### ループを閉じる（推奨）

セッション終了後、未処理の会話を構造化メモリに蒸留します：

```bash
# 未処理の会話テキストを確認
node .claude/hooks/memory-distill.js

# 決定事項を記録
node .claude/hooks/memory-remember.js decision

# バグ修正を記録
node .claude/hooks/memory-remember.js bug

# 処理済みとしてマーク
node .claude/hooks/memory-mark-processed.js
```

### 検索

```bash
# キーワード検索（FTS5）
python3 .claude/hooks/memory-search.py "検索語"

# 意味検索（要 Ollama）
python3 .claude/hooks/memory-search.py "検索語" --semantic

# ハイブリッド検索
python3 .claude/hooks/memory-search.py "検索語" --hybrid
```

---

## 意味検索のセットアップ（オプション）

```bash
# Ollama インストール後
ollama pull kun432/cl-nagoya-ruri-large

export MEMORY_EMBED_PROVIDER=ollama

# インデックスを初回構築
python3 .claude/hooks/memory-search.py "" --reindex
```

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| `MEMORY_EMBED_PROVIDER` | `''`（FTS5） | `ollama` または `openai` |
| `MEMORY_EMBED_MODEL` | `kun432/cl-nagoya-ruri-large` | 埋め込みモデル名 |

---

## ディレクトリ構成

```
.claude/
├── hooks/
│   ├── memory-capture.js        # 会話の自動保存
│   ├── memory-session-start.js  # 起動時メモリ注入
│   ├── memory-mark-processed.js # 処理済みマーク
│   ├── memory-distill.js        # 未処理会話の確認
│   ├── memory-remember.js       # 構造化メモリへの追記
│   ├── memory-search.py         # 検索（FTS5 + 意味検索）
│   ├── memory-blob.js           # コード/ログ分離
│   ├── memory-paths.js          # スコープ解決（Node.js）
│   └── memory_paths.py          # スコープ解決（Python）
└── memory/
    ├── handoff.md               # セッション引き継ぎメモ
    ├── project-state.md         # プロジェクト恒久情報
    ├── decisions.md             # 決定事項ログ
    ├── bugs-and-fixes.md        # バグ修正ログ
    └── fragments/               # 生会話データ（SQLite）
```

---

## 動作要件

- **Node.js** 18+
- **Python** 3.8+
- **Claude Code** 最新版
- （意味検索のみ）**Ollama** + `kun432/cl-nagoya-ruri-large`

---

## ライセンス

MIT

---

## English Summary

**Tsuzuri** (綴り, "to string together") gives Claude Code persistent memory through Claude Code hooks.

- Auto-captures conversations via hooks (no manual work)
- Injects session summaries at startup
- Full-text search with SQLite FTS5 (Japanese trigram support, zero extra dependencies)
- Optional semantic search via Ollama + Ruri (Japanese embedding model, fully local)
- Distills raw logs into structured decisions and bug records

```bash
node install.js   # run in your project root
```
