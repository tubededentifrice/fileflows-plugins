import importlib.util
import json
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fileflows', Path(__file__).parents[1] / 'Tools/fileflows.py')
ff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ff)
UID = 'c3a508d3-7af2-40c2-acd1-7668d1a2c1df'
CODE = '/**\n * @description Test\n */\nfunction Script() { return 1; }\n'


class ToolTests(unittest.TestCase):
    def test_metadata_only_is_removed(self):
        self.assertEqual(ff.clean_code(CODE), 'function Script() { return 1; }')
        self.assertIn('/* keep */', ff.clean_code(CODE + '\n/* keep */'))

    def test_log_text_removes_credentials_and_inline_images(self):
        out = ff.redact('<div>API.Key: secret</div>\n<img src="data:image/png;base64,abcdef">\n<div>score &gt; 95</div>')
        self.assertNotIn('secret', out)
        self.assertNotIn('abcdef', out)
        self.assertIn('score > 95', out)

    def test_variable_types(self):
        self.assertEqual(ff.variables(['rate=12', 'enabled=false', 'name=text']),
                         {'rate': 12, 'enabled': False, 'name': 'text'})
        with self.assertRaises(ValueError):
            ff.variables(['invalid'])

    def test_host_and_container_validation(self):
        for host in ['-oProxyCommand=bad', 'naze;bad']:
            with self.assertRaises(ValueError):
                ff.FileFlows(host=host)
        with self.assertRaises(ValueError):
            ff.FileFlows(container='fileflows;bad')

    @patch('subprocess.run')
    def test_ssh_quoting_and_json_stdin(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, '{"status":200,"body":[]}', '')
        self.assertEqual(ff.FileFlows().api('POST', '/api/test', {'name': 'a`$"b'}), [])
        args, kwargs = run.call_args
        remote = shlex.split(args[0][-1])
        self.assertEqual(remote, ['docker', 'exec', '-i', 'fileflows', 'python3', '-c', ff.BRIDGE])
        self.assertEqual(json.loads(kwargs['input'])['body']['name'], 'a`$"b')
        self.assertFalse(kwargs.get('shell', False))

    def test_private_backup_and_upload_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            client = ff.FileFlows(backup_dir=directory)
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
            client = ff.FileFlows()
            calls = []
            def api(method, path, body=None):
                calls.append(method)
                return [{'Name': 'Test', 'Uid': UID}] * 2
            client.api = api
            with self.assertRaises(ValueError):
                client.upload(source)
            self.assertEqual(calls, ['GET'])

    def test_failed_files_pagination(self):
        client = ff.FileFlows()
        calls = []
        def api(method, path, body=None):
            calls.append(path)
            return [{'Status': 4}] * (500 if 'skip=0&' in path else 2)
        client.api = api
        self.assertEqual(len(client.failed()), 502)
        self.assertIn('skip=500&top=500', calls[1])

    def test_wait_returns_terminal_state(self):
        client = ff.FileFlows()
        for status in [1, 4, -3]:
            client.api = lambda *args: {'Uid': UID, 'Status': status}
            result = ff.wait_file(client, UID)
            self.assertEqual(result['Status'], status)
            self.assertEqual(result['finished'], status in [1, 4])

    def test_wait_timeout(self):
        client = ff.FileFlows()
        client.api = lambda method, path: ({'Status': 2, 'Name': 'movie'} if 'library-file' in path else {})
        with patch('time.monotonic', side_effect=[0, 5]):
            result = ff.wait_file(client, UID, timeout=1)
        self.assertTrue(result['timeout'])

    def test_wait_rejects_invalid_limits(self):
        for interval, timeout in [(0, 1), (61, 1), (1, float('nan'))]:
            with self.assertRaises(ValueError):
                ff.wait_file(ff.FileFlows(), UID, interval, timeout)

    def test_restore_uses_full_export_and_exact_uid(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'object.json'
            path.write_text(json.dumps({'Uid': UID, 'Code': 'parsed source'}))
            client = ff.FileFlows()
            with patch.object(client, 'upload', return_value={'verified': True}) as upload:
                self.assertTrue(client.restore(path)['verified'])
                upload.assert_called_once_with(path.with_name('source.js'), uid=UID)

    def test_reprocess_merges_requested_variables(self):
        client = ff.FileFlows()
        with patch.object(client, 'api', return_value=None) as api, patch.object(ff, 'FileFlows', return_value=client), patch('builtins.print'):
            ff.main(['reprocess', UID, '--var', 'vpp_qsv=30'])
        body = api.call_args.args[2]
        self.assertEqual(body['Mode'], 1)
        self.assertEqual(body['CustomVariables'], {'vpp_qsv': 30})


if __name__ == '__main__':
    unittest.main()
