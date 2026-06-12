'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const TOOL = path.join(__dirname, '..', 'memory-remember.js');

function run(cwd, args) {
  return execFileSync(process.execPath, [TOOL].concat(args), {
    cwd, env: Object.assign({}, process.env, { MEMORY_SCOPE: 'project' }), encoding: 'utf8',
  });
}

test('decision を decisions.md に追記し、同一内容は重複スキップ', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  fs.mkdirSync(path.join(root, '.git'));
  run(root, ['decision', '--decision', 'メモリは global 既定にする', '--reason', '横断知識の集約']);
  const f = path.join(root, '.claude', 'memory', 'decisions.md');
  let txt = fs.readFileSync(f, 'utf8');
  assert.ok(txt.includes('- 決定内容: メモリは global 既定にする'));
  assert.ok(txt.includes('- 理由: 横断知識の集約'));
  const cnt1 = (txt.match(/^## /gm) || []).length;
  run(root, ['decision', '--decision', 'メモリは global 既定にする', '--reason', '横断知識の集約']);
  txt = fs.readFileSync(f, 'utf8');
  const cnt2 = (txt.match(/^## /gm) || []).length;
  assert.strictEqual(cnt1, cnt2);
});

test('bug を bugs-and-fixes.md に追記', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  fs.mkdirSync(path.join(root, '.git'));
  run(root, ['bug', '--symptom', 'uv_cwd EPERM', '--cause', 'TCC FDA 失効', '--fix', 'FDA再付与', '--prevention', 'OS更新後に確認']);
  const f = path.join(root, '.claude', 'memory', 'bugs-and-fixes.md');
  const txt = fs.readFileSync(f, 'utf8');
  assert.ok(txt.includes('- 症状: uv_cwd EPERM'));
  assert.ok(txt.includes('- 修正内容: FDA再付与'));
});

test('必須フィールド欠如は exit 2', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  fs.mkdirSync(path.join(root, '.git'));
  let code = 0;
  try {
    execFileSync(process.execPath, [TOOL, 'decision'], {
      cwd: root, env: Object.assign({}, process.env, { MEMORY_SCOPE: 'project' }), stdio: 'ignore',
    });
  } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
});
