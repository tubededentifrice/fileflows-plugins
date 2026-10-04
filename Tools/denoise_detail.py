#!/usr/bin/env python3
"""Compare native decoded frame detail against a high-quality reference."""
import argparse
import hashlib
import json
import math
import struct
import subprocess


def frame_metrics(raw, reference, width, height):
    if width < 6 or height < 6 or width % 2 or height % 2:
        raise ValueError('Use even dimensions of at least six pixels')
    expected = width * height * 3
    if len(raw) != expected or len(reference) != expected:
        raise ValueError('Decoded frame size differs from the requested crop')
    values = struct.unpack('<' + 'H' * (len(raw) // 2), raw)
    baseline = struct.unpack('<' + 'H' * (len(reference) // 2), reference)
    planes = {}
    offset = 0
    for name, w, h in [('Y', width, height), ('U', width // 2, height // 2), ('V', width // 2, height // 2)]:
        a = values[offset:offset + w * h]
        b = baseline[offset:offset + w * h]
        offset += w * h
        energy = 0
        for y in range(1, h - 1):
            for x in range(1, w - 1):
                k = y * w + x
                laplace = (4 * a[k] - a[k - 1] - a[k + 1] - a[k - w] - a[k + w]) / 64
                energy += laplace * laplace
        planes[name] = {
            'mean_abs_diff_10bit': sum(abs(x - y) for x, y in zip(a, b)) / (w * h) / 64,
            'changed_percent': sum(x != y for x, y in zip(a, b)) / (w * h) * 100,
            'high_frequency_rms_10bit': math.sqrt(energy / ((w - 2) * (h - 2)) / 20)
        }
    return {'sha256': hashlib.sha256(raw).hexdigest(), 'planes': planes}


def decode_frame(binary, path, second, width, height):
    graph = f'crop={width}:{height}:(iw-{width})/2:(ih-{height})/2,format=yuv420p16le'
    args = [binary, '-v', 'error', '-threads', '1', '-ss', str(second), '-i', path,
            '-vf', graph, '-frames:v', '1', '-f', 'rawvideo', '-']
    result = subprocess.run(args, capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace')[-2000:])
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, help='High-quality zero-denoise reference')
    parser.add_argument('--candidates', required=True, nargs='+', help='High-quality denoised references')
    parser.add_argument('--times', type=float, nargs='+', default=[1, 2, 3])
    parser.add_argument('--width', type=int, default=640)
    parser.add_argument('--height', type=int, default=360)
    parser.add_argument('--ffmpeg', default='/usr/local/bin/ffmpeg')
    args = parser.parse_args()
    if any(not math.isfinite(t) or t < 0 for t in args.times):
        parser.error('Use finite non-negative times')
    if args.width < 6 or args.height < 6 or args.width % 2 or args.height % 2:
        parser.error('Use even dimensions of at least six pixels')
    rows = []
    for second in args.times:
        reference = decode_frame(args.ffmpeg, args.reference, second, args.width, args.height)
        for path in [args.reference] + args.candidates:
            raw = reference if path == args.reference else decode_frame(args.ffmpeg, path, second, args.width, args.height)
            row = {'path': path, 'second': second, 'width': args.width, 'height': args.height}
            row.update(frame_metrics(raw, reference, args.width, args.height))
            rows.append(row)
    print(json.dumps(rows, indent=2))


if __name__ == '__main__':
    main()
