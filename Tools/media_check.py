#!/usr/bin/env python3
"""Probe media and decode selected intervals without changing the source."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import time


def run(command, timeout):
    started = time.monotonic()
    with tempfile.TemporaryFile(mode='w+t') as log:
        timed_out = False
        try:
            result = subprocess.run([str(x) for x in command], stdout=subprocess.PIPE,
                                    stderr=log, text=True, timeout=timeout)
            code, output = result.returncode, result.stdout
        except subprocess.TimeoutExpired:
            code, output, timed_out = None, '', True
        log.seek(0)
        # FFmpeg can return zero after recoverable decode errors. Check the log too.
        count, info_count, head, tail = 0, 0, [], []
        for line in log:
            # VA-API writes initialization information even at log level error.
            if line.startswith('libva info:'):
                info_count += 1
                continue
            if line.strip():
                count += 1
                if len(head) < 10:
                    head.append(line.rstrip())
                tail = (tail + [line.rstrip()])[-10:]
    return {'command': [str(x) for x in command], 'exit_code': code,
            'seconds': round(time.monotonic() - started, 3), 'timeout': timed_out,
            'driver_info_lines': info_count,
            'diagnostic_lines': count, 'diagnostic_head': head, 'diagnostic_tail': tail,
            'stdout': output}


def decode_command(ffmpeg, source, indexes, start=None, duration=None, qsv=False, native='nv12', threads=1):
    command = [ffmpeg, '-hide_banner', '-v', 'error', '-nostdin', '-threads', str(threads),
               '-err_detect', 'crccheck']
    if qsv:
        command += ['-init_hw_device', 'qsv=gpu', '-filter_hw_device', 'gpu',
                    '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv']
    if start is not None:
        command += ['-ss', str(start)]
    command += ['-i', str(source)]
    if duration is not None:
        command += ['-t', str(duration)]
    for index in indexes:
        command += ['-map', '0:' + str(index)]
    if qsv:
        command += ['-vf', 'hwdownload,format=' + native]
    return command + ['-sn', '-dn', '-f', 'null', '-']


def check(source, starts=None, duration=8, ffmpeg='/usr/local/bin/ffmpeg', ffprobe='ffprobe',
          qsv=True, full_audio_index=None, timeout=600, emit=None, threads=1):
    if not math.isfinite(duration) or duration <= 0 or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('Use positive finite duration and timeout values')
    if starts is not None and (not starts or any(not math.isfinite(x) or x < 0 for x in starts)):
        raise ValueError('Use non-negative finite start times')
    if not isinstance(threads, int) or threads < 1:
        raise ValueError('Use a positive decoder thread count')
    source = Path(source).resolve(strict=True)
    before = source.stat()
    report = {'source': str(source), 'bytes': before.st_size, 'checks': [],
              'uid': os.geteuid(), 'gid': os.getegid()}
    result = run([ffprobe, '-v', 'error', '-show_format', '-show_streams', '-of', 'json', source], timeout)
    output = result.pop('stdout')
    report['probe_check'] = result
    if result['exit_code'] != 0:
        report['clean'] = False
        return report
    info = json.loads(output)
    report['probe'] = info
    length = float(info['format']['duration'])
    if not math.isfinite(length) or length <= 0:
        raise ValueError('The source has no positive finite duration')
    if starts is None:
        starts = [min(30, max(0, length-duration)), length/2, max(0, length-duration-2)]
    videos = [s for s in info['streams'] if s.get('codec_type') == 'video'
              and not s.get('disposition', {}).get('attached_pic')]
    audio = [s['index'] for s in info['streams'] if s.get('codec_type') == 'audio']
    if full_audio_index is not None and full_audio_index not in audio:
        raise ValueError('The selected index is not an audio stream')
    report['starts'] = starts
    report['sample_duration'] = duration
    def record(kind, command, start=None):
        row = run(command, timeout)
        row.pop('stdout')
        row.update(kind=kind, start=start)
        row['clean'] = row['exit_code'] == 0 and row['diagnostic_lines'] == 0
        report['checks'].append(row)
        if emit:
            emit(row)
    for start in starts:
        if start >= length:
            raise ValueError('A start time is outside the source duration')
        span = min(duration, length-start)
        indexes = [s['index'] for s in videos] + audio
        if indexes:
            record('software_video_audio', decode_command(ffmpeg, source, indexes, start, span, threads=threads), start)
        if qsv and videos:
            native = 'p010le' if '10' in videos[0].get('pix_fmt', '') else 'nv12'
            record('qsv_primary_video', decode_command(ffmpeg, source, [videos[0]['index']],
                                                       start, span, True, native, threads), start)
    if full_audio_index is not None:
        record('full_audio', decode_command(ffmpeg, source, [full_audio_index], threads=threads))
    after = source.stat()
    report['source_stat_unchanged'] = (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
    report['clean'] = (result['diagnostic_lines'] == 0 and bool(report['checks'])
                       and all(row['clean'] for row in report['checks']) and report['source_stat_unchanged'])
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('--starts', type=float, nargs='+')
    parser.add_argument('--duration', type=float, default=8)
    parser.add_argument('--timeout', type=float, default=600, help='Limit for each command in seconds')
    parser.add_argument('--threads', type=int, default=1)
    parser.add_argument('--ffmpeg', default='/usr/local/bin/ffmpeg')
    parser.add_argument('--ffprobe', default='ffprobe')
    parser.add_argument('--no-qsv', action='store_true')
    parser.add_argument('--full-audio-index', type=int, help='Decode one complete audio stream by absolute index')
    args = parser.parse_args()
    result = check(args.source, args.starts, args.duration, args.ffmpeg, args.ffprobe,
                   not args.no_qsv, args.full_audio_index, args.timeout,
                   emit=lambda row: print(json.dumps({'event': 'check', **row}), flush=True), threads=args.threads)
    print(json.dumps({'event': 'result', **result}), flush=True)


if __name__ == '__main__':
    main()
