# memory_paths.py: メモリ保存先のスコープ・パス解決モジュール（Python版）
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
