---
title: "Claude Codeに永続記憶を自作した — Tsuzuri for Claude Code"
emoji: "🧠"
type: "tech"
topics: ["claudecode", "ai", "sqlite", "ollama", "個人開発"]
published: false
---

## セッションを閉じると、Claude は全部忘れる

Claude Code は優秀ですが、**セッションを閉じると会話の文脈をすべて忘れます**。

数日前に「この方式でいこう」と決めたはずなのに、新しいセッションでは何も覚えていない。同じ説明を毎回やり直す。決定事項がまた蒸し返される。長く使うほど、この「健忘」がストレスになっていきます。

そこで、**ローカル完結・無料・日本語対応**の永続記憶システムを自作しました。それが **Tsuzuri（綴り）** です。

https://github.com/ai-app-rizz/claude-tsuzuri

「綴り」＝バラバラの会話を一本の糸でつなぎ、文脈を綴じていく、という意味を込めています。

---

## 既存ツールのどこが不満だったか

「Claude Code memory」で検索すると、すでに多くのツールが出てきます。mem0、Letta、Zep、各種 claude-memory 系リポジトリ…。群雄割拠です。

ただ、自分の用途で使おうとすると、どれも引っかかる点がありました。

- **日本語の検索が弱い** — 海外製はトークナイザが英語前提で、日本語の全文検索・意味検索の精度が出にくい
- **API 課金が発生する** — 埋め込みに OpenAI API などを使うと、会話が増えるほどコストがかさむ
- **クラウドに送信される** — 仕事の文脈やコードを外部サービスに預けたくない

「日本語で・無料で・ローカルで完結する」ものが欲しい。なければ作る、ということで作りました。

---

## 設計思想：3つの原則

Tsuzuri は次の3点に振り切っています。

1. **ローカル完結** — データは SQLite に保存。意味検索も Ollama でローカル実行。外部送信ゼロ
2. **無料** — API 課金なし。追加の pip / npm 依存もほぼゼロ（標準ライブラリ中心）
3. **日本語対応** — SQLite FTS5 の trigram トークナイザ ＋ 日本製埋め込みモデル Ruri

そして最大の特徴は、**インストール後は何もしなくていい**こと。Claude Code の hooks を使い、会話を自動で保存し、次回起動時に自動で注入します。

---

## 仕組み

### 全体像

```
[会話] ──UserPromptSubmit/Stop hook──▶ [SQLite に自動保存]
                                              │
[新セッション] ◀──SessionStart hook── [要約を自動注入]
                                              │
                                  [必要なら過去ログを検索]
```

Claude Code の hooks（`UserPromptSubmit` / `Stop` / `SessionStart`）に小さな Node.js / Python スクリプトをぶら下げているだけです。

### 2層メモリ

記憶を「常に思い出すもの」と「必要なときに掘るもの」に分けています。

- **Tier1（注入）** — `handoff.md`（引き継ぎメモ）と `project-state.md`（恒久情報）を、セッション起動時に必ず注入する。"いつも頭にある記憶"
- **Tier2（検索）** — 過去の生ログを SQLite FTS5 で全文検索。"思い出そうとして掘る記憶"

全部を毎回注入するとコンテキストを食い潰すので、要約だけ常時注入し、詳細は検索で取りに行く構造です。

### 工夫1：blob 分離で検索精度を上げる

会話には、自然文だけでなくコードブロックやスタックトレース、長大なログが混ざります。これらをそのまま埋め込みベクトルにすると、ノイズになって検索精度が落ちます。

そこで、会話本文を **「会話テキスト」と「コード/ログ blob」に分離**しました。

```js
// memory-blob.js より（抜粋）
function splitBlobs(content) {
  // 1) ```フェンス付きコードブロックを抽出
  // 2) 連続するシェルコマンド/JSON/スタックトレース/ログ行をまとめて blob 化
  // → text（会話のみ）と blobs（コード/ログ）に分ける
  return { text, blobs };
}
```

意味検索の埋め込み対象は **text（会話のみ）**。一方で全文検索（FTS5）と詳細表示には全文を残すので、**情報は失わずに信号だけ高める**ことができます。

### 工夫2：生ログを「構造化メモリ」に蒸留する

生の会話ログは情報密度が低く、そのまま貯めても検索ノイズになりがちです。そこで、確定した内容を蒸留して構造化します。

- 決定事項 → `decisions.md`
- 解決したバグ → `bugs-and-fixes.md`

```bash
node .claude/hooks/memory-distill.js      # 未処理の会話を要約表示
node .claude/hooks/memory-remember.js decision   # 決定を構造化追記
node .claude/hooks/memory-remember.js bug        # バグ修正を構造化追記
```

内容ハッシュで重複を自動スキップするので、同じことを二重に記録しません。そして意味検索の埋め込み元を「生ログ」ではなく「この構造化メモリ」に向けることで、検索の信号品質をさらに上げています。

### 工夫3：意味検索は日本製モデルでローカル実行（オプション）

キーワードが一致しなくても、意味が近ければ拾いたい。そのための意味検索は **Ollama + [Ruri large](https://huggingface.co/cl-nagoya/ruri-large)**（日本製・Apache-2.0）で実現しています。完全ローカル・無料です。

```bash
ollama pull kun432/cl-nagoya-ruri-large
export MEMORY_EMBED_PROVIDER=ollama
python3 .claude/hooks/memory-search.py "曖昧な質問でも意味で探す" --hybrid
```

キーワード（FTS5）と意味（埋め込み）を **RRF で融合したハイブリッド検索**もできます。そして重要なのは、**Ollama を入れなくても動く**こと。`MEMORY_EMBED_PROVIDER` が未設定なら自動で FTS5 のみにフォールバックします。意味検索はあくまで「効く人だけ効かせる」オプション層です。

---

## インストールと使い方

プロジェクトのルートで、インストーラを実行するだけです。

```bash
node install.js
```

これで `.claude/hooks/` にスクリプト群、`.claude/memory/` にメモリファイル、`settings.local.json` に hooks 登録が自動配置されます。

あとは普通に Claude Code を使うだけ。会話は自動で記憶され、次のセッションで引き継がれます。

セッション終了後にループを閉じたいときだけ、蒸留コマンドを叩きます。

```bash
node .claude/hooks/memory-distill.js
node .claude/hooks/memory-remember.js decision
node .claude/hooks/memory-mark-processed.js
```

検索したいときはこれ。

```bash
# キーワード検索（追加依存ゼロ・日本語OK）
python3 .claude/hooks/memory-search.py "検索語"

# 意味検索（要 Ollama）
python3 .claude/hooks/memory-search.py "検索語" --hybrid
```

---

## 今後の予定

現状は「永続記憶のコア」が固まったところで、次のような拡張を考えています。

- **sbx（Docker サンドボックス）↔ 母艦の記憶同期** — Claude Code を Docker コンテナ内で動かして作業した記憶を、ホスト側に共有する仕組み。今は sbx 内でも壊れずに動く対応まで入れていて、同期そのものはこれから
- **global インストールでの全プロジェクト横断メモリ** — `~/.claude/` 側に置いて、プロジェクトをまたいで思い出せるように
- **意味検索の品質改善** — 短文・定型文のノイズを、チャンク分割や定型文除去で減らす

「まず動くコアを出して反応を見てから育てる」方針なので、要望があれば優先度を上げて実装します。

---

## おわりに

Tsuzuri は「Claude Code に記憶を持たせたい」という個人的な不満から始めたものですが、

- **ローカル完結・無料・日本語対応**
- インストール後は**自動で記憶**
- 追加依存ほぼゼロ、意味検索は**入れたい人だけ**

という構成で、似た悩みを持つ方の役に立てばと思って公開しました。MIT ライセンスです。

https://github.com/ai-app-rizz/claude-tsuzuri

「セッションを閉じるたびに Claude が記憶を失うのが地味につらい」という方は、ぜひ試してみてください。フィードバック・Issue・スターお待ちしています 🧠
