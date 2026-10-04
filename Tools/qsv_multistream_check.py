#!/usr/bin/env python3
"""Check QSV decoding with two generated video tracks. Run inside FileFlows."""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--ffmpeg', default='/usr/local/bin/ffmpeg')
    parser.add_argument('--ffprobe', default='/usr/local/bin/ffprobe')
    parser.add_argument('--device', default='/dev/dri/renderD128')
    args = parser.parse_args()
    directory = Path(args.output)
    directory.mkdir(parents=True, exist_ok=False)
    reports = []

    def run(name, command):
        result = subprocess.run(command, text=True, capture_output=True, timeout=120)
        (directory / (name + '.log')).write_text(result.stderr)
        return result

    def packets(path, stream):
        result = subprocess.run([args.ffprobe, '-v', 'error', '-select_streams', stream,
                                 '-show_packets', '-show_data_hash', 'sha256',
                                 '-show_entries', 'packet=data_hash', '-of', 'json', str(path)],
                                text=True, capture_output=True, check=True, timeout=30)
        return [p['data_hash'] for p in json.loads(result.stdout)['packets']]

    for bits in [8, 10]:
        source = directory / ('source-' + str(bits) + '.mkv')
        codec = 'libx264' if bits == 8 else 'libx265'
        pix = 'yuv420p' if bits == 8 else 'yuv420p10le'
        make = [args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                'testsrc2=size=320x240:rate=24', '-f', 'lavfi', '-i',
                'testsrc2=size=160x120:rate=24', '-t', '2', '-map', '0:v', '-map', '1:v',
                '-c:v', codec, '-preset', 'ultrafast', '-pix_fmt', pix]
        if bits == 10:
            make += ['-x265-params', 'pools=2:frame-threads=2:log-level=error']
        make.append(str(source))
        result = run('source-' + str(bits), make)
        if result.returncode:
            raise RuntimeError(result.stderr)
        src_hash = packets(source, 'v:1')
        for mode in ['global-cpu', 'scoped-cpu', 'scoped-copy']:
            name = str(bits) + '-' + mode
            output = directory / (name + '.mkv')
            spec = '' if mode == 'global-cpu' else ':0'
            native = 'nv12' if bits == 8 else 'p010le'
            filters = 'vpp_qsv=denoise=30:format=' + native
            if bits == 8:
                filters += ',scale_qsv=format=p010le'
            command = [args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-init_hw_device',
                       'qsv=gpu:hw,child_device=' + args.device, '-filter_hw_device', 'gpu',
                       '-hwaccel' + spec, 'qsv', '-hwaccel_output_format' + spec, 'qsv',
                       '-i', str(source), '-map', '0:0', '-map', '0:1',
                       '-c:v:0', 'hevc_qsv', '-preset:v:0', 'fast', '-global_quality:v:0', '18',
                       '-filter:v:0', filters, '-c:v:1', 'copy' if mode == 'scoped-copy' else 'libx265']
            if mode != 'scoped-copy':
                command += ['-preset:v:1', 'ultrafast', '-x265-params:v:1', 'pools=2:log-level=error']
            command.append(str(output))
            result = run(name, command)
            if mode == 'global-cpu':
                passed = result.returncode != 0 and 'Impossible to convert' in result.stderr
            else:
                passed = result.returncode == 0
                if passed:
                    decoded = run(name + '-decode', [args.ffmpeg, '-v', 'error', '-i', str(output),
                                                    '-map', '0:v', '-f', 'null', '-'])
                    passed = decoded.returncode == 0
                if passed and mode == 'scoped-copy':
                    passed = packets(output, 'v:1') == src_hash
            reports.append({'bits': bits, 'mode': mode, 'exit_code': result.returncode, 'passed': passed})
    report = {'checks': reports, 'passed': all(r['passed'] for r in reports)}
    (directory / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
