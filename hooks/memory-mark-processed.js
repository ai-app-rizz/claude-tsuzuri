#!/usr/bin/env node
'use strict';
/**
 * memory-mark-processed.js
 * メモリ整理（compaction）完了後に実行して「ループを閉じる」ヘルパー。
 *   - 現時点の fragments を全て処理済みとみなす。
 *   - 未処理 fragment を archive/YYYY-MM/ へ移動。
 *   - state.json: uncompacted_count=0, last_processed_fragment=最新, processed_count加算。
 *   - queue.json: needs_compaction=false。
 *
 * 使い方:
 *   node .claude/hooks/memory-mark-processed.js
 *   node .claude/hooks/memory-mark-processed.js --no-archive  # 移動せずカーソルだけ進める
 *   node .claude/hooks/memory-mark-processed.js --dry-run     # 実行せず内容だけ表示
 */

const fs = require('fs');
const path = require('path');
const { resolveMemoryDir } = require('./memory-paths.js');

const NO_ARCHIVE = process.argv.includes('--no-archive');
const DRY_RUN = process.argv.includes('--dry-run');

// フラグ以外の最初の位置引数を起点ディレクトリとして使う（無ければカレント）
const startDir = process.argv.slice(2).find((a) => !a.startsWith('--')) || '.';
const MEMORY_DIR = resolveMemoryDir(startDir).dir;
const FRAGMENTS_DIR = path.join(MEMORY_DIR, 'fragments');
const ARCHIVE_DIR = path.join(MEMORY_DIR, 'archive');
const STATE_PATH = path.join(MEMORY_DIR, 'state.json');
const QUEUE_PATH = path.join(MEMORY_DIR, 'queue.json');

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function main() {
  // CWDチェック: プロジェクトルート以外での誤実行を防ぐ。
  // .claude/memory が無ければ、ここで新規作成せずエラー終了。
  if (!fs.existsSync(MEMORY_DIR)) {
    console.error(
      '.claude/memory が見つかりません。プロジェクトルートで実行してください。'
    );
    console.error('現在の作業ディレクトリ: ' + process.cwd());
    process.exit(1);
  }

  const now = new Date();

  let files = [];
  try {
    files = fs.readdirSync(FRAGMENTS_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch (_) {
    files = [];
  }

  const state = readJsonSafe(STATE_PATH, {
    version: 1,
    uncompacted_count: 0,
    last_fragment: null,
    last_compacted_at: null,
    last_processed_fragment: null,
    processed_count: 0,
    updated_at: null,
  });

  const cursor = state.last_processed_fragment;
  const unprocessed = cursor ? files.filter((f) => f > cursor) : files;
  const newest = files.length > 0 ? files[files.length - 1] : cursor;

  // --- dry-run: 何が起きるか表示するだけ ---
  if (DRY_RUN) {
    console.log('(DRY-RUN) 実行内容のプレビュー:');
    console.log('  処理済みにする fragment 数: ' + unprocessed.length);
    console.log('  archive 移動: ' + (NO_ARCHIVE ? 'なし(--no-archive)' : unprocessed.length + '件'));
    console.log('  カーソル更新先: ' + (newest || '(なし)'));
    console.log('  uncompacted_count → 0 / needs_compaction → false');
    return;
  }

  // --- 書き込み順序の方針 ---
  // 先に state/queue を確定・書き込みし、最後に archive 移動を行う。
  // こうすると、archive 移動が途中で失敗しても state は既に正しく、
  // 残った fragment は次回 capture の上限処理か再 mark で移動されるだけで
  // 整合が崩れない（「移動だけ済んで state 未更新」を避ける）。
  const nextState = Object.assign({}, state, {
    uncompacted_count: 0,
    last_processed_fragment: newest || null,
    processed_count: (state.processed_count || 0) + unprocessed.length,
    last_compacted_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2));
  } catch (e) {
    console.error('state.json の更新に失敗: ' + (e && e.message ? e.message : e));
    console.error('（archive 移動は行っていません。安全に中断しました）');
    process.exit(1);
  }

  const queue = readJsonSafe(QUEUE_PATH, {
    version: 1,
    needs_compaction: false,
    reason: null,
    updated_at: null,
  });
  queue.needs_compaction = false;
  queue.reason = null;
  queue.updated_at = now.toISOString();
  try {
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
  } catch (_) { /* queue 失敗は致命的でない */ }

  // --- 最後に archive 移動 ---
  let movedCount = 0;
  if (!NO_ARCHIVE && unprocessed.length > 0) {
    const ym =
      now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const destDir = path.join(ARCHIVE_DIR, ym);
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) {}
    for (const f of unprocessed) {
      try {
        fs.renameSync(path.join(FRAGMENTS_DIR, f), path.join(destDir, f));
        movedCount++;
      } catch (_) { /* 個別失敗は無視。state は既に正しい */ }
    }
  }

  console.log('メモリ整理を完了としてマークしました。');
  console.log('  処理済みにした fragment 数: ' + unprocessed.length);
  if (!NO_ARCHIVE) {
    console.log('  archive へ移動した数: ' + movedCount);
    if (movedCount < unprocessed.length) {
      console.log('  （一部移動できなかったファイルは次回再試行されます）');
    }
  } else {
    console.log('  （--no-archive: 移動はせずカーソルのみ更新）');
  }
  console.log('  uncompacted_count: 0 / needs_compaction: false');
}

try {
  main();
} catch (e) {
  console.error('予期しないエラー: ' + (e && e.message ? e.message : e));
  process.exit(1);
}
