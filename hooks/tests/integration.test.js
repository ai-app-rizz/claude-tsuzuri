'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
// hooks ディレクトリのパス（tests の親）
const HOOKS = path.join(__dirname, '..');

test('integration: project スコープで capture→search が同じ dir を使う', () => {
  // 一時ディレクトリを作成し、Git リポジトリとして扱う
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'int-'));
  fs.mkdirSync(path.join(root, '.git'));

  // 環境変数設定: project スコープで動作させ、再帰呼び出しを防ぐために CLAUDE_MEMORY_HOOK_ACTIVE を削除
  const env = Object.assign({}, process.env, { MEMORY_SCOPE: 'project' });
  delete env.CLAUDE_MEMORY_HOOK_ACTIVE;

  // 1) capture (Node) でフラグメントを1件保存
  execFileSync(process.execPath, [path.join(HOOKS, 'memory-capture.js')], {
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: '統合テスト用の発言データ',
      session_id: 'i1',
      cwd: root,
    }),
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  // 2) memory-search.py (Python) で同じ memDir を解決して索引を構築
  execFileSync('python3', [path.join(HOOKS, 'memory-search.py'), '--reindex'], {
    cwd: root,
    env,
    stdio: 'ignore',
  });

  // 3) 索引とフラグメントが同じプロジェクト内 .claude/memory に存在することを確認
  assert.ok(
    fs.existsSync(path.join(root, '.claude', 'memory', 'index.sqlite')),
    'index.sqlite should exist under project memory dir'
  );
  const frag = path.join(root, '.claude', 'memory', 'fragments');
  assert.ok(
    fs.readdirSync(frag).some((f) => f.endsWith('.json')),
    'at least one fragment json should exist'
  );
});
