#!/usr/bin/env node
'use strict';
/**
 * memory-session-start.js
 * SessionStart hook。永続メモリ（handoff.md / project-state.md）の「中身」を
 * 起動時に additionalContext へ注入する（Hermes Agent 流の frozen block 方式）。
 *
 * 設計（Hermes 準拠）:
 * - メモリは「retrieval（必要時に検索）」ではなく「injection（起動時に常時注入）」。
 *   → handoff.md / project-state.md の本文をそのまま system プロンプトへ載せる。
 * - 肥大化防止のため注入は字数上限でキャップ（超過分は「全文はファイル参照」と明示）。
 * - 空テンプレ（（未記入）のみ）は注入しない（ノイズ防止）。
 * - 未処理 fragment があれば、蒸留＆ループクローズの督促を末尾に付ける。
 * - 失敗しても本体を止めない（常に exit 0）。claude コマンドは呼ばない。
 * - stdin からペイロード（cwd を含む）を受け取り、memory-paths.js でパスを解決する。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveMemoryDir } = require('./memory-paths.js');

// 再帰防止ガード（最優先で確認）
if (process.env.CLAUDE_MEMORY_HOOK_ACTIVE === '1') {
  process.exit(0);
}

// 注入の字数上限（prefix キャッシュ保護のため。Hermes は MEMORY.md ≈2200字）
const HANDOFF_INJECT_MAX = 4000;
const STATE_INJECT_MAX = 2500;

// logError はメモリディレクトリが決まってから設定する（lazy resolve）
let resolvedErrorLog = null; // main が memDir を決めたら設定
function logError(msg) {
  try {
    const target = resolvedErrorLog || path.join(os.tmpdir(), 'claude-memory-hook-errors.log');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, new Date().toISOString() + ' [session-start] ' + msg + '\n');
  } catch (_) {}
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readTextSafe(p) {
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return '';
  }
}

/**
 * additionalContext の出力。
 * 現行 Claude Code (1.x系) の標準形式:
 *   { "hookSpecificOutput": { "hookEventName": "SessionStart",
 *                             "additionalContext": "..." } }
 */
function emitContext(text) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

/**
 * 見出し・引用・HTMLコメント・（未記入）・空行を除いて
 * 実質的な中身が残るかを判定する。空テンプレの注入を避けるため。
 */
function hasRealContent(md) {
  if (!md) return false;
  const stripped = md
    .replace(/<!--[\s\S]*?-->/g, '')      // HTMLコメント除去
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith('#'))    // 見出し除外
    .filter((l) => !l.startsWith('>'))    // 引用（説明文）除外
    .filter((l) => l.replace(/[（(]未記入[）)]/g, '').trim().length > 0);
  return stripped.length > 0;
}

/**
 * 字数上限でキャップ。超過時は末尾に省略の旨とファイルパスを付ける。
 */
function cap(text, max, filePath) {
  const t = text.trimEnd();
  if (t.length <= max) return t;
  return (
    t.slice(0, max) +
    '\n…（以下省略。全文は ' + filePath + ' を参照）'
  );
}

/**
 * 未処理の fragment ファイル情報を返す。
 * @param {object|null} state - state.json の内容
 * @param {string} fragmentsDir - fragments ディレクトリの絶対パス
 */
function getUnprocessedInfo(state, fragmentsDir) {
  let files = [];
  try {
    files = fs
      .readdirSync(fragmentsDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (_) {
    return { count: 0, oldest: null, newest: null };
  }
  const cursor = state && state.last_processed_fragment;
  const unprocessed = cursor ? files.filter((f) => f > cursor) : files;
  if (unprocessed.length === 0) {
    return { count: 0, oldest: null, newest: null };
  }
  const stamp = (name) => {
    const m = name.match(/^(\d{8})-(\d{6})/);
    if (!m) return name;
    const d = m[1], t = m[2];
    return (
      d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + ' ' +
      t.slice(0, 2) + ':' + t.slice(2, 4) + ':' + t.slice(4, 6)
    );
  };
  return {
    count: unprocessed.length,
    oldest: stamp(unprocessed[0]),
    newest: stamp(unprocessed[unprocessed.length - 1]),
  };
}

/**
 * メインロジック。stdin から受け取ったペイロードを元にパスを解決し、
 * メモリ内容を additionalContext へ注入する。
 * @param {object} payload - フックペイロード（cwd を含む）
 */
function main(payload) {
  // ペイロードの cwd（または workingDirectory）を使ってメモリパスを解決する
  const cwd = (payload && (payload.cwd || payload.workingDirectory)) || '.';
  const memDir = resolveMemoryDir(cwd).dir;
  resolvedErrorLog = path.join(memDir, 'hook-errors.log');
  const fragmentsDir = path.join(memDir, 'fragments');
  const statePath = path.join(memDir, 'state.json');
  const queuePath = path.join(memDir, 'queue.json');
  const handoffPath = path.join(memDir, 'handoff.md');
  const projectStatePath = path.join(memDir, 'project-state.md');

  const state = readJsonSafe(statePath, null);
  const queue = readJsonSafe(queuePath, null);
  const parts = [];

  // --- 1) 永続メモリの「中身」を凍結ブロックとして注入 ---
  const handoff = readTextSafe(handoffPath);
  if (hasRealContent(handoff)) {
    parts.push(
      '【永続メモリ｜引き継ぎ (handoff.md)】\n' +
      cap(handoff, HANDOFF_INJECT_MAX, '.claude/memory/handoff.md')
    );
  }

  const pstate = readTextSafe(projectStatePath);
  if (hasRealContent(pstate)) {
    parts.push(
      '【永続メモリ｜プロジェクト状態 (project-state.md)】\n' +
      cap(pstate, STATE_INJECT_MAX, '.claude/memory/project-state.md')
    );
  }

  // --- 2) 未処理 fragment があれば蒸留＆ループクローズの督促 ---
  const needsCompaction = !!(queue && queue.needs_compaction);
  const info = getUnprocessedInfo(state, fragmentsDir);
  if (needsCompaction || info.count > 0) {
    const range =
      info.oldest && info.newest
        ? '（最古 ' + info.oldest + ' 〜 最新 ' + info.newest + '）'
        : '';
    parts.push(
      '※ 未処理のメモリ断片が約' + info.count + '件あります' + range + '。次の手順で蒸留してください:\n' +
      '1) node .claude/hooks/memory-distill.js で未処理の会話要約（テキストのみ）を確認。\n' +
      '2) 確定した決定は node .claude/hooks/memory-remember.js decision、解決したバグは memory-remember.js bug で ' +
      'decisions.md / bugs-and-fixes.md に追記（重複は自動スキップ・推測や未確定は書かない・秘密はマスク）。' +
      '横断的な教訓（環境の罠/ツールの使い方/好み）も決定として記録。\n' +
      '3) 現状/次/注意は .claude/memory/handoff.md、恒久情報は project-state.md に反映。\n' +
      '4) node .claude/hooks/memory-mark-processed.js でループを閉じる。'
    );
  }

  if (parts.length === 0) return; // 注入すべき中身が何も無ければ黙る

  // 深掘り用ツール(Tier2)があれば導線を示す（表示パスはあえて相対のまま）
  // 存在チェックは cwd 非依存にするため memDir 基準で行う（memDir/../hooks/）
  if (fs.existsSync(path.join(memDir, '..', 'hooks', 'memory-search.py'))) {
    parts.push('（過去ログの深掘りは: python3 .claude/hooks/memory-search.py "検索語"）');
  }
  emitContext(parts.join('\n\n'));
}

// --- stdin からペイロードを読み込み、完了後に main を呼ぶ ---
// 二重起動防止: 'end' イベントと 5秒タイムアウトのどちらか早い方で一度だけ実行する
let done = false;
function runOnce(payload) {
  if (done) return;
  done = true;
  try { main(payload); } catch (e) { logError(e && e.message ? e.message : String(e)); }
  try { process.exit(0); } catch (_) {}
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = input.trim() ? JSON.parse(input) : {}; } catch (_) {}
  runOnce(payload);
});
// stdin が閉じられない場合の 5秒フォールバック
setTimeout(() => runOnce({}), 5000);
