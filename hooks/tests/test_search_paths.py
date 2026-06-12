import os, sys, json, tempfile, subprocess, unittest
HOOKS = os.path.join(os.path.dirname(__file__), "..")


class TestSearchPaths(unittest.TestCase):
    def test_reindex_uses_project_scope(self):
        root = tempfile.mkdtemp()
        os.mkdir(os.path.join(root, ".git"))
        frag = os.path.join(root, ".claude", "memory", "fragments")
        os.makedirs(frag)
        with open(os.path.join(frag, "20260101-000000-user-aaaaaa.json"), "w", encoding="utf-8") as f:
            json.dump({"ts": "2026-01-01T00:00:00Z", "role": "user", "content": "永続メモリの設計について話した"}, f)
        env = dict(os.environ, MEMORY_SCOPE="project")
        out = subprocess.run(
            [sys.executable, os.path.join(HOOKS, "memory-search.py"), "--reindex"],
            cwd=root, env=env, capture_output=True, text=True)
        self.assertIn("索引を再構築", out.stdout)
        self.assertTrue(os.path.exists(os.path.join(root, ".claude", "memory", "index.sqlite")))

    def test_reindex_from_subdir_resolves_project_root(self):
        # サブディレクトリから実行しても、上方探索でプロジェクトルートの
        # .claude/memory に索引が作られることを確認（リゾルバ配線の回帰テスト）。
        root = tempfile.mkdtemp()
        os.mkdir(os.path.join(root, ".git"))
        frag = os.path.join(root, ".claude", "memory", "fragments")
        os.makedirs(frag)
        with open(os.path.join(frag, "20260101-000000-user-bbbbbb.json"), "w", encoding="utf-8") as f:
            json.dump({"ts": "2026-01-01T00:00:00Z", "role": "user", "content": "上方探索のテスト用データ"}, f)
        subdir = os.path.join(root, "a", "b")
        os.makedirs(subdir)
        env = dict(os.environ, MEMORY_SCOPE="project")
        out = subprocess.run(
            [sys.executable, os.path.join(HOOKS, "memory-search.py"), "--reindex"],
            cwd=subdir, env=env, capture_output=True, text=True)
        self.assertIn("索引を再構築", out.stdout)
        # 索引はプロジェクトルート直下に作られる
        self.assertTrue(os.path.exists(os.path.join(root, ".claude", "memory", "index.sqlite")))
        # サブディレクトリ側には .claude/memory を作らない
        self.assertFalse(os.path.exists(os.path.join(subdir, ".claude", "memory", "index.sqlite")))
