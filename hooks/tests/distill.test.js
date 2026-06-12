'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const TOOL = path.join(__dirname, '..', 'memory-distill.js');

function runDistill(root) {
  return execFileSync(process.execPath, [TOOL], {
    cwd: root, env: Object.assign({}, process.env, { MEMORY_SCOPE: 'project' }), encoding: 'utf8',
  });
}

test('memory-distill: 未処理fragmentの会話text（blob除外）と指示を出力', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
  fs.mkdirSync(path.join(root, '.git'));
  const frag = path.join(root, '.claude', 'memory', 'fragments');
  fs.mkdirSync(frag, { recursive: true });
  fs.writeFileSync(path.join(frag, '20260101-000000-user-aaaaaa.json'), JSON.stringify({
    ts: '2026-01-01T00:00:00Z', role: 'user',
    content: '転入手続きを教えて\n[CODEBLOCK]', text: '転入手続きを教えて',
  }));
  const out = runDistill(root);
  assert.ok(out.includes('転入手続きを教えて'));
  assert.ok(!out.includes('[CODEBLOCK]'));
  assert.ok(out.includes('memory-remember.js'));
  assert.ok(out.includes('mark-processed'));
});

test('memory-distill: 未処理が無ければその旨を出力', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude', 'memory', 'fragments'), { recursive: true });
  const out = runDistill(root);
  assert.ok(out.includes('未処理の会話断片はありません'));
});

test('memory-distill: カーソル(last_processed_fragment)より後だけ対象', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
  fs.mkdirSync(path.join(root, '.git'));
  const mem = path.join(root, '.claude', 'memory');
  const frag = path.join(mem, 'fragments');
  fs.mkdirSync(frag, { recursive: true });
  fs.writeFileSync(path.join(frag, '20260101-000000-user-aaaaaa.json'), JSON.stringify({ ts: 't1', role: 'user', text: '古い発言A' }));
  fs.writeFileSync(path.join(frag, '20260102-000000-user-bbbbbb.json'), JSON.stringify({ ts: 't2', role: 'user', text: '新しい発言B' }));
  fs.writeFileSync(path.join(mem, 'state.json'), JSON.stringify({ last_processed_fragment: '20260101-000000-user-aaaaaa.json' }));
  const out = runDistill(root);
  assert.ok(!out.includes('古い発言A'));
  assert.ok(out.includes('新しい発言B'));
});
