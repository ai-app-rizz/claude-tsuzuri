import os, sys, tempfile, subprocess, unittest
HOOKS = os.path.join(os.path.dirname(__file__), "..")

DECISIONS = (
    "# 意思決定ログ\n\n<!--\n## YYYY-MM-DD\n- 決定内容:\n-->\n\n"
    "## 2026-06-01\n- 決定内容: メモリは global 既定にする\n- 理由: 横断知識の集約\n<!-- mh:aaaaaaaaaaaa -->\n\n"
    "## 2026-06-02\n- 決定内容: 漢字アプリのサービスワーカーを更新する\n<!-- mh:bbbbbbbbbbbb -->\n"
)


class TestRetarget(unittest.TestCase):
    def _setup(self):
        root = tempfile.mkdtemp()
        os.mkdir(os.path.join(root, ".git"))
        mem = os.path.join(root, ".claude", "memory")
        os.makedirs(os.path.join(mem, "fragments"))
        with open(os.path.join(mem, "fragments", "20260101-000000-user-aaaaaa.json"), "w", encoding="utf-8") as f:
            f.write('{"ts":"2026-01-01T00:00:00Z","role":"user","content":"特殊キーワードXYZ123 を含む生ログ","text":"特殊キーワードXYZ123 を含む生ログ"}')
        with open(os.path.join(mem, "decisions.md"), "w", encoding="utf-8") as f:
            f.write(DECISIONS)
        return root, mem

    def _run(self, root, args, mock=True):
        env = dict(os.environ, MEMORY_SCOPE="project")
        if mock:
            env["MEMORY_EMBED_PROVIDER"] = "mock"
        return subprocess.run(
            [sys.executable, os.path.join(HOOKS, "memory-search.py")] + args,
            cwd=root, env=env, capture_output=True, text=True)

    def test_semantic_returns_structured_item(self):
        root, mem = self._setup()
        self._run(root, ["--reindex"])
        out = self._run(root, ["メモリ global 既定", "--semantic"]).stdout
        self.assertIn("global 既定にする", out)
        self.assertIn("構造化", out)
        self.assertNotIn("特殊キーワードXYZ123", out)

    def test_keyword_returns_fragment(self):
        root, mem = self._setup()
        self._run(root, ["--reindex"])
        out = self._run(root, ["特殊キーワードXYZ123", "--keyword"]).stdout
        self.assertIn("特殊キーワードXYZ123", out)

    def test_hybrid_shows_structured(self):
        root, mem = self._setup()
        self._run(root, ["--reindex"])
        out = self._run(root, ["global メモリ 既定", "--hybrid"]).stdout
        self.assertIn("global 既定にする", out)

    def test_hybrid_renders_fragment_branch(self):
        # 生ログにもクエリ語(メモリ)を含め、hybrid で frag: 分岐
        # （5文字プレフィックスstrip→生ログ本文の描画）が機能することを検証する。
        root = tempfile.mkdtemp()
        os.mkdir(os.path.join(root, ".git"))
        mem = os.path.join(root, ".claude", "memory")
        os.makedirs(os.path.join(mem, "fragments"))
        with open(os.path.join(mem, "fragments", "20260103-000000-user-cccccc.json"), "w", encoding="utf-8") as f:
            f.write('{"ts":"2026-01-03T00:00:00Z","role":"user","content":"メモリの保存先について相談した記録ABC","text":"メモリの保存先について相談した記録ABC"}')
        with open(os.path.join(mem, "decisions.md"), "w", encoding="utf-8") as f:
            f.write(DECISIONS)
        self._run(root, ["--reindex"])
        out = self._run(root, ["メモリ", "--hybrid"]).stdout
        self.assertIn("global 既定にする", out)              # doc: 構造化
        self.assertIn("保存先について相談した記録ABC", out)   # frag: 生ログ本文（strip誤りなら欠落）


if __name__ == "__main__":
    unittest.main()
