import os, sys, sqlite3, tempfile, subprocess, unittest
HOOKS = os.path.join(os.path.dirname(__file__), "..")

DECISIONS = (
    "# 意思決定ログ\n\n<!--\n## YYYY-MM-DD\n- 決定内容:\n-->\n\n"
    "## 2026-06-01\n- 決定内容: メモリは global 既定にする\n- 理由: 横断知識の集約\n<!-- mh:aaaaaaaaaaaa -->\n"
)


class TestEmbedDocs(unittest.TestCase):
    def test_embeddings_are_built_over_docs_with_mock_provider(self):
        root = tempfile.mkdtemp()
        os.mkdir(os.path.join(root, ".git"))
        mem = os.path.join(root, ".claude", "memory")
        os.makedirs(os.path.join(mem, "fragments"))
        with open(os.path.join(mem, "fragments", "20260101-000000-user-aaaaaa.json"), "w", encoding="utf-8") as f:
            f.write('{"ts":"t","role":"user","content":"これは生ログの会話です","text":"これは生ログの会話です"}')
        with open(os.path.join(mem, "decisions.md"), "w", encoding="utf-8") as f:
            f.write(DECISIONS)
        env = dict(os.environ, MEMORY_SCOPE="project", MEMORY_EMBED_PROVIDER="mock")
        out = subprocess.run(
            [sys.executable, os.path.join(HOOKS, "memory-search.py"), "--reindex"],
            cwd=root, env=env, capture_output=True, text=True)
        self.assertIn("索引を再構築", out.stdout)
        con = sqlite3.connect(os.path.join(mem, "index.sqlite"))
        files = [r[0] for r in con.execute("SELECT DISTINCT file FROM embeddings").fetchall()]
        self.assertTrue(len(files) > 0, "embeddings should be built; stderr=" + out.stderr)
        self.assertTrue(all(f.startswith("decisions.md#") for f in files),
                        "embeddings must target docs, got: " + str(files))
        con.close()


if __name__ == "__main__":
    unittest.main()
