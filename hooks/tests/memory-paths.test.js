'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mp = require('../memory-paths.js');

// 作成した一時ディレクトリを追跡してテスト後に削除する
const createdDirs = [];

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memtest-'));
  createdDirs.push(d);
  return d;
}

test('findProjectRoot: .git を上方探索で見つける', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.git'));
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  assert.strictEqual(mp.findProjectRoot(sub), fs.realpathSync(root));
});

test('resolveMemoryDir: MEMORY_SCOPE=project はプロジェクト内', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.git'));
  const r = mp.resolveMemoryDir(root, { MEMORY_SCOPE: 'project' });
  assert.strictEqual(r.scope, 'project');
  assert.strictEqual(r.dir, path.join(fs.realpathSync(root), '.claude', 'memory'));
});

test('getOrCreateProjectId: 生成して再読込で同じ', () => {
  const mem = path.join(tmpdir(), '.claude', 'memory');
  const id1 = mp.getOrCreateProjectId(mem);
  const id2 = mp.getOrCreateProjectId(mem);
  assert.ok(id1.startsWith('proj-'));
  assert.strictEqual(id1, id2);
});

test('resolveMemoryDir: MEMORY_SCOPE=global はグローバル', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.git'));
  const os2 = require('os');
  const r = mp.resolveMemoryDir(root, { MEMORY_SCOPE: 'global' });
  assert.strictEqual(r.scope, 'global');
  assert.strictEqual(r.dir, path.join(os2.homedir(), '.claude', 'memory'));
});

test('resolveMemoryDir: scope未指定でprojectMem存在なら自動でproject', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  const r = mp.resolveMemoryDir(root, {}); // env空＝自動検出
  assert.strictEqual(r.scope, 'project');
  assert.strictEqual(r.dir, path.join(fs.realpathSync(root), '.claude', 'memory'));
});

test('cleanup: 一時ディレクトリを削除', () => {
  for (const d of createdDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});
