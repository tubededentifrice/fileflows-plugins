#!/usr/bin/env python3
"""Measure QSV size, speed, and encoding loss on short video extracts."""
import argparse
import json
from pathlib import Path
import subprocess
import time


def run(args):
    started = time.monotonic()
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:])
    return result.stdout, time.monotonic() - started


def probe(binary, path):
    out, _ = run([binary, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])
    return json.loads(out)


def metric(binary, distorted, reference, log):
    # The log path is made from the controlled output directory and file names.
    escaped = str(log).replace('\\', '/').replace(':', '\\:').replace("'", "\\'")
    graph = ('[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];'
             f'[d][r]libvmaf=n_threads=4:n_subsample=2:shortest=1:eof_action=endall:log_fmt=json:log_path=\'{escaped}\'')
    run([binary, '-v', 'error', '-i', distorted, '-i', reference, '-filter_complex', graph, '-f', 'null', '-'])
    data = json.loads(log.read_text())
    scores = sorted(f['metrics']['vmaf'] for f in data['frames'])
    if not scores:
        raise RuntimeError('No metric frames')
    return {'mean': sum(scores) / len(scores), 'p10': scores[int(len(scores) * 0.1)], 'frames': len(scores)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('--output', required=True, help='New directory for extracts and results')
    parser.add_argument('--starts', type=float, nargs='+', default=[30])
    parser.add_argument('--duration', type=float, default=12)
    parser.add_argument('--denoise', type=int, nargs='+', default=[0, 30, 50])
    parser.add_argument('--quality', type=int, nargs='+', default=[14, 18])
    parser.add_argument('--ffmpeg', default='/usr/local/bin/ffmpeg')
    parser.add_argument('--ffprobe', default='ffprobe')
    parser.add_argument('--metric-ffmpeg', default='/app/common/ffmpeg-static/ffmpeg')
    parser.add_argument('--device', default='qsv=gpu', help='FFmpeg QSV device specification, named gpu')
    parser.add_argument('--preset', default='veryslow')
    parser.add_argument('--crop', help='QSV crop options, for example cw=1920:ch=1024:cx=0:cy=28')
    parser.add_argument('--field-mode', choices=['source', 'progressive', 'deinterlace'], default='source')
    parser.add_argument('--compare-denoise', action='store_true', help='Measure denoise change against the zero-denoise reference')
    parser.add_argument('--software-decode', action='store_true', help='Use software decode and upload, as in Auto Quality')
    args = parser.parse_args()
    if args.duration <= 0 or any(x < 0 for x in args.starts):
        parser.error('Use a positive duration and non-negative start times')
    if any(not 0 <= x <= 100 for x in args.denoise) or any(not 1 <= x <= 51 for x in args.quality):
        parser.error('Use denoise 0–100 and quality 1–51')
    if args.compare_denoise and 0 not in args.denoise:
        parser.error('Denoise comparison requires level zero')
    args.denoise = sorted(set(args.denoise))
    source = Path(args.source).resolve(strict=True)
    root = Path(args.output).resolve()
    root.mkdir(mode=0o700, parents=True)  # Refuse an existing directory.
    report = {'source': str(source), 'settings': vars(args), 'samples': [], 'results': []}
    for index, start in enumerate(args.starts):
        clip = root / f'sample{index}.mkv'
        run([args.ffmpeg, '-v', 'error', '-n', '-ss', start, '-i', source, '-t', args.duration,
             '-map', '0:v:0', '-c:v', 'copy', '-an', '-sn', '-map_metadata', '-1', '-map_chapters', '-1', clip])
        info = probe(args.ffprobe, clip)
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        native = 'p010le' if '10' in video['pix_fmt'] else 'nv12'
        report['samples'].append({'index': index, 'start': start, 'probe': info})
        references = {}
        for denoise in args.denoise:
            prefix = 'setfield=prog,' if args.field_mode == 'progressive' else ''
            if args.software_decode:
                prefix += f'format={native},hwupload=extra_hw_frames=64,'
            if args.field_mode == 'deinterlace':
                prefix += 'deinterlace_qsv=mode=advanced,'
            vf = prefix + f'vpp_qsv=denoise={denoise}:format={native}'
            if args.crop:
                vf += ',vpp_qsv=' + args.crop + ':format=' + native
            if native == 'nv12':
                vf += ',scale_qsv=format=p010le'
            for quality in sorted(set([1] + args.quality)):
                dst = root / f'sample{index}-d{denoise}-q{quality}.mkv'
                command = [args.ffmpeg, '-v', 'error', '-n', '-init_hw_device', args.device,
                           '-filter_hw_device', 'gpu']
                if not args.software_decode:
                    command += ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv']
                command += ['-i', clip, '-t', args.duration, '-vf', vf, '-c:v', 'hevc_qsv',
                           '-preset', args.preset, '-profile:v', 'main10', '-global_quality', quality,
                           '-extbrc', '1', '-look_ahead', '1', '-bf', '7', '-refs', '4', '-g', '120',
                           '-an', '-sn', '-map_metadata', '-1', dst]
                _, seconds = run(command)
                encoded = probe(args.ffprobe, dst)
                duration = float(encoded['format']['duration'])
                row = {'sample': index, 'denoise': denoise, 'quality': quality, 'bytes': dst.stat().st_size,
                       'encode_seconds': seconds, 'duration': duration, 'mib_per_hour': dst.stat().st_size / duration * 3600 / 1048576,
                       'filter': vf, 'command': [str(a) for a in command]}
                if quality == 1:
                    references[denoise] = dst
                    row['vmaf_identity'] = metric(args.metric_ffmpeg, dst, dst, root / f'{dst.stem}-identity.json')
                else:
                    row['vmaf_encoding'] = metric(args.metric_ffmpeg, dst, references[denoise], root / f'{dst.stem}-encoding.json')
                if quality == 1 and args.compare_denoise and denoise != 0:
                    row['vmaf_denoise'] = metric(args.metric_ffmpeg, dst, references[0], root / f'{dst.stem}-denoise.json')
                report['results'].append(row)
                (root / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
                print(json.dumps({k: v for k, v in row.items() if k != 'command'}), flush=True)


if __name__ == '__main__':
    main()
