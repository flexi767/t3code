import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('update_ui', Path(__file__).with_name('update-ui.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublishTests(unittest.TestCase):
    def test_updates_entry_and_preserves_old_chunks(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'source', Path(directory) / 'target'
            source.mkdir()
            target.mkdir()
            (target / 'old.js').write_text('old chunk')
            (target / 'index.html').write_text('old entry')
            (source / 'new.js').write_text('new chunk')
            (source / 'index.html').write_text('new entry')
            module.publish(source, target)
            self.assertEqual((target / 'index.html').read_text(), 'new entry')
            self.assertEqual((target / 'new.js').read_text(), 'new chunk')
            self.assertEqual((target / 'old.js').read_text(), 'old chunk')

    def test_invalid_build_leaves_current_entry_intact(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'source', Path(directory) / 'target'
            source.mkdir()
            target.mkdir()
            (target / 'index.html').write_text('current')
            with self.assertRaises(RuntimeError):
                module.publish(source, target)
            (source / 'index.html').write_text('new')
            (source / 'link.js').symlink_to(target / 'index.html')
            with self.assertRaises(RuntimeError):
                module.publish(source, target)
            self.assertEqual((target / 'index.html').read_text(), 'current')


if __name__ == '__main__':
    unittest.main()
