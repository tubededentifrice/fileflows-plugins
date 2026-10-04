import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { URL } from 'node:url';

function run(result, working = '/temp/Runner/output.mkv', extra = {}) {
    const calls = [];
    const context = {
        Variables: { file: { Orig: { FullName: '/media/movie.mkv' } }, ...extra },
        Flow: {
            IsLinux: true,
            WorkingFile: working,
            TempPath: '/temp/Runner',
            Execute: (args) => {
                calls.push(args);
                return result;
            },
            SetWorkingFile: (...args) => calls.push(args)
        },
        Logger: { ILog() {}, ELog() {} }
    };
    vm.createContext(context);
    for (const path of [
        'Shared/ScriptHelpers.js',
        'Shared/SafeFileReplace.js',
        'Flow/Video/Video - Safe Replace Original.js'
    ]) {
        const code = readFileSync(new URL('../Scripts/' + path, import.meta.url), 'utf8')
            .replace(/^import .*;\n/gm, '')
            .replace(/export class/g, 'class');
        vm.runInContext(code, context);
    }
    const output = vm.runInContext('Script()', context);
    return { output, calls, variables: context.Variables };
}

test('safe replacement passes original and encoded paths separately', () => {
    const { output, calls } = run({
        exitCode: 0,
        standardOutput: 'REPLACED {"destination":"/media/movie.mkv","bytes":100}'
    });
    assert.equal(output, 1);
    assert.deepEqual(Array.from(calls[0].argumentList.slice(2, 6)), [
        '/temp/Runner/output.mkv',
        '/media/movie.mkv',
        '/temp/FileFlows-Recovery',
        '/temp/Runner'
    ]);
    assert.deepEqual(Array.from(calls[1]), ['/media/movie.mkv', true]);
});

test('replacement failure stops without changing the working file', () => {
    const { output, calls } = run({
        exitCode: 2,
        standardOutput: 'Replacement failed; encoded file retained: /recovery/encoded.mkv'
    });
    assert.equal(output, -1);
    assert.equal(calls.length, 1);
});

test('replacement requires a confirmed result from the command', () => {
    const { output, calls } = run({ exitCode: 0, standardOutput: '' });
    assert.equal(output, -1);
    assert.equal(calls.length, 1);
});

test('an interrupted replacement is a failure even if the exit code is zero', () => {
    const { output, calls } = run({ exitCode: 0, completed: false, standardOutput: '' });
    assert.equal(output, -1);
    assert.equal(calls.length, 1);
});

test('mandatory conversion cannot succeed with the original working file', () => {
    const { output, calls } = run(null, '/media/movie.mkv', { MaxFileSize: 100 });
    assert.equal(output, -1);
    assert.equal(calls.length, 0);
});
