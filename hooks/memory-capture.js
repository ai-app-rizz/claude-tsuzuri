#!/usr/bin/env node
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
