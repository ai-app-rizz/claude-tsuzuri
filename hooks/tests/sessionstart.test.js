'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const HOOK = path.join(__dirname, '..', 'memory-session-start.js');

test('session-start: project の handoff 中身を注入する', () => {
  // テスト用の一時ディレクトリを作成
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  fs.mkdirSync(path.join(root, '.git'));
  const mem = path.join(root, '.claude', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'handoff.md'), '# handoff\n\n## 現在\n- 実装中の重要事項XYZ\n');
  const env = Object.assign({}, process.env, { MEMORY_SCOPE: 'project' });
  delete env.CLAUDE_MEMORY_HOOK_ACTIVE;
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }),
    env,
    encoding: 'utf8',
  });
  assert.ok(out.includes('実装中の重要事項XYZ'), 'handoff content should be injected; got: ' + out.slice(0, 300));
});
