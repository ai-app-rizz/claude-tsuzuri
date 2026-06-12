#!/usr/bin/env node
/**
 * install-memory.js
 * -----------------------------------------------------------------------------
 * Claude Code 用「Hermes Agent風 自動永続メモリー機構」を
 * カレントのプロジェクトディレクトリ配下に展開する自己完結インストーラ。
 *
 * 特徴:
 *   - 単一ファイル完結。テンプレートは全てこのファイルに埋め込み。
 *     → ~/.claude を消しても、別マシンにコピーしても動く。
 *   - ファイル単位の存在チェック。既存ファイルは絶対に上書きしない。
 *     不足しているファイルだけを作成する（部分復旧に対応）。
 *   - .claude/settings.local.json は特別扱い:
 *       既存があれば hooks 設定だけを安全にマージ（他設定は保持）。
 *       無ければ新規作成。JSON破損時は触らず報告のみ。
 *   - 各ファイルの結果を created / skipped(exists) / merged で表示。
 *
 * 使い方:
 *   1. このファイルを好きな場所に置く（例: ~/.claude/install-memory.js）
 *      ※ 自己完結なので置き場所は自由。PATHを通すと尚良い。
 *   2. 対象プロジェクトのルートで実行:
 *        node /path/to/install-memory.js
 *      または chmod +x して:
 *        ~/.claude/install-memory.js
 *
 * オプション:
 *   --dry-run   実際には書き込まず、何をするかだけ表示
 *   --help      ヘルプ表示
 *
 * 安全方針:
 *   - 破壊的操作は一切行わない（削除・rm・git操作なし）。
 *   - 既存ファイルは上書きしない。
 *   - settings.local.json はマージのみ。元の値は消さない。
 * -----------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 引数処理
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SHOW_HELP = args.includes('--help') || args.includes('-h');
const FORCE_YES = args.includes('--yes') || args.includes('-y');
const NO_BACKUP = args.includes('--no-backup');
const NO_GITIGNORE = args.includes('--no-gitignore');
const FORCE = args.includes('--force');
const WITH_EMBEDDINGS = args.includes('--with-embeddings');
const NO_EMBEDDINGS = args.includes('--no-embeddings');

if (SHOW_HELP) {
  console.log(`
install-memory.js — Claude Code 永続メモリー機構インストーラ

使い方:
  node install-memory.js [options]

オプション:
  --dry-run     書き込まず、実行内容のプレビューのみ表示
  --yes, -y     確認プロンプトを出さず、既存があれば自動でバックアップ
  --no-backup   バックアップを取らずに続行（既存ファイルは上書きしないため安全）
  --no-gitignore .gitignore への自動追記をしない（提案表示のみ）
  --force       hook本体スクリプトを最新版で上書き更新する
                （memory配下のデータと settings.local.json は保持）
  --with-embeddings  ベクトル意味検索のセットアップを行う（OS別にOllama導入を案内/実行）
  --no-embeddings    ベクトル意味検索を尋ねない（FTS5のみ）
  --help, -h    このヘルプを表示

動作:
  カレントディレクトリをプロジェクトルートとみなし、
  .claude/ 配下に必要なファイルを展開します。
  既存ファイルは上書きせず、不足分のみ作成します。
  settings.local.json は hooks 設定だけを安全にマージします。

バックアップ:
  既存の .claude/ がある場合、展開前に
  .claude.backup-YYYYMMDD-HHMMSS/ へ丸ごとコピーできます。
  - 対話環境(TTY)では実行前に確認します。
  - 非対話環境(sbx/CIなど)では自動でバックアップして続行します。
  - 戻したいときは手動で:
      rm -rf .claude && mv .claude.backup-YYYYMMDD-HHMMSS .claude
`);
  process.exit(0);
}

const PROJECT_ROOT = process.cwd();
const CLAUDE_DIR = path.join(PROJECT_ROOT, '.claude');

// 結果集計
const results = { created: [], skipped: [], merged: [], updated: [], errors: [], dirs: [] };

// ---------------------------------------------------------------------------
// バックアップ
// ---------------------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }

function backupStamp(d) {
  return (
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    '-' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

/**
 * ディレクトリを再帰コピー。
 * Node 16.7+ の fs.cpSync があればそれを使い、無ければ手動再帰。
 */
function copyDirRecursive(src, dest) {
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dest, { recursive: true });
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isSymbolicLink()) {
      try { fs.symlinkSync(fs.readlinkSync(s), d); } catch (_) {}
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * TTY（対話端末）かどうか。sbx/CI/パイプ実行では false になる。
 */
function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * 対話プロンプトで yes/no を取る。
 * readline を使い、TTY が無い場合は呼ばない前提。
 */
function askYesNo(question) {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes' || a === 'はい');
    });
  });
}

/**
 * 既存 .claude/ のバックアップ処理。
 * 戻り値: 作成したバックアップパス、または null（取らなかった）。
 */
async function maybeBackup() {
  // 既存が無ければバックアップ不要
  if (!fs.existsSync(CLAUDE_DIR)) return null;

  const backupName = '.claude.backup-' + backupStamp(new Date());
  const backupPath = path.join(PROJECT_ROOT, backupName);

  // dry-run は予告のみ
  if (DRY_RUN) {
    console.log('既存の .claude/ を検出しました。');
    console.log('(DRY-RUN) バックアップ先候補: ' + backupName);
    console.log('');
    return null;
  }

  // --no-backup 明示時はスキップ
  if (NO_BACKUP) {
    console.log('既存の .claude/ を検出しましたが、--no-backup のためバックアップしません。');
    console.log('（既存ファイルは上書きしない設計なので、内容は保持されます）');
    console.log('');
    return null;
  }

  let doBackup;
  if (FORCE_YES) {
    doBackup = true;
  } else if (isInteractive()) {
    // 対話: ユーザーに確認
    console.log('既存の .claude/ ディレクトリが存在します。');
    console.log('バックアップしておくと、いつでも元の状態に戻せます。');
    doBackup = await askYesNo(
      'バックアップしておきますか？ [Y/n]: '
    );
  } else {
    // 非対話(sbx/CI): 自動でバックアップして続行
    console.log('既存の .claude/ を検出しました（非対話環境）。自動でバックアップします。');
    doBackup = true;
  }

  if (!doBackup) {
    console.log('バックアップせずに続行します。');
    console.log('（既存ファイルは上書きしない設計なので、内容は保持されます）');
    console.log('');
    return null;
  }

  try {
    copyDirRecursive(CLAUDE_DIR, backupPath);
    console.log('バックアップを作成しました: ' + backupName + '/');
    console.log('戻したいときは:');
    console.log('  rm -rf .claude && mv ' + backupName + ' .claude');
    console.log('');
    return backupPath;
  } catch (e) {
    console.log('バックアップに失敗しました: ' + (e && e.message ? e.message : e));
    // 非対話なら安全側に倒して中断
    if (!isInteractive()) {
      console.log('安全のため処理を中断します。');
      process.exit(1);
    }
    // 対話なら続行可否を確認
    const cont = await askYesNo('バックアップ無しで続行しますか？ [y/N]: ');
    if (!cont) {
      console.log('中断しました。');
      process.exit(1);
    }
    console.log('');
    return null;
  }
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------
function ensureDir(dirPath) {
  const rel = path.relative(PROJECT_ROOT, dirPath) || '.';
  if (fs.existsSync(dirPath)) return;
  if (DRY_RUN) {
    results.dirs.push(rel + ' (would create)');
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true });
  results.dirs.push(rel);
}

/**
 * 既存なら触らず skip、無ければ作成。
 */
function writeIfMissing(filePath, content) {
  const rel = path.relative(PROJECT_ROOT, filePath);
  if (fs.existsSync(filePath)) {
    results.skipped.push(rel);
    return;
  }
  if (DRY_RUN) {
    results.created.push(rel + ' (would create)');
    return;
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
  results.created.push(rel);
}

/**
 * hook本体スクリプト専用の書き込み。
 *   - 無ければ作成（created）。
 *   - 既存があり、--force のときは内容が違えば上書き（updated）。
 *     内容が同じなら skip。
 *   - --force でなく既存があれば従来どおり skip。
 * memory配下のデータは対象にしない（呼び出し側でhookファイルのみ渡す）。
 */
function writeHook(filePath, content) {
  const rel = path.relative(PROJECT_ROOT, filePath);
  const exists = fs.existsSync(filePath);

  if (!exists) {
    if (DRY_RUN) {
      results.created.push(rel + ' (would create)');
      return;
    }
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content, 'utf8');
    results.created.push(rel);
    return;
  }

  // 既存あり
  if (!FORCE) {
    results.skipped.push(rel);
    return;
  }

  // --force: 内容差分があるときだけ更新
  let current = '';
  try { current = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
  if (current === content) {
    results.skipped.push(rel + '（最新版と同一）');
    return;
  }
  if (DRY_RUN) {
    results.updated.push(rel + ' (would update)');
    return;
  }
  fs.writeFileSync(filePath, content, 'utf8');
  results.updated.push(rel);
}
/**
 * hooks のマージ方針:
 *   - 既存の hooks / permissions / env / その他キーは保持。
 *   - 各イベント(UserPromptSubmit/Stop/SessionStart)について、
 *     同じ command が既に登録されていれば追加しない（重複防止）。
 *     未登録なら既存配列に追加する（既存hookは消さない）。
 */
function mergeSettingsLocal(filePath, desiredHooks) {
  const rel = path.relative(PROJECT_ROOT, filePath);

  // 既存なし → 新規作成
  if (!fs.existsSync(filePath)) {
    const fresh = { hooks: desiredHooks };
    if (DRY_RUN) {
      results.created.push(rel + ' (would create)');
      return;
    }
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
    results.created.push(rel);
    return;
  }

  // 既存あり → 読み込んでマージ
  let raw, parsed;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    // JSON破損時は触らず報告のみ
    results.errors.push(
      `${rel} は JSON として読めませんでした（${e.message}）。` +
      `安全のため自動修復・上書きは行いません。手動で確認してください。`
    );
    return;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    results.errors.push(
      `${rel} のトップレベルがオブジェクトではありません。安全のため変更しません。`
    );
    return;
  }

  if (!parsed.hooks || typeof parsed.hooks !== 'object') {
    parsed.hooks = {};
  }

  let changed = false;

  for (const eventName of Object.keys(desiredHooks)) {
    const desiredMatchers = desiredHooks[eventName];
    if (!Array.isArray(parsed.hooks[eventName])) {
      parsed.hooks[eventName] = [];
    }
    const existingMatchers = parsed.hooks[eventName];

    // 既存に登録済みの command 一覧を収集
    const existingCommands = new Set();
    for (const m of existingMatchers) {
      if (m && Array.isArray(m.hooks)) {
        for (const h of m.hooks) {
          if (h && typeof h.command === 'string') {
            existingCommands.add(h.command);
          }
        }
      }
    }

    // desired のうち、未登録の command を持つ matcher だけ追加
    for (const dm of desiredMatchers) {
      const dmCommands = (dm.hooks || [])
        .map((h) => h.command)
        .filter(Boolean);
      const allAlreadyPresent = dmCommands.every((c) =>
        existingCommands.has(c)
      );
      if (allAlreadyPresent && dmCommands.length > 0) {
        continue; // 既に同じcommandがある → 追加しない
      }
      existingMatchers.push(dm);
      changed = true;
    }
  }

  if (!changed) {
    results.skipped.push(rel + '（hooks は既に設定済み）');
    return;
  }

  if (DRY_RUN) {
    results.merged.push(rel + ' (would merge)');
    return;
  }

  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  results.merged.push(rel);
}

// ===========================================================================
// 埋め込みテンプレート群
// ===========================================================================

// --- hooks 設定（settings.local.json にマージする内容） -------------------
const DESIRED_HOOKS = {
  UserPromptSubmit: [
    {
      hooks: [
        { type: 'command', command: 'node .claude/hooks/memory-capture.js' },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        { type: 'command', command: 'node .claude/hooks/memory-capture.js' },
      ],
    },
  ],
  SessionStart: [
    {
      hooks: [
        {
          type: 'command',
          command: 'node .claude/hooks/memory-session-start.js',
        },
      ],
    },
  ],
};

// --- memory-paths.js / memory_paths.py (共有リゾルバ) ---
const TPL_PATHS_JS = String.raw`'use strict';
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
`;
const TPL_PATHS_PY = String.raw`# memory_paths.py: メモリ保存先のスコープ・パス解決モジュール（Python版）
# memory_paths.js（Node版）と同じ解決ロジックを Python で実装する
# memory-search.py 等から import される
import os
import uuid

# プロジェクトルートを判定するマーカーファイル／ディレクトリ
PROJECT_MARKERS = (".git", "package.json", ".claude")


def _safe_exists(p):
    """macOS TCC 等で os.path.exists が例外を投げてもフックを止めない"""
    try:
        return os.path.exists(p)
    except OSError:
        return False


def _safe_isdir(p):
    """macOS TCC 等で os.path.isdir が例外を投げてもフックを止めない"""
    try:
        return os.path.isdir(p)
    except OSError:
        return False


def find_project_root(start_dir):
    """startDir から上方探索してプロジェクトルートを返す。
    マーカーが見つからない場合は startDir の絶対パスを返す。"""
    try:
        d = os.path.realpath(os.path.abspath(start_dir))
    except Exception:
        d = os.path.abspath(start_dir)
    while True:
        for m in PROJECT_MARKERS:
            if _safe_exists(os.path.join(d, m)):
                return d
        parent = os.path.dirname(d)
        if parent == d:
            return os.path.abspath(start_dir)
        d = parent


def global_memory_dir():
    """グローバルメモリディレクトリ (~/.claude/memory) を返す"""
    return os.path.join(os.path.expanduser("~"), ".claude", "memory")


def global_reachable():
    """~/.claude/ が読み書き可能かチェック"""
    g = os.path.join(os.path.expanduser("~"), ".claude")
    return os.access(g, os.R_OK | os.W_OK)


def resolve_memory_dir(start_dir, env=None):
    """メモリ保存先ディレクトリを解決する。
    env は省略時 os.environ。テスト容易性のため引数で差し込める。

    優先順位:
      1. MEMORY_SCOPE=project → プロジェクト内 .claude/memory
      2. MEMORY_SCOPE=global  → ~/.claude/memory
      3. 自動検出: プロジェクト内に .claude/memory が存在すれば project
      4. 自動検出: ~/.claude/ が書き込み可能なら global
      5. フォールバック: project

    戻り値: (scope, dir, project_root) のタプル
    """
    env = env if env is not None else os.environ
    scope = (env.get("MEMORY_SCOPE") or "").strip().lower()
    project_root = find_project_root(start_dir or ".")
    project_mem = os.path.join(project_root, ".claude", "memory")
    if scope == "project":
        return ("project", project_mem, project_root)
    if scope == "global":
        return ("global", global_memory_dir(), project_root)
    if _safe_isdir(project_mem):
        return ("project", project_mem, project_root)
    if global_reachable():
        return ("global", global_memory_dir(), project_root)
    return ("project", project_mem, project_root)


def get_or_create_project_id(memory_dir):
    """プロジェクトIDを取得または新規生成する。
    memory_dir/project-id ファイルに永続化し、ディレクトリ名変更後も同じIDを維持する。
    Node版と同様に 'proj-' + 16桁 hex 形式を使用する。
    必ず非空の文字列を返す（例外はすべて吸収する）。
    """
    id_file = os.path.join(memory_dir, "project-id")
    try:
        if _safe_exists(id_file):
            with open(id_file, "r", encoding="utf-8") as f:
                v = f.read().strip()
            if v:
                return v
    except Exception:
        pass
    # Node版: 'proj-' + crypto.randomBytes(8).toString('hex') → 16桁 hex
    pid = "proj-" + uuid.uuid4().hex[:16]
    try:
        os.makedirs(memory_dir, exist_ok=True)
        with open(id_file, "w", encoding="utf-8") as f:
            f.write(pid + "\n")
    except Exception:
        pass
    return pid
`;

// --- memory-blob.js (コード/ログ blob 分離) ---
const TPL_BLOB_JS = String.raw`'use strict';
// memory-blob.js: 会話本文を「会話テキスト」と「コード/ログ blob」に分離する純粋関数。
// 意味検索は text のみ埋め込んで高信号化し、FTS5/詳細表示は全文を保持する（情報は失わない）。
// 例外を投げない設計（hook から安全に呼べる）。

const MIN_BLOB_RUN = 3;     // 連続する blob 的な行がこの数以上で log blob とみなす
const LONG_TOKEN_LEN = 40;  // 空白なしでこの長さ以上は base64/hash/url 等とみなす

// 日本語（ひらがな/カタカナ/漢字）を含むか
function hasJapanese(s) {
  return /[぀-ゟ゠-ヿ一-鿿]/.test(s);
}

// 1行が「コード/ログ的」かを判定する
function isBlobishLine(line) {
  if (typeof line !== 'string') return false;
  const s = line.trim();
  if (s === '') return false;
  if (/^[$#>]\s+\S/.test(s)) return true;           // シェルプロンプト/コマンド（$ # > 形式）
  if (/^[{}\[\]]/.test(s)) return true;             // JSON/配列の括弧始まり
  if (/^(at\s|File\s+"|Traceback)/.test(s)) return true; // スタックトレース
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return true; // ログのタイムスタンプ行
  if (!/\s/.test(s) && s.length >= LONG_TOKEN_LEN) return true; // 長い無空白トークン
  if (s.length >= 20 && !hasJapanese(s)) {          // 記号過多（英数より記号が多い）
    const alnum = (s.match(/[A-Za-z0-9]/g) || []).length;
    const symbols = (s.match(/[^A-Za-z0-9\s]/g) || []).length;
    if (symbols > alnum) return true;
  }
  return false;
}

/**
 * content を { text, blobs } に分離する。
 * - text: 会話テキスト（意味検索の埋め込み対象）
 * - blobs: [{ kind: 'code'|'log', content }]
 */
function splitBlobs(content) {
  const src = typeof content === 'string' ? content : '';
  const blobs = [];

  // 1) フェンス付きコードブロックを抽出（kind='code'）
  // \x60 はバッククォート。配布インストーラの String.raw テンプレへ埋め込めるよう、
  // ソースにリテラルのバッククォートを置かない（3連バッククォートのフェンス検出と動作同一）。
  const rest = src.replace(/\x60{3}[\s\S]*?\x60{3}/g, (m) => {
    blobs.push({ kind: 'code', content: m });
    return '\n';
  });

  // 2) 残りを行単位で走査し、連続する blob 的行を log blob にまとめる
  const lines = rest.split('\n');
  const textLines = [];
  let run = [];
  function flushRun() {
    if (run.length >= MIN_BLOB_RUN) {
      blobs.push({ kind: 'log', content: run.join('\n') });
    } else {
      for (const l of run) textLines.push(l);
    }
    run = [];
  }
  for (const line of lines) {
    if (isBlobishLine(line)) {
      run.push(line);
    } else {
      flushRun();
      textLines.push(line);
    }
  }
  flushRun();

  const text = textLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, blobs };
}

module.exports = { splitBlobs, isBlobishLine };
`;

// --- memory-capture.js ------------------------------------------------------
const TPL_CAPTURE = String.raw`#!/usr/bin/env node
'use strict';
/**
 * memory-capture.js
 * UserPromptSubmit / Stop hook から呼ばれ、会話断片を保存する。
 * - stdin から Claude Code hook の JSON を受け取る。
 * - 秘密情報を含む行はマスクする。
 * - content には上限サイズを設け、超過時は truncated:true。
 * - Stop では transcript_path から最後のassistantメッセージを抽出。
 *   取得できない/空の場合は fragment を作らない（空ファイル量産防止）。
 * - fragment に project_id（安定ID）・cwd（realpath化）・content_hash（sha1）を付与。
 * - 保存前に冪等チェック：直近2秒以内に同一 (session_id, role, content_hash) が
 *   あればスキップ（hook 二重発火対策）。
 * - state.json の uncompacted_count を更新し、閾値以上で queue.json を更新。
 * - fragments が HARD_LIMIT を超えたら古い順に archive/YYYY-MM/ へ自動移動。
 * - 失敗しても Claude Code 本体を止めない（常に exit 0）。
 * - hook 内から claude コマンドは呼ばない（再帰防止）。
 * - パス解決は payload の cwd から resolveMemoryDir で行う（process.cwd() 不使用）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 再帰防止: 自分自身が起動したセッションでは何もしない
if (process.env.CLAUDE_MEMORY_HOOK_ACTIVE === '1') {
  process.exit(0);
}
// 以降に呼ぶ子プロセスがあっても再帰しないよう、自分でフラグを立てる
process.env.CLAUDE_MEMORY_HOOK_ACTIVE = '1';

// memory-paths.js の共有パス解決モジュールを読み込む
const { resolveMemoryDir, getOrCreateProjectId } = require('./memory-paths.js');
// memory-blob.js: content を text（会話テキスト）と blobs（コード/ログ）に分離する
const { splitBlobs } = require('./memory-blob.js');

// パス定数は削除（main 内で payload の cwd から動的に導出）
// MEMORY_DIR / FRAGMENTS_DIR / ARCHIVE_DIR / STATE_PATH / QUEUE_PATH / ERROR_LOG は不使用

const CONTENT_MAX_BYTES = 8 * 1024; // content 上限 8KB
const COMPACTION_THRESHOLD = 10;
const FRAGMENTS_HARD_LIMIT = 500; // この件数を超えたら古い順に自動archive

// エラーログの書き込み先（main が memDir を確定後に設定）
let resolvedErrorLog = null;

/**
 * エラーをログファイルへ追記する。
 * main 実行前（parse 失敗時等）は os.tmpdir() 下にフォールバックする。
 */
function logError(msg) {
  try {
    const target = resolvedErrorLog || path.join(os.tmpdir(), 'claude-memory-hook-errors.log');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const line = new Date().toISOString() + ' [capture] ' + msg + '\n';
    fs.appendFileSync(target, line);
  } catch (_) { /* 最後の砦: 何もしない */ }
}

// --- 秘密情報マスク --------------------------------------------------------
// 行全体を [REDACTED_LINE] にするパターン。大文字小文字を無視。
// 汎用 token= は誤検知が多いため使わず、認証用キーのみ対象にする。
const REDACT_PATTERNS = [
  /BEGIN PRIVATE KEY/i,
  /PRIVATE KEY/i,
  /\bsk-/i,
  /\bxoxb-/i,
  /\bghp_/i,
  /\bgithub_pat_/i,
  /\bAIza/i,
  /\bwhsec_/i,
  /Authorization:\s*Bearer/i,
  /Cookie:/i,
  /Set-Cookie:/i,
  /password\s*=/i,
  /passwd\s*=/i,
  /secret\s*=/i,
  /api_key\s*=/i,
  /apikey\s*=/i,
  /access_token\s*=/i,
  /refresh_token\s*=/i,
  /auth_token\s*=/i,
  /bearer_token\s*=/i,
];

function maskSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    .split('\n')
    .map((line) => (REDACT_PATTERNS.some((re) => re.test(line)) ? '[REDACTED_LINE]' : line))
    .join('\n');
}

// --- payload から安全に値を取り出す（キー名のバージョン差に耐性） ---------
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && typeof obj[k] === 'string' && obj[k].length > 0) return obj[k];
  }
  return null;
}

function truncate(text) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= CONTENT_MAX_BYTES) return { content: text, truncated: false };
  const sliced = buf.slice(0, CONTENT_MAX_BYTES).toString('utf8');
  return { content: sliced, truncated: true };
}

function pad(n) { return String(n).padStart(2, '0'); }
function timestamp(d) {
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

/**
 * transcript_path(JSONL) から最後の assistant テキストを抽出する。
 * 巨大ファイルでも末尾だけ読むため、後ろから一定バイトのみ読む。
 * 取得できなければ空文字を返す（呼び出し側で fragment を作らない判断をする）。
 */
function extractLastAssistantText(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
    const stat = fs.statSync(transcriptPath);
    const READ_TAIL = 256 * 1024; // 末尾256KBだけ読む
    const start = Math.max(0, stat.size - READ_TAIL);
    const fd = fs.openSync(transcriptPath, 'r');
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);

    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    // 後ろから走査して最初に見つかった assistant のテキストを返す
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try { obj = JSON.parse(lines[i]); } catch (_) { continue; }
      const role =
        (obj && obj.role) ||
        (obj && obj.message && obj.message.role) ||
        (obj && obj.type);
      if (role !== 'assistant') continue;

      const msg = (obj && obj.message) || obj;
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
          .map((b) => b.text || '')
          .join('\n');
      } else if (typeof msg.text === 'string') {
        text = msg.text;
      }
      if (text && text.trim()) return text;
    }
    return '';
  } catch (e) {
    logError('transcript read failed: ' + (e && e.message ? e.message : e));
    return '';
  }
}

/**
 * fragments が HARD_LIMIT を超えていたら、古い順（ファイル名昇順）に
 * archive/YYYY-MM/ へ移動して件数を上限以内に収める。
 * memDir を引数で受け取り、fragmentsDir/archiveDir を動的に導出する。
 */
function enforceFragmentsLimit(now, memDir) {
  // memDir 基準でパスを導出（モジュールスコープの定数に依存しない）
  const fragmentsDir = path.join(memDir, 'fragments');
  const archiveDir = path.join(memDir, 'archive');

  let files;
  try {
    files = fs.readdirSync(fragmentsDir).filter((f) => f.endsWith('.json')).sort();
  } catch (_) {
    return;
  }
  if (files.length <= FRAGMENTS_HARD_LIMIT) return;

  const overflow = files.length - FRAGMENTS_HARD_LIMIT;
  const toMove = files.slice(0, overflow); // 古い順
  const ym =
    now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const destDir = path.join(archiveDir, ym);
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (_) {
    return;
  }
  for (const f of toMove) {
    try {
      fs.renameSync(path.join(fragmentsDir, f), path.join(destDir, f));
    } catch (_) { /* 個別失敗は無視して継続 */ }
  }
  logError('auto-archived ' + toMove.length + ' fragments to ' + destDir);
}

function main(payload) {
  const eventName = pick(payload, ['hook_event_name', 'hookEventName']) || 'unknown';
  // process.cwd() は sbx/TCC で uv_cwd 例外になり得るため使用しない
  const cwd = pick(payload, ['cwd', 'workingDirectory']) || '.';
  const sessionId = pick(payload, ['session_id', 'sessionId', 'session']) || 'unknown';

  // payload の cwd から memDir を解決し、配下のパスを導出する
  const memDir = resolveMemoryDir(cwd).dir;
  const fragmentsDir = path.join(memDir, 'fragments');
  const statePath = path.join(memDir, 'state.json');
  const queuePath = path.join(memDir, 'queue.json');

  // memDir が確定したらエラーログの書き込み先を設定
  resolvedErrorLog = path.join(memDir, 'hook-errors.log');

  // プロジェクトIDを取得または生成（memDir/project-id ファイルに永続化）
  const projectId = getOrCreateProjectId(memDir);

  let role = 'unknown';
  let rawContent = '';

  if (eventName === 'UserPromptSubmit') {
    role = 'user';
    rawContent = pick(payload, ['prompt', 'user_prompt', 'message', 'content']) || '';
  } else if (eventName === 'Stop') {
    role = 'assistant';
    // まず payload に本文があれば使う（将来の仕様変更に備える）
    rawContent =
      pick(payload, [
        'last_assistant_message',
        'lastAssistantMessage',
        'assistant_message',
      ]) || '';
    // 無ければ transcript_path から末尾の assistant メッセージを抽出
    if (!rawContent) {
      const transcriptPath = pick(payload, [
        'transcript_path',
        'transcriptPath',
        'transcript',
      ]);
      rawContent = extractLastAssistantText(transcriptPath);
    }
    // それでも空なら fragment を作らない（空ファイル量産防止）
    if (!rawContent || !rawContent.trim()) {
      return;
    }
  } else {
    // 想定外イベントは保存しない
    return;
  }

  // UserPromptSubmit でも空入力なら作らない
  if (!rawContent || !rawContent.trim()) {
    return;
  }

  const masked = maskSecrets(rawContent);
  const { content, truncated } = truncate(masked);

  // content_hash: role + content の sha1（冪等チェックに使用）
  const contentHash = crypto.createHash('sha1').update(role + ' ' + content).digest('hex');

  // fragments ディレクトリを確保
  fs.mkdirSync(fragmentsDir, { recursive: true });

  // --- 冪等チェック（直近2秒・同一 session/role/hash はスキップ） ----------
  // hook 二重発火（同一イベントが短時間に複数回送られる）対策
  const now = new Date();
  const nowMs = now.getTime();
  try {
    for (const f of fs.readdirSync(fragmentsDir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(fragmentsDir, f);
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      // mtime が2秒以内のファイルのみ対象
      if (nowMs - st.mtimeMs > 2000) continue;
      try {
        const prev = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (
          prev.session_id === sessionId &&
          prev.role === role &&
          prev.content_hash === contentHash
        ) {
          return; // 重複 → スキップ
        }
      } catch (_) { /* 読み取り失敗は無視して継続 */ }
    }
  } catch (_) { /* ディレクトリ走査失敗は無視して継続 */ }

  // cwd を realpath 化（シンボリックリンク解決）
  let cwdReal = cwd;
  try { cwdReal = fs.realpathSync(cwd); } catch (_) {}

  // ファイル名: タイムスタンプ + role + ランダム3バイト
  const rand = crypto.randomBytes(3).toString('hex');
  const fileName = timestamp(now) + '-' + role + '-' + rand + '.json';

  // content をテキスト部分とコード/ログ blob に分離（意味検索の高信号化）
  const { text, blobs } = splitBlobs(content);

  const fragment = {
    ts: now.toISOString(),
    hook_event_name: eventName,
    role: role,
    project_id: projectId,
    cwd: cwdReal,
    session_id: sessionId,
    content: content,
    text: text,
    blobs: blobs,
    content_hash: contentHash,
    truncated: truncated,
  };

  fs.writeFileSync(path.join(fragmentsDir, fileName), JSON.stringify(fragment, null, 2));

  // --- state.json 更新 ---
  const state = readJsonSafe(statePath, {
    version: 1,
    uncompacted_count: 0,
    last_fragment: null,
    last_compacted_at: null,
    last_processed_fragment: null,
    processed_count: 0,
    updated_at: null,
  });
  state.uncompacted_count = (state.uncompacted_count || 0) + 1;
  state.last_fragment = fileName;
  state.updated_at = now.toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  // --- queue.json 更新（閾値超過時） ---
  if (state.uncompacted_count >= COMPACTION_THRESHOLD) {
    const queue = readJsonSafe(queuePath, {
      version: 1,
      needs_compaction: false,
      reason: null,
      updated_at: null,
    });
    queue.needs_compaction = true;
    queue.reason = 'uncompacted_count >= ' + COMPACTION_THRESHOLD;
    queue.updated_at = now.toISOString();
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  }

  // --- fragments ハード上限チェック（超過分を古い順に自動archive） ---
  enforceFragmentsLimit(now, memDir);
}

// --- stdin 読み取り --------------------------------------------------------
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const payload = input.trim() ? JSON.parse(input) : {};
    main(payload);
  } catch (e) {
    logError(e && e.message ? e.message : String(e));
  }
  process.exit(0); // 何があっても本体を止めない
});
// stdin が来ないケースのフェイルセーフ
setTimeout(() => { try { process.exit(0); } catch (_) {} }, 5000);
`;

// --- memory-session-start.js ------------------------------------------------
const TPL_SESSION_START = String.raw`#!/usr/bin/env node
'use strict';
/**
 * memory-session-start.js
 * SessionStart hook。永続メモリ（handoff.md / project-state.md）の「中身」を
 * 起動時に additionalContext へ注入する（Hermes Agent 流の frozen block 方式）。
 *
 * 設計（Hermes 準拠）:
 * - メモリは「retrieval（必要時に検索）」ではなく「injection（起動時に常時注入）」。
 *   → handoff.md / project-state.md の本文をそのまま system プロンプトへ載せる。
 * - 肥大化防止のため注入は字数上限でキャップ（超過分は「全文はファイル参照」と明示）。
 * - 空テンプレ（（未記入）のみ）は注入しない（ノイズ防止）。
 * - 未処理 fragment があれば、蒸留＆ループクローズの督促を末尾に付ける。
 * - 失敗しても本体を止めない（常に exit 0）。claude コマンドは呼ばない。
 * - stdin からペイロード（cwd を含む）を受け取り、memory-paths.js でパスを解決する。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveMemoryDir } = require('./memory-paths.js');

// 再帰防止ガード（最優先で確認）
if (process.env.CLAUDE_MEMORY_HOOK_ACTIVE === '1') {
  process.exit(0);
}

// 注入の字数上限（prefix キャッシュ保護のため。Hermes は MEMORY.md ≈2200字）
const HANDOFF_INJECT_MAX = 4000;
const STATE_INJECT_MAX = 2500;

// logError はメモリディレクトリが決まってから設定する（lazy resolve）
let resolvedErrorLog = null; // main が memDir を決めたら設定
function logError(msg) {
  try {
    const target = resolvedErrorLog || path.join(os.tmpdir(), 'claude-memory-hook-errors.log');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, new Date().toISOString() + ' [session-start] ' + msg + '\n');
  } catch (_) {}
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readTextSafe(p) {
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return '';
  }
}

/**
 * additionalContext の出力。
 * 現行 Claude Code (1.x系) の標準形式:
 *   { "hookSpecificOutput": { "hookEventName": "SessionStart",
 *                             "additionalContext": "..." } }
 */
function emitContext(text) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

/**
 * 見出し・引用・HTMLコメント・（未記入）・空行を除いて
 * 実質的な中身が残るかを判定する。空テンプレの注入を避けるため。
 */
function hasRealContent(md) {
  if (!md) return false;
  const stripped = md
    .replace(/<!--[\s\S]*?-->/g, '')      // HTMLコメント除去
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith('#'))    // 見出し除外
    .filter((l) => !l.startsWith('>'))    // 引用（説明文）除外
    .filter((l) => l.replace(/[（(]未記入[）)]/g, '').trim().length > 0);
  return stripped.length > 0;
}

/**
 * 字数上限でキャップ。超過時は末尾に省略の旨とファイルパスを付ける。
 */
function cap(text, max, filePath) {
  const t = text.trimEnd();
  if (t.length <= max) return t;
  return (
    t.slice(0, max) +
    '\n…（以下省略。全文は ' + filePath + ' を参照）'
  );
}

/**
 * 未処理の fragment ファイル情報を返す。
 * @param {object|null} state - state.json の内容
 * @param {string} fragmentsDir - fragments ディレクトリの絶対パス
 */
function getUnprocessedInfo(state, fragmentsDir) {
  let files = [];
  try {
    files = fs
      .readdirSync(fragmentsDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (_) {
    return { count: 0, oldest: null, newest: null };
  }
  const cursor = state && state.last_processed_fragment;
  const unprocessed = cursor ? files.filter((f) => f > cursor) : files;
  if (unprocessed.length === 0) {
    return { count: 0, oldest: null, newest: null };
  }
  const stamp = (name) => {
    const m = name.match(/^(\d{8})-(\d{6})/);
    if (!m) return name;
    const d = m[1], t = m[2];
    return (
      d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + ' ' +
      t.slice(0, 2) + ':' + t.slice(2, 4) + ':' + t.slice(4, 6)
    );
  };
  return {
    count: unprocessed.length,
    oldest: stamp(unprocessed[0]),
    newest: stamp(unprocessed[unprocessed.length - 1]),
  };
}

/**
 * メインロジック。stdin から受け取ったペイロードを元にパスを解決し、
 * メモリ内容を additionalContext へ注入する。
 * @param {object} payload - フックペイロード（cwd を含む）
 */
function main(payload) {
  // ペイロードの cwd（または workingDirectory）を使ってメモリパスを解決する
  const cwd = (payload && (payload.cwd || payload.workingDirectory)) || '.';
  const memDir = resolveMemoryDir(cwd).dir;
  resolvedErrorLog = path.join(memDir, 'hook-errors.log');
  const fragmentsDir = path.join(memDir, 'fragments');
  const statePath = path.join(memDir, 'state.json');
  const queuePath = path.join(memDir, 'queue.json');
  const handoffPath = path.join(memDir, 'handoff.md');
  const projectStatePath = path.join(memDir, 'project-state.md');

  const state = readJsonSafe(statePath, null);
  const queue = readJsonSafe(queuePath, null);
  const parts = [];

  // --- 1) 永続メモリの「中身」を凍結ブロックとして注入 ---
  const handoff = readTextSafe(handoffPath);
  if (hasRealContent(handoff)) {
    parts.push(
      '【永続メモリ｜引き継ぎ (handoff.md)】\n' +
      cap(handoff, HANDOFF_INJECT_MAX, '.claude/memory/handoff.md')
    );
  }

  const pstate = readTextSafe(projectStatePath);
  if (hasRealContent(pstate)) {
    parts.push(
      '【永続メモリ｜プロジェクト状態 (project-state.md)】\n' +
      cap(pstate, STATE_INJECT_MAX, '.claude/memory/project-state.md')
    );
  }

  // --- 2) 未処理 fragment があれば蒸留＆ループクローズの督促 ---
  const needsCompaction = !!(queue && queue.needs_compaction);
  const info = getUnprocessedInfo(state, fragmentsDir);
  if (needsCompaction || info.count > 0) {
    const range =
      info.oldest && info.newest
        ? '（最古 ' + info.oldest + ' 〜 最新 ' + info.newest + '）'
        : '';
    parts.push(
      '※ 未処理のメモリ断片が約' + info.count + '件あります' + range + '。次の手順で蒸留してください:\n' +
      '1) node .claude/hooks/memory-distill.js で未処理の会話要約（テキストのみ）を確認。\n' +
      '2) 確定した決定は node .claude/hooks/memory-remember.js decision、解決したバグは memory-remember.js bug で ' +
      'decisions.md / bugs-and-fixes.md に追記（重複は自動スキップ・推測や未確定は書かない・秘密はマスク）。' +
      '横断的な教訓（環境の罠/ツールの使い方/好み）も決定として記録。\n' +
      '3) 現状/次/注意は .claude/memory/handoff.md、恒久情報は project-state.md に反映。\n' +
      '4) node .claude/hooks/memory-mark-processed.js でループを閉じる。'
    );
  }

  if (parts.length === 0) return; // 注入すべき中身が何も無ければ黙る

  // 深掘り用ツール(Tier2)があれば導線を示す（表示パスはあえて相対のまま）
  // 存在チェックは cwd 非依存にするため memDir 基準で行う（memDir/../hooks/）
  if (fs.existsSync(path.join(memDir, '..', 'hooks', 'memory-search.py'))) {
    parts.push('（過去ログの深掘りは: python3 .claude/hooks/memory-search.py "検索語"）');
  }
  emitContext(parts.join('\n\n'));
}

// --- stdin からペイロードを読み込み、完了後に main を呼ぶ ---
// 二重起動防止: 'end' イベントと 5秒タイムアウトのどちらか早い方で一度だけ実行する
let done = false;
function runOnce(payload) {
  if (done) return;
  done = true;
  try { main(payload); } catch (e) { logError(e && e.message ? e.message : String(e)); }
  try { process.exit(0); } catch (_) {}
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = input.trim() ? JSON.parse(input) : {}; } catch (_) {}
  runOnce(payload);
});
// stdin が閉じられない場合の 5秒フォールバック
setTimeout(() => runOnce({}), 5000);
`;

// --- memory-mark-processed.js -----------------------------------------------
// compaction（メモリ整理）完了後に Claude が1回呼ぶヘルパー。
// ループを閉じる: state/queue をリセットし、処理済みfragmentをarchiveへ移動。
const TPL_MARK_PROCESSED = String.raw`#!/usr/bin/env node
'use strict';
/**
 * memory-mark-processed.js
 * メモリ整理（compaction）完了後に実行して「ループを閉じる」ヘルパー。
 *   - 現時点の fragments を全て処理済みとみなす。
 *   - 未処理 fragment を archive/YYYY-MM/ へ移動。
 *   - state.json: uncompacted_count=0, last_processed_fragment=最新, processed_count加算。
 *   - queue.json: needs_compaction=false。
 *
 * 使い方:
 *   node .claude/hooks/memory-mark-processed.js
 *   node .claude/hooks/memory-mark-processed.js --no-archive  # 移動せずカーソルだけ進める
 *   node .claude/hooks/memory-mark-processed.js --dry-run     # 実行せず内容だけ表示
 */

const fs = require('fs');
const path = require('path');
const { resolveMemoryDir } = require('./memory-paths.js');

const NO_ARCHIVE = process.argv.includes('--no-archive');
const DRY_RUN = process.argv.includes('--dry-run');

// フラグ以外の最初の位置引数を起点ディレクトリとして使う（無ければカレント）
const startDir = process.argv.slice(2).find((a) => !a.startsWith('--')) || '.';
const MEMORY_DIR = resolveMemoryDir(startDir).dir;
const FRAGMENTS_DIR = path.join(MEMORY_DIR, 'fragments');
const ARCHIVE_DIR = path.join(MEMORY_DIR, 'archive');
const STATE_PATH = path.join(MEMORY_DIR, 'state.json');
const QUEUE_PATH = path.join(MEMORY_DIR, 'queue.json');

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function main() {
  // CWDチェック: プロジェクトルート以外での誤実行を防ぐ。
  // .claude/memory が無ければ、ここで新規作成せずエラー終了。
  if (!fs.existsSync(MEMORY_DIR)) {
    console.error(
      '.claude/memory が見つかりません。プロジェクトルートで実行してください。'
    );
    console.error('現在の作業ディレクトリ: ' + process.cwd());
    process.exit(1);
  }

  const now = new Date();

  let files = [];
  try {
    files = fs.readdirSync(FRAGMENTS_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch (_) {
    files = [];
  }

  const state = readJsonSafe(STATE_PATH, {
    version: 1,
    uncompacted_count: 0,
    last_fragment: null,
    last_compacted_at: null,
    last_processed_fragment: null,
    processed_count: 0,
    updated_at: null,
  });

  const cursor = state.last_processed_fragment;
  const unprocessed = cursor ? files.filter((f) => f > cursor) : files;
  const newest = files.length > 0 ? files[files.length - 1] : cursor;

  // --- dry-run: 何が起きるか表示するだけ ---
  if (DRY_RUN) {
    console.log('(DRY-RUN) 実行内容のプレビュー:');
    console.log('  処理済みにする fragment 数: ' + unprocessed.length);
    console.log('  archive 移動: ' + (NO_ARCHIVE ? 'なし(--no-archive)' : unprocessed.length + '件'));
    console.log('  カーソル更新先: ' + (newest || '(なし)'));
    console.log('  uncompacted_count → 0 / needs_compaction → false');
    return;
  }

  // --- 書き込み順序の方針 ---
  // 先に state/queue を確定・書き込みし、最後に archive 移動を行う。
  // こうすると、archive 移動が途中で失敗しても state は既に正しく、
  // 残った fragment は次回 capture の上限処理か再 mark で移動されるだけで
  // 整合が崩れない（「移動だけ済んで state 未更新」を避ける）。
  const nextState = Object.assign({}, state, {
    uncompacted_count: 0,
    last_processed_fragment: newest || null,
    processed_count: (state.processed_count || 0) + unprocessed.length,
    last_compacted_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2));
  } catch (e) {
    console.error('state.json の更新に失敗: ' + (e && e.message ? e.message : e));
    console.error('（archive 移動は行っていません。安全に中断しました）');
    process.exit(1);
  }

  const queue = readJsonSafe(QUEUE_PATH, {
    version: 1,
    needs_compaction: false,
    reason: null,
    updated_at: null,
  });
  queue.needs_compaction = false;
  queue.reason = null;
  queue.updated_at = now.toISOString();
  try {
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
  } catch (_) { /* queue 失敗は致命的でない */ }

  // --- 最後に archive 移動 ---
  let movedCount = 0;
  if (!NO_ARCHIVE && unprocessed.length > 0) {
    const ym =
      now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const destDir = path.join(ARCHIVE_DIR, ym);
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) {}
    for (const f of unprocessed) {
      try {
        fs.renameSync(path.join(FRAGMENTS_DIR, f), path.join(destDir, f));
        movedCount++;
      } catch (_) { /* 個別失敗は無視。state は既に正しい */ }
    }
  }

  console.log('メモリ整理を完了としてマークしました。');
  console.log('  処理済みにした fragment 数: ' + unprocessed.length);
  if (!NO_ARCHIVE) {
    console.log('  archive へ移動した数: ' + movedCount);
    if (movedCount < unprocessed.length) {
      console.log('  （一部移動できなかったファイルは次回再試行されます）');
    }
  } else {
    console.log('  （--no-archive: 移動はせずカーソルのみ更新）');
  }
  console.log('  uncompacted_count: 0 / needs_compaction: false');
}

try {
  main();
} catch (e) {
  console.error('予期しないエラー: ' + (e && e.message ? e.message : e));
  process.exit(1);
}
`;

// --- memory-search.py (Tier2 全文検索) --------------------------------------
const TPL_MEMORY_SEARCH = String.raw`#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
memory-search.py  —  永続メモリの「深掘り（Tier2）」検索ツール

位置づけ:
  Tier1（memory-session-start.js）が handoff.md / project-state.md の要約を
  起動時に常時注入する「通常メモリ」。本ツールはその先、過去の生ログ
  （fragment / archive）を検索して掘るための retrieval 層。

検索方式（2段構え）:
  - 既定: FTS5(trigram) キーワード検索。標準ライブラリのみ・追加依存ゼロ・sbx でも動く。
  - 任意（オプション層）: 埋め込みベクトルによる「意味検索」。曖昧/言い換えに強い。
      MEMORY_EMBED_PROVIDER を設定した人だけ有効。未設定なら自動で FTS5 にフォールバック。
      埋め込み源は urllib（標準ライブラリ）で叩くため、本体に外部 pip 依存は無い。

意味検索の有効化（例: Ollama + Ruri large＝日本語強・日本製・Apache-2.0）:
  ollama pull <Ruri の Ollama タグ>             # 例: kun432/cl-nagoya-ruri-large
  export MEMORY_EMBED_PROVIDER=ollama
  export MEMORY_EMBED_MODEL=<上で pull したタグ>
  python3 .claude/hooks/memory-search.py --reindex   # 埋め込みを構築
  python3 .claude/hooks/memory-search.py "曖昧な質問でも意味で探す"

環境変数:
  MEMORY_EMBED_PROVIDER   ''(既定/無効) | ollama | openai
  MEMORY_EMBED_MODEL      埋め込みモデル名（既定: kun432/cl-nagoya-ruri-large）
  OLLAMA_URL              Ollama のベースURL（既定: http://localhost:11434）
  MEMORY_EMBED_URL        OpenAI互換エンドポイント（provider=openai 時の完全URL）
  MEMORY_EMBED_KEY        APIキー（provider=openai 時。env からのみ参照・出力しない）
  MEMORY_EMBED_QUERY_PREFIX / MEMORY_EMBED_DOC_PREFIX  プレフィックス上書き（任意）

使い方（プロジェクトルートで実行）:
  python3 .claude/hooks/memory-search.py "検索語"
  python3 .claude/hooks/memory-search.py "install-security" --role user --limit 5
  python3 .claude/hooks/memory-search.py --reindex          # 索引（＋埋め込み）の再構築

オプション:
  query                検索語（省略時は索引統計のみ表示）
  --reindex/--rebuild  索引を作り直して終了（埋め込みも更新）
  --limit N            最大表示件数（既定 10）
  --role ROLE          user / assistant などで絞り込み
  --since YYYY-MM-DD    その日以降に絞り込み
  --no-archive         archive を検索対象から除外
  --no-reindex         検索前の自動再構築をしない
  --keyword            FTS5 キーワード検索を強制
  --semantic           意味検索を強制（埋め込み未構築なら FTS5 へフォールバック）
  --hybrid             キーワード＋意味のハイブリッド（既定: 意味検索が使える時）
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys

# メモリ保存先は共有リゾルバで解決する（project/global/sbx自動判定）。
# memory_paths はこのスクリプトと同じディレクトリにあるため、確実に import できるよう
# スクリプト自身のディレクトリを sys.path 先頭に挿入する。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memory_paths


def _resolve_memory_dir():
    try:
        start = os.getcwd()
    except Exception:
        start = "."
    return memory_paths.resolve_memory_dir(start)[1]


MEMORY_DIR = _resolve_memory_dir()
FRAGMENTS_DIR = os.path.join(MEMORY_DIR, "fragments")
ARCHIVE_DIR = os.path.join(MEMORY_DIR, "archive")
DB_PATH = os.path.join(MEMORY_DIR, "index.sqlite")

# --- 埋め込み（オプション層）の設定。未設定なら意味検索は無効＝FTS5 のみ ---
EMBED_PROVIDER = os.environ.get("MEMORY_EMBED_PROVIDER", "").strip().lower()
EMBED_MODEL = os.environ.get("MEMORY_EMBED_MODEL", "kun432/cl-nagoya-ruri-large").strip()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OPENAI_URL = os.environ.get("MEMORY_EMBED_URL", "").strip()
OPENAI_KEY = os.environ.get("MEMORY_EMBED_KEY", "").strip()
EMBED_DEBUG = bool(os.environ.get("MEMORY_EMBED_DEBUG"))
# 埋め込みモデルの最大トークン長対策（Ruri/BERT系は512トークン上限）。
# 長文をそのまま投げると "input length exceeds the context length" で 400/500 になる。
# 実測: Ruri large は先頭300字なら確実に収まる（日本語はトークン密度が高い）。
# ※先頭N字のみ埋め込む簡易策。長文後半まで意味検索に乗せるには将来チャンク分割で拡張。
EMBED_MAX_CHARS = int(os.environ.get("MEMORY_EMBED_MAX_CHARS", "300"))
# チャンク分割: 長文を複数ウィンドウに割って各々を埋め込み、検索時は最良チャンクで代表。
# 先頭だけ埋め込む簡易策より、話題が後半にある長文も拾える（精度向上）。
CHUNK_CHARS = int(os.environ.get("MEMORY_EMBED_CHUNK_CHARS", str(EMBED_MAX_CHARS)))
CHUNK_OVERLAP = int(os.environ.get("MEMORY_EMBED_CHUNK_OVERLAP", "50"))
EMBED_MAX_CHUNKS = int(os.environ.get("MEMORY_EMBED_MAX_CHUNKS", "6"))
# 短すぎる発言（相づち「はい」「OK」等）は意味検索のノイズ源（“ハブ”化）になるため、
# この文字数未満は埋め込み対象外にする（FTS5 キーワード検索では従来どおり引ける）。
EMBED_MIN_CHARS = int(os.environ.get("MEMORY_EMBED_MIN_CHARS", "24"))


def _dbg(msg):
    """MEMORY_EMBED_DEBUG=1 のとき診断メッセージを stderr に出す（秘密は出さない）。"""
    if EMBED_DEBUG:
        print("[embed-debug] " + str(msg), file=sys.stderr)


def _err_detail(e):
    """HTTPError 等から、サーバが返したエラー本文を安全に取り出す（診断用）。"""
    try:
        body = e.read().decode("utf-8", "replace")
        return " body=" + body[:400]
    except Exception:
        return ""


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


# ===========================================================================
# プレフィックス（モデルごとに最適な接頭辞が異なる）
# ===========================================================================
def resolve_prefixes(model):
    """モデル名から (query_prefix, doc_prefix) を推定。env で上書き可。"""
    m = (model or "").lower()
    if "ruri" in m:
        # Ollama 入手可能な Ruri は v1 系(kun432/cl-nagoya-ruri-*)＝接頭辞は クエリ:/文章:
        # （Ruri v3 を使う場合は env で 検索クエリ:/検索文書: に上書きすること）
        qp, dp = "クエリ: ", "文章: "
    elif "e5" in m:
        qp, dp = "query: ", "passage: "                # multilingual-e5
    elif "nomic" in m:
        qp, dp = "search_query: ", "search_document: " # nomic-embed-text
    elif "arctic" in m:
        qp, dp = "query: ", ""                          # snowflake-arctic (query側のみ)
    else:
        qp, dp = "", ""                                  # bge-m3 等は接頭辞不要
    # env による明示上書き（空文字も尊重する）
    env_qp = os.environ.get("MEMORY_EMBED_QUERY_PREFIX")
    env_dp = os.environ.get("MEMORY_EMBED_DOC_PREFIX")
    if env_qp is not None:
        qp = env_qp
    if env_dp is not None:
        dp = env_dp
    return qp, dp


# ===========================================================================
# 埋め込み生成（urllib のみ＝追加依存なし）。失敗時は None を返し、呼び出し側が FTS5 へ落ちる。
# ===========================================================================
def _http_json(url, payload, headers=None, timeout=120):
    import urllib.request
    data = json.dumps(payload).encode("utf-8")
    hdr = {"Content-Type": "application/json"}
    if headers:
        hdr.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdr, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def embed_texts(texts):
    """texts のベクトル配列を返す。失敗・無効時は None。"""
    if not EMBED_PROVIDER or not texts:
        return None
    if EMBED_PROVIDER == "mock":
        # テスト用の決定的な擬似ベクトル（文字頻度・64次元）。Ollama 不要で検索経路を検証する。
        out = []
        for t in texts:
            v = [0.0] * 64
            for ch in str(t):
                v[ord(ch) % 64] += 1.0
            out.append(v)
        return out
    if EMBED_PROVIDER == "ollama":
        # 新しい Ollama: /api/embed（バッチ input 可）
        try:
            res = _http_json(OLLAMA_URL + "/api/embed", {"model": EMBED_MODEL, "input": texts, "truncate": True})
            embs = res.get("embeddings")
            if embs and len(embs) == len(texts):
                return embs
            _dbg("/api/embed 応答が想定外: " + (json.dumps(res)[:300] if isinstance(res, dict) else str(res)[:300]))
        except Exception as e:
            _dbg("/api/embed 失敗: " + repr(e) + _err_detail(e))
        # 旧 Ollama: /api/embeddings（1件ずつ prompt）
        out = []
        for t in texts:
            try:
                res = _http_json(OLLAMA_URL + "/api/embeddings", {"model": EMBED_MODEL, "prompt": t})
                e = res.get("embedding")
                if not e:
                    _dbg("/api/embeddings 応答に embedding 無し: " + (json.dumps(res)[:300] if isinstance(res, dict) else str(res)[:300]))
                    return None
                out.append(e)
            except Exception as e:
                _dbg("/api/embeddings 失敗: " + repr(e) + _err_detail(e))
                return None
        return out
    if EMBED_PROVIDER == "openai":
        if not OPENAI_URL:
            return None
        headers = {"Authorization": "Bearer " + OPENAI_KEY} if OPENAI_KEY else None
        try:
            res = _http_json(OPENAI_URL, {"model": EMBED_MODEL, "input": texts}, headers=headers)
            data = res.get("data")
            if data and len(data) == len(texts):
                return [d.get("embedding") for d in data]
        except Exception:
            return None
        return None
    return None


def cosine_rank(qvec, items):
    """items[(file, vec)]（1ファイル複数チャンク可）を、各 file の最良チャンク
    コサイン類似度で降順に並べた file 配列で返す（max プーリング）。numpy があれば高速化。"""
    best = {}
    try:
        import numpy as np
        q = np.asarray(qvec, dtype="float32")
        qn = float(np.linalg.norm(q)) + 1e-9
        for file, v in items:
            a = np.asarray(v, dtype="float32")
            s = float(np.dot(q, a)) / ((float(np.linalg.norm(a)) + 1e-9) * qn)
            if file not in best or s > best[file]:
                best[file] = s
    except ImportError:
        import math
        qn = math.sqrt(sum(c * c for c in qvec)) + 1e-9
        for file, v in items:
            dot = sum(a * b for a, b in zip(qvec, v))
            vn = math.sqrt(sum(c * c for c in v)) + 1e-9
            s = dot / (vn * qn)
            if file not in best or s > best[file]:
                best[file] = s
    return sorted(best.keys(), key=lambda f: -best[f])


# ===========================================================================
# 索引（fragment/archive 列挙・読み込み・FTS5/LIKE 構築）
# ===========================================================================
def fts5_available(con):
    try:
        con.execute("CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(x)")
        con.execute("DROP TABLE temp._fts5_probe")
        return True
    except sqlite3.OperationalError:
        return False


def iter_fragment_files(include_archive=True):
    files = []
    if os.path.isdir(FRAGMENTS_DIR):
        for name in os.listdir(FRAGMENTS_DIR):
            if name.endswith(".json"):
                files.append(os.path.join(FRAGMENTS_DIR, name))
    if include_archive and os.path.isdir(ARCHIVE_DIR):
        for root, _dirs, names in os.walk(ARCHIVE_DIR):
            for name in names:
                if name.endswith(".json"):
                    files.append(os.path.join(root, name))
    return sorted(files)


def load_fragment(path):
    """fragment JSON を読み、(file_label, ts, role, session, content, embed_src, blobs) を返す。
    embed_src は意味検索の埋め込み元（text 優先・無ければ content）。
    blobs は [(kind, content), ...]。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            j = json.load(f)
    except Exception:
        return None
    label = os.path.relpath(path, MEMORY_DIR)
    content = str(j.get("content", ""))
    text = j.get("text")
    embed_src = str(text) if isinstance(text, str) and text.strip() else content
    blobs = []
    raw_blobs = j.get("blobs")
    if isinstance(raw_blobs, list):
        for b in raw_blobs:
            if isinstance(b, dict):
                blobs.append((str(b.get("kind", "blob")), str(b.get("content", ""))))
    return (label, str(j.get("ts", "")), str(j.get("role", "")),
            str(j.get("session_id", "")), content, embed_src, blobs)


def parse_structured(text, source, kind):
    """構造化メモリ(decisions/bugs)を ## 日付 ブロック単位で解析する。
    HTMLコメント(雛形/mhマーカー)は先に除去。戻り値 [(id, source, kind, ts, content), ...]。"""
    t = re.sub(r"<!--[\s\S]*?-->", "", text or "")
    items = []
    blocks = re.split(r"(?m)^##\s+", t)
    for b in blocks[1:]:  # 先頭(ヘッダ前文)は捨てる
        b = b.strip()
        if not b:
            continue
        lines = b.split("\n")
        ts = lines[0].strip()
        body = "\n".join(lines[1:]).strip()
        content = body if body else ts
        did = source + "#" + hashlib.sha1(content.encode("utf-8")).hexdigest()[:12]
        items.append((did, source, kind, ts, content))
    return items


def build_docs(con):
    """decisions.md / bugs-and-fixes.md を解析して docs テーブルを作り直す。件数を返す。"""
    con.execute("DROP TABLE IF EXISTS docs")
    con.execute("CREATE TABLE docs(id TEXT PRIMARY KEY, source TEXT, kind TEXT, ts TEXT, content TEXT)")
    n = 0
    for src_file, kind in (("decisions.md", "decision"), ("bugs-and-fixes.md", "bug")):
        p = os.path.join(MEMORY_DIR, src_file)
        try:
            with open(p, "r", encoding="utf-8") as f:
                txt = f.read()
        except Exception:
            continue
        for item in parse_structured(txt, src_file, kind):
            con.execute(
                "INSERT OR REPLACE INTO docs(id, source, kind, ts, content) VALUES (?, ?, ?, ?, ?)",
                item)
            n += 1
    return n


def build_index(con, use_fts, include_archive=True):
    """fragment/archive を走査して FTS5/LIKE 索引と blobs テーブルを作り直す。件数を返す。"""
    con.execute("DROP TABLE IF EXISTS frag")
    con.execute("DROP TABLE IF EXISTS blobs")
    if use_fts:
        # trigram トークナイザ: 3文字以上なら日本語含む部分一致が可能
        con.execute(
            "CREATE VIRTUAL TABLE frag USING fts5("
            "file UNINDEXED, ts UNINDEXED, role UNINDEXED, session UNINDEXED, "
            "content, embed_src UNINDEXED, "
            "tokenize='trigram')"
        )
    else:
        con.execute(
            "CREATE TABLE frag(file TEXT, ts TEXT, role TEXT, session TEXT, "
            "content TEXT, embed_src TEXT)"
        )
    con.execute("CREATE TABLE blobs(file TEXT, idx INTEGER, kind TEXT, content TEXT)")
    frag_rows = []
    blob_rows = []
    for path in iter_fragment_files(include_archive):
        rec = load_fragment(path)
        if rec is None:
            continue
        label, ts, role, session, content, embed_src, blobs = rec
        frag_rows.append((label, ts, role, session, content, embed_src))
        for i, (kind, bcontent) in enumerate(blobs):
            blob_rows.append((label, i, kind, bcontent))
    con.executemany(
        "INSERT INTO frag(file, ts, role, session, content, embed_src) "
        "VALUES (?, ?, ?, ?, ?, ?)", frag_rows
    )
    con.executemany(
        "INSERT INTO blobs(file, idx, kind, content) VALUES (?, ?, ?, ?)", blob_rows
    )
    build_docs(con)
    con.commit()
    return len(frag_rows)


def chunk_text(text):
    """テキストを CHUNK_CHARS のウィンドウに分割（オーバーラップ付き・最大 EMBED_MAX_CHUNKS）。
    空白は畳んで密度を上げる。"""
    t = " ".join((text or "").split())
    if not t:
        return []
    step = max(1, CHUNK_CHARS - CHUNK_OVERLAP)
    chunks = []
    pos = 0
    while pos < len(t) and len(chunks) < EMBED_MAX_CHUNKS:
        chunks.append(t[pos:pos + CHUNK_CHARS])
        pos += step
    return chunks


def build_embeddings(con):
    """frag を元に、未作成/変更分の埋め込みを（チャンク分割して）構築する。
    戻り値 (files, chunks, failed)。provider 無効なら (0,0,False)。"""
    if not EMBED_PROVIDER:
        return (0, 0, False)
    # スキーマ（チャンク対応）。旧スキーマ(chunk列なし)なら作り直す。
    cols = [r[1] for r in con.execute("PRAGMA table_info(embeddings)")]
    if cols and "chunk" not in cols:
        con.execute("DROP TABLE embeddings")
    con.execute(
        "CREATE TABLE IF NOT EXISTS embeddings("
        "file TEXT, chunk INTEGER, model TEXT, sha TEXT, dim INTEGER, vec TEXT, "
        "PRIMARY KEY(file, chunk))"
    )
    # docs に無い id の埋め込みは掃除（意味検索の対象は構造化メモリ docs。項目の更新/削除で id が変わるため）
    con.execute("DELETE FROM embeddings WHERE file NOT IN (SELECT id FROM docs)")
    # file 単位の既存 (model, sha)
    have = {}
    for file, model, sha in con.execute(
        "SELECT file, model, sha FROM embeddings GROUP BY file"
    ):
        have[file] = (model, sha)
    _qp, dp = resolve_prefixes(EMBED_MODEL)
    # 再埋め込みが必要な file のチャンクを平坦化
    flat = []  # (file, chunk_idx, text, sha)
    redo_files = []
    short_files = []
    for file, embed_src in con.execute("SELECT id, content FROM docs"):
        collapsed = " ".join((embed_src or "").split())
        if len(collapsed) < EMBED_MIN_CHARS:
            # 短すぎる/コード除去後に空になった発言は意味検索の対象外（FTS5では引ける）
            short_files.append(file)
            continue
        sha = hashlib.sha1((embed_src or "").encode("utf-8")).hexdigest()
        prev = have.get(file)
        if prev and prev[0] == EMBED_MODEL and prev[1] == sha:
            continue
        redo_files.append(file)
        for ci, ch in enumerate(chunk_text(embed_src or "")):
            flat.append((file, ci, ch, sha))
    # 短文 file の既存埋め込みを除去（しきい値変更や過去データの掃除）
    for file in short_files:
        con.execute("DELETE FROM embeddings WHERE file = ?", (file,))
    # 旧チャンクを削除してから入れ直す（チャンク数が変わるため）
    for file in redo_files:
        con.execute("DELETE FROM embeddings WHERE file = ?", (file,))
    chunks_done = 0
    failed = False
    BATCH = 16
    for i in range(0, len(flat), BATCH):
        batch = flat[i:i + BATCH]
        vecs = embed_texts([dp + text for (_f, _ci, text, _s) in batch])
        if vecs is None:
            failed = True
            break
        for (file, ci, _text, sha), v in zip(batch, vecs):
            con.execute(
                "INSERT OR REPLACE INTO embeddings(file, chunk, model, sha, dim, vec) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (file, ci, EMBED_MODEL, sha, len(v), json.dumps(v)),
            )
            chunks_done += 1
    con.commit()
    return (len(redo_files), chunks_done, failed)


def load_doc_embeddings(con, allowed):
    """現モデルの埋め込みを (file, vec) で返す。allowed が None でなければ file で絞る。"""
    try:
        rows = con.execute(
            "SELECT file, vec FROM embeddings WHERE model = ?", (EMBED_MODEL,)
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    out = []
    for file, vec in rows:
        if allowed is not None and file not in allowed:
            continue
        try:
            out.append((file, json.loads(vec)))
        except Exception:
            continue
    return out


# ===========================================================================
# 表示ヘルパ
# ===========================================================================
def make_snippet(content, query, width=60):
    flat = " ".join(content.split())
    if not query:
        return flat[: width * 2]
    low = flat.lower()
    pos = low.find(query.lower())
    if pos < 0:
        return flat[: width * 2]
    start = max(0, pos - width // 2)
    end = min(len(flat), pos + len(query) + width)
    pre = "…" if start > 0 else ""
    post = "…" if end < len(flat) else ""
    seg = flat[start:end]
    seg_low = seg.lower()
    qp = seg_low.find(query.lower())
    if qp >= 0:
        seg = seg[:qp] + "«" + seg[qp:qp + len(query)] + "»" + seg[qp + len(query):]
    return pre + seg + post


def fmt_ts(ts):
    if len(ts) >= 16 and ts[10] in ("T", " "):
        return ts[0:10] + " " + ts[11:16]
    return ts


# ===========================================================================
# 検索（FTS5 / LIKE / 意味 / ハイブリッド）
# ===========================================================================
def fts_files(con, query, role, since, limit):
    """FTS5 で file のランキング配列を返す。"""
    where = ["frag MATCH ?"]
    params = [query]
    if role:
        where.append("role = ?")
        params.append(role)
    if since:
        where.append("ts >= ?")
        params.append(since)
    sql = ("SELECT file FROM frag WHERE " + " AND ".join(where) +
           " ORDER BY rank LIMIT ?")
    params.append(limit)
    try:
        rows = con.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        params[0] = '"' + query.replace('"', "") + '"'
        rows = con.execute(sql, params).fetchall()
    return [r[0] for r in rows]


def like_files(con, query, role, since, limit):
    where = ["content LIKE ?"]
    params = ["%" + query + "%"]
    if role:
        where.append("role = ?")
        params.append(role)
    if since:
        where.append("ts >= ?")
        params.append(since)
    sql = ("SELECT file FROM frag WHERE " + " AND ".join(where) +
           " ORDER BY ts DESC LIMIT ?")
    params.append(limit)
    return [r[0] for r in con.execute(sql, params).fetchall()]


def allowed_file_set(con, role, since):
    """role/since の絞り込みに合致する file 集合（意味検索の事前フィルタ用）。"""
    if not role and not since:
        return None
    where = []
    params = []
    if role:
        where.append("role = ?")
        params.append(role)
    if since:
        where.append("ts >= ?")
        params.append(since)
    sql = "SELECT file FROM frag WHERE " + " AND ".join(where)
    return set(r[0] for r in con.execute(sql, params).fetchall())


def rrf_fuse(rank_lists, k=60):
    """Reciprocal Rank Fusion で複数ランキングを融合し file 配列を返す。"""
    scores = {}
    for rl in rank_lists:
        for rank, file in enumerate(rl):
            scores[file] = scores.get(file, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.keys(), key=lambda f: -scores[f])


def file_meta_map(con):
    """file -> (ts, role, content) を構築（表示用）。"""
    meta = {}
    for file, ts, role, content in con.execute(
        "SELECT file, ts, role, content FROM frag"
    ):
        meta[file] = (ts, role, content)
    return meta


def docs_meta_map(con):
    """id -> (ts, kind, content)（構造化アイテム表示用）。"""
    meta = {}
    try:
        for did, ts, kind, content in con.execute("SELECT id, ts, kind, content FROM docs"):
            meta[did] = (ts, kind, content)
    except sqlite3.OperationalError:
        pass
    return meta


def main():
    parser = argparse.ArgumentParser(add_help=True, description="永続メモリ検索 (Tier2)")
    parser.add_argument("query", nargs="?", default=None, help="検索語")
    parser.add_argument("--reindex", "--rebuild", dest="reindex", action="store_true",
                        help="索引（＋埋め込み）を再構築して終了")
    parser.add_argument("--limit", type=int, default=10, help="最大表示件数（既定10）")
    parser.add_argument("--role", default=None, help="role で絞り込み（user/assistant 等）")
    parser.add_argument("--since", default=None, help="YYYY-MM-DD 以降に絞り込み")
    parser.add_argument("--no-archive", dest="archive", action="store_false",
                        help="archive を対象外にする")
    parser.add_argument("--no-reindex", dest="auto_reindex", action="store_false",
                        help="検索前の自動再構築をしない")
    parser.add_argument("--keyword", dest="force_keyword", action="store_true",
                        help="FTS5 キーワード検索を強制")
    parser.add_argument("--semantic", dest="force_semantic", action="store_true",
                        help="意味検索を強制")
    parser.add_argument("--hybrid", dest="force_hybrid", action="store_true",
                        help="キーワード＋意味のハイブリッド")
    args = parser.parse_args()

    if not os.path.isdir(MEMORY_DIR):
        die(".claude/memory が見つかりません。プロジェクトルートで実行してください。\n"
            "現在の作業ディレクトリ: " + os.getcwd())

    con = sqlite3.connect(DB_PATH)
    use_fts = fts5_available(con)
    kw_label = "FTS5" if use_fts else "LIKE"
    embed_on = bool(EMBED_PROVIDER)

    # --- 索引構築（--reindex 指定時、または検索時の自動再構築）---
    if args.reindex or (args.query is not None and args.auto_reindex):
        n = build_index(con, use_fts, include_archive=args.archive)
        emb_msg = ""
        if embed_on:
            files_n, chunks_n, failed = build_embeddings(con)
            if failed:
                emb_msg = "  埋め込み: 失敗（{}が未起動/未導入の可能性→FTS5にフォールバック）".format(EMBED_PROVIDER)
            else:
                emb_msg = "  埋め込み: {}ファイル/{}チャンク（model={}）".format(files_n, chunks_n, EMBED_MODEL)
        if args.reindex:
            print("索引を再構築しました: {}件  DB: {}  方式: {}{}".format(n, DB_PATH, kw_label, emb_msg))
            return

    # --- クエリ無し → 統計のみ ---
    if args.query is None:
        try:
            n = con.execute("SELECT COUNT(*) FROM frag").fetchone()[0]
        except sqlite3.OperationalError:
            n = 0
        emb_n = 0
        if embed_on:
            try:
                emb_n = con.execute(
                    "SELECT COUNT(*) FROM embeddings WHERE model = ?", (EMBED_MODEL,)
                ).fetchone()[0]
            except sqlite3.OperationalError:
                emb_n = 0
        prov = EMBED_PROVIDER if embed_on else "なし(FTS5のみ)"
        print("索引: {}件 / 埋め込みチャンク: {}件  DB: {}  キーワード方式: {}  意味検索: {}".format(
            n, emb_n, DB_PATH, kw_label, prov))
        print("使い方: python3 .claude/hooks/memory-search.py \"検索語\" [--role user] [--since YYYY-MM-DD] [--limit N] [--semantic|--keyword|--hybrid]")
        return

    q = args.query.strip()

    # --- 検索モードの決定 ---
    # 意味検索が実際に使えるか（provider設定 かつ 現モデルの埋め込みが存在）
    semantic_ready = False
    if embed_on and not args.force_keyword:
        try:
            cnt = con.execute(
                "SELECT COUNT(*) FROM embeddings WHERE model = ?", (EMBED_MODEL,)
            ).fetchone()[0]
            semantic_ready = cnt > 0
        except sqlite3.OperationalError:
            semantic_ready = False

    if args.force_keyword:
        mode = "keyword"
    elif args.force_semantic:
        mode = "semantic" if semantic_ready else "keyword"
    elif args.force_hybrid:
        mode = "hybrid" if semantic_ready else "keyword"
    else:
        mode = "hybrid" if semantic_ready else "keyword"

    # --- キーワード側のランキング ---
    kw_rank = []
    if mode in ("keyword", "hybrid"):
        if use_fts and len(q) < 3:
            if mode == "keyword":
                print("FTS5(trigram) は3文字以上の語が必要です。3文字以上で検索するか、--semantic をご利用ください。")
                return
            # hybrid のときは keyword をスキップして semantic のみ
        else:
            cand = max(args.limit * 3, args.limit)
            kw_rank = fts_files(con, q, args.role, args.since, cand) if use_fts \
                else like_files(con, q, args.role, args.since, cand)

    # --- 意味検索側のランキング ---
    sem_rank = []
    if mode in ("semantic", "hybrid") and semantic_ready:
        qp, _dp = resolve_prefixes(EMBED_MODEL)
        qv = embed_texts([qp + q[:EMBED_MAX_CHARS]])
        if qv is None:
            # クエリ埋め込み失敗 → キーワードへ
            if mode == "semantic":
                print("意味検索のクエリ埋め込みに失敗しました（{}未起動?）。FTS5 にフォールバックします。".format(EMBED_PROVIDER))
                mode = "keyword"
                if not kw_rank and not (use_fts and len(q) < 3):
                    kw_rank = fts_files(con, q, args.role, args.since, args.limit) if use_fts \
                        else like_files(con, q, args.role, args.since, args.limit)
        else:
            # 意味検索の対象は構造化メモリ(docs)。role/since フィルタは適用しない。
            items = load_doc_embeddings(con, None)
            sem_rank = cosine_rank(qv[0], items)[: max(args.limit * 3, args.limit)]

    # --- 融合して最終ランキング ---
    if mode == "hybrid":
        kw_typed = ["frag:" + f for f in kw_rank]
        sem_typed = ["doc:" + d for d in sem_rank]
        final = rrf_fuse([r for r in (kw_typed, sem_typed) if r])
        mode_label = "ハイブリッド(FTS生ログ+意味:構造化)"
    elif mode == "semantic":
        final = ["doc:" + d for d in sem_rank]
        mode_label = "意味検索:構造化メモリ({}:{})".format(EMBED_PROVIDER, EMBED_MODEL)
    else:
        final = ["frag:" + f for f in kw_rank]
        mode_label = kw_label

    final = final[: args.limit]

    print("検索: \"{}\"  ヒット {}件（方式: {}）".format(args.query, len(final), mode_label))
    if not final:
        print("該当なし。語を変える・--no-archive を外す・--since を緩める・--semantic を試すなど。")
        return
    frag_meta = file_meta_map(con)
    docs_meta = docs_meta_map(con)
    for i, tid in enumerate(final, 1):
        if tid.startswith("doc:"):
            did = tid[4:]
            ts, kind, content = docs_meta.get(did, ("", "", ""))
            snip = make_snippet(content, q)
            print("")
            print("[{}] {} [構造化:{}]  {}".format(i, fmt_ts(ts), kind, did))
            print("    " + " ".join(str(snip).split()))
        else:
            f = tid[5:] if tid.startswith("frag:") else tid
            ts, role_, content = frag_meta.get(f, ("", "", ""))
            snip = make_snippet(content, q)
            print("")
            print("[{}] {} [{}]  {}".format(i, fmt_ts(ts), role_, f))
            print("    " + " ".join(str(snip).split()))


if __name__ == "__main__":
    main()
`;

// --- memory-remember.js (構造化メモリ追記) ---
const TPL_REMEMBER = String.raw`#!/usr/bin/env node
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
`;
// --- memory-distill.js (蒸留digest) ---
const TPL_DISTILL = String.raw`#!/usr/bin/env node
'use strict';
// memory-distill.js: 未処理の会話断片を「会話テキストのみ」(Phase1b の text)で一覧表示し、
// 蒸留(構造化メモリ化)の手順を案内する。注入ドリブン蒸留A の補助ツール。node で起動。
// node .claude/hooks/memory-distill.js
// ※ String.raw 配布埋め込みのためバッククォートと dollar-brace は使わない。

const fs = require('fs');
const path = require('path');
const { resolveMemoryDir } = require('./memory-paths.js');

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

function main() {
  let startDir = '.';
  try { startDir = process.cwd(); } catch (_) {}
  const memDir = resolveMemoryDir(startDir).dir;
  const fragmentsDir = path.join(memDir, 'fragments');
  const state = readJsonSafe(path.join(memDir, 'state.json'), {});
  const cursor = state && state.last_processed_fragment;

  let files = [];
  try {
    files = fs.readdirSync(fragmentsDir).filter(function (f) { return f.endsWith('.json'); }).sort();
  } catch (_) { files = []; }
  const unprocessed = cursor ? files.filter(function (f) { return f > cursor; }) : files;

  if (unprocessed.length === 0) {
    console.log('未処理の会話断片はありません。');
    return;
  }

  console.log('=== 未処理の会話断片 ' + unprocessed.length + ' 件（会話テキストのみ・コード/ログ除外済み） ===');
  for (const name of unprocessed) {
    const j = readJsonSafe(path.join(fragmentsDir, name), null);
    if (!j) continue;
    const txt = (typeof j.text === 'string' && j.text.trim()) ? j.text : (j.content || '');
    if (!String(txt).trim()) continue;
    console.log('\n--- [' + (j.role || '?') + '] ' + (j.ts || '') + ' ---');
    console.log(String(txt).trim());
  }

  console.log('\n=== 蒸留の指示 ===');
  console.log('上記から「確定した決定」「解決したバグ」「重要な状態変化」だけを抽出（推測/未確定は書かない・秘密はマスク）。');
  console.log('決定: node .claude/hooks/memory-remember.js decision --decision "..." [--reason "..."] [--scope "..."] [--review "..."]');
  console.log('バグ: node .claude/hooks/memory-remember.js bug --symptom "..." [--cause "..."] [--fix "..."] [--prevention "..."] [--files "..."]');
  console.log('横断知識(環境の罠/ツールの使い方/好み)も決定として記録。現状/次/注意は handoff.md、恒久情報は project-state.md に反映。');
  console.log('最後に node .claude/hooks/memory-mark-processed.js でループを閉じる。');
}

main();
`;

// --- state.json -------------------------------------------------------------
const TPL_STATE = JSON.stringify(
  {
    version: 1,
    uncompacted_count: 0,
    last_fragment: null,
    last_compacted_at: null,
    last_processed_fragment: null,
    processed_count: 0,
    updated_at: null,
  },
  null,
  2
) + '\n';

// --- queue.json -------------------------------------------------------------
const TPL_QUEUE = JSON.stringify(
  {
    version: 1,
    needs_compaction: false,
    reason: null,
    updated_at: null,
  },
  null,
  2
) + '\n';

// --- Markdown テンプレート ---------------------------------------------------
const TPL_PROJECT_STATE = `# プロジェクト状態 (project-state.md)

> Claude Code 永続メモリー。SessionStart 時に参照・更新されます。

## 現在のプロジェクト状態
（未記入）

## 現在の作業ブランチ
（未記入）

## 主要な起動方法
（未記入）

## 現在の未解決課題
（未記入）

## 次に確認すべきこと
（未記入）
`;

const TPL_DECISIONS = `# 意思決定ログ (decisions.md)

> 重要な技術的・設計的判断を時系列で記録します。

<!--
## YYYY-MM-DD
- 決定内容:
- 理由:
- 影響範囲:
- 後から見直す条件:
-->
`;

const TPL_BUGS = `# バグと修正の記録 (bugs-and-fixes.md)

> 発生した不具合と対処を記録し、再発を防ぎます。

<!--
## YYYY-MM-DD
- 症状:
- 原因:
- 修正内容:
- 再発防止策:
- 関連ファイル:
-->
`;

const TPL_HANDOFF = `# 引き継ぎメモ (handoff.md)

> 次回 Claude Code 起動時に最初に読むべき要約。

## 現在どこまで進んだか
（未記入）

## 次にやること
（未記入）

## 注意点
（未記入）

## 未処理fragmentの有無
（未記入）
`;

// ===========================================================================
// .gitignore 処理
// ===========================================================================

// Claude memory 用の必須エントリ（既存/新規どちらでも必ず入れたい行）
const GITIGNORE_CLAUDE_ENTRIES = [
  '.claude/settings.local.json',
  '.claude/memory/fragments/',
  '.claude/memory/archive/',
  '.claude/memory/state.json',
  '.claude/memory/queue.json',
  '.claude/memory/hook-errors.log',
  '.claude/memory/index.sqlite',
  '.claude/memory/index.sqlite-wal',
  '.claude/memory/index.sqlite-shm',
  '.claude.backup-*/',
];

// 新規作成時に書く汎用テンプレート（Node + PHP/Laravel + エディタ + OS）
const GITIGNORE_NEW_TEMPLATE = `# Dependencies
node_modules/
vendor/

# Environment
.env
.env.local
.env.*.local

# Logs
*.log
logs/

# Build / cache
dist/
build/
.cache/
tmp/

# PHP / Laravel
composer.phar

# Editor / IDE
.vscode/
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Claude Code local hooks / memory runtime files
${GITIGNORE_CLAUDE_ENTRIES.join('\n')}
`;

/**
 * 既存 .gitignore の行を正規化して集合化（重複判定用）。
 * 末尾スラッシュや前後空白の揺れを吸収する。
 */
function normalizeIgnoreLine(line) {
  return line.trim().replace(/\/+$/, '');
}

/**
 * .gitignore を処理する。
 *   - 無ければ新規作成（汎用テンプレート）。
 *   - あれば不足している Claude memory エントリだけ末尾にブロック追記。
 *   - --no-gitignore 指定時は提案表示のみ。
 *   - 既存ファイルを変更する場合は、変更前にバックアップを取る。
 */
function handleGitignore() {
  const giPath = path.join(PROJECT_ROOT, '.gitignore');
  const exists = fs.existsSync(giPath);

  // 提案のみモード
  if (NO_GITIGNORE) {
    console.log('\n--- .gitignore 追記の提案（--no-gitignore のため自動追記しません）---');
    console.log(
      ['# Claude Code local hooks / memory runtime files', ...GITIGNORE_CLAUDE_ENTRIES]
        .map((l) => '  ' + l)
        .join('\n')
    );
    return;
  }

  // 新規作成
  if (!exists) {
    if (DRY_RUN) {
      console.log('\n[.gitignore] (would create) 新規作成し汎用テンプレートを書き込みます');
      return;
    }
    fs.writeFileSync(giPath, GITIGNORE_NEW_TEMPLATE, 'utf8');
    results.created.push('.gitignore');
    console.log('\n[.gitignore] 新規作成しました（汎用テンプレート + Claude memory）');
    return;
  }

  // 既存あり → 不足分のみ追記
  let raw;
  try {
    raw = fs.readFileSync(giPath, 'utf8');
  } catch (e) {
    results.errors.push('.gitignore を読めませんでした: ' + (e && e.message ? e.message : e));
    return;
  }

  const existingSet = new Set(
    raw.split('\n').map(normalizeIgnoreLine).filter(Boolean)
  );
  const missing = GITIGNORE_CLAUDE_ENTRIES.filter(
    (entry) => !existingSet.has(normalizeIgnoreLine(entry))
  );

  if (missing.length === 0) {
    console.log('\n[.gitignore] Claude memory 関連は既に記載済みです（変更なし）');
    return;
  }

  if (DRY_RUN) {
    console.log('\n[.gitignore] (would append) 不足エントリを追記します:');
    missing.forEach((m) => console.log('  + ' + m));
    return;
  }

  // 既存ファイルを変更する前にバックアップ
  if (!NO_BACKUP) {
    try {
      const giBackup = giPath + '.backup-' + backupStamp(new Date());
      fs.copyFileSync(giPath, giBackup);
      console.log('\n[.gitignore] 変更前にバックアップ: ' + path.basename(giBackup));
    } catch (e) {
      console.log('\n[.gitignore] バックアップに失敗（追記は続行）: ' + (e && e.message ? e.message : e));
    }
  }

  // 末尾が改行で終わっていなければ改行を足してからブロック追記
  const needsNL = raw.length > 0 && !raw.endsWith('\n');
  const block =
    (needsNL ? '\n' : '') +
    '\n# Claude Code local hooks / memory runtime files\n' +
    missing.join('\n') +
    '\n';
  fs.appendFileSync(giPath, block, 'utf8');
  results.merged.push('.gitignore');
  console.log('\n[.gitignore] 不足エントリを追記しました:');
  missing.forEach((m) => console.log('  + ' + m));
}

// ===========================================================================
// 展開処理
// ===========================================================================
// ---------------------------------------------------------------------------
// ベクトル意味検索（オプション）の Ollama セットアップ
//   - 既定(FTS5)は不変。利用者が「使う」と答えた時だけ動く。
//   - OS検出: mac/Win は確認後にパッケージマネージャ実行、Linux は案内のみ。
//   - curl|bash は使わない。sbx/非対話では自動実行しない（案内のみ）。
// ---------------------------------------------------------------------------
const { execSync } = require('child_process');
const RURI_OLLAMA_TAG = 'kun432/cl-nagoya-ruri-large';

function commandExists(cmd) {
  try {
    const probe = process.platform === 'win32' ? ('where ' + cmd) : ('command -v ' + cmd);
    execSync(probe, { stdio: 'ignore', shell: true });
    return true;
  } catch (_) {
    return false;
  }
}

function runShown(cmd) {
  console.log('  実行: ' + cmd);
  if (DRY_RUN) { console.log('  (DRY-RUN) 実行しません'); return true; }
  try {
    execSync(cmd, { stdio: 'inherit', shell: true });
    return true;
  } catch (e) {
    console.log('  失敗: ' + (e && e.message ? e.message : e));
    return false;
  }
}

function printOllamaManual() {
  const plat = process.platform;
  console.log('  Ollama 導入手順:');
  if (plat === 'darwin') {
    console.log('    - Homebrew: brew install ollama');
    console.log('    - または: https://ollama.com/download （macOS アプリ）');
  } else if (plat === 'win32') {
    console.log('    - winget: winget install --id Ollama.Ollama -e');
    console.log('    - または: https://ollama.com/download （OllamaSetup.exe）');
  } else {
    console.log('    - 公式ページ: https://ollama.com/download');
    console.log('    - 公式スクリプト(自己責任): curl -fsSL https://ollama.com/install.sh | sh');
    console.log('      ※本インストーラは安全のため自動実行しません。内容確認の上ご自身で。');
  }
}

function printModelAndEnvGuidance() {
  console.log('');
  console.log('  --- 意味検索を有効化する手順 ---');
  console.log('  1) 埋め込みモデル取得（日本語最強・日本製・Apache-2.0 の Ruri large 推奨）:');
  console.log('       ollama pull ' + RURI_OLLAMA_TAG + '   ※正確なタグは ollama.com で確認');
  console.log('  2) 環境変数を設定（~/.zshrc 等に手動で追記）:');
  console.log('       export MEMORY_EMBED_PROVIDER=ollama');
  console.log('       export MEMORY_EMBED_MODEL=' + RURI_OLLAMA_TAG);
  console.log('  3) 索引に埋め込みを構築:');
  console.log('       python3 .claude/hooks/memory-search.py --reindex');
  console.log('  ※ Ollama は localhost:11434 のデーモン。sbx から届かない場合は自動で FTS5 に');
  console.log('     フォールバックします（母艦で reindex 推奨）。');
}

async function offerOllamaInstall() {
  const plat = process.platform;
  if (plat === 'darwin' && commandExists('brew')) {
    const ok = await askYesNo('  Ollama が未導入です。brew install ollama を実行しますか？ [y/N]: ');
    if (ok) { runShown('brew install ollama'); return; }
    printOllamaManual(); return;
  }
  if (plat === 'win32' && commandExists('winget')) {
    const ok = await askYesNo('  Ollama が未導入です。winget install Ollama.Ollama を実行しますか？ [y/N]: ');
    if (ok) { runShown('winget install --id Ollama.Ollama -e'); return; }
    printOllamaManual(); return;
  }
  console.log('  自動導入に対応しない環境です（Linux、または brew/winget 無し）。手順を表示します。');
  printOllamaManual();
}

async function maybeSetupEmbeddings() {
  if (NO_EMBEDDINGS) return;
  let want = false;
  if (WITH_EMBEDDINGS) {
    want = true;
  } else if (DRY_RUN) {
    console.log('\n[ベクトル意味検索] (DRY-RUN) 本番では要否を尋ね、必要なら OS別に Ollama 導入を案内します。');
    return;
  } else if (!isInteractive()) {
    console.log('\n[ベクトル意味検索] 非対話環境のため自動セットアップはしません（FTS5 で動作）。');
    printModelAndEnvGuidance();
    return;
  } else {
    console.log('');
    want = await askYesNo('ベクトル「意味検索」（曖昧/言い換えに強い・オプション）を使いますか？ 埋め込みに Ollama 等が必要です [y/N]: ');
  }
  if (!want) {
    console.log('意味検索は使いません（既定の FTS5 キーワード検索で動作します）。');
    return;
  }
  if (commandExists('ollama')) {
    console.log('Ollama: 既にインストールされています。');
  } else if (!isInteractive()) {
    console.log('Ollama: 未導入です（非対話のため自動実行なし）。');
    printOllamaManual();
  } else {
    await offerOllamaInstall();
  }
  printModelAndEnvGuidance();
}

async function run() {
  console.log('');
  console.log('Claude Code 永続メモリー機構インストーラ');
  console.log('対象プロジェクト: ' + PROJECT_ROOT);
  if (DRY_RUN) console.log('*** DRY-RUN モード（実際には書き込みません）***');
  console.log('');

  // 既存 .claude/ があればバックアップ（対話 or 自動）
  await maybeBackup();

  // ディレクトリ作成
  ensureDir(CLAUDE_DIR);
  ensureDir(path.join(CLAUDE_DIR, 'hooks'));
  ensureDir(path.join(CLAUDE_DIR, 'memory'));
  ensureDir(path.join(CLAUDE_DIR, 'memory', 'fragments'));
  ensureDir(path.join(CLAUDE_DIR, 'memory', 'archive'));
  ensureDir(path.join(CLAUDE_DIR, 'memory', 'summaries'));

  // ファイル単位で不足分のみ作成
  const M = path.join(CLAUDE_DIR, 'memory');
  writeHook(path.join(CLAUDE_DIR, 'hooks', 'memory-paths.js'), TPL_PATHS_JS);
  writeHook(path.join(CLAUDE_DIR, 'hooks', 'memory_paths.py'), TPL_PATHS_PY);
  writeHook(path.join(CLAUDE_DIR, 'hooks', 'memory-blob.js'), TPL_BLOB_JS);
  writeHook(path.join(CLAUDE_DIR, 'hooks', 'memory-capture.js'), TPL_CAPTURE);
  writeHook(path.join(CLAUDE_DIR, 'hooks', 'memory-session-start.js'), TPL_SESSION_START);
  writeHook(path.join(CLAUDE_DIR, 'hooks', 'memory-mark-processed.js'), TPL_MARK_PROCESSED);
  writeHook(path.join(CLAUDE_DIR, 'hooks', 'memory-search.py'), TPL_MEMORY_SEARCH);
  writeHook(path.join(CLAUDE_DIR, 'hooks', 'memory-remember.js'), TPL_REMEMBER);
  writeHook(path.join(CLAUDE_DIR, 'hooks', 'memory-distill.js'), TPL_DISTILL);
  writeIfMissing(path.join(M, 'state.json'), TPL_STATE);
  writeIfMissing(path.join(M, 'queue.json'), TPL_QUEUE);
  writeIfMissing(path.join(M, 'project-state.md'), TPL_PROJECT_STATE);
  writeIfMissing(path.join(M, 'decisions.md'), TPL_DECISIONS);
  writeIfMissing(path.join(M, 'bugs-and-fixes.md'), TPL_BUGS);
  writeIfMissing(path.join(M, 'handoff.md'), TPL_HANDOFF);

  // hooks スクリプトに実行権限を付与（dry-run以外）
  if (!DRY_RUN) {
    for (const h of ['memory-capture.js', 'memory-session-start.js', 'memory-mark-processed.js']) {
      const p = path.join(CLAUDE_DIR, 'hooks', h);
      try {
        if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
      } catch (_) {}
    }
  }

  // settings.local.json は特別扱い（マージ）
  mergeSettingsLocal(
    path.join(CLAUDE_DIR, 'settings.local.json'),
    DESIRED_HOOKS
  );

  // --- 結果表示 ---
  console.log('--- 結果 ---');
  if (results.dirs.length) {
    console.log('\n[ディレクトリ]');
    results.dirs.forEach((d) => console.log('  + ' + d));
  }
  if (results.created.length) {
    console.log('\n[作成 / created]');
    results.created.forEach((f) => console.log('  + ' + f));
  }
  if (results.merged.length) {
    console.log('\n[マージ / merged]');
    results.merged.forEach((f) => console.log('  ~ ' + f));
  }
  if (results.updated.length) {
    console.log('\n[更新 / updated]');
    results.updated.forEach((f) => console.log('  * ' + f));
  }
  if (results.skipped.length) {
    console.log('\n[既に存在 / skipped]');
    results.skipped.forEach((f) => console.log('  = ' + f + ' は既に存在します'));
  }
  if (results.errors.length) {
    console.log('\n[要確認 / errors]');
    results.errors.forEach((e) => console.log('  ! ' + e));
  }

  // .gitignore の自動処理（新規作成 or 不足分追記）
  handleGitignore();

  await maybeSetupEmbeddings();

  console.log('\n完了しました。' + (DRY_RUN ? '（DRY-RUN）' : ''));
  console.log('');
}

run().catch((e) => {
  console.error('予期しないエラー: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
