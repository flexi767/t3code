import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("fleet", Path(__file__).with_name("rebuild-fleet.py"))
fleet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fleet)


class FleetRuntimeTests(unittest.TestCase):
    def test_only_exact_safe_versions_can_select_runtime_directories(self):
        for value in ["latest", "../other", "1.2.3", "1.2.3-preview.20261104.1/other"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                fleet.version(value)

    def test_marker_requires_the_actual_binary_to_match_and_keeps_old_runtime(self):
        ver = "1.2.3-preview.20261104.1"
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            old = home / ".t3/runtime/versions/previous"
            old.mkdir(parents=True)
            (old / "sentinel").write_text("keep")
            content = home / "archive-content"
            (content / "client").mkdir(parents=True)
            (content / "client/index.html").write_text("web")
            binary = content / "t3"
            binary.write_text("#!/bin/sh\necho 't3 v0.0.1'\n")
            binary.chmod(0o755)
            archive = home / "runtime.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(content, arcname="runtime")
            with patch.object(fleet.Path, "home", return_value=home):
                with self.assertRaisesRegex(RuntimeError, "version"):
                    fleet.stage(ver, archive)
                self.assertFalse((fleet.runtime(ver) / ".install-complete").exists())
                self.assertEqual((old / "sentinel").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
