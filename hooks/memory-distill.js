#!/usr/bin/env node
'use strict';
// memory-distill.js: 未処理の会話断片を「会話テキストのみ」(Phase1b の text)で一覧表示し、
// 蒸留(構造化メモリ化)の手順を案内する。注入ドリブン蒸留A の補助ツール。node で起動。
// node .claude/hooks/memory-distill.js
// ※ String.raw 配布埋め込みのためバッククォートと dollar-brace は使わない。

const fs = require('fs');
const path = require('path');
const { resolveMemoryDir } = require('./memory-paths.js');

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

function main() {
  let startDir = '.';
  try { startDir = process.cwd(); } catch (_) {}
  const memDir = resolveMemoryDir(startDir).dir;
  const fragmentsDir = path.join(memDir, 'fragments');
  const state = readJsonSafe(path.join(memDir, 'state.json'), {});
  const cursor = state && state.last_processed_fragment;

  let files = [];
  try {
    files = fs.readdirSync(fragmentsDir).filter(function (f) { return f.endsWith('.json'); }).sort();
  } catch (_) { files = []; }
  const unprocessed = cursor ? files.filter(function (f) { return f > cursor; }) : files;

  if (unprocessed.length === 0) {
    console.log('未処理の会話断片はありません。');
    return;
  }

  console.log('=== 未処理の会話断片 ' + unprocessed.length + ' 件（会話テキストのみ・コード/ログ除外済み） ===');
  for (const name of unprocessed) {
    const j = readJsonSafe(path.join(fragmentsDir, name), null);
    if (!j) continue;
    const txt = (typeof j.text === 'string' && j.text.trim()) ? j.text : (j.content || '');
    if (!String(txt).trim()) continue;
    console.log('\n--- [' + (j.role || '?') + '] ' + (j.ts || '') + ' ---');
    console.log(String(txt).trim());
  }

  console.log('\n=== 蒸留の指示 ===');
  console.log('上記から「確定した決定」「解決したバグ」「重要な状態変化」だけを抽出（推測/未確定は書かない・秘密はマスク）。');
  console.log('決定: node .claude/hooks/memory-remember.js decision --decision "..." [--reason "..."] [--scope "..."] [--review "..."]');
  console.log('バグ: node .claude/hooks/memory-remember.js bug --symptom "..." [--cause "..."] [--fix "..."] [--prevention "..."] [--files "..."]');
  console.log('横断知識(環境の罠/ツールの使い方/好み)も決定として記録。現状/次/注意は handoff.md、恒久情報は project-state.md に反映。');
  console.log('最後に node .claude/hooks/memory-mark-processed.js でループを閉じる。');
}

main();
