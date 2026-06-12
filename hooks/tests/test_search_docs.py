import os, sys, json, sqlite3, tempfile, subprocess, unittest
HOOKS = os.path.join(os.path.dirname(__file__), "..")

DECISIONS = (
    "# 意思決定ログ (decisions.md)\n\n"
    "> 説明文。\n\n"
    "<!--\n## YYYY-MM-DD\n- 決定内容:\n- 理由:\n-->\n\n"
    "## 2026-06-01\n- 決定内容: メモリは global 既定にする\n- 理由: 横断知識の集約\n<!-- mh:aaaaaaaaaaaa -->\n\n"
    "## 2026-06-02\n- 決定内容: コード/ログ blob を分離する\n<!-- mh:bbbbbbbbbbbb -->\n"
)
BUGS = (
    "# バグと修正の記録 (bugs-and-fixes.md)\n\n"
    "<!--\n## YYYY-MM-DD\n- 症状:\n-->\n\n"
    "## 2026-06-01\n- 症状: uv_cwd EPERM\n- 修正内容: FDA 再付与\n<!-- mh:cccccccccccc -->\n"
)


class TestSearchDocs(unittest.TestCase):
    def _setup(self):
        root = tempfile.mkdtemp()
        os.mkdir(os.path.join(root, ".git"))
        mem = os.path.join(root, ".claude", "memory")
        os.makedirs(os.path.join(mem, "fragments"))
        with open(os.path.join(mem, "decisions.md"), "w", encoding="utf-8") as f:
            f.write(DECISIONS)
        with open(os.path.join(mem, "bugs-and-fixes.md"), "w", encoding="utf-8") as f:
            f.write(BUGS)
        return root, mem

    def _reindex(self, root, extra_env=None):
        env = dict(os.environ, MEMORY_SCOPE="project")
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            [sys.executable, os.path.join(HOOKS, "memory-search.py"), "--reindex"],
            cwd=root, env=env, capture_output=True, text=True)

    def test_docs_table_built_from_structured_files(self):
        root, mem = self._setup()
        self._reindex(root)
        con = sqlite3.connect(os.path.join(mem, "index.sqlite"))
        rows = con.execute("SELECT kind, ts, content FROM docs ORDER BY ts").fetchall()
        kinds = [r[0] for r in rows]
        self.assertEqual(kinds.count("decision"), 2)
        self.assertEqual(kinds.count("bug"), 1)
        joined = "\n".join(r[2] for r in rows)
        self.assertIn("メモリは global 既定にする", joined)
        self.assertIn("uv_cwd EPERM", joined)
        self.assertFalse(any("YYYY-MM-DD" in (r[1] + r[2]) for r in rows))
        con.close()


if __name__ == "__main__":
    unittest.main()
