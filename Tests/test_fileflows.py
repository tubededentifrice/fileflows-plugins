import importlib.util
import gzip
import json
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fileflows', Path(__file__).parents[1] / 'Tools/fileflows.py')
ff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ff)
UID = 'c3a508d3-7af2-40c2-acd1-7668d1a2c1df'
CODE = '/**\n * @description Test\n */\nfunction Script() { return 1; }\n'


class ToolTests(unittest.TestCase):
    def test_cli_requires_host_before_remote_access(self):
        with patch('subprocess.run') as run, patch('sys.stderr'), self.assertRaises(SystemExit) as error:
            ff.main(['status'])
        self.assertEqual(error.exception.code, 2)
        run.assert_not_called()

    def test_missing_library_file_is_reported_before_media_check(self):
        client = ff.FileFlows(host='server.example')
        with patch.object(client, 'api', return_value=None):
            self.assertEqual(client.diagnose([UID])[0]['cause'], 'file_not_found')
            with self.assertRaisesRegex(ValueError, 'Library file was not found'):
                client.media_check(UID, [])

    def test_diagnosis_separates_quality_failure_and_audio_errors(self):
        log = '''[ERRR] -> [truehd] Lossless check failed
Auto Quality Results (VMAF)
[INFO] -> Target: 95.00 (min)
[INFO] -> Max Size: 17.79 GB
[INFO] -> Size Budget: 13.34 GiB
[INFO] -> 14 | 95.05 | 95.05 | 98.05 | 96.26 | +0.05 | 17.15 GB | Size Fail
[ERRR] -> No tested quality value meets VMAF 95 and the size budget.
Finishing file: ProcessingFailed'''
        row = ff.diagnose_log(log)
        self.assertEqual(row['cause'], 'quality_size_conflict')
        self.assertEqual(row['truehd_checksum_errors'], 1)
        self.assertEqual(row['size_budget_gib'], 13.34)
        self.assertEqual(row['quality_trials'][0]['estimated_gib'], 17.15)
        self.assertTrue(row['log_finished'])

    def test_diagnosis_reports_adaptive_retention_and_actual_size_attempts(self):
        log = '''[INFO] -> Size fallback: testing VMAF target 94.
[INFO] -> Encoded size: 1200 bytes; limit: 1000 bytes.
[INFO] -> Encoded size: 900 bytes; limit: 1000 bytes.
[WARN] -> Original retained: no measured VMAF 90 encode fits the size limit.
Finishing file: Processed'''
        row = ff.diagnose_log(log)
        self.assertEqual(row['cause'], 'original_retained_quality_floor')
        self.assertEqual(row['fallback_targets'], [94])
        self.assertEqual(row['size_attempts'], [{'bytes': 1200, 'limit_bytes': 1000}, {'bytes': 900, 'limit_bytes': 1000}])
        self.assertTrue(row['log_finished'])

    def test_diagnosis_identifies_frame_conversion_and_missing_logs(self):
        self.assertEqual(ff.diagnose_log('Impossible to convert between the formats supported')['cause'],
                         'qsv_software_frame_conversion')
        client = ff.FileFlows(host='server.example')
        client.failed = lambda: [{'Uid': UID, 'Name': 'movie'}]
        with patch.object(client, 'file_log', side_effect=RuntimeError('No retained log')):
            self.assertEqual(client.diagnose()[0]['cause'], 'log_unavailable')

    def test_metadata_only_is_removed(self):
        self.assertEqual(ff.clean_code(CODE), 'function Script() { return 1; }')
        self.assertIn('/* keep */', ff.clean_code(CODE + '\n/* keep */'))

    def test_plain_log_removes_image_data_and_keeps_comparison_operators(self):
        out = ff.redact('score < 95\ndata:image/jpeg;base64,abcdef:640x480\nsize > limit', html=False)
        self.assertNotIn('abcdef', out)
        self.assertIn('score < 95', out)
        self.assertIn('size > limit', out)

    def test_log_text_removes_credentials_and_inline_images(self):
        out = ff.redact('<div>API.Key: secret</div>\n<img src="data:image/png;base64,abcdef">\n<div>score &gt; 95</div>')
        self.assertNotIn('secret', out)
        self.assertNotIn('abcdef', out)
        self.assertIn('score > 95', out)

    @patch('subprocess.run')
    def test_docker_logs_preserve_operators_redact_and_merge_context(self, run):
        run.return_value = subprocess.CompletedProcess([], 0,
            'start\nrequires setuptools<82\nAPI.Key=secret\nfailed build\nend\n', '')
        out = ff.FileFlows(host='server.example').docker_logs(since='48h', match='requires|failed', context=1)
        self.assertIn('setuptools<82', out)
        self.assertNotIn('secret', out)
        self.assertEqual(out.count('[credential line removed]'), 1)
        command = run.call_args.args[0][-1]
        self.assertEqual(shlex.split(command)[:-1],
                         ['docker', 'logs', '--since', '48h', '--tail', 'all', 'fileflows'])
        self.assertTrue(command.endswith('2>&1'))

    def test_docker_logs_reject_invalid_limits(self):
        for tail, context in [('0', 0), ('-1', 0), ('all', -1)]:
            with self.assertRaises(ValueError):
                ff.FileFlows(host='server.example').docker_logs(tail=tail, context=context)

    def test_file_log_reads_compressed_and_plain_logs_without_html(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / (UID + '-server.log')).write_text('active log\n')
            with gzip.open(root / (UID + '.log.gz'), 'wt') as stream:
                stream.write('complete log\nfinal error\n')
            (root / (UID + '.html.gz')).write_text('skip html')
            code = ff.FILE_LOG_BRIDGE.replace('/app/Logs/LibraryFiles', directory)
            result = subprocess.run([sys.executable, '-c', code, UID], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('active log', result.stdout)
            self.assertIn('final error', result.stdout)
            self.assertNotIn('skip html', result.stdout)

    def test_file_log_rejects_invalid_uid_before_ssh(self):
        with patch('subprocess.run') as run:
            with self.assertRaises(ValueError):
                ff.FileFlows(host='server.example').file_log('../secret')
            run.assert_not_called()

    def test_mod_upload_preserves_settings_and_private_restore_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'mod.sh'
            source.write_text('#!/bin/bash\necho OK\n')
            client = ff.FileFlows(host='server.example', backup_dir=directory)
            obj = {'Uid': UID, 'Name': 'Audio', 'Code': 'old', 'Enabled': True,
                   'Order': 7, 'Repository': False}
            calls = []
            def api(method, path, body=None):
                calls.append((method, path))
                if method == 'POST':
                    obj.update(body)
                    obj['Code'] = obj['Code'].rstrip('\n')
                return obj.copy()
            client.api = api
            result = client.upload_mod(source, UID)
            backup = Path(result['backup'])
            self.assertEqual(json.loads(backup.read_text())['Code'], 'old')
            self.assertEqual(backup.with_name('source.sh').read_text(), 'old')
            self.assertEqual(stat.S_IMODE(backup.with_name('source.sh').stat().st_mode), 0o600)
            self.assertTrue(obj['Enabled'])
            self.assertEqual(obj['Order'], 7)
            calls.clear()
            self.assertTrue(client.upload_mod(source, UID)['unchanged'])
            self.assertEqual(calls, [('GET', '/api/dockermod/' + UID)])
            with patch.object(client, 'upload_mod', return_value={'verified': True}) as upload:
                client.restore(backup)
                upload.assert_called_once_with(backup.with_name('source.sh'), UID)

    def test_mod_upload_rejects_invalid_shell_before_remote_write(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'mod.sh'
            source.write_text('if then\n')
            client = ff.FileFlows(host='server.example')
            with patch.object(client, 'api') as api:
                with self.assertRaises(ValueError):
                    client.upload_mod(source, UID)
                api.assert_not_called()

    def test_mod_upload_rejects_repository_mods(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'mod.sh'
            source.write_text('#!/bin/bash\ntrue\n')
            client = ff.FileFlows(host='server.example')
            with patch.object(client, 'api', return_value={'Repository': True}) as api:
                with self.assertRaises(ValueError):
                    client.upload_mod(source, UID)
                self.assertEqual(api.call_count, 1)

    def test_mod_upload_detects_saved_code_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'mod.sh'
            source.write_text('#!/bin/bash\necho OK\n')
            client = ff.FileFlows(host='server.example', backup_dir=directory)
            obj = {'Uid': UID, 'Name': 'Audio', 'Code': 'old', 'Repository': False}
            client.api = lambda *args: obj.copy()
            with self.assertRaisesRegex(RuntimeError, 'Saved DockerMod differs'):
                client.upload_mod(source, UID)

    def test_variable_types(self):
        self.assertEqual(ff.variables(['rate=12', 'enabled=false', 'name=text']),
                         {'rate': 12, 'enabled': False, 'name': 'text'})
        with self.assertRaises(ValueError):
            ff.variables(['invalid'])

    def test_host_and_container_validation(self):
        for host in ['-oProxyCommand=bad', 'server.example;bad']:
            with self.assertRaises(ValueError):
                ff.FileFlows(host=host)
        with self.assertRaises(ValueError):
            ff.FileFlows(host='server.example', container='fileflows;bad')

    @patch('subprocess.run')
    def test_ssh_quoting_and_json_stdin(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, '{"status":200,"body":[]}', '')
        self.assertEqual(ff.FileFlows(host='server.example').api('POST', '/api/test', {'name': 'a`$"b'}), [])
        args, kwargs = run.call_args
        self.assertEqual(args[0][:-1], ['ssh', '-o', 'BatchMode=yes', 'server.example'])
        remote = shlex.split(args[0][-1])
        self.assertEqual(remote, ['docker', 'exec', '-i', 'fileflows', 'python3', '-c', ff.BRIDGE])
        self.assertEqual(json.loads(kwargs['input'])['body']['name'], 'a`$"b')
        self.assertFalse(kwargs.get('shell', False))

    def test_private_backup_and_upload_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            client = ff.FileFlows(host='server.example', backup_dir=directory)
            source = Path(directory) / 'Test.js'
            source.write_text(CODE)
            obj = {'Uid': UID, 'Name': 'Test', 'Code': 'old'}
            calls = []
            def api(method, path, body=None):
                calls.append((method, path))
                if path == '/api/script' and method == 'GET':
                    return [obj.copy()]
                if path == '/api/script/' + UID:
                    return obj.copy()
                if path == '/api/script/export/' + UID:
                    return CODE
                if path == '/api/script' and method == 'POST':
                    obj['Code'] = ff.clean_code(body['Code'])
                return None
            client.api = api
            result = client.upload(source)
            self.assertTrue(result['verified'])
            backup = Path(result['backup'])
            self.assertEqual(json.loads(backup.read_text())['Code'], 'old')
            self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(backup.parent.stat().st_mode), 0o700)
            self.assertLess(calls.index(('POST', '/api/script/validate')), calls.index(('POST', '/api/script')))
            self.assertTrue(backup.with_name('source.js').exists())

    def test_ambiguous_upload_never_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'Test.js'
            source.write_text(CODE)
            client = ff.FileFlows(host='server.example')
            calls = []
            def api(method, path, body=None):
                calls.append(method)
                return [{'Name': 'Test', 'Uid': UID}] * 2
            client.api = api
            with self.assertRaises(ValueError):
                client.upload(source)
            self.assertEqual(calls, ['GET'])

    def test_failed_files_pagination(self):
        client = ff.FileFlows(host='server.example')
        calls = []
        def api(method, path, body=None):
            calls.append(path)
            return [{'Status': 4}] * (500 if 'skip=0&' in path else 2)
        client.api = api
        self.assertEqual(len(client.failed()), 502)
        self.assertIn('skip=500&top=500', calls[1])

    def test_wait_returns_terminal_state(self):
        client = ff.FileFlows(host='server.example')
        for status in [1, 4, -3]:
            client.api = lambda *args: {'Uid': UID, 'Status': status}
            result = ff.wait_file(client, UID)
            self.assertEqual(result['Status'], status)
            self.assertEqual(result['finished'], status in [1, 4])

    def test_wait_timeout(self):
        client = ff.FileFlows(host='server.example')
        client.api = lambda method, path: ({'Status': 2, 'Name': 'movie'} if 'library-file' in path else {})
        with patch('time.monotonic', side_effect=[0, 5]):
            result = ff.wait_file(client, UID, timeout=1)
        self.assertTrue(result['timeout'])

    def test_wait_rejects_invalid_limits(self):
        for interval, timeout in [(0, 1), (61, 1), (1, float('nan'))]:
            with self.assertRaises(ValueError):
                ff.wait_file(ff.FileFlows(host='server.example'), UID, interval, timeout)

    def test_restore_uses_full_export_and_exact_uid(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'object.json'
            path.write_text(json.dumps({'Uid': UID, 'Code': 'parsed source'}))
            client = ff.FileFlows(host='server.example')
            with patch.object(client, 'upload', return_value={'verified': True}) as upload:
                self.assertTrue(client.restore(path)['verified'])
                upload.assert_called_once_with(path.with_name('source.js'), uid=UID)

    def test_reprocess_merges_requested_variables(self):
        client = ff.FileFlows(host='server.example')
        with patch.object(client, 'api', return_value=None) as api, patch.object(ff, 'FileFlows', return_value=client), patch('builtins.print'):
            ff.main(['--host', 'server.example', 'reprocess', UID, '--var', 'vpp_qsv=30'])
        body = api.call_args.args[2]
        self.assertEqual(body['Mode'], 1)
        self.assertEqual(body['CustomVariables'], {'vpp_qsv': 30})


if __name__ == '__main__':
    unittest.main()
