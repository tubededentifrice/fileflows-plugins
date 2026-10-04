import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).parents[1] / 'DockerMods/AudioLangIDDockerMod.sh'


class AudioModTests(unittest.TestCase):
    def run_build(self, fail=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            base = root / 'langid'
            src = base / 'whisper.cpp'
            (src / '.git').mkdir(parents=True)
            (src / 'build').mkdir()
            (src / 'build/CMakeCache.txt').write_text('OpenMP_gomp_LIBRARY=/missing/gcc13/libgomp.so')
            (base / 'whisper-models').mkdir()
            (base / 'whisper-models/ggml-tiny.bin').write_bytes(b'model')
            installed = bin_dir / 'fflangid-whispercpp'
            installed.write_text('old binary')
            for name, code in {
                'git': '#!/bin/bash\nexit 0\n',
                'nproc': '#!/bin/bash\necho 2\n',
                'cmake': '''#!/bin/bash
printf '%s\n' "$*" >>"$TEST_LOG"
if [ "$1" = "--fresh" ]; then
    [ "$TEST_FAIL" = "0" ] || exit 1
    mkdir -p "$5/bin"
    printf '#!/bin/bash\nexit 0\n' >"$5/bin/whisper-cli"
    chmod +x "$5/bin/whisper-cli"
fi
''',
            }.items():
                path = bin_dir / name
                path.write_text(code)
                path.chmod(0o755)
            script = SOURCE.read_text().rsplit('main "$@"', 1)[0]
            script = script.replace('/usr/local/bin', str(bin_dir))
            script += '\nBASE_DIR=' + shlex.quote(str(base)) + '\ninstall_whisper_cpp\n'
            env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'],
                       TEST_LOG=str(root / 'cmake.log'), TEST_FAIL='1' if fail else '0')
            result = subprocess.run(['bash'], input=script, text=True, capture_output=True, env=env)
            return result, (root / 'cmake.log').read_text(), installed.read_text()

    def test_build_uses_fresh_cache_exact_cli_and_static_libraries(self):
        result, calls, installed = self.run_build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--fresh', calls)
        self.assertIn('-DBUILD_SHARED_LIBS=OFF', calls)
        self.assertIn('--target whisper-cli', calls)
        self.assertIn('build-fileflows', calls)
        self.assertEqual(installed, '#!/bin/bash\nexit 0\n')

    def test_failed_build_returns_error_and_keeps_previous_binary(self):
        result, calls, installed = self.run_build(fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ERROR: Failed to build', result.stderr)
        self.assertNotIn('--build', calls)
        self.assertEqual(installed, 'old binary')


if __name__ == '__main__':
    unittest.main()
