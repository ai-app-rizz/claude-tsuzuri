'use strict';
// memory-paths.js: メモリ保存先のスコープ・パス解決モジュール
// memory-capture.js / memory-session-start.js / memory-mark-processed.js から require される
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// プロジェクトルートを判定するマーカーファイル／ディレクトリ
const PROJECT_MARKERS = ['.git', 'package.json', '.claude'];

// macOS TCC 等で existsSync が例外を投げてもフックを止めない
function safeExistsSync(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

/**
 * startDir から上方探索してプロジェクトルートを返す。
 * マーカーが見つからない場合は startDir の絶対パスを返す。
 */
function findProjectRoot(startDir) {
  let dir;
  try { dir = fs.realpathSync(path.resolve(startDir)); }
  catch (_) { dir = path.resolve(startDir); }
  while (true) {
    for (const m of PROJECT_MARKERS) {
      if (safeExistsSync(path.join(dir, m))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

/** グローバルメモリディレクトリ (~/.claude/memory) を返す */
function globalMemoryDir() {
  return path.join(os.homedir(), '.claude', 'memory');
}

/** ~/.claude/ が読み書き可能かチェック */
function globalReachable() {
  try {
    fs.accessSync(path.join(os.homedir(), '.claude'), fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (_) { return false; }
}

/**
 * メモリ保存先ディレクトリを解決する。
 * env は省略時 process.env。テスト容易性のため引数で差し込める。
 *
 * 優先順位:
 *   1. MEMORY_SCOPE=project → プロジェクト内 .claude/memory
 *   2. MEMORY_SCOPE=global  → ~/.claude/memory
 *   3. 自動検出: プロジェクト内に .claude/memory が存在すれば project
 *   4. 自動検出: ~/.claude/ が書き込み可能なら global
 *   5. フォールバック: project
 */
function resolveMemoryDir(startDir, env) {
  env = env || process.env;
  const scope = (env.MEMORY_SCOPE || '').trim().toLowerCase();
  const projectRoot = findProjectRoot(startDir || '.');
  const projectMem = path.join(projectRoot, '.claude', 'memory');
  if (scope === 'project') return { scope: 'project', dir: projectMem, projectRoot };
  if (scope === 'global') return { scope: 'global', dir: globalMemoryDir(), projectRoot };
  if (safeExistsSync(projectMem)) return { scope: 'project', dir: projectMem, projectRoot };
  if (globalReachable()) return { scope: 'global', dir: globalMemoryDir(), projectRoot };
  return { scope: 'project', dir: projectMem, projectRoot };
}

/**
 * プロジェクトIDを取得または新規生成する。
 * memoryDir/project-id ファイルに永続化し、ディレクトリ名変更後も同じIDを維持する。
 */
function getOrCreateProjectId(memoryDir) {
  const idFile = path.join(memoryDir, 'project-id');
  try {
    if (safeExistsSync(idFile)) {
      const v = fs.readFileSync(idFile, 'utf8').trim();
      if (v) return v;
    }
  } catch (_) {}
  const id = 'proj-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(idFile, id + '\n', 'utf8');
  } catch (_) {}
  return id;
}

module.exports = { findProjectRoot, resolveMemoryDir, getOrCreateProjectId, globalMemoryDir, globalReachable };
