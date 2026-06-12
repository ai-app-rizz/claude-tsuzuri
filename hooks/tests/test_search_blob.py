import os, sys, json, sqlite3, tempfile, subprocess, unittest
HOOKS = os.path.join(os.path.dirname(__file__), "..")


def _write_fragment(frag_dir, name, obj):
    with open(os.path.join(frag_dir, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


class TestSearchBlob(unittest.TestCase):
    def _reindex(self, root):
        env = dict(os.environ, MEMORY_SCOPE="project")
        return subprocess.run(
            [sys.executable, os.path.join(HOOKS, "memory-search.py"), "--reindex"],
            cwd=root, env=env, capture_output=True, text=True)

    def test_embed_src_excludes_blob_and_blobs_table_populated(self):
        root = tempfile.mkdtemp()
        os.mkdir(os.path.join(root, ".git"))
        frag = os.path.join(root, ".claude", "memory", "fragments")
        os.makedirs(frag)
        _write_fragment(frag, "20260101-000000-user-aaaaaa.json", {
            "ts": "2026-01-01T00:00:00Z", "role": "user",
            "content": "このコードを直して。\n```js\nconst x = 1;\n```\nお願いします。",
            "text": "このコードを直して。\nお願いします。",
            "blobs": [{"kind": "code", "content": "```js\nconst x = 1;\n```"}],
        })
        out = self._reindex(root)
        self.assertIn("索引を再構築", out.stdout)
        db = os.path.join(root, ".claude", "memory", "index.sqlite")
        con = sqlite3.connect(db)
        es = con.execute("SELECT embed_src FROM frag").fetchone()[0]
        self.assertNotIn("const x = 1", es)
        self.assertIn("このコードを直して", es)
        ct = con.execute("SELECT content FROM frag").fetchone()[0]
        self.assertIn("const x = 1", ct)
        rows = con.execute("SELECT kind, content FROM blobs").fetchall()
        self.assertTrue(any(k == "code" and "const x = 1" in c for (k, c) in rows))
        con.close()

    def test_old_fragment_without_text_falls_back_to_content(self):
        root = tempfile.mkdtemp()
        os.mkdir(os.path.join(root, ".git"))
        frag = os.path.join(root, ".claude", "memory", "fragments")
        os.makedirs(frag)
        _write_fragment(frag, "20260101-000000-user-bbbbbb.json", {
            "ts": "2026-01-01T00:00:00Z", "role": "user",
            "content": "古い形式の発言データです。",
        })
        self._reindex(root)
        db = os.path.join(root, ".claude", "memory", "index.sqlite")
        con = sqlite3.connect(db)
        es = con.execute("SELECT embed_src FROM frag").fetchone()[0]
        self.assertEqual(es, "古い形式の発言データです。")
        n = con.execute("SELECT COUNT(*) FROM blobs").fetchone()[0]
        self.assertEqual(n, 0)
        con.close()


if __name__ == "__main__":
    unittest.main()
