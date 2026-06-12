#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
memory-search.py  —  永続メモリの「深掘り（Tier2）」検索ツール

位置づけ:
  Tier1（memory-session-start.js）が handoff.md / project-state.md の要約を
  起動時に常時注入する「通常メモリ」。本ツールはその先、過去の生ログ
  （fragment / archive）を検索して掘るための retrieval 層。

検索方式（2段構え）:
  - 既定: FTS5(trigram) キーワード検索。標準ライブラリのみ・追加依存ゼロ・sbx でも動く。
  - 任意（オプション層）: 埋め込みベクトルによる「意味検索」。曖昧/言い換えに強い。
      MEMORY_EMBED_PROVIDER を設定した人だけ有効。未設定なら自動で FTS5 にフォールバック。
      埋め込み源は urllib（標準ライブラリ）で叩くため、本体に外部 pip 依存は無い。

意味検索の有効化（例: Ollama + Ruri large＝日本語強・日本製・Apache-2.0）:
  ollama pull <Ruri の Ollama タグ>             # 例: kun432/cl-nagoya-ruri-large
  export MEMORY_EMBED_PROVIDER=ollama
  export MEMORY_EMBED_MODEL=<上で pull したタグ>
  python3 .claude/hooks/memory-search.py --reindex   # 埋め込みを構築
  python3 .claude/hooks/memory-search.py "曖昧な質問でも意味で探す"

環境変数:
  MEMORY_EMBED_PROVIDER   ''(既定/無効) | ollama | openai
  MEMORY_EMBED_MODEL      埋め込みモデル名（既定: kun432/cl-nagoya-ruri-large）
  OLLAMA_URL              Ollama のベースURL（既定: http://localhost:11434）
  MEMORY_EMBED_URL        OpenAI互換エンドポイント（provider=openai 時の完全URL）
  MEMORY_EMBED_KEY        APIキー（provider=openai 時。env からのみ参照・出力しない）
  MEMORY_EMBED_QUERY_PREFIX / MEMORY_EMBED_DOC_PREFIX  プレフィックス上書き（任意）

使い方（プロジェクトルートで実行）:
  python3 .claude/hooks/memory-search.py "検索語"
  python3 .claude/hooks/memory-search.py "install-security" --role user --limit 5
  python3 .claude/hooks/memory-search.py --reindex          # 索引（＋埋め込み）の再構築

オプション:
  query                検索語（省略時は索引統計のみ表示）
  --reindex/--rebuild  索引を作り直して終了（埋め込みも更新）
  --limit N            最大表示件数（既定 10）
  --role ROLE          user / assistant などで絞り込み
  --since YYYY-MM-DD    その日以降に絞り込み
  --no-archive         archive を検索対象から除外
  --no-reindex         検索前の自動再構築をしない
  --keyword            FTS5 キーワード検索を強制
  --semantic           意味検索を強制（埋め込み未構築なら FTS5 へフォールバック）
  --hybrid             キーワード＋意味のハイブリッド（既定: 意味検索が使える時）
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys

# メモリ保存先は共有リゾルバで解決する（project/global/sbx自動判定）。
# memory_paths はこのスクリプトと同じディレクトリにあるため、確実に import できるよう
# スクリプト自身のディレクトリを sys.path 先頭に挿入する。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memory_paths


def _resolve_memory_dir():
    try:
        start = os.getcwd()
    except Exception:
        start = "."
    return memory_paths.resolve_memory_dir(start)[1]


MEMORY_DIR = _resolve_memory_dir()
FRAGMENTS_DIR = os.path.join(MEMORY_DIR, "fragments")
ARCHIVE_DIR = os.path.join(MEMORY_DIR, "archive")
DB_PATH = os.path.join(MEMORY_DIR, "index.sqlite")

# --- 埋め込み（オプション層）の設定。未設定なら意味検索は無効＝FTS5 のみ ---
EMBED_PROVIDER = os.environ.get("MEMORY_EMBED_PROVIDER", "").strip().lower()
EMBED_MODEL = os.environ.get("MEMORY_EMBED_MODEL", "kun432/cl-nagoya-ruri-large").strip()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OPENAI_URL = os.environ.get("MEMORY_EMBED_URL", "").strip()
OPENAI_KEY = os.environ.get("MEMORY_EMBED_KEY", "").strip()
EMBED_DEBUG = bool(os.environ.get("MEMORY_EMBED_DEBUG"))
# 埋め込みモデルの最大トークン長対策（Ruri/BERT系は512トークン上限）。
# 長文をそのまま投げると "input length exceeds the context length" で 400/500 になる。
# 実測: Ruri large は先頭300字なら確実に収まる（日本語はトークン密度が高い）。
# ※先頭N字のみ埋め込む簡易策。長文後半まで意味検索に乗せるには将来チャンク分割で拡張。
EMBED_MAX_CHARS = int(os.environ.get("MEMORY_EMBED_MAX_CHARS", "300"))
# チャンク分割: 長文を複数ウィンドウに割って各々を埋め込み、検索時は最良チャンクで代表。
# 先頭だけ埋め込む簡易策より、話題が後半にある長文も拾える（精度向上）。
CHUNK_CHARS = int(os.environ.get("MEMORY_EMBED_CHUNK_CHARS", str(EMBED_MAX_CHARS)))
CHUNK_OVERLAP = int(os.environ.get("MEMORY_EMBED_CHUNK_OVERLAP", "50"))
EMBED_MAX_CHUNKS = int(os.environ.get("MEMORY_EMBED_MAX_CHUNKS", "6"))
# 短すぎる発言（相づち「はい」「OK」等）は意味検索のノイズ源（“ハブ”化）になるため、
# この文字数未満は埋め込み対象外にする（FTS5 キーワード検索では従来どおり引ける）。
EMBED_MIN_CHARS = int(os.environ.get("MEMORY_EMBED_MIN_CHARS", "24"))


def _dbg(msg):
    """MEMORY_EMBED_DEBUG=1 のとき診断メッセージを stderr に出す（秘密は出さない）。"""
    if EMBED_DEBUG:
        print("[embed-debug] " + str(msg), file=sys.stderr)


def _err_detail(e):
    """HTTPError 等から、サーバが返したエラー本文を安全に取り出す（診断用）。"""
    try:
        body = e.read().decode("utf-8", "replace")
        return " body=" + body[:400]
    except Exception:
        return ""


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


# ===========================================================================
# プレフィックス（モデルごとに最適な接頭辞が異なる）
# ===========================================================================
def resolve_prefixes(model):
    """モデル名から (query_prefix, doc_prefix) を推定。env で上書き可。"""
    m = (model or "").lower()
    if "ruri" in m:
        # Ollama 入手可能な Ruri は v1 系(kun432/cl-nagoya-ruri-*)＝接頭辞は クエリ:/文章:
        # （Ruri v3 を使う場合は env で 検索クエリ:/検索文書: に上書きすること）
        qp, dp = "クエリ: ", "文章: "
    elif "e5" in m:
        qp, dp = "query: ", "passage: "                # multilingual-e5
    elif "nomic" in m:
        qp, dp = "search_query: ", "search_document: " # nomic-embed-text
    elif "arctic" in m:
        qp, dp = "query: ", ""                          # snowflake-arctic (query側のみ)
    else:
        qp, dp = "", ""                                  # bge-m3 等は接頭辞不要
    # env による明示上書き（空文字も尊重する）
    env_qp = os.environ.get("MEMORY_EMBED_QUERY_PREFIX")
    env_dp = os.environ.get("MEMORY_EMBED_DOC_PREFIX")
    if env_qp is not None:
        qp = env_qp
    if env_dp is not None:
        dp = env_dp
    return qp, dp


# ===========================================================================
# 埋め込み生成（urllib のみ＝追加依存なし）。失敗時は None を返し、呼び出し側が FTS5 へ落ちる。
# ===========================================================================
def _http_json(url, payload, headers=None, timeout=120):
    import urllib.request
    data = json.dumps(payload).encode("utf-8")
    hdr = {"Content-Type": "application/json"}
    if headers:
        hdr.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdr, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def embed_texts(texts):
    """texts のベクトル配列を返す。失敗・無効時は None。"""
    if not EMBED_PROVIDER or not texts:
        return None
    if EMBED_PROVIDER == "mock":
        # テスト用の決定的な擬似ベクトル（文字頻度・64次元）。Ollama 不要で検索経路を検証する。
        out = []
        for t in texts:
            v = [0.0] * 64
            for ch in str(t):
                v[ord(ch) % 64] += 1.0
            out.append(v)
        return out
    if EMBED_PROVIDER == "ollama":
        # 新しい Ollama: /api/embed（バッチ input 可）
        try:
            res = _http_json(OLLAMA_URL + "/api/embed", {"model": EMBED_MODEL, "input": texts, "truncate": True})
            embs = res.get("embeddings")
            if embs and len(embs) == len(texts):
                return embs
            _dbg("/api/embed 応答が想定外: " + (json.dumps(res)[:300] if isinstance(res, dict) else str(res)[:300]))
        except Exception as e:
            _dbg("/api/embed 失敗: " + repr(e) + _err_detail(e))
        # 旧 Ollama: /api/embeddings（1件ずつ prompt）
        out = []
        for t in texts:
            try:
                res = _http_json(OLLAMA_URL + "/api/embeddings", {"model": EMBED_MODEL, "prompt": t})
                e = res.get("embedding")
                if not e:
                    _dbg("/api/embeddings 応答に embedding 無し: " + (json.dumps(res)[:300] if isinstance(res, dict) else str(res)[:300]))
                    return None
                out.append(e)
            except Exception as e:
                _dbg("/api/embeddings 失敗: " + repr(e) + _err_detail(e))
                return None
        return out
    if EMBED_PROVIDER == "openai":
        if not OPENAI_URL:
            return None
        headers = {"Authorization": "Bearer " + OPENAI_KEY} if OPENAI_KEY else None
        try:
            res = _http_json(OPENAI_URL, {"model": EMBED_MODEL, "input": texts}, headers=headers)
            data = res.get("data")
            if data and len(data) == len(texts):
                return [d.get("embedding") for d in data]
        except Exception:
            return None
        return None
    return None


def cosine_rank(qvec, items):
    """items[(file, vec)]（1ファイル複数チャンク可）を、各 file の最良チャンク
    コサイン類似度で降順に並べた file 配列で返す（max プーリング）。numpy があれば高速化。"""
    best = {}
    try:
        import numpy as np
        q = np.asarray(qvec, dtype="float32")
        qn = float(np.linalg.norm(q)) + 1e-9
        for file, v in items:
            a = np.asarray(v, dtype="float32")
            s = float(np.dot(q, a)) / ((float(np.linalg.norm(a)) + 1e-9) * qn)
            if file not in best or s > best[file]:
                best[file] = s
    except ImportError:
        import math
        qn = math.sqrt(sum(c * c for c in qvec)) + 1e-9
        for file, v in items:
            dot = sum(a * b for a, b in zip(qvec, v))
            vn = math.sqrt(sum(c * c for c in v)) + 1e-9
            s = dot / (vn * qn)
            if file not in best or s > best[file]:
                best[file] = s
    return sorted(best.keys(), key=lambda f: -best[f])


# ===========================================================================
# 索引（fragment/archive 列挙・読み込み・FTS5/LIKE 構築）
# ===========================================================================
def fts5_available(con):
    try:
        con.execute("CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(x)")
        con.execute("DROP TABLE temp._fts5_probe")
        return True
    except sqlite3.OperationalError:
        return False


def iter_fragment_files(include_archive=True):
    files = []
    if os.path.isdir(FRAGMENTS_DIR):
        for name in os.listdir(FRAGMENTS_DIR):
            if name.endswith(".json"):
                files.append(os.path.join(FRAGMENTS_DIR, name))
    if include_archive and os.path.isdir(ARCHIVE_DIR):
        for root, _dirs, names in os.walk(ARCHIVE_DIR):
            for name in names:
                if name.endswith(".json"):
                    files.append(os.path.join(root, name))
    return sorted(files)


def load_fragment(path):
    """fragment JSON を読み、(file_label, ts, role, session, content, embed_src, blobs) を返す。
    embed_src は意味検索の埋め込み元（text 優先・無ければ content）。
    blobs は [(kind, content), ...]。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            j = json.load(f)
    except Exception:
        return None
    label = os.path.relpath(path, MEMORY_DIR)
    content = str(j.get("content", ""))
    text = j.get("text")
    embed_src = str(text) if isinstance(text, str) and text.strip() else content
    blobs = []
    raw_blobs = j.get("blobs")
    if isinstance(raw_blobs, list):
        for b in raw_blobs:
            if isinstance(b, dict):
                blobs.append((str(b.get("kind", "blob")), str(b.get("content", ""))))
    return (label, str(j.get("ts", "")), str(j.get("role", "")),
            str(j.get("session_id", "")), content, embed_src, blobs)


def parse_structured(text, source, kind):
    """構造化メモリ(decisions/bugs)を ## 日付 ブロック単位で解析する。
    HTMLコメント(雛形/mhマーカー)は先に除去。戻り値 [(id, source, kind, ts, content), ...]。"""
    t = re.sub(r"<!--[\s\S]*?-->", "", text or "")
    items = []
    blocks = re.split(r"(?m)^##\s+", t)
    for b in blocks[1:]:  # 先頭(ヘッダ前文)は捨てる
        b = b.strip()
        if not b:
            continue
        lines = b.split("\n")
        ts = lines[0].strip()
        body = "\n".join(lines[1:]).strip()
        content = body if body else ts
        did = source + "#" + hashlib.sha1(content.encode("utf-8")).hexdigest()[:12]
        items.append((did, source, kind, ts, content))
    return items


def build_docs(con):
    """decisions.md / bugs-and-fixes.md を解析して docs テーブルを作り直す。件数を返す。"""
    con.execute("DROP TABLE IF EXISTS docs")
    con.execute("CREATE TABLE docs(id TEXT PRIMARY KEY, source TEXT, kind TEXT, ts TEXT, content TEXT)")
    n = 0
    for src_file, kind in (("decisions.md", "decision"), ("bugs-and-fixes.md", "bug")):
        p = os.path.join(MEMORY_DIR, src_file)
        try:
            with open(p, "r", encoding="utf-8") as f:
                txt = f.read()
        except Exception:
            continue
        for item in parse_structured(txt, src_file, kind):
            con.execute(
                "INSERT OR REPLACE INTO docs(id, source, kind, ts, content) VALUES (?, ?, ?, ?, ?)",
                item)
            n += 1
    return n


def build_index(con, use_fts, include_archive=True):
    """fragment/archive を走査して FTS5/LIKE 索引と blobs テーブルを作り直す。件数を返す。"""
    con.execute("DROP TABLE IF EXISTS frag")
    con.execute("DROP TABLE IF EXISTS blobs")
    if use_fts:
        # trigram トークナイザ: 3文字以上なら日本語含む部分一致が可能
        con.execute(
            "CREATE VIRTUAL TABLE frag USING fts5("
            "file UNINDEXED, ts UNINDEXED, role UNINDEXED, session UNINDEXED, "
            "content, embed_src UNINDEXED, "
            "tokenize='trigram')"
        )
    else:
        con.execute(
            "CREATE TABLE frag(file TEXT, ts TEXT, role TEXT, session TEXT, "
            "content TEXT, embed_src TEXT)"
        )
    con.execute("CREATE TABLE blobs(file TEXT, idx INTEGER, kind TEXT, content TEXT)")
    frag_rows = []
    blob_rows = []
    for path in iter_fragment_files(include_archive):
        rec = load_fragment(path)
        if rec is None:
            continue
        label, ts, role, session, content, embed_src, blobs = rec
        frag_rows.append((label, ts, role, session, content, embed_src))
        for i, (kind, bcontent) in enumerate(blobs):
            blob_rows.append((label, i, kind, bcontent))
    con.executemany(
        "INSERT INTO frag(file, ts, role, session, content, embed_src) "
        "VALUES (?, ?, ?, ?, ?, ?)", frag_rows
    )
    con.executemany(
        "INSERT INTO blobs(file, idx, kind, content) VALUES (?, ?, ?, ?)", blob_rows
    )
    build_docs(con)
    con.commit()
    return len(frag_rows)


def chunk_text(text):
    """テキストを CHUNK_CHARS のウィンドウに分割（オーバーラップ付き・最大 EMBED_MAX_CHUNKS）。
    空白は畳んで密度を上げる。"""
    t = " ".join((text or "").split())
    if not t:
        return []
    step = max(1, CHUNK_CHARS - CHUNK_OVERLAP)
    chunks = []
    pos = 0
    while pos < len(t) and len(chunks) < EMBED_MAX_CHUNKS:
        chunks.append(t[pos:pos + CHUNK_CHARS])
        pos += step
    return chunks


def build_embeddings(con):
    """frag を元に、未作成/変更分の埋め込みを（チャンク分割して）構築する。
    戻り値 (files, chunks, failed)。provider 無効なら (0,0,False)。"""
    if not EMBED_PROVIDER:
        return (0, 0, False)
    # スキーマ（チャンク対応）。旧スキーマ(chunk列なし)なら作り直す。
    cols = [r[1] for r in con.execute("PRAGMA table_info(embeddings)")]
    if cols and "chunk" not in cols:
        con.execute("DROP TABLE embeddings")
    con.execute(
        "CREATE TABLE IF NOT EXISTS embeddings("
        "file TEXT, chunk INTEGER, model TEXT, sha TEXT, dim INTEGER, vec TEXT, "
        "PRIMARY KEY(file, chunk))"
    )
    # docs に無い id の埋め込みは掃除（意味検索の対象は構造化メモリ docs。項目の更新/削除で id が変わるため）
    con.execute("DELETE FROM embeddings WHERE file NOT IN (SELECT id FROM docs)")
    # file 単位の既存 (model, sha)
    have = {}
    for file, model, sha in con.execute(
        "SELECT file, model, sha FROM embeddings GROUP BY file"
    ):
        have[file] = (model, sha)
    _qp, dp = resolve_prefixes(EMBED_MODEL)
    # 再埋め込みが必要な file のチャンクを平坦化
    flat = []  # (file, chunk_idx, text, sha)
    redo_files = []
    short_files = []
    for file, embed_src in con.execute("SELECT id, content FROM docs"):
        collapsed = " ".join((embed_src or "").split())
        if len(collapsed) < EMBED_MIN_CHARS:
            # 短すぎる/コード除去後に空になった発言は意味検索の対象外（FTS5では引ける）
            short_files.append(file)
            continue
        sha = hashlib.sha1((embed_src or "").encode("utf-8")).hexdigest()
        prev = have.get(file)
        if prev and prev[0] == EMBED_MODEL and prev[1] == sha:
            continue
        redo_files.append(file)
        for ci, ch in enumerate(chunk_text(embed_src or "")):
            flat.append((file, ci, ch, sha))
    # 短文 file の既存埋め込みを除去（しきい値変更や過去データの掃除）
    for file in short_files:
        con.execute("DELETE FROM embeddings WHERE file = ?", (file,))
    # 旧チャンクを削除してから入れ直す（チャンク数が変わるため）
    for file in redo_files:
        con.execute("DELETE FROM embeddings WHERE file = ?", (file,))
    chunks_done = 0
    failed = False
    BATCH = 16
    for i in range(0, len(flat), BATCH):
        batch = flat[i:i + BATCH]
        vecs = embed_texts([dp + text for (_f, _ci, text, _s) in batch])
        if vecs is None:
            failed = True
            break
        for (file, ci, _text, sha), v in zip(batch, vecs):
            con.execute(
                "INSERT OR REPLACE INTO embeddings(file, chunk, model, sha, dim, vec) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (file, ci, EMBED_MODEL, sha, len(v), json.dumps(v)),
            )
            chunks_done += 1
    con.commit()
    return (len(redo_files), chunks_done, failed)


def load_doc_embeddings(con, allowed):
    """現モデルの埋め込みを (file, vec) で返す。allowed が None でなければ file で絞る。"""
    try:
        rows = con.execute(
            "SELECT file, vec FROM embeddings WHERE model = ?", (EMBED_MODEL,)
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    out = []
    for file, vec in rows:
        if allowed is not None and file not in allowed:
            continue
        try:
            out.append((file, json.loads(vec)))
        except Exception:
            continue
    return out


# ===========================================================================
# 表示ヘルパ
# ===========================================================================
def make_snippet(content, query, width=60):
    flat = " ".join(content.split())
    if not query:
        return flat[: width * 2]
    low = flat.lower()
    pos = low.find(query.lower())
    if pos < 0:
        return flat[: width * 2]
    start = max(0, pos - width // 2)
    end = min(len(flat), pos + len(query) + width)
    pre = "…" if start > 0 else ""
    post = "…" if end < len(flat) else ""
    seg = flat[start:end]
    seg_low = seg.lower()
    qp = seg_low.find(query.lower())
    if qp >= 0:
        seg = seg[:qp] + "«" + seg[qp:qp + len(query)] + "»" + seg[qp + len(query):]
    return pre + seg + post


def fmt_ts(ts):
    if len(ts) >= 16 and ts[10] in ("T", " "):
        return ts[0:10] + " " + ts[11:16]
    return ts


# ===========================================================================
# 検索（FTS5 / LIKE / 意味 / ハイブリッド）
# ===========================================================================
def fts_files(con, query, role, since, limit):
    """FTS5 で file のランキング配列を返す。"""
    where = ["frag MATCH ?"]
    params = [query]
    if role:
        where.append("role = ?")
        params.append(role)
    if since:
        where.append("ts >= ?")
        params.append(since)
    sql = ("SELECT file FROM frag WHERE " + " AND ".join(where) +
           " ORDER BY rank LIMIT ?")
    params.append(limit)
    try:
        rows = con.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        params[0] = '"' + query.replace('"', "") + '"'
        rows = con.execute(sql, params).fetchall()
    return [r[0] for r in rows]


def like_files(con, query, role, since, limit):
    where = ["content LIKE ?"]
    params = ["%" + query + "%"]
    if role:
        where.append("role = ?")
        params.append(role)
    if since:
        where.append("ts >= ?")
        params.append(since)
    sql = ("SELECT file FROM frag WHERE " + " AND ".join(where) +
           " ORDER BY ts DESC LIMIT ?")
    params.append(limit)
    return [r[0] for r in con.execute(sql, params).fetchall()]


def allowed_file_set(con, role, since):
    """role/since の絞り込みに合致する file 集合（意味検索の事前フィルタ用）。"""
    if not role and not since:
        return None
    where = []
    params = []
    if role:
        where.append("role = ?")
        params.append(role)
    if since:
        where.append("ts >= ?")
        params.append(since)
    sql = "SELECT file FROM frag WHERE " + " AND ".join(where)
    return set(r[0] for r in con.execute(sql, params).fetchall())


def rrf_fuse(rank_lists, k=60):
    """Reciprocal Rank Fusion で複数ランキングを融合し file 配列を返す。"""
    scores = {}
    for rl in rank_lists:
        for rank, file in enumerate(rl):
            scores[file] = scores.get(file, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.keys(), key=lambda f: -scores[f])


def file_meta_map(con):
    """file -> (ts, role, content) を構築（表示用）。"""
    meta = {}
    for file, ts, role, content in con.execute(
        "SELECT file, ts, role, content FROM frag"
    ):
        meta[file] = (ts, role, content)
    return meta


def docs_meta_map(con):
    """id -> (ts, kind, content)（構造化アイテム表示用）。"""
    meta = {}
    try:
        for did, ts, kind, content in con.execute("SELECT id, ts, kind, content FROM docs"):
            meta[did] = (ts, kind, content)
    except sqlite3.OperationalError:
        pass
    return meta


def main():
    parser = argparse.ArgumentParser(add_help=True, description="永続メモリ検索 (Tier2)")
    parser.add_argument("query", nargs="?", default=None, help="検索語")
    parser.add_argument("--reindex", "--rebuild", dest="reindex", action="store_true",
                        help="索引（＋埋め込み）を再構築して終了")
    parser.add_argument("--limit", type=int, default=10, help="最大表示件数（既定10）")
    parser.add_argument("--role", default=None, help="role で絞り込み（user/assistant 等）")
    parser.add_argument("--since", default=None, help="YYYY-MM-DD 以降に絞り込み")
    parser.add_argument("--no-archive", dest="archive", action="store_false",
                        help="archive を対象外にする")
    parser.add_argument("--no-reindex", dest="auto_reindex", action="store_false",
                        help="検索前の自動再構築をしない")
    parser.add_argument("--keyword", dest="force_keyword", action="store_true",
                        help="FTS5 キーワード検索を強制")
    parser.add_argument("--semantic", dest="force_semantic", action="store_true",
                        help="意味検索を強制")
    parser.add_argument("--hybrid", dest="force_hybrid", action="store_true",
                        help="キーワード＋意味のハイブリッド")
    args = parser.parse_args()

    if not os.path.isdir(MEMORY_DIR):
        die(".claude/memory が見つかりません。プロジェクトルートで実行してください。\n"
            "現在の作業ディレクトリ: " + os.getcwd())

    con = sqlite3.connect(DB_PATH)
    use_fts = fts5_available(con)
    kw_label = "FTS5" if use_fts else "LIKE"
    embed_on = bool(EMBED_PROVIDER)

    # --- 索引構築（--reindex 指定時、または検索時の自動再構築）---
    if args.reindex or (args.query is not None and args.auto_reindex):
        n = build_index(con, use_fts, include_archive=args.archive)
        emb_msg = ""
        if embed_on:
            files_n, chunks_n, failed = build_embeddings(con)
            if failed:
                emb_msg = "  埋め込み: 失敗（{}が未起動/未導入の可能性→FTS5にフォールバック）".format(EMBED_PROVIDER)
            else:
                emb_msg = "  埋め込み: {}ファイル/{}チャンク（model={}）".format(files_n, chunks_n, EMBED_MODEL)
        if args.reindex:
            print("索引を再構築しました: {}件  DB: {}  方式: {}{}".format(n, DB_PATH, kw_label, emb_msg))
            return

    # --- クエリ無し → 統計のみ ---
    if args.query is None:
        try:
            n = con.execute("SELECT COUNT(*) FROM frag").fetchone()[0]
        except sqlite3.OperationalError:
            n = 0
        emb_n = 0
        if embed_on:
            try:
                emb_n = con.execute(
                    "SELECT COUNT(*) FROM embeddings WHERE model = ?", (EMBED_MODEL,)
                ).fetchone()[0]
            except sqlite3.OperationalError:
                emb_n = 0
        prov = EMBED_PROVIDER if embed_on else "なし(FTS5のみ)"
        print("索引: {}件 / 埋め込みチャンク: {}件  DB: {}  キーワード方式: {}  意味検索: {}".format(
            n, emb_n, DB_PATH, kw_label, prov))
        print("使い方: python3 .claude/hooks/memory-search.py \"検索語\" [--role user] [--since YYYY-MM-DD] [--limit N] [--semantic|--keyword|--hybrid]")
        return

    q = args.query.strip()

    # --- 検索モードの決定 ---
    # 意味検索が実際に使えるか（provider設定 かつ 現モデルの埋め込みが存在）
    semantic_ready = False
    if embed_on and not args.force_keyword:
        try:
            cnt = con.execute(
                "SELECT COUNT(*) FROM embeddings WHERE model = ?", (EMBED_MODEL,)
            ).fetchone()[0]
            semantic_ready = cnt > 0
        except sqlite3.OperationalError:
            semantic_ready = False

    if args.force_keyword:
        mode = "keyword"
    elif args.force_semantic:
        mode = "semantic" if semantic_ready else "keyword"
    elif args.force_hybrid:
        mode = "hybrid" if semantic_ready else "keyword"
    else:
        mode = "hybrid" if semantic_ready else "keyword"

    # --- キーワード側のランキング ---
    kw_rank = []
    if mode in ("keyword", "hybrid"):
        if use_fts and len(q) < 3:
            if mode == "keyword":
                print("FTS5(trigram) は3文字以上の語が必要です。3文字以上で検索するか、--semantic をご利用ください。")
                return
            # hybrid のときは keyword をスキップして semantic のみ
        else:
            cand = max(args.limit * 3, args.limit)
            kw_rank = fts_files(con, q, args.role, args.since, cand) if use_fts \
                else like_files(con, q, args.role, args.since, cand)

    # --- 意味検索側のランキング ---
    sem_rank = []
    if mode in ("semantic", "hybrid") and semantic_ready:
        qp, _dp = resolve_prefixes(EMBED_MODEL)
        qv = embed_texts([qp + q[:EMBED_MAX_CHARS]])
        if qv is None:
            # クエリ埋め込み失敗 → キーワードへ
            if mode == "semantic":
                print("意味検索のクエリ埋め込みに失敗しました（{}未起動?）。FTS5 にフォールバックします。".format(EMBED_PROVIDER))
                mode = "keyword"
                if not kw_rank and not (use_fts and len(q) < 3):
                    kw_rank = fts_files(con, q, args.role, args.since, args.limit) if use_fts \
                        else like_files(con, q, args.role, args.since, args.limit)
        else:
            # 意味検索の対象は構造化メモリ(docs)。role/since フィルタは適用しない。
            items = load_doc_embeddings(con, None)
            sem_rank = cosine_rank(qv[0], items)[: max(args.limit * 3, args.limit)]

    # --- 融合して最終ランキング ---
    if mode == "hybrid":
        kw_typed = ["frag:" + f for f in kw_rank]
        sem_typed = ["doc:" + d for d in sem_rank]
        final = rrf_fuse([r for r in (kw_typed, sem_typed) if r])
        mode_label = "ハイブリッド(FTS生ログ+意味:構造化)"
    elif mode == "semantic":
        final = ["doc:" + d for d in sem_rank]
        mode_label = "意味検索:構造化メモリ({}:{})".format(EMBED_PROVIDER, EMBED_MODEL)
    else:
        final = ["frag:" + f for f in kw_rank]
        mode_label = kw_label

    final = final[: args.limit]

    print("検索: \"{}\"  ヒット {}件（方式: {}）".format(args.query, len(final), mode_label))
    if not final:
        print("該当なし。語を変える・--no-archive を外す・--since を緩める・--semantic を試すなど。")
        return
    frag_meta = file_meta_map(con)
    docs_meta = docs_meta_map(con)
    for i, tid in enumerate(final, 1):
        if tid.startswith("doc:"):
            did = tid[4:]
            ts, kind, content = docs_meta.get(did, ("", "", ""))
            snip = make_snippet(content, q)
            print("")
            print("[{}] {} [構造化:{}]  {}".format(i, fmt_ts(ts), kind, did))
            print("    " + " ".join(str(snip).split()))
        else:
            f = tid[5:] if tid.startswith("frag:") else tid
            ts, role_, content = frag_meta.get(f, ("", "", ""))
            snip = make_snippet(content, q)
            print("")
            print("[{}] {} [{}]  {}".format(i, fmt_ts(ts), role_, f))
            print("    " + " ".join(str(snip).split()))


if __name__ == "__main__":
    main()
