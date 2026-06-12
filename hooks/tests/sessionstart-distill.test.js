'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const HOOK = path.join(__dirname, '..', 'memory-session-start.js');

test('session-start: 未処理ありで蒸留手順(distill/remember)を案内する', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssd-'));
  fs.mkdirSync(path.join(root, '.git'));
  const mem = path.join(root, '.claude', 'memory');
  fs.mkdirSync(path.join(mem, 'fragments'), { recursive: true });
  fs.writeFileSync(path.join(mem, 'handoff.md'), '# h\n\n## 現在\n- 何か\n');
  fs.writeFileSync(path.join(mem, 'fragments', '20260101-000000-user-aaaaaa.json'),
    JSON.stringify({ ts: 'x', role: 'user', content: '未処理データ' }));
  const env = Object.assign({}, process.env, { MEMORY_SCOPE: 'project' });
  delete env.CLAUDE_MEMORY_HOOK_ACTIVE;
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }), env, encoding: 'utf8',
  });
  assert.ok(out.includes('memory-distill.js'), 'distill 案内が必要: ' + out.slice(0, 400));
  assert.ok(out.includes('memory-remember.js'), 'remember 案内が必要');
  assert.ok(out.includes('memory-mark-processed.js'), 'mark-processed 案内が必要');
});
