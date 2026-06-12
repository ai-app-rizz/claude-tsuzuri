#!/usr/bin/env node
'use strict';
// memory-remember.js: 確定した決定/解決したバグを構造化メモリ
// (decisions.md / bugs-and-fixes.md) へ追記する CLI。重複は内容ハッシュで自動スキップ。
// Claude が蒸留時に呼ぶ（注入ドリブン蒸留A の出力先）。node で起動する想定（chmod 不要）。
// 使い方:
//   node memory-remember.js decision --decision "..." [--reason "..."] [--scope "..."] [--review "..."]
//   node memory-remember.js bug --symptom "..." [--cause "..."] [--fix "..."] [--prevention "..."] [--files "..."]
// ※ String.raw 配布埋め込みのためバッククォートと dollar-brace は使わない。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveMemoryDir } = require('./memory-paths.js');

// --flag value 形式を素朴にパースする
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0) {
      const key = a.slice(2);
      const hasVal = i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0;
      out[key] = hasVal ? argv[++i] : 'true';
    } else {
      out._.push(a);
    }
  }
  return out;
}

// 値が空でなければ "- ラベル: 値\n" を返す
function field(label, value) {
  if (!value || !String(value).trim()) return '';
  return '- ' + label + ': ' + String(value).trim() + '\n';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const type = args._[0];
  if (type !== 'decision' && type !== 'bug') {
    console.error('使い方: node memory-remember.js <decision|bug> --...');
    process.exit(2);
  }

  let startDir = '.';
  try { startDir = process.cwd(); } catch (_) {}
  const memDir = resolveMemoryDir(startDir).dir;
  const date = new Date().toISOString().slice(0, 10);

  let fileName, body, hashSrc;
  if (type === 'decision') {
    const decision = args.decision || '';
    if (!decision.trim()) { console.error('--decision は必須です'); process.exit(2); }
    fileName = 'decisions.md';
    body =
      field('決定内容', decision) +
      field('理由', args.reason) +
      field('影響範囲', args.scope) +
      field('後から見直す条件', args.review);
    hashSrc = 'decision|' + decision + '|' + (args.reason || '') + '|' + (args.scope || '') + '|' + (args.review || '');
  } else {
    const symptom = args.symptom || '';
    if (!symptom.trim()) { console.error('--symptom は必須です'); process.exit(2); }
    fileName = 'bugs-and-fixes.md';
    body =
      field('症状', symptom) +
      field('原因', args.cause) +
      field('修正内容', args.fix) +
      field('再発防止策', args.prevention) +
      field('関連ファイル', args.files);
    hashSrc = 'bug|' + symptom + '|' + (args.cause || '') + '|' + (args.fix || '') + '|' + (args.prevention || '') + '|' + (args.files || '');
  }

  const hash = crypto.createHash('sha1').update(hashSrc).digest('hex').slice(0, 12);
  const target = path.join(memDir, fileName);

  let existing = '';
  try { existing = fs.readFileSync(target, 'utf8'); } catch (_) {}
  if (existing.indexOf('mh:' + hash) !== -1) {
    console.log('重複のためスキップしました (' + fileName + ')');
    return;
  }

  const entry = '\n## ' + date + '\n' + body + '<!-- mh:' + hash + ' -->\n';
  try {
    fs.mkdirSync(memDir, { recursive: true });
    fs.appendFileSync(target, entry, 'utf8');
  } catch (e) {
    console.error('追記に失敗: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
  console.log('記録しました: ' + fileName + ' (' + type + ', mh:' + hash + ')');
}

main();
