"""Exercise the exact Python payload used by FileFlows."""
import contextlib
import errno
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).parents[1] / 'Scripts/Shared/SafeFileReplace.js'
PAYLOAD = SOURCE.read_text().split('return String.raw`', 1)[1].split('`;', 1)[0]
replace = types.ModuleType('safe_replace')
exec(compile(PAYLOAD, str(SOURCE), 'exec'), replace.__dict__)


class ReplacementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runner = self.root / 'Runner'
        self.runner.mkdir()
        self.media = self.root / 'media'
        self.media.mkdir()
        self.source = self.runner / 'encoded.mkv'
        self.original = self.media / 'movie.mkv'
        self.source.write_bytes(b'encoded payload' * 100)
        self.original.write_bytes(b'original payload' * 100)
        self.recovery = self.root / 'FileFlows-Recovery'
        self.log = io.StringIO()
        self.redirect = contextlib.redirect_stdout(self.log)
        self.redirect.__enter__()
        self.addCleanup(self.redirect.__exit__, None, None, None)

    def run_replace(self):
        return replace.replace_file(self.source, self.original, self.recovery, self.runner)

    def recovered(self):
        return list(self.recovery.glob('*/encoded.mkv'))

    def test_success_keeps_dates_and_permissions_and_clears_recovery(self):
        os.chmod(self.original, 0o640)
        os.utime(self.original, (1000000000, 1000000001))
        result = self.run_replace()
        self.assertEqual(self.original.read_bytes(), self.source.read_bytes())
        self.assertEqual(self.original.stat().st_mtime, 1000000001)
        self.assertEqual(self.original.stat().st_mode & 0o777, 0o640)
        self.assertEqual(result['bytes'], self.source.stat().st_size)
        self.assertEqual(list(self.recovery.iterdir()), [])
        self.assertEqual(list(self.media.iterdir()), [self.original])

    def test_read_only_replace_keeps_both_files_after_runner_cleanup(self):
        real_replace = os.replace
        def deny(src, dst):
            if Path(dst) == self.original:
                raise OSError(errno.EROFS, 'Read-only file system')
            return real_replace(src, dst)
        with patch.object(replace.os, 'replace', side_effect=deny), self.assertRaises(OSError):
            self.run_replace()
        self.assertEqual(self.original.read_bytes(), b'original payload' * 100)
        shutil.rmtree(self.runner)
        self.assertEqual(self.recovered()[0].read_bytes(), b'encoded payload' * 100)
        self.assertEqual(len(list(self.media.glob('.fforiginal-*.bak'))), 1)
        manifest = json.loads(next(self.recovery.glob('*/manifest.json')).read_text())
        self.assertEqual(manifest['state'], 'failed')

    def test_no_space_copy_keeps_original_and_encoded_recovery(self):
        with patch.object(replace, 'checked_copy', side_effect=OSError(errno.ENOSPC, 'No space left')), self.assertRaises(OSError):
            self.run_replace()
        self.assertEqual(self.original.read_bytes(), b'original payload' * 100)
        shutil.rmtree(self.runner)
        self.assertEqual(self.recovered()[0].read_bytes(), b'encoded payload' * 100)

    def test_checksum_mismatch_never_replaces_original(self):
        with patch.object(replace, 'digest', return_value='bad'), self.assertRaisesRegex(OSError, 'checksum mismatch'):
            self.run_replace()
        self.assertEqual(self.original.read_bytes(), b'original payload' * 100)
        self.assertTrue(self.recovered()[0].exists())
        self.assertFalse(list(self.media.glob('.ffreplace-*')))

    def test_interrupted_copy_keeps_original_and_encoded_after_runner_cleanup(self):
        with patch.object(replace, 'checked_copy', side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            self.run_replace()
        shutil.rmtree(self.runner)
        self.assertEqual(self.original.read_bytes(), b'original payload' * 100)
        self.assertEqual(self.recovered()[0].read_bytes(), b'encoded payload' * 100)

    def test_original_change_during_copy_stops_commit(self):
        copy = replace.checked_copy
        def change(src, dst):
            result = copy(src, dst)
            self.original.write_bytes(b'new external original')
            return result
        with patch.object(replace, 'checked_copy', side_effect=change), self.assertRaisesRegex(OSError, 'Original changed'):
            self.run_replace()
        self.assertEqual(self.original.read_bytes(), b'new external original')
        self.assertTrue(self.recovered()[0].exists())

    def test_source_change_during_copy_stops_commit(self):
        copy = replace.checked_copy
        def change(src, dst):
            result = copy(src, dst)
            self.source.write_bytes(b'changed source')
            return result
        with patch.object(replace, 'checked_copy', side_effect=change), self.assertRaisesRegex(OSError, 'Encoded source changed'):
            self.run_replace()
        self.assertEqual(self.original.read_bytes(), b'original payload' * 100)

    def test_cross_device_recovery_uses_checked_copy(self):
        link = os.link
        def cross_device(src, dst):
            if Path(dst).name == 'encoded.mkv':
                raise OSError(errno.EXDEV, 'Invalid cross-device link')
            return link(src, dst)
        with patch.object(replace.os, 'link', side_effect=cross_device):
            self.run_replace()
        self.assertEqual(self.original.read_bytes(), self.source.read_bytes())

    def test_recovery_inside_runner_is_rejected(self):
        self.recovery = self.runner / 'recovery'
        with self.assertRaisesRegex(ValueError, 'outside the runner'):
            self.run_replace()
        self.assertEqual(self.original.read_bytes(), b'original payload' * 100)

    def test_empty_and_symlink_inputs_are_rejected(self):
        self.source.write_bytes(b'')
        with self.assertRaisesRegex(ValueError, 'empty'):
            self.run_replace()
        self.source.unlink()
        self.source.symlink_to(self.original)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            self.run_replace()

    def test_missing_original_keeps_encoded_for_recovery(self):
        self.original.unlink()
        with self.assertRaises(FileNotFoundError):
            self.run_replace()
        self.assertTrue(self.recovered()[0].exists())

    def test_extension_change_publishes_output_before_removing_original(self):
        self.original = self.original.rename(self.media / 'movie.avi')
        result = self.run_replace()
        self.assertFalse(self.original.exists())
        self.assertEqual(Path(result['destination']).read_bytes(), self.source.read_bytes())

    def test_extension_change_does_not_overwrite_an_existing_output(self):
        self.original = self.original.rename(self.media / 'movie.avi')
        destination = self.media / 'movie.mkv'
        destination.write_bytes(b'existing movie')
        with self.assertRaises(FileExistsError):
            self.run_replace()
        self.assertEqual(destination.read_bytes(), b'existing movie')
        self.assertEqual(self.original.read_bytes(), b'original payload' * 100)

    def test_failure_after_commit_keeps_old_and_new_recovery_files(self):
        sync = replace.sync_directory
        def fail_after_commit(path):
            if Path(path) == self.media and self.original.read_bytes().startswith(b'encoded'):
                raise OSError(errno.EIO, 'sync failed')
            return sync(path)
        with patch.object(replace, 'sync_directory', side_effect=fail_after_commit), self.assertRaises(OSError):
            self.run_replace()
        self.assertEqual(self.original.read_bytes(), b'encoded payload' * 100)
        self.assertEqual(next(self.media.glob('.fforiginal-*.bak')).read_bytes(), b'original payload' * 100)
        self.assertTrue(self.recovered()[0].exists())


if __name__ == '__main__':
    unittest.main()
