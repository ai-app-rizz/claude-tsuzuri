import os, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import memory_paths as mp


class TestMemoryPaths(unittest.TestCase):
    def test_find_project_root(self):
        root = tempfile.mkdtemp()
        os.mkdir(os.path.join(root, ".git"))
        sub = os.path.join(root, "a", "b")
        os.makedirs(sub)
        self.assertEqual(mp.find_project_root(sub), os.path.realpath(root))

    def test_resolve_project_scope(self):
        root = tempfile.mkdtemp()
        os.mkdir(os.path.join(root, ".git"))
        scope, d, _ = mp.resolve_memory_dir(root, {"MEMORY_SCOPE": "project"})
        self.assertEqual(scope, "project")
        self.assertEqual(d, os.path.join(os.path.realpath(root), ".claude", "memory"))

    def test_project_id_stable(self):
        mem = os.path.join(tempfile.mkdtemp(), ".claude", "memory")
        id1 = mp.get_or_create_project_id(mem)
        id2 = mp.get_or_create_project_id(mem)
        self.assertTrue(id1.startswith("proj-"))
        self.assertEqual(id1, id2)


if __name__ == "__main__":
    unittest.main()
