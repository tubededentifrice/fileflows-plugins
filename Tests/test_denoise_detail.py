import importlib.util
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location('denoise_detail', Path(__file__).parents[1] / 'Tools/denoise_detail.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DetailTests(unittest.TestCase):
    def test_equal_flat_frames_have_no_change_or_high_frequency_signal(self):
        raw = struct.pack('<54H', *([128 * 64] * 54))
        row = module.frame_metrics(raw, raw, 6, 6)
        for plane in row['planes'].values():
            self.assertEqual(plane['changed_percent'], 0)
            self.assertEqual(plane['high_frequency_rms_10bit'], 0)

    def test_brightness_and_color_changes_are_separate(self):
        reference = struct.pack('<54H', *([0] * 54))
        raw = struct.pack('<54H', *([64] * 36 + [128] * 9 + [192] * 9))
        row = module.frame_metrics(raw, reference, 6, 6)
        for plane, expected in [('Y', 1), ('U', 2), ('V', 3)]:
            self.assertEqual(row['planes'][plane]['mean_abs_diff_10bit'], expected)
            self.assertEqual(row['planes'][plane]['changed_percent'], 100)
        self.assertNotEqual(row['sha256'], module.frame_metrics(reference, reference, 6, 6)['sha256'])

    def test_invalid_dimensions_and_truncated_frames_fail(self):
        with self.assertRaises(ValueError):
            module.frame_metrics(b'', b'', 5, 6)
        with self.assertRaises(ValueError):
            module.frame_metrics(b'', b'', 6, 6)
