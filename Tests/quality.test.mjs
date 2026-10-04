import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { URL } from 'node:url';

const shared = readFileSync(new URL('../Scripts/Shared/FfmpegHelpers.js', import.meta.url), 'utf8');
const helpersCode = readFileSync(new URL('../Scripts/Shared/ScriptHelpers.js', import.meta.url), 'utf8');
const cleaningCode = readFileSync(
    new URL('../Scripts/Flow/Video/Video - Cleaning Filters.js', import.meta.url),
    'utf8'
);
function loadHelpers() {
    return vm.runInNewContext(shared.replace('export class', 'class') + '\nnew FfmpegHelpers()');
}
function list(values = []) {
    values.Add = (value) => values.push(value);
    values.Clear = () => {
        values.length = 0;
    };
    values.RemoveAt = (index) => values.splice(index, 1);
    Object.defineProperty(values, 'Count', { get: () => values.length });
    return values;
}

test('8-bit source denoise precedes the separate Main10 conversion', () => {
    const h = loadHelpers();
    const chain = h.buildQsvDenoiseFilter(40, 8, 10, 'cw=1920:ch=1040:cx=0:cy=20');
    assert.equal(
        chain,
        'vpp_qsv=denoise=40:format=nv12,vpp_qsv=cw=1920:ch=1040:cx=0:cy=20:format=nv12,scale_qsv=format=p010le'
    );
    assert.equal(h.mergeFilters([chain]), chain);
    assert.equal(h.mergeFilters([chain, chain]), chain);
});

test('10-bit source retains P010 without an 8-bit detour', () => {
    const h = loadHelpers();
    const chain = h.buildQsvDenoiseFilter(40, 10, 10, '');
    assert.equal(chain, 'vpp_qsv=denoise=40:format=p010le');
    assert.equal(h.mergeFilters([chain, 'scale_qsv=format=p010le']), chain);
    assert.equal(h.mergeFilters(['scale_qsv=format=p010le']), 'scale_qsv=format=p010le');
});

test('quality search excludes small files below target and large files above budget', () => {
    const h = loadHelpers();
    const results = [
        { crf: 15, score: 98, size: 1100 },
        { crf: 18, score: 96, size: 900 },
        { crf: 20, score: 95, size: 800 },
        { crf: 24, score: 92, size: 500 }
    ];
    assert.equal(h.selectQualityResult(results, 95, 1000, true).crf, 20);
    assert.equal(h.selectQualityResult(results, 95, 1000, false).crf, 18);
    assert.equal(h.selectQualityResult(results, 99, 1000, true), null);
    assert.equal(h.selectQualityResult(results, 95, 700, true), null);
    assert.equal(h.selectQualityResult([{ score: 96, size: 0 }], 95, 700, true), null);
});

for (const bits of [8, 10]) {
    test(`Cleaning Filters builds a usable ${bits}-bit source to Main10 pipeline`, () => {
        const stream = {
            Codec: 'hevc_qsv',
            Index: 0,
            EncodingParameters: list(['hevc_qsv', '-profile:v:0', 'main10', '-pix_fmt', 'p010le']),
            Filter: list(['scale_qsv=format=p010le']),
            OptionalFilter: list(),
            Crop: { Width: 1920, Height: 1040, X: 0, Y: 20 }
        };
        const videoInfo = {
            VideoStreams: [{ Bits: bits, Width: 1920, Height: 1080, Duration: 3600, FramesPerSecond: 24 }]
        };
        const variables = {
            FfmpegBuilderModel: { VideoStreams: [stream], VideoInfo: videoInfo },
            vi: { VideoInfo: videoInfo },
            file: { FullName: 'Movie.1986.mkv' },
            VideoMetadata: { Year: 1986, Genres: ['Animation'] },
            vpp_qsv: '40',
            'CleaningFilters.SkipQsvTuning': true
        };
        const context = vm.createContext({
            Variables: variables,
            System: {},
            Logger: { ILog() {}, DLog() {}, WLog() {}, ELog() {} },
            Flow: {
                WorkingFile: 'Movie.1986.mkv',
                GetToolPath() {
                    return null;
                }
            }
        });
        vm.runInContext(
            shared.replace('export class', 'class') + '\n' + helpersCode.replace('export class', 'class'),
            context
        );
        vm.runInContext(
            cleaningCode.replace(/^import .*;\n/gm, '') +
                '\nScript(3, false, false, false, false, false, false, false, "qsv")',
            context
        );
        const expected = loadHelpers().buildQsvDenoiseFilter(40, bits, 10, 'cw=1920:ch=1040:cx=0:cy=20');
        assert.equal(variables.filters, expected);
        const at = stream.EncodingParameters.indexOf('-filter:v:0');
        assert.ok(at >= 0);
        assert.equal(stream.EncodingParameters[at + 1], expected);
        assert.equal(stream.EncodingParameters.filter((s) => s === '-filter:v:0').length, 1);
        assert.ok(!variables.filters.includes('hwdownload'));
    });
}

const autoCode = readFileSync(new URL('../Scripts/Flow/Video/Video - Auto Quality.js', import.meta.url), 'utf8');
function runAuto(options = {}) {
    const files = new Map([['/movie.mkv', 'source']]);
    const calls = [];
    const logs = [];
    const video = {
        Codec: 'hevc_qsv',
        EncodingParameters: list([
            'hevc_qsv',
            '-preset:v',
            'fast',
            '-profile:v:0',
            'main10',
            '-filter:v:0',
            'vpp_qsv=denoise=30:format=nv12,scale_qsv=format=p010le'
        ]),
        Filter: list(),
        OptionalFilter: list()
    };
    const info = {
        VideoStreams: [
            { Codec: 'h264', Bits: 8, Width: 1920, Height: 1080, Duration: 90, FramesPerSecond: 24, Bitrate: 20000000 }
        ]
    };
    const variables = {
        FfmpegBuilderModel: { VideoStreams: [video], VideoInfo: info, ForceEncode: true },
        vi: { VideoInfo: info },
        file: { FullName: '/movie.mkv', Size: 100000000 },
        AutoQuality_Validated: true,
        MaxFileSize: options.maxSize || 0
    };
    const context = vm.createContext({
        Variables: variables,
        Logger: {
            ILog(x) {
                logs.push(x);
            },
            DLog(x) {
                logs.push(x);
            },
            WLog(x) {
                logs.push(x);
            },
            ELog(x) {
                logs.push(x);
            }
        },
        System: {
            IO: {
                Path: { Combine: (...p) => p.join('/') },
                File: {
                    Exists: (p) => files.has(p),
                    Delete: (p) => files.delete(p),
                    ReadAllText: (p) => files.get(p)
                },
                FileInfo: function (p) {
                    this.Exists = files.has(p);
                    const q = /quality_(\d+)/.exec(p);
                    this.Length = q ? 10000 * (30 - Number(q[1])) : 1000000;
                }
            }
        },
        Flow: {
            TempPath: '/temp',
            WorkingFile: '/movie.mkv',
            GetToolPath: () => 'ffmpeg',
            NewGuid: () => 'id',
            Execute({ argumentList: args }) {
                calls.push(args);
                if (args.includes('filter=libvmaf')) return { exitCode: 0, standardOutput: 'libvmaf' };
                const graph = args[args.indexOf('-filter_complex') + 1];
                if (args.includes('-filter_complex')) {
                    const q = Number(/quality_(\d+)/.exec(args[args.indexOf('-i') + 1])[1]);
                    const score = q <= 18 ? 96 : 92;
                    const metric = /log_path=([^:]+)/.exec(graph)[1];
                    if (options.failMetric && q > 18) return { exitCode: 2 };
                    files.set(
                        metric,
                        JSON.stringify({
                            frames: Array(options.shortMetric ? 1 : 240).fill({}),
                            pooled_metrics: { vmaf: { mean: score } }
                        })
                    );
                } else {
                    const out = args[args.length - 1];
                    if (options.failReference && out.includes('_reference')) return { exitCode: 2 };
                    files.set(out, 'video');
                }
                return { exitCode: 0, completed: true };
            }
        }
    });
    vm.runInContext(
        shared.replace('export class', 'class') + '\n' + helpersCode.replace('export class', 'class'),
        context
    );
    vm.runInContext(autoCode.replace(/^import .*;\n/gm, ''), context);
    const result = vm.runInContext(
        'Script(95, 10, 24, 10, 3, 6, true, false, "veryslow", 0, 2, false, "min")',
        context
    );
    return { result, variables, calls, video, logs };
}

test('Auto Quality keeps the manual target and uses the final preset and GPU format in samples', () => {
    const { result, variables, calls, logs } = runAuto();
    assert.equal(result, 1, logs.slice(-15).join('\n'));
    assert.equal(variables.AutoQuality_Target, 95);
    assert.equal(variables.AutoQuality_Validated, true);
    assert.equal(variables.AutoQuality_CRF, 18);
    const encodes = calls.filter((a) => a.some((v) => v.startsWith('-global_quality')));
    assert.ok(encodes.length > 0);
    for (const args of encodes) {
        assert.equal(args[args.indexOf('-preset:v') + 1], 'veryslow');
        assert.ok(!args.includes('fast'));
        assert.ok(!args.includes('-pix_fmt'));
        assert.ok(args[args.indexOf('-vf') + 1].includes('format=nv12,hwupload'));
    }
});
for (const options of [{ failReference: true }, { failMetric: true }, { shortMetric: true }, { maxSize: 1 }]) {
    test(`Auto Quality rejects incomplete or infeasible search: ${JSON.stringify(options)}`, () => {
        const { result, variables } = runAuto(options);
        assert.equal(result, -1);
        assert.equal(variables.AutoQuality_Validated, false);
    });
}

test('Auto Quality reports the effective budget and rejects a quality-only pass', () => {
    const { result, logs } = runAuto({ maxSize: 1200000 });
    assert.equal(result, -1);
    assert.ok(logs.some((x) => x.includes('Size Budget:')));
    assert.ok(logs.some((x) => x.includes('Size Fail')));
    assert.ok(!logs.some((x) => /\| Pass/.test(x)));
});

for (const mode of ['progressive', 'interlaced', 'empty', 'failed']) {
    test(`Cleaning Filters reads the populated idet result: ${mode}`, () => {
        const video = {
            Codec: 'hevc_qsv',
            EncodingParameters: list(['hevc_qsv', '-profile:v:0', 'main10']),
            Filter: list(),
            OptionalFilter: list()
        };
        const info = { VideoStreams: [{ Bits: 8, Width: 1920, Height: 1080, Duration: 3600, FramesPerSecond: 25 }] };
        const variables = {
            FfmpegBuilderModel: { VideoStreams: [video], VideoInfo: info },
            vi: { VideoInfo: info },
            video: { Duration: '00:01:30.9200000' },
            file: { FullName: '/movie.mkv' },
            'CleaningFilters.SkipQsvTuning': true
        };
        const empty = 'Multi frame detection: TFF: 0 BFF: 0 Progressive: 0 Undetermined: 0';
        const data =
            mode === 'interlaced'
                ? 'Multi frame detection: TFF: 220 BFF: 0 Progressive: 30 Undetermined: 0'
                : 'Multi frame detection: TFF: 0 BFF: 0 Progressive: 249 Undetermined: 1';
        const context = vm.createContext({
            Variables: variables,
            System: {},
            Logger: { ILog() {}, DLog() {}, WLog() {}, ELog() {} },
            Flow: {
                GetToolPath: () => 'ffmpeg',
                WorkingFile: '/movie.mkv',
                Execute({ argumentList: args }) {
                    if (args.indexOf('idet') >= 0) {
                        assert.ok(Number(args[args.indexOf('-ss') + 1]) < 90);
                    }
                    return {
                        exitCode: mode === 'failed' ? 1 : 0,
                        standardError: empty + (mode === 'empty' ? '' : '\n' + data)
                    };
                }
            }
        });
        vm.runInContext(
            shared.replace('export class', 'class') + '\n' + helpersCode.replace('export class', 'class'),
            context
        );
        vm.runInContext(
            cleaningCode.replace(/^import .*;\n/gm, '') +
                '\nScript(3, true, false, false, false, true, false, false, "off")',
            context
        );
        const chain = video.Filter.join(',');
        assert.equal(chain.includes('setfield=prog'), mode === 'progressive');
        assert.equal(chain.includes('deinterlace_qsv'), mode === 'interlaced');
        assert.equal(variables.interlace_progressive, mode === 'progressive' ? 747 : mode === 'interlaced' ? 90 : 0);
    });
}

const executorCode = readFileSync(
    new URL('../Scripts/Flow/Video/Video - FFmpeg Builder Executor (Single Filter).js', import.meta.url),
    'utf8'
);
const defaultsCode = readFileSync(new URL('../Scripts/Shared/FfmpegBuilderDefaults.js', import.meta.url), 'utf8');
function runExecutor(copy, fail = false, options = {}) {
    const calls = [];
    const variables = {
        AutoQuality_CRF: copy ? 'copy' : 18,
        AutoQuality_Validated: true,
        video: { Duration: 90 },
        file: { FullName: '/source.mkv' },
        FfmpegBuilderModel: {
            Extension: 'mkv',
            ForceEncode: true,
            VideoStreams: [
                {
                    Codec: 'hevc_qsv',
                    Stream: { IndexString: '0:0' },
                    EncodingParameters: ['hevc_qsv', '-global_quality:v', '18', '-preset:v', 'veryslow'],
                    Filter: ['vpp_qsv=denoise=30:format=nv12,scale_qsv=format=p010le']
                }
            ],
            AudioStreams: [
                { Codec: 'aac', Stream: { IndexString: '0:1' }, EncodingParameters: ['aac', '-b:a', '128k'] }
            ]
        }
    };
    if (options.secondary) variables.FfmpegBuilderModel.VideoStreams.push(options.secondary);
    if (options.sourceMap) variables.FfmpegBuilderModel.VideoStreams[0].Stream.IndexString = options.sourceMap;
    if (options.inputs) variables.FfmpegBuilderModel.InputFiles = options.inputs;
    const context = vm.createContext({
        Variables: variables,
        System: {},
        Logger: { ILog() {}, DLog() {}, WLog() {}, ELog() {} },
        Flow: {
            TempPath: '/temp',
            GetToolPath: () => 'ffmpeg',
            NewGuid: () => 'id',
            PartPercentageUpdate() {},
            SetWorkingFile() {},
            Execute({ argumentList }) {
                calls.push(argumentList);
                return { exitCode: fail ? 1 : 0, standardError: fail ? 'hevc_qsv error while opening encoder' : '' };
            }
        }
    });
    vm.runInContext(
        [shared, helpersCode, defaultsCode].map((s) => s.replace('export class', 'class')).join('\n'),
        context
    );
    vm.runInContext(executorCode.replace(/^import .*;\n/gm, ''), context);
    const result = vm.runInContext(`Script(${JSON.stringify(options.hardware || 'Off')}, true, false, 0)`, context);
    return { result, calls };
}

test('Executor copy mode keeps the video unchanged and still converts audio', () => {
    const { result, calls } = runExecutor(true);
    assert.equal(result, 1);
    const args = calls[0];
    assert.equal(args[args.indexOf('-c:v:0') + 1], 'copy');
    assert.equal(args[args.indexOf('-c:a:0') + 1], 'aac');
    assert.ok(!args.includes('-filter:v:0'));
    assert.ok(!args.includes('-global_quality:v'));
});

test('Executor does not change settings after a validated QSV encode fails', () => {
    const { result, calls } = runExecutor(false, true);
    assert.equal(result, -1);
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].includes('-low_power:v:0'));
});

test('Executor copies an unchanged second HEVC track and scopes QSV to the first source track', () => {
    const { result, calls } = runExecutor(false, false, {
        hardware: 'Automatic',
        secondary: { Codec: 'hevc', Stream: { IndexString: '0:1', Codec: 'hevc' }, EncodingParameters: [] }
    });
    assert.equal(result, 1);
    const args = calls[0];
    assert.equal(args[args.indexOf('-c:v:1') + 1], 'copy');
    assert.ok(args.includes('-hwaccel:0'));
    assert.ok(!args.includes('-hwaccel'));
    assert.ok(!args.includes('-hwaccel:1'));
    assert.ok(!args.includes('-filter:v:1'));
});

test('Executor leaves an explicit CPU encode on software frames', () => {
    const { result, calls } = runExecutor(false, false, {
        hardware: 'Automatic',
        secondary: {
            Codec: 'libx265',
            Stream: { IndexString: '0:v:1', Codec: 'hevc' },
            EncodingParameters: ['libx265', '-preset:v', 'fast']
        }
    });
    assert.equal(result, 1);
    assert.equal(calls[0][calls[0].indexOf('-c:v:1') + 1], 'libx265');
    assert.ok(!calls[0].includes('-hwaccel:v:1'));
});

test('Executor places hardware decode options before the mapped input and uses source indices', () => {
    const { result, calls } = runExecutor(false, false, {
        hardware: 'Automatic',
        sourceMap: '1:v:2',
        inputs: ['/first.mkv', '/second.mkv']
    });
    assert.equal(result, 1);
    const args = calls[0];
    const hw = args.indexOf('-hwaccel:v:2');
    assert.ok(hw > args.indexOf('/first.mkv'));
    assert.ok(hw < args.indexOf('/second.mkv'));
    assert.ok(!args.includes('-hwaccel:0'));
});
