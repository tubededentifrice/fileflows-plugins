#!/usr/bin/env python3
"""Use the FileFlows API through SSH and the container's loopback interface."""
import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from html import unescape

BRIDGE = r'''
import json, sys, urllib.request, urllib.error
request = json.load(sys.stdin)
body = request.get('body')
data = None if body is None else json.dumps(body).encode()
url = request['base'].rstrip('/') + request['path']
req = urllib.request.Request(url, data=data, method=request['method'],
                             headers={'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(req, timeout=request.get('timeout', 60)) as response:
        text = response.read().decode('utf-8', errors='replace')
        try: result = json.loads(text) if text else None
        except ValueError: result = text
        print(json.dumps({'status': response.status, 'body': result}))
except urllib.error.HTTPError as error:
    print(json.dumps({'status': error.code, 'body': error.read().decode('utf-8', errors='replace')}))
'''

FILE_LOG_BRIDGE = r'''
import gzip, sys
from pathlib import Path
files = sorted(p for p in Path('/app/Logs/LibraryFiles').glob(sys.argv[1]+'*.log*')
               if p.name.endswith(('.log', '.log.gz')))
if not files:
    raise SystemExit(2)
for path in files:
    if path.suffix == '.gz':
        with gzip.open(path, 'rt', errors='replace') as stream:
            print(stream.read())
    else:
        print(path.read_text(errors='replace'))
'''


def clean_code(code):
    """Save removes the script metadata comment. Keep all other comments."""
    return re.sub(r'/\*\*\s*\n\s*\* @(?:name|description)[\s\S]*?\*/', '', code, count=1).strip()


def script_name(path, code):
    match = re.search(r'^\s*\*\s*@name\s+(.+)$', code, re.MULTILINE)
    return match.group(1).strip() if match else Path(path).stem


def redact(text, html=True):
    if html:
        text = re.sub(r'<img\b[^>]*>', '', text, flags=re.I)
        text = unescape(re.sub(r'<[^>]+>', '', text))
    text = re.sub(r'data:image/[^\s\"\']+', '[image removed]', text, flags=re.I)
    lines = []
    for line in text.splitlines():
        if re.search(r'api[._ -]?key|access[._ -]?token|password|client[._ -]?secret|encryptionkey|licensekey|authorization|bearer', line, re.I):
            lines.append('[credential line removed]')
        else:
            lines.append(line)
    return '\n'.join(lines)


class FileFlows:
    def __init__(self, host, container='fileflows', base='http://localhost:5000', backup_dir=None):
        if host.startswith('-') or not re.fullmatch(r'[\w.@:-]+', host):
            raise ValueError('Invalid SSH host')
        if not re.fullmatch(r'[\w.-]+', container):
            raise ValueError('Invalid container name')
        self.host, self.container, self.base = host, container, base
        self.backup_dir = Path(backup_dir or Path.home() / '.cache' / 'fileflows' / 'backups')

    def api(self, method, path, body=None):
        command = shlex.join(['docker', 'exec', '-i', self.container, 'python3', '-c', BRIDGE])
        payload = json.dumps({'base': self.base, 'method': method, 'path': path, 'body': body})
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', self.host, command],
                                input=payload, text=True, capture_output=True, timeout=90)
        if result.returncode:
            raise RuntimeError(redact(result.stderr).strip() or 'SSH request failed')
        response = json.loads(result.stdout)
        if not 200 <= response['status'] < 300:
            raise RuntimeError(f"HTTP {response['status']}: {redact(str(response['body']))[:1500]}")
        return response['body']

    def docker_logs(self, since='48h', tail='all', match=None, context=0):
        if context < 0 or (tail != 'all' and (not str(tail).isdigit() or int(tail) <= 0)):
            raise ValueError('Use a positive tail count or all, and non-negative context')
        command = shlex.join(['docker', 'logs', '--since', since, '--tail', str(tail), self.container]) + ' 2>&1'
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', self.host, command],
                                text=True, capture_output=True, timeout=90)
        if result.returncode:
            raise RuntimeError(redact(result.stdout + result.stderr, html=False))
        lines = redact(result.stdout, html=False).splitlines()
        if match:
            pattern = re.compile(match, re.I)
            selected = set()
            for i, line in enumerate(lines):
                if pattern.search(line):
                    selected.update(range(max(0, i-context), min(len(lines), i+context+1)))
            lines = [lines[i] for i in sorted(selected)]
        return '\n'.join(lines)

    def file_log(self, uid):
        uid = str(uuid.UUID(uid))
        command = shlex.join(['docker', 'exec', self.container, 'python3', '-c', FILE_LOG_BRIDGE, uid])
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', self.host, command],
                                text=True, capture_output=True, timeout=90)
        if result.returncode:
            raise RuntimeError(redact(result.stderr, html=False).strip() or 'No retained file log on this NAS')
        return result.stdout

    def backup(self, kind, uid):
        uid = str(uuid.UUID(uid))
        obj = self.api('GET', f'/api/{kind}/{uid}')
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        directory = self.backup_dir / f'{stamp}-{kind}-{uid}'
        directory.mkdir(parents=True, mode=0o700)
        os.chmod(directory, 0o700)
        path = directory / 'object.json'
        write_private(path, json.dumps(obj, indent=2) + '\n')
        if kind == 'script':
            code = self.api('GET', f'/api/script/export/{uid}')
            source = directory / 'source.js'
            write_private(source, code)
        elif kind == 'dockermod':
            write_private(directory / 'source.sh', obj['Code'])
        return path

    def upload_mod(self, path, uid):
        uid = str(uuid.UUID(uid))
        code = Path(path).read_text().replace('\r\n', '\n')
        syntax = subprocess.run(['bash', '-n', str(Path(path).resolve())], text=True, capture_output=True)
        if syntax.returncode:
            raise ValueError(syntax.stderr.strip())
        obj = self.api('GET', '/api/dockermod/' + uid)
        if obj.get('Repository'):
            raise ValueError('Select a custom DockerMod')
        if obj.get('Code', '').rstrip('\n') == code.rstrip('\n'):
            return {'name': obj['Name'], 'uid': uid, 'verified': True, 'unchanged': True}
        backup = self.backup('dockermod', uid)
        obj['Code'] = code
        self.api('POST', '/api/dockermod', obj)
        saved = self.api('GET', '/api/dockermod/' + uid)
        if saved.get('Code', '').rstrip('\n') != code.rstrip('\n') or any(saved.get(k) != obj.get(k) for k in ['Name', 'Enabled', 'Order', 'Repository']):
            raise RuntimeError(f'Saved DockerMod differs. Recovery copy: {backup}')
        return {'name': saved['Name'], 'uid': uid, 'verified': True, 'backup': str(backup)}

    def upload(self, path, name=None, uid=None):
        code = Path(path).read_text()
        name = name or script_name(path, code)
        uid = str(uuid.UUID(uid)) if uid else None
        scripts = self.api('GET', '/api/script')
        matches = [s for s in scripts if s['Uid'] == uid] if uid else [s for s in scripts if s['Name'] == name]
        if len(matches) != 1:
            raise ValueError(f'Expected one existing script for {name}; found {len(matches)}. Use --uid.')
        obj = self.api('GET', '/api/script/' + matches[0]['Uid'])
        self.api('POST', '/api/script/validate', {'Code': code, 'IsFunction': False, 'Variables': {}})
        backup = self.backup('script', obj['Uid'])
        obj['Code'] = code
        self.api('POST', '/api/script', obj)
        saved = self.api('GET', '/api/script/' + obj['Uid'])
        if clean_code(saved['Code']) != clean_code(code):
            raise RuntimeError(f'Saved code differs. Recovery copy: {backup}')
        return {'name': saved['Name'], 'uid': saved['Uid'], 'verified': True, 'backup': str(backup)}

    def failed(self):
        files, skip, batch = [], 0, 500
        while True:
            page = self.api('GET', f'/api/library-file?status=4&skip={skip}&top={batch}')
            if not isinstance(page, list):
                raise RuntimeError('Expected a file list from FileFlows')
            files.extend(f for f in page if f.get('Status') == 4)
            if len(page) < batch:
                return files
            skip += batch

    def diagnose(self, uids=None):
        files = []
        if uids:
            for value in uids:
                uid = str(uuid.UUID(value))
                obj = self.api('GET', '/api/library-file/' + uid)
                files.append(obj if isinstance(obj, dict) else {'Uid': uid, 'missing': True})
        else:
            files = self.failed()
        rows = []
        for obj in files:
            row = {k: obj.get(k) for k in ['Uid', 'Name', 'Status', 'FailureReason']}
            if obj.get('missing'):
                row['cause'] = 'file_not_found'
                rows.append(row)
                continue
            try:
                log = redact(self.file_log(obj['Uid']), html=False)
                row.update(diagnose_log(log))
            except RuntimeError as error:
                row.update(cause='log_unavailable', log_error=str(error))
            rows.append(row)
        return rows

    def media_check(self, uid, options, user=None):
        uid = str(uuid.UUID(uid))
        if user and not re.fullmatch(r'[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?', user):
            raise ValueError('Invalid container user')
        obj = self.api('GET', '/api/library-file/' + uid)
        if not isinstance(obj, dict) or not obj.get('Name'):
            raise ValueError('Library file was not found')
        code = Path(__file__).with_name('media_check.py').read_text()
        command = shlex.join(['docker', 'exec', *(['--user', user] if user else []),
                             self.container, 'python3', '-c', code, obj['Name'], *options])
        # Stream completed checks so a long audio scan shows its earlier results.
        with tempfile.TemporaryFile(mode='w+t') as error_log:
            process = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                                        self.host, command], text=True, stdout=subprocess.PIPE, stderr=error_log)
            result = None
            try:
                for line in process.stdout:
                    event = json.loads(line)
                    if event.get('event') == 'result':
                        result = event
                    else:
                        print(json.dumps(event), flush=True)
                if process.wait() or result is None:
                    error_log.seek(0)
                    raise RuntimeError(redact(error_log.read(), html=False)[-2000:] or 'Media check did not finish')
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait()
                process.stdout.close()
        result['Uid'] = uid
        return result

    def restore(self, path):
        path = Path(path)
        obj = json.loads(path.read_text())
        if path.with_name('source.sh').exists():
            return self.upload_mod(path.with_name('source.sh'), obj['Uid'])
        if 'Code' in obj:
            return self.upload(path.with_name('source.js'), uid=obj['Uid'])
        return self.save_flow(path)

    def save_flow(self, path):
        obj = json.loads(Path(path).read_text())
        uid = str(uuid.UUID(obj['Uid']))
        # Resolve an existing flow before any mutation.
        self.api('GET', '/api/flow/' + uid)
        backup = self.backup('flow', uid)
        self.api('PUT', '/api/flow', obj)
        saved = self.api('GET', '/api/flow/' + uid)
        for key in ['Parts', 'Properties', 'Name', 'Type', 'Enabled']:
            if key in obj and saved.get(key) != obj[key]:
                raise RuntimeError(f'Saved flow field differs: {key}. Recovery copy: {backup}')
        return {'uid': uid, 'verified': True, 'backup': str(backup)}


def write_private(path, text):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        stream.write(text)


def diagnose_log(log):
    """Extract terminal errors and the last quality table from a plain file log."""
    lines = log.splitlines()
    quality = 'No tested quality value meets' in log
    retained = any(re.search(r'\[WARN\].*Original retained: no (?:tested|measured)', line) for line in lines)
    cause = 'original_retained_quality_floor' if retained else 'quality_size_conflict' if quality else (
        'qsv_software_frame_conversion' if 'Impossible to convert between the formats supported' in log else 'unknown')
    # Exclude logged FFmpeg stderr metadata, including titles containing 'error'.
    errors = [line for line in lines if '[ERRR]' in line and not re.search(r'->\s+(title|comment)\s*:', line)]
    marker = log.rfind('Auto Quality Results (')
    table = log[marker:] if marker >= 0 else ''
    trials = []
    for line in table.splitlines():
        match = re.search(r'->\s+(\d+)\s*\|\s*([\d.]+)\s*\|.*?\|\s*([\d.]+) G(?:i)?B\s*\|\s*(.*)', line)
        if match:
            trials.append({'quality': int(match[1]), 'score': float(match[2]),
                           'estimated_gib': float(match[3]), 'logged_status': match[4].strip()})
    target = re.search(r'Target:\s*([\d.]+)', table)
    limit = re.search(r'Max Size:\s*([\d.]+) G(?:i)?B', table)
    budget = re.search(r'Size Budget:\s*([\d.]+) G(?:i)?B', table)
    attempts = [{'bytes': int(m[1]), 'limit_bytes': int(m[2])}
                for line in lines for m in [re.search(r'\[INFO\].*Encoded size: (\d+) bytes; limit: (\d+) bytes', line)] if m]
    fallbacks = [float(m[1]) for line in lines
                 for m in [re.search(r'\[INFO\].*Size fallback: testing VMAF target ([\d.]+)', line)] if m]
    return {'cause': cause, 'errors': errors[-8:], 'quality_trials': trials,
            'size_attempts': attempts, 'fallback_targets': fallbacks,
            'quality_target': float(target[1]) if target else None,
            'max_size_gib': float(limit[1]) if limit else None,
            'size_budget_gib': float(budget[1]) if budget else None,
            'truehd_checksum_errors': len(re.findall(r'Lossless check failed', log)),
            'log_finished': 'Finishing file: ProcessingFailed' in log or 'Finishing file: Processed' in log}


def wait_file(client, uid, interval=20, timeout=1800, emit=None):
    uid = str(uuid.UUID(uid))
    if not 1 <= interval <= 60 or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('Use interval 1–60 seconds and a positive timeout')
    deadline = time.monotonic() + timeout
    previous = None
    while True:
        obj = client.api('GET', '/api/library-file/' + uid)
        state = {k: obj.get(k) for k in ['Uid', 'Status', 'OriginalSize', 'FinalSize', 'FailureReason']}
        if obj.get('Status') in [1, 4] or obj.get('Status', 0) < 0:
            state['finished'] = obj.get('Status') in [1, 4]
            return state
        status = client.api('GET', '/api/status')
        running = next((f for f in status.get('processingFiles', []) if f.get('name') == obj.get('Name')), {})
        state.update(step=running.get('step'), percent=running.get('stepPercent'))
        if state != previous and emit:
            emit(state)
        previous = state
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            state['timeout'] = True
            return state
        time.sleep(min(interval, remaining))


def variables(values):
    out = {}
    for value in values:
        key, separator, raw = value.partition('=')
        if not separator or not key:
            raise ValueError('Use --var NAME=JSON_VALUE')
        try:
            out[key] = json.loads(raw)
        except ValueError:
            out[key] = raw
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True, help='SSH host name or user@host')
    parser.add_argument('--container', default='fileflows')
    parser.add_argument('--base', default='http://localhost:5000')
    parser.add_argument('--backup-dir')
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ['status', 'failed', 'scripts', 'flows', 'mods']:
        sub.add_parser(name)
    diagnose = sub.add_parser('diagnose', help='Read complete failure logs and extract causes and quality trials')
    diagnose.add_argument('uids', nargs='*', help='Default: all failed files')
    diagnose.add_argument('--output', help='Save the report in a new private file')
    media = sub.add_parser('media-check', help='Probe and decode source samples on the NAS')
    media.add_argument('uid')
    media.add_argument('--starts', type=float, nargs='+')
    media.add_argument('--duration', type=float, default=8)
    media.add_argument('--timeout', type=float, default=600)
    media.add_argument('--threads', type=int, default=1)
    media.add_argument('--user', help='Container user or UID:GID to check runner access')
    media.add_argument('--ffmpeg', default='/usr/local/bin/ffmpeg')
    media.add_argument('--ffprobe', default='ffprobe')
    media.add_argument('--no-qsv', action='store_true')
    media.add_argument('--full-audio-index', type=int)
    media.add_argument('--output', help='Save the report in a new private file')
    upload = sub.add_parser('upload', help='Update an existing script; back up and verify it')
    upload.add_argument('files', nargs='+')
    upload.add_argument('--name')
    upload.add_argument('--uid')
    mod = sub.add_parser('upload-mod', help='Back up, save, and verify a custom DockerMod')
    mod.add_argument('file')
    mod.add_argument('--uid', required=True)
    backup = sub.add_parser('backup')
    backup.add_argument('kind', choices=['script', 'flow', 'dockermod'])
    backup.add_argument('uid')
    save = sub.add_parser('save-flow', help='Save a prepared JSON flow; back up and verify it')
    save.add_argument('file')
    get = sub.add_parser('get')
    get.add_argument('kind', choices=['script', 'flow', 'library-file', 'dockermod'])
    get.add_argument('uid')
    get.add_argument('--output', help='Write the exact object to a new private file')
    restore = sub.add_parser('restore', help='Restore a saved object; back up current state first')
    restore.add_argument('file')
    wait = sub.add_parser('wait', help='Wait for one file; show status changes')
    wait.add_argument('uid')
    wait.add_argument('--interval', type=float, default=20)
    wait.add_argument('--timeout', type=float, default=1800)
    log = sub.add_parser('log')
    log.add_argument('uid')
    log.add_argument('--lines', type=int, default=200)
    log.add_argument('--match')
    log.add_argument('--source', choices=['api', 'nas'], default='api')
    docker_log = sub.add_parser('docker-logs', help='Read container logs through SSH; remove credential lines')
    docker_log.add_argument('--since', default='48h')
    docker_log.add_argument('--tail', default='all')
    docker_log.add_argument('--match')
    docker_log.add_argument('--context', type=int, default=0)
    docker_log.add_argument('--output', help='Save the filtered logs in a new private file')
    reprocess = sub.add_parser('reprocess', help='Reprocess only the supplied file UIDs')
    reprocess.add_argument('uids', nargs='+')
    reprocess.add_argument('--var', action='append', default=[])
    reprocess.add_argument('--flow-uid')
    reprocess.add_argument('--bottom', action='store_true')
    add = sub.add_parser('add', help='Run selected test files through a specified flow')
    add.add_argument('--flow-uid', required=True)
    add.add_argument('files', nargs='+')
    add.add_argument('--var', action='append', default=[])
    args = parser.parse_args(argv)
    client = FileFlows(args.host, args.container, args.base, args.backup_dir)
    if args.command == 'status':
        result = client.api('GET', '/api/status')
    elif args.command == 'diagnose':
        result = client.diagnose(args.uids)
        if args.output:
            write_private(Path(args.output), json.dumps(result, indent=2) + '\n')
    elif args.command == 'media-check':
        options = ['--duration', str(args.duration), '--timeout', str(args.timeout), '--threads', str(args.threads),
                   '--ffmpeg', args.ffmpeg, '--ffprobe', args.ffprobe]
        if args.starts:
            options += ['--starts', *[str(x) for x in args.starts]]
        if args.no_qsv:
            options.append('--no-qsv')
        if args.full_audio_index is not None:
            options += ['--full-audio-index', str(args.full_audio_index)]
        result = client.media_check(args.uid, options, args.user)
        if args.output:
            write_private(Path(args.output), json.dumps(result, indent=2) + '\n')
        print(json.dumps({'Uid': result['Uid'], 'clean': result['clean'], 'output': args.output}, indent=2)
              if args.output else json.dumps(result, indent=2))
        if not result['clean']:
            sys.exit(2)
        return
    elif args.command == 'failed':
        files = client.failed()
        result = [{k: f.get(k) for k in ['Uid', 'Name', 'Status', 'FailureReason', 'OriginalSize', 'FinalSize']}
                  for f in files if f.get('Status') == 4]
    elif args.command == 'mods':
        result = [{k: o.get(k) for k in ['Uid', 'Name', 'Enabled', 'Repository', 'Order']}
                  for o in client.api('GET', '/api/dockermod')]
    elif args.command == 'docker-logs':
        text = client.docker_logs(args.since, args.tail, args.match, args.context)
        if args.output:
            write_private(Path(args.output), text + '\n')
            result = {'output': str(Path(args.output).resolve())}
        else:
            print(text)
            return
    elif args.command == 'upload-mod':
        result = client.upload_mod(args.file, args.uid)
    elif args.command in ['scripts', 'flows']:
        result = [{k: o.get(k) for k in ['Uid', 'Name', 'Type']} for o in client.api('GET', '/api/' + args.command[:-1])]
    elif args.command == 'upload':
        if len(args.files) > 1 and (args.name or args.uid):
            parser.error('--name and --uid require one input file')
        result = [client.upload(p, args.name, args.uid) for p in args.files]
    elif args.command == 'backup':
        result = {'backup': str(client.backup(args.kind, args.uid))}
    elif args.command == 'restore':
        result = client.restore(args.file)
    elif args.command == 'save-flow':
        result = client.save_flow(args.file)
    elif args.command == 'get':
        result = client.api('GET', f'/api/{args.kind}/{uuid.UUID(args.uid)}')
        if args.output:
            write_private(Path(args.output), json.dumps(result, indent=2) + '\n')
            result = {'output': str(Path(args.output).resolve())}
    elif args.command == 'wait':
        result = wait_file(client, args.uid, args.interval, args.timeout,
                           emit=lambda state: print(json.dumps(state), flush=True))
        print(json.dumps(result, indent=2))
        if result.get('Status') != 1:
            sys.exit(2)
        return
    elif args.command == 'log':
        body = client.file_log(args.uid) if args.source == 'nas' else client.api('GET', f'/api/library-file/{uuid.UUID(args.uid)}/log')
        text = body if isinstance(body, str) else json.dumps(body)
        if args.lines <= 0:
            raise ValueError('--lines must be positive')
        lines = redact(text, html=args.source == 'api').splitlines()
        if args.match:
            lines = [line for line in lines if re.search(args.match, line)]
        print('\n'.join(lines[-args.lines:]))
        return
    elif args.command == 'reprocess':
        uids = [str(uuid.UUID(uid)) for uid in args.uids]
        body = {'Uids': uids, 'CustomVariables': variables(args.var),
                'Mode': 1 if args.var else 0, 'BottomOfQueue': args.bottom}
        if args.flow_uid:
            body['Flow'] = {'Uid': str(uuid.UUID(args.flow_uid))}
        client.api('POST', '/api/library-file/reprocess', body)
        result = {'queued': uids}
    else:
        body = {'FlowUid': str(uuid.UUID(args.flow_uid)), 'Files': args.files, 'CustomVariables': variables(args.var)}
        client.api('POST', '/api/library-file/manually-add', body)
        result = {'queued': args.files}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, re.error, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
