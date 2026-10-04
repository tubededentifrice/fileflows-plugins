import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location('media_check', Path(__file__).parents[1] / 'Tools/media_check.py')
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)


class MediaTests(unittest.TestCase):
    def test_zero_exit_with_decode_error_is_recorded(self):
        result = media.run([sys.executable, '-c', "import sys; print('Lossless check failed', file=sys.stderr)"], 5)
        self.assertEqual(result['exit_code'], 0)
        self.assertEqual(result['diagnostic_lines'], 1)

    def test_driver_info_does_not_hide_real_errors(self):
        result = media.run([sys.executable, '-c',
            "import sys; print('libva info: opened', file=sys.stderr); print('libva error: failed', file=sys.stderr)"], 5)
        self.assertEqual(result['driver_info_lines'], 1)
        self.assertEqual(result['diagnostic_lines'], 1)
        self.assertIn('libva error', result['diagnostic_head'][0])

    def test_timeout_is_reported(self):
        result = media.run([sys.executable, '-c', 'import time; time.sleep(2)'], 0.05)
        self.assertTrue(result['timeout'])
        self.assertIsNone(result['exit_code'])

    def test_commands_select_exact_streams_and_do_not_write_media(self):
        args = media.decode_command('ffmpeg', '/a weird`$ file.mkv', [2, 5], 30, 8)
        self.assertEqual([args[i+1] for i, a in enumerate(args) if a == '-map'], ['0:2', '0:5'])
        self.assertEqual(args[-3:], ['-f', 'null', '-'])
        self.assertEqual(args[args.index('-threads')+1], '1')
        self.assertIn('crccheck', args)
        hw = media.decode_command('ffmpeg', '/movie.mkv', [0], qsv=True, native='p010le')
        self.assertIn('hwdownload,format=p010le', hw)

    def test_bad_limits_fail_before_file_access(self):
        for options in [{'duration': float('nan')}, {'timeout': 0}, {'starts': [-1]}, {'threads': 0}]:
            with self.assertRaises(ValueError):
                media.check('/missing', **options)


if __name__ == '__main__':
    unittest.main()
