'use strict';
// capture.test.js: memory-capture.js の結合テスト
// - project_id と cwd が fragment に含まれるか
// - 同一発言の二重発火が冪等（1件のみ保存）か
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'memory-capture.js');

/**
 * memory-capture.js を子プロセスとして実行する。
 * process.execPath で絶対パスの node を使うため、PATH 不要。
 * CLAUDE_MEMORY_HOOK_ACTIVE は明示的に削除して再帰防止フラグをクリアする。
 */
function runCapture(payload, extraEnv) {
  // 現在の環境変数をコピーしてから上書き
  const env = Object.assign({}, process.env, extraEnv);
  // 再帰防止フラグを必ずクリア（テスト実行環境から引き継がない）
  delete env.CLAUDE_MEMORY_HOOK_ACTIVE;
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

test('capture: project スコープで fragment に project_id と cwd が入る', () => {
  // 一時ディレクトリを作り .git を置いてプロジェクトルートと認識させる
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  fs.mkdirSync(path.join(root, '.git'));

  runCapture(
    {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'これはテスト発言です',
      session_id: 's1',
      cwd: root,
    },
    { MEMORY_SCOPE: 'project' }
  );

  const fragDir = path.join(root, '.claude', 'memory', 'fragments');
  const files = fs.readdirSync(fragDir).filter((f) => f.endsWith('.json'));
  assert.strictEqual(files.length, 1, 'fragment が1件保存されること');

  const j = JSON.parse(fs.readFileSync(path.join(fragDir, files[0]), 'utf8'));
  // project_id が "proj-" で始まるか
  assert.ok(
    j.project_id && j.project_id.startsWith('proj-'),
    'project_id が "proj-" で始まること: ' + j.project_id
  );
  // cwd が realpath 化された値か
  assert.strictEqual(j.cwd, fs.realpathSync(root), 'cwd が realpath 化されていること');
  assert.strictEqual(j.role, 'user', 'role が "user" であること');
});

test('capture: 同一発言の二重発火は1件に収束（冪等）', () => {
  // 別の一時ディレクトリで実施（前テストと干渉しない）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  fs.mkdirSync(path.join(root, '.git'));

  const p = {
    hook_event_name: 'UserPromptSubmit',
    prompt: '重複テスト',
    session_id: 's2',
    cwd: root,
  };

  // 同一 payload を2回実行
  runCapture(p, { MEMORY_SCOPE: 'project' });
  runCapture(p, { MEMORY_SCOPE: 'project' });

  const fragDir = path.join(root, '.claude', 'memory', 'fragments');
  const files = fs.readdirSync(fragDir).filter((f) => f.endsWith('.json'));
  // 2回発火しても fragment は1件のみ保存されること
  assert.strictEqual(files.length, 1, '二重発火でも fragment は1件のみ保存されること');
});
