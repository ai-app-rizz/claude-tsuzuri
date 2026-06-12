'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const HOOK = path.join(__dirname, '..', 'memory-capture.js');

function runCapture(payload) {
  const env = Object.assign({}, process.env, { MEMORY_SCOPE: 'project' });
  delete env.CLAUDE_MEMORY_HOOK_ACTIVE;
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), env, stdio: ['pipe', 'ignore', 'ignore'],
  });
}

test('capture: コード貼り付けは text と blobs に分離して保存される', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capblob-'));
  fs.mkdirSync(path.join(root, '.git'));
  const prompt = 'このコードを直して。\n```js\nconst x = 1;\n```\nお願いします。';
  runCapture({ hook_event_name: 'UserPromptSubmit', prompt, session_id: 'b1', cwd: root });
  const fragDir = path.join(root, '.claude', 'memory', 'fragments');
  const files = fs.readdirSync(fragDir).filter((f) => f.endsWith('.json'));
  assert.strictEqual(files.length, 1);
  const j = JSON.parse(fs.readFileSync(path.join(fragDir, files[0]), 'utf8'));
  assert.ok(j.content.includes('const x = 1;'));
  assert.ok(typeof j.text === 'string');
  assert.ok(!j.text.includes('const x = 1;'));
  assert.ok(j.text.includes('このコードを直して。'));
  assert.ok(Array.isArray(j.blobs));
  assert.ok(j.blobs.some((b) => b.kind === 'code' && b.content.includes('const x = 1;')));
});
