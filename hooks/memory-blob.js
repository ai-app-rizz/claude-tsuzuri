'use strict';
// memory-blob.js: 会話本文を「会話テキスト」と「コード/ログ blob」に分離する純粋関数。
// 意味検索は text のみ埋め込んで高信号化し、FTS5/詳細表示は全文を保持する（情報は失わない）。
// 例外を投げない設計（hook から安全に呼べる）。

const MIN_BLOB_RUN = 3;     // 連続する blob 的な行がこの数以上で log blob とみなす
const LONG_TOKEN_LEN = 40;  // 空白なしでこの長さ以上は base64/hash/url 等とみなす

// 日本語（ひらがな/カタカナ/漢字）を含むか
function hasJapanese(s) {
  return /[぀-ゟ゠-ヿ一-鿿]/.test(s);
}

// 1行が「コード/ログ的」かを判定する
function isBlobishLine(line) {
  if (typeof line !== 'string') return false;
  const s = line.trim();
  if (s === '') return false;
  if (/^[$#>]\s+\S/.test(s)) return true;           // シェルプロンプト/コマンド（$ # > 形式）
  if (/^[{}\[\]]/.test(s)) return true;             // JSON/配列の括弧始まり
  if (/^(at\s|File\s+"|Traceback)/.test(s)) return true; // スタックトレース
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return true; // ログのタイムスタンプ行
  if (!/\s/.test(s) && s.length >= LONG_TOKEN_LEN) return true; // 長い無空白トークン
  if (s.length >= 20 && !hasJapanese(s)) {          // 記号過多（英数より記号が多い）
    const alnum = (s.match(/[A-Za-z0-9]/g) || []).length;
    const symbols = (s.match(/[^A-Za-z0-9\s]/g) || []).length;
    if (symbols > alnum) return true;
  }
  return false;
}

/**
 * content を { text, blobs } に分離する。
 * - text: 会話テキスト（意味検索の埋め込み対象）
 * - blobs: [{ kind: 'code'|'log', content }]
 */
function splitBlobs(content) {
  const src = typeof content === 'string' ? content : '';
  const blobs = [];

  // 1) フェンス付きコードブロックを抽出（kind='code'）
  // \x60 はバッククォート。配布インストーラの String.raw テンプレへ埋め込めるよう、
  // ソースにリテラルのバッククォートを置かない（3連バッククォートのフェンス検出と動作同一）。
  const rest = src.replace(/\x60{3}[\s\S]*?\x60{3}/g, (m) => {
    blobs.push({ kind: 'code', content: m });
    return '\n';
  });

  // 2) 残りを行単位で走査し、連続する blob 的行を log blob にまとめる
  const lines = rest.split('\n');
  const textLines = [];
  let run = [];
  function flushRun() {
    if (run.length >= MIN_BLOB_RUN) {
      blobs.push({ kind: 'log', content: run.join('\n') });
    } else {
      for (const l of run) textLines.push(l);
    }
    run = [];
  }
  for (const line of lines) {
    if (isBlobishLine(line)) {
      run.push(line);
    } else {
      flushRun();
      textLines.push(line);
    }
  }
  flushRun();

  const text = textLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, blobs };
}

module.exports = { splitBlobs, isBlobishLine };
