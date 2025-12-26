import { FfmpegBuilderDefaults } from 'Shared/FfmpegBuilderDefaults';
import { ScriptHelpers } from 'Shared/ScriptHelpers';

/**
 * @description Executes the FFmpeg Builder model but guarantees only one video filter option per output stream by merging all upstream filters into a single `-filter:v:N` argument.
 * @author Vincent Courcelle
 * @revision 14
 * @minimumVersion 25.0.0.0
 * @param {('Automatic'|'On'|'Off')} HardwareDecoding Hardware decoding mode. Automatic enables it when QSV filters/encoders are detected. Default: Automatic.
 * @param {bool} KeepModel Keep the builder model variable after executing. Default: false.
 * @param {bool} WriteFullArgumentsToComment Write the full ffmpeg command-line into the output container `comment` tag (useful for auditing encodes). Default: true.
 * @param {int} MaxCommentLength Max chars for the comment metadata (0 = unlimited). Default: 32000.
 * @output Executed FFmpeg
 * @output Skipped (no changes)
 */
function Script(HardwareDecoding, KeepModel, WriteFullArgumentsToComment, MaxCommentLength) {
    const helpers = new ScriptHelpers();
    const toEnumerableArray = (v, m) => helpers.toEnumerableArray(v, m);
    const safeString = (v) => helpers.safeString(v);
    const clampNumber = (v, min, max) => helpers.clampNumber(v, min, max);
    const truthy = (v) => helpers.truthy(v);
    const secondsToClock = (v) => helpers.secondsToClock(v);
    const hasArg = (l, f) => helpers.hasArg(l, (t) => t.toLowerCase() === String(f || '').toLowerCase());

    const builderDefaults = new FfmpegBuilderDefaults();

    // Shared helpers are imported, but we can alias them if we want to match existing code exactly
    // or just use them directly. The existing code uses `safeTokenString` which is identical to `safeString`.
    const safeTokenString = safeString;

    function normalizeInputFile(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') {
            const s = String(value).trim();
            if (!s) return '';
            // Some runner versions may serialize FileFlows input objects as JSON strings.
            if (s[0] === '{' && s.indexOf('"FileName"') >= 0) {
                try {
                    const o = JSON.parse(s);
                    if (o && o.FileName) return String(o.FileName).trim();
                } catch (err) {}
            }
            return s;
        }
        if (typeof value === 'object') {
            try {
                if (value.FileName) return String(value.FileName).trim();
            } catch (err) {}
            try {
                if (value.FullName) return String(value.FullName).trim();
            } catch (err) {}
            try {
                if (value.Path) return String(value.Path).trim();
            } catch (err) {}
        }
        // Fallback: avoid JSON-stringifying objects into -i
        return '';
    }

    function splitCommandLine(s) {
        const input = String(s || '');
        const out = [];
        let cur = '';
        let inQuotes = false;
        let escape = false;
        for (let i = 0; i < input.length; i++) {
            const ch = input[i];
            if (escape) {
                cur += ch;
                escape = false;
                continue;
            }
            if (ch === '\\\\') {
                escape = true;
                continue;
            }
            if (ch === '"') {
                inQuotes = !inQuotes;
                continue;
            }
            if (!inQuotes && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) {
                if (cur.length) {
                    out.push(cur);
                    cur = '';
                }
                continue;
            }
            cur += ch;
        }
        if (cur.length) out.push(cur);
        return out;
    }

    function flattenTokenList(value) {
        const items = toEnumerableArray(value, 5000)
            .map(safeTokenString)
            .map((x) => String(x || '').trim())
            .filter((x) => x);
        const out = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            // Some builder nodes store an entire mini command line in a single item.
            if (item.indexOf(' ') >= 0 || item.indexOf('\t') >= 0) {
                const split = splitCommandLine(item);
                for (let j = 0; j < split.length; j++) out.push(split[j]);
            } else {
                out.push(item);
            }
        }
        return out;
    }

    function buildAuditCommandLine(executable, args) {
        const tokens = [helpers.quoteProcessArg(executable)];
        for (let i = 0; i < (args || []).length; i++) tokens.push(helpers.quoteProcessArg(args[i]));
        return tokens.join(' ');
    }

    function splitFilterChain(chain) {
        const s = String(chain || '');
        const parts = [];
        let cur = '';
        let escaped = false;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (escaped) {
                cur += ch;
                escaped = false;
                continue;
            }
            if (ch === '\\\\') {
                cur += ch;
                escaped = true;
                continue;
            }
            if (ch === ',') {
                const t = cur.trim();
                if (t) parts.push(t);
                cur = '';
                continue;
            }
            cur += ch;
        }
        const tail = cur.trim();
        if (tail) parts.push(tail);
        return parts;
    }

    function dedupePreserveOrder(items) {
        const seen = {};
        const out = [];
        for (let i = 0; i < (items || []).length; i++) {
            const v = String(items[i] || '').trim();
            if (!v) continue;
            if (seen[v]) continue;
            seen[v] = true;
            out.push(v);
        }
        return out;
    }

    function mergeFilters(filterExpressions) {
        const flat = [];
        for (let i = 0; i < (filterExpressions || []).length; i++) {
            const f = String(filterExpressions[i] || '').trim();
            if (!f) continue;
            const parts = splitFilterChain(f);
            for (let j = 0; j < parts.length; j++) flat.push(parts[j]);
        }

        // Common FileFlows/FFmpeg Builder artifact: injected `scale_qsv=format=p010le` for 10-bit output.
        // If the chain already forces the same format (eg via vpp_qsv=...:format=p010le), drop the redundant segment.
        const lowered = flat.map((x) => x.toLowerCase());
        const hasP010 = lowered.some((x) => x.indexOf('format=p010le') >= 0 || x.indexOf('p010le') >= 0);
        if (hasP010) {
            for (let i = flat.length - 1; i >= 0; i--) {
                const seg = lowered[i];
                if (seg === 'scale_qsv=format=p010le') {
                    flat.splice(i, 1);
                    lowered.splice(i, 1);
                }
            }
        }

        return dedupePreserveOrder(flat).join(',');
    }

    function extractAndStripFilterArgs(tokens, typeChar) {
        const out = [];
        const filters = [];
        for (let i = 0; i < (tokens || []).length; i++) {
            const t = String(tokens[i] || '').trim();
            const lower = t.toLowerCase();
            const tc = String(typeChar || 'v').toLowerCase();
            const isVideo = tc === 'v';
            const isAudio = tc === 'a';
            const isFilterFlag =
                (isVideo && (lower === '-vf' || lower === '-filter:v' || lower.indexOf('-filter:v:') === 0)) ||
                (isAudio && (lower === '-af' || lower === '-filter:a' || lower.indexOf('-filter:a:') === 0));
            if (!isFilterFlag) {
                out.push(t);
                continue;
            }
            const val = i + 1 < tokens.length ? String(tokens[i + 1] || '').trim() : '';
            if (val) filters.push(val);
            i++; // skip value token
        }
        return { tokens: out, filters };
    }

    function extractBareCodecToken(tokens) {
        const list = tokens || [];
        for (let i = 0; i < list.length; i++) {
            const t = String(list[i] || '').trim();
            if (!t) continue;
            if (t[0] === '-') return { codec: '', tokens: list }; // already in flags, no bare codec at front
            if (t.indexOf('=') >= 0) return { codec: '', tokens: list };
            if (/^[0-9]+$/.test(t)) return { codec: '', tokens: list };
            // treat the first non-flag token as a codec token (builder sometimes emits this)
            const out = list.slice(0, i).concat(list.slice(i + 1));
            return { codec: t, tokens: out };
        }
        return { codec: '', tokens: list };
    }

    function extractCodecFromArgs(tokens) {
        // Extracts codec from patterns like: -c:v:0 hevc_qsv, -c:v hevc_qsv, -c copy
        for (let i = 0; i < (tokens || []).length - 1; i++) {
            const t = String(tokens[i] || '')
                .trim()
                .toLowerCase();
            if (t === '-c' || t.indexOf('-c:') === 0) {
                const codec = String(tokens[i + 1] || '').trim();
                if (codec) return codec;
            }
        }
        return '';
    }

    function stripCodecArgs(tokens) {
        const out = [];
        for (let i = 0; i < (tokens || []).length; i++) {
            const t = String(tokens[i] || '').trim();
            if (!t) continue;
            const lower = t.toLowerCase();
            if (lower === '-c' || lower.indexOf('-c:') === 0) {
                i++;
                continue;
            }
            out.push(t);
        }
        return out;
    }

    function stripBareCodecToken(tokens, codec) {
        const c = String(codec || '')
            .trim()
            .toLowerCase();
        if (!c) return tokens || [];
        const out = [];
        for (let i = 0; i < (tokens || []).length; i++) {
            const t = String(tokens[i] || '').trim();
            if (!t) continue;
            if (t.toLowerCase() === c) {
                const prev =
                    i > 0
                        ? String(tokens[i - 1] || '')
                              .trim()
                              .toLowerCase()
                        : '';
                const prevIsCodecFlag = prev === '-c' || prev.indexOf('-c:') === 0;
                if (!prevIsCodecFlag) continue; // drop stray codec token
            }
            out.push(t);
        }
        return out;
    }

    function rewriteStreamIndexTokens(tokens, typeChar, outIndex) {
        // Rewrites tokens like -c:v:0, -filter:v:0, -disposition:a:0 to use the provided outIndex.
        // This avoids "gapped" indices when streams are deleted.
        const out = [];
        const re = new RegExp('(:' + typeChar + ':)(\\d+)$', 'i');
        for (let i = 0; i < (tokens || []).length; i++) {
            const t = String(tokens[i] || '').trim();
            const m = t.match(re);
            if (m) out.push(t.replace(re, '$1' + String(outIndex)));
            else out.push(t);
        }
        return out;
    }

    function replaceIndexPlaceholders(tokens, outIndex) {
        const out = [];
        for (let i = 0; i < (tokens || []).length; i++) {
            const t = String(tokens[i] || '');
            out.push(t.replace(/\{index\}/gi, String(outIndex)));
        }
        return out;
    }

    function getSourceTypeIndex(stream) {
        try {
            if (stream && stream.TypeIndex !== undefined && stream.TypeIndex !== null)
                return parseInt(stream.TypeIndex);
        } catch (err) {}
        try {
            const s = stream && stream.Stream ? stream.Stream : null;
            if (s && s.TypeIndex !== undefined && s.TypeIndex !== null) return parseInt(s.TypeIndex);
        } catch (err) {}
        return -1;
    }

    function replaceSourcePlaceholders(tokens, stream) {
        const sourceTypeIndex = getSourceTypeIndex(stream);
        const out = [];
        for (let i = 0; i < (tokens || []).length; i++) {
            let t = String(tokens[i] || '');
            if (sourceTypeIndex >= 0) t = t.replace(/\{sourceTypeIndex\}/gi, String(sourceTypeIndex));
            out.push(t);
        }
        return out;
    }

    function stripMapArgs(tokens) {
        // Per-stream token lists sometimes contain their own -map directives (eg audio normalization).
        // Mapping is handled by this executor; keep stream tokens free of -map to avoid extra/invalid mappings.
        const out = [];
        for (let i = 0; i < (tokens || []).length; i++) {
            const t = String(tokens[i] || '').trim();
            const lower = t.toLowerCase();
            if (lower === '-map') {
                i++;
                continue;
            }
            out.push(t);
        }
        return out;
    }

    function detectNeedsQsv(model) {
        function containsQsvFilterExpr(expr) {
            const s = String(expr || '').toLowerCase();
            if (!s) return false;
            if (s.indexOf('vpp_qsv') >= 0) return true;
            if (s.indexOf('scale_qsv') >= 0) return true;
            if (s.indexOf('deinterlace_qsv') >= 0) return true;
            if (s.indexOf('tonemap_qsv') >= 0) return true;
            if (s.indexOf('hwupload') >= 0 || s.indexOf('hwdownload') >= 0) return true;
            return /_qsv(?:=|,|:|$)/i.test(s);
        }

        try {
            const vs = toEnumerableArray(model && model.VideoStreams ? model.VideoStreams : null, 20);
            for (let i = 0; i < vs.length; i++) {
                const v = vs[i];
                if (!v || v.Deleted) continue;
                const codec = String(v.Codec || '').toLowerCase();
                if (codec.indexOf('_qsv') >= 0) return true;
                const sig = [
                    flattenTokenList(v.Filters).join(' '),
                    flattenTokenList(v.OptionalFilter).join(' '),
                    flattenTokenList(v.Filter).join(' '),
                    flattenTokenList(v.EncodingParameters).join(' '),
                    flattenTokenList(v.OptionalEncodingParameters).join(' '),
                    flattenTokenList(v.AdditionalParameters).join(' ')
                ].join(' ');
                if (containsQsvFilterExpr(sig)) return true;
            }
        } catch (err) {}

        return false;
    }

    function getToolPath() {
        try {
            return Flow.GetToolPath('ffmpeg');
        } catch (e) {}
        try {
            return Flow.GetToolPath('FFmpeg');
        } catch (e) {}
        // fallback to common variables
        return Variables['ffmpeg'] || Variables['FFmpeg'] || Variables.ffmpeg || Variables.FFmpeg || '';
    }

    function isQsvCodec(codec) {
        const c = String(codec || '').toLowerCase();
        return c.indexOf('_qsv') >= 0;
    }

    function getStreamSourceCodecLower(stream) {
        try {
            const s = stream && stream.Stream ? stream.Stream : null;
            if (s && s.Codec)
                return String(s.Codec || '')
                    .trim()
                    .toLowerCase();
        } catch (err) {}
        return '';
    }

    function normalizeSourceAudioCodec(codecLower) {
        const s = String(codecLower || '')
            .trim()
            .toLowerCase();
        if (!s) return '';
        if (s.indexOf('eac3') >= 0 || s.indexOf('e-ac-3') >= 0 || s.indexOf('eac-3') >= 0) return 'eac3';
        if (s.indexOf('ac3') >= 0) return 'ac3';
        if (s.indexOf('aac') >= 0) return 'aac';
        if (s.indexOf('flac') >= 0) return 'flac';
        if (s.indexOf('alac') >= 0) return 'alac';
        if (s.indexOf('pcm_s16le') >= 0) return 'pcm_s16le';
        if (s.indexOf('pcm_s24le') >= 0) return 'pcm_s24le';
        if (s.indexOf('pcm_s32le') >= 0) return 'pcm_s32le';
        if (s.indexOf('pcm_f32le') >= 0) return 'pcm_f32le';
        if (s.indexOf('pcm_f64le') >= 0) return 'pcm_f64le';
        return '';
    }

    function chooseAudioCodecForFilters(stream, outputExtension) {
        const override = String(Variables['FFmpegExecutor.AudioFilterFallbackCodec'] || '').trim();
        if (override) return override;

        const sourceCodec = normalizeSourceAudioCodec(getStreamSourceCodecLower(stream));
        if (sourceCodec) return sourceCodec;

        const ext = String(outputExtension || '')
            .trim()
            .toLowerCase();
        if (ext === 'mkv') return 'eac3';
        if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') return 'aac';
        return 'aac';
    }

    function hasLowPowerOption(tokens, outIndex) {
        // Treat "-low_power" and "-low_power:v" as global for all video streams.
        const target = `-low_power:v:${outIndex}`;
        for (let i = 0; i < (tokens || []).length; i++) {
            const t = String(tokens[i] || '')
                .trim()
                .toLowerCase();
            if (!t) continue;
            if (t === '-low_power' || t === '-low_power:v' || t === target) return true;
        }
        return false;
    }

    function stripExistingCommentMetadata(tokens) {
        // Remove pairs like: -metadata comment=...
        const out = [];
        for (let i = 0; i < (tokens || []).length; i++) {
            const t = String(tokens[i] || '').trim();
            if (t.toLowerCase() !== '-metadata') {
                out.push(t);
                continue;
            }
            const val = i + 1 < tokens.length ? String(tokens[i + 1] || '') : '';
            if (/^comment=/i.test(val || '')) {
                i++;
                continue;
            }
            out.push(t);
            if (i + 1 < tokens.length) {
                out.push(tokens[i + 1]);
                i++;
            }
        }
        return out;
    }

    function getOutputExtension(model) {
        const ext = String(model && model.Extension ? model.Extension : '').trim();
        if (ext) return ext.replace(/^\\./, '');
        // fallback to current file extension
        try {
            const varFile = Variables && Variables.file ? Variables.file : null;
            const fn = String(Flow.WorkingFileName || (varFile ? varFile.Name : '') || '');
            const idx = fn.lastIndexOf('.');
            if (idx > 0) return fn.substring(idx + 1);
        } catch (err) {}
        return 'mkv';
    }

    function getStreamIndexString(stream) {
        try {
            const s = stream && stream.Stream ? stream.Stream : null;
            if (s && s.IndexString) return String(s.IndexString);
        } catch (err) {}
        // fallback: inputFileIndex:type:typeIndex
        try {
            const s = stream && stream.Stream ? stream.Stream : null;
            if (
                s &&
                s.InputFileIndex !== undefined &&
                s.InputFileIndex !== null &&
                s.TypeIndex !== undefined &&
                s.TypeIndex !== null &&
                s.Type
            ) {
                const type = String(s.Type || '').toLowerCase();
                let typeChar = 'v';
                if (type.indexOf('audio') >= 0) typeChar = 'a';
                else if (type.indexOf('subtitle') >= 0) typeChar = 's';
                return `${s.InputFileIndex}:${typeChar}:${s.TypeIndex}`;
            }
        } catch (err) {}
        return '';
    }

    function shouldExecute(model) {
        if (!model) return false;
        if (model.ForceEncode) return true;
        if (truthy(Variables.ForceEncode)) return true;
        if (truthy(model.RemoveAttachments)) return true;

        const streams = []
            .concat(toEnumerableArray(model.VideoStreams, 50))
            .concat(toEnumerableArray(model.AudioStreams, 200))
            .concat(toEnumerableArray(model.SubtitleStreams, 200));

        for (let i = 0; i < streams.length; i++) {
            const s = streams[i];
            if (!s) continue;
            if (s.Deleted) return true;
            if (flattenTokenList(s.EncodingParameters).length) return true;
            if (flattenTokenList(s.OptionalEncodingParameters).length) return true;
            if (flattenTokenList(s.AdditionalParameters).length) return true;
            if (flattenTokenList(s.Filters).length) return true;
            if (flattenTokenList(s.OptionalFilter).length) return true;
            if (flattenTokenList(s.Filter).length) return true;
            if (s.Language || s.Title || s.IsDefault === true) return true;
        }

        if (flattenTokenList(model.CustomParameters).length) return true;
        if (flattenTokenList(model.MetadataParameters).length) return true;

        return false;
    }

    function tryGetDurationSeconds() {
        const metadata = helpers.getVideoMetadata();
        if (metadata.duration > 0) return metadata.duration;
        return 0;
    }

    function createFfmpegProgressHandler(durationSeconds) {
        let duration = parseFloat(durationSeconds || 0);
        let lastPercent = -1;
        let lastUpdateMs = 0;
        let lastOutSeconds = 0;
        let lastFps = NaN;
        let lastSpeed = NaN;
        let lastInfoUpdateMs = 0;

        function updatePercent(percent, force) {
            const p = clampNumber(percent, 0, 100);
            const now = Date.now();
            const shouldUpdate = force || (p !== lastPercent && now - lastUpdateMs >= 750);
            if (!shouldUpdate) return;
            lastPercent = p;
            lastUpdateMs = now;
            try {
                Flow.PartPercentageUpdate(p);
            } catch (err) {}
        }

        function tryUpdateFromSeconds(seconds) {
            if (!duration || duration <= 0) return;
            if (seconds === null || seconds === undefined) return;
            const s = parseFloat(seconds);
            if (isNaN(s) || s < 0) return;
            lastOutSeconds = s;
            updatePercent((100.0 / duration) * s, false);
        }

        function maybeUpdateAdditionalInfo(force) {
            const now = Date.now();
            const throttleOk = force || now - lastInfoUpdateMs >= 1000;
            if (!throttleOk) return;
            lastInfoUpdateMs = now;

            let speedParts = [];
            if (!isNaN(lastFps) && lastFps > 0) speedParts.push(`${lastFps.toFixed(1)} fps`);
            if (!isNaN(lastSpeed) && lastSpeed > 0) speedParts.push(`(${lastSpeed.toFixed(2)}x)`);

            if (speedParts.length > 0) {
                try {
                    if (typeof Flow.AdditionalInfoRecorder === 'function') {
                        Flow.AdditionalInfoRecorder('Speed', speedParts.join(' '), 1);
                    }
                } catch (err) {}
            }

            if (duration > 0 && lastOutSeconds >= 0 && !isNaN(lastSpeed) && lastSpeed > 0) {
                const remaining = Math.max(0, duration - lastOutSeconds);
                const etaSeconds = remaining / lastSpeed;
                try {
                    if (typeof Flow.AdditionalInfoRecorder === 'function') {
                        Flow.AdditionalInfoRecorder('Time Left', secondsToClock(etaSeconds), 2);
                    }
                } catch (err) {}
            }
        }

        function maybeSetDurationFromLine(line) {
            if (duration && duration > 0) return;
            const m = String(line || '').match(/Duration:\s*([0-9:.]+)/i);
            if (!m) return;
            const d = helpers.parseDurationSeconds(m[1]);
            if (d > 0) duration = d;
        }

        function handleLine(line) {
            const s = String(line || '');
            if (!s) return;

            maybeSetDurationFromLine(s);

            // -progress style output: out_time_ms=12345678
            let m = s.match(/out_time_ms=([0-9]+)/i);
            if (m) {
                const ms = parseInt(m[1], 10);
                if (!isNaN(ms) && ms >= 0) tryUpdateFromSeconds(ms / 1000000.0);
                maybeUpdateAdditionalInfo(false);
                return;
            }

            // -progress style output: out_time_us=12345678
            m = s.match(/out_time_us=([0-9]+)/i);
            if (m) {
                const us = parseInt(m[1], 10);
                if (!isNaN(us) && us >= 0) tryUpdateFromSeconds(us / 1000000.0);
                maybeUpdateAdditionalInfo(false);
                return;
            }

            // -progress style output: out_time=00:00:12.34
            m = s.match(/out_time=([0-9:.]+)/i);
            if (m) {
                tryUpdateFromSeconds(helpers.parseDurationSeconds(m[1]));
                maybeUpdateAdditionalInfo(false);
                return;
            }

            // -progress style output: fps=47.3
            m = s.match(/fps=\s*([0-9.]+)/i);
            if (m) {
                const fps = parseFloat(m[1]);
                if (!isNaN(fps) && fps >= 0) lastFps = fps;
                maybeUpdateAdditionalInfo(false);
                return;
            }

            // -progress style output: speed=1.28x
            m = s.match(/speed=\s*([0-9.]+)x/i);
            if (m) {
                const sp = parseFloat(m[1]);
                if (!isNaN(sp) && sp >= 0) lastSpeed = sp;
                maybeUpdateAdditionalInfo(false);
                return;
            }

            // -stats style output: time=00:00:12.34
            m = s.match(/time=([.:0-9]+)/i);
            if (m) {
                tryUpdateFromSeconds(helpers.parseDurationSeconds(m[1]));
                maybeUpdateAdditionalInfo(false);
                return;
            }

            // Completion markers
            if (s.indexOf('progress=end') >= 0) {
                updatePercent(100, true);
                maybeUpdateAdditionalInfo(true);
            }
        }

        function complete() {
            updatePercent(100, true);
            maybeUpdateAdditionalInfo(true);
        }

        return { handleLine, complete };
    }

    function tryClearModel(keep) {
        if (keep) return;
        try {
            Variables.FfmpegBuilderModel = null;
        } catch (err) {}
        try {
            delete Variables.FfmpegBuilderModel;
        } catch (err) {}
        try {
            if (typeof Variables.Remove === 'function') Variables.Remove('FfmpegBuilderModel');
        } catch (err) {}
        try {
            if (typeof Variables.Remove === 'function') Variables.Remove('FFmpegBuilderModel');
        } catch (err) {}
    }

    // ===== VALIDATE MODEL =====
    const model = Variables.FfmpegBuilderModel || Variables.FFmpegBuilderModel;
    if (!model) {
        Logger.ELog('FFmpeg Builder model not found. Place this node after "FFmpeg Builder: Start".');
        return -1;
    }

    // ===== SKIP IF NO WORK =====
    if (!shouldExecute(model)) {
        Logger.ILog('FFmpeg Builder Executor (Single Filter): no changes detected; skipping encode.');
        tryClearModel(KeepModel);
        return 2;
    }

    // ===== TOOL PATH =====
    const ffmpegPath = String(getToolPath() || '').trim();
    if (!ffmpegPath) {
        Logger.ELog('FFmpeg not found. Ensure the FFmpeg tool is configured.');
        return -1;
    }

    HardwareDecoding = String(HardwareDecoding || 'Automatic');
    KeepModel = truthy(KeepModel);
    WriteFullArgumentsToComment =
        WriteFullArgumentsToComment === undefined || WriteFullArgumentsToComment === null
            ? true
            : truthy(WriteFullArgumentsToComment);
    MaxCommentLength = parseInt(MaxCommentLength || 32000);
    if (isNaN(MaxCommentLength) || MaxCommentLength < 0) MaxCommentLength = 32000;

    // ===== INPUT FILES =====
    let inputFiles = toEnumerableArray(model.InputFiles, 20)
        .map(normalizeInputFile)
        .filter((x) => x);
    if (inputFiles.length === 0) {
        const current =
            Variables.file && Variables.file.FullName
                ? String(Variables.file.FullName)
                : String(Flow.WorkingFile || '');
        if (!current) {
            Logger.ELog('No input file found');
            return -1;
        }
        inputFiles = [current];
    }

    // ===== OUTPUT FILE =====
    const outExt = getOutputExtension(model);
    const outFile = `${Flow.TempPath}/${Flow.NewGuid()}.${outExt}`;

    // ===== GLOBAL ARGS =====
    // Match FFmpeg Builder executor defaults as closely as possible.
    // Note: These are placed before inputs so they apply as input options.
    let args = builderDefaults.ApplyFfmpegBuilderExecutorDefaults([]);

    // Include model custom parameters early so input options (probesize/analyzeduration/etc) still apply.
    const customTokens0 = flattenTokenList(model.CustomParameters);
    if (customTokens0.length) args = args.concat(customTokens0);

    // Hardware decoding: keep it minimal and only auto-enable QSV when needed.
    const needQsv = detectNeedsQsv(model);
    const hwMode = (HardwareDecoding || 'Automatic').toLowerCase();
    const hwAllowed = hwMode !== 'off' && (hwMode === 'on' || (hwMode === 'automatic' && needQsv));
    const hasHwaccelAlready = args.some((t) => String(t || '').toLowerCase() === '-hwaccel');
    const hasInitHw = args.some((t) => String(t || '').toLowerCase() === '-init_hw_device');

    if (hwAllowed && needQsv) {
        if (!hasInitHw) args = args.concat(['-init_hw_device', 'qsv=gpu', '-filter_hw_device', 'gpu']);
        if (!hasHwaccelAlready) args = args.concat(['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv']);
    }

    // Inputs
    for (let i = 0; i < inputFiles.length; i++) args = args.concat(['-i', inputFiles[i]]);

    // ===== STREAMS =====
    function buildStream(typeChar, stream, outIndex) {
        const filterExpressions = [];
        const filtersFromModel = []
            .concat(flattenTokenList(stream.Filter))
            .concat(flattenTokenList(stream.Filters))
            .concat(flattenTokenList(stream.OptionalFilter));
        for (let i = 0; i < filtersFromModel.length; i++) filterExpressions.push(filtersFromModel[i]);

        let tokens = [];
        const ep = flattenTokenList(stream.EncodingParameters);
        const oep = flattenTokenList(stream.OptionalEncodingParameters);
        const ap = flattenTokenList(stream.AdditionalParameters);
        for (let i = 0; i < ep.length; i++) tokens.push(ep[i]);
        for (let i = 0; i < ap.length; i++) tokens.push(ap[i]);
        // Optional encoding parameters are only meaningful when encoding is actually happening.
        if (ep.length || ap.length || filtersFromModel.length) {
            for (let i = 0; i < oep.length; i++) tokens.push(oep[i]);
        }

        tokens = rewriteStreamIndexTokens(tokens, typeChar, outIndex);
        tokens = replaceIndexPlaceholders(tokens, outIndex);
        tokens = replaceSourcePlaceholders(tokens, stream);
        tokens = stripMapArgs(tokens);

        // Extract filters encoded as args (-vf/-filter:v:* or -af/-filter:a:*)
        const stripped = extractAndStripFilterArgs(tokens, typeChar);
        tokens = stripped.tokens;
        for (let i = 0; i < stripped.filters.length; i++) filterExpressions.push(stripped.filters[i]);
        const filterChain = mergeFilters(filterExpressions);

        // Determine codec, then strip codec args from tokens so we can re-add a single correct -c:*:*.
        const codecFromArgs = extractCodecFromArgs(tokens);
        const bare = extractBareCodecToken(tokens);
        tokens = bare.tokens;
        const streamCodec = stream && stream.Codec ? String(stream.Codec).trim() : '';
        // Some codecs (like PGS/DVD subs) are decoder-only names; we shouldn't try to use them as encoders.
        const isDecoderOnly = /^(hdmv_pgs_subtitle|dvd_subtitle|dvb_subtitle)$/i.test(streamCodec);
        const acceptStreamCodec = streamCodec && streamCodec.indexOf('-') === -1 && !isDecoderOnly;
        let codec = String(codecFromArgs || bare.codec || (acceptStreamCodec ? streamCodec : '') || 'copy').trim();

        if (filterChain && codec.toLowerCase() === 'copy') {
            const tc = String(typeChar || '')
                .trim()
                .toLowerCase();
            if (tc === 'a') {
                const fallback = String(chooseAudioCodecForFilters(stream, outExt) || '').trim();
                if (!fallback || fallback.toLowerCase() === 'copy') {
                    Logger.ELog(
                        `Filters are present for a:${outIndex} but codec is copy; no fallback codec is configured.`
                    );
                    return { ok: false, reason: 'copy-with-filters' };
                }
                Logger.WLog(
                    `Filters are present for a:${outIndex} but codec is copy; using '${fallback}' to allow filtering.`
                );
                codec = fallback;
            } else {
                Logger.ELog(
                    `Filters are present for ${typeChar}:${outIndex} but codec is copy; cannot filter with stream copy.`
                );
                return { ok: false, reason: 'copy-with-filters' };
            }
        }

        tokens = stripCodecArgs(tokens);
        tokens = stripBareCodecToken(tokens, codec);
        return { ok: true, codec, tokens, filterChain };
    }

    function addStreamMetadata(typeChar, stream, outIndex) {
        try {
            if (stream.Language)
                args = args.concat([`-metadata:s:${typeChar}:${outIndex}`, `language=${String(stream.Language)}`]);
        } catch (err) {}
        try {
            if (stream.Title)
                args = args.concat([`-metadata:s:${typeChar}:${outIndex}`, `title=${String(stream.Title)}`]);
        } catch (err) {}
        try {
            if (stream.IsDefault === true) args = args.concat([`-disposition:${typeChar}:${outIndex}`, 'default']);
            else if (stream.IsDefault === false) args = args.concat([`-disposition:${typeChar}:${outIndex}`, '0']);
        } catch (err) {}
    }

    // Video streams
    const videoStreams = toEnumerableArray(model.VideoStreams, 20);
    let outV = 0;
    for (let i = 0; i < videoStreams.length; i++) {
        const v = videoStreams[i];
        if (!v || v.Deleted) continue;
        const idx = getStreamIndexString(v);
        if (!idx) {
            Logger.ELog('Could not determine video stream map index');
            return -1;
        }
        args = args.concat(['-map', idx]);
        const built = buildStream('v', v, outV);
        if (!built.ok) return -1;
        args = args.concat([`-c:v:${outV}`, built.codec || 'copy']);
        // Force full-power QSV encode unless already specified (avoids unexpected low_power defaults).
        if (isQsvCodec(built.codec) && !hasLowPowerOption(args, outV) && !hasLowPowerOption(built.tokens, outV)) {
            args = args.concat([`-low_power:v:${outV}`, '0']);
        }
        if (built.tokens.length) args = args.concat(built.tokens);
        if (built.filterChain) args = args.concat([`-filter:v:${outV}`, built.filterChain]);
        addStreamMetadata('v', v, outV);
        outV++;
    }

    // Audio streams
    const audioStreams = toEnumerableArray(model.AudioStreams, 200);
    let outA = 0;
    for (let i = 0; i < audioStreams.length; i++) {
        const a = audioStreams[i];
        if (!a || a.Deleted) continue;
        const idx = getStreamIndexString(a);
        if (!idx) {
            Logger.ELog('Could not determine audio stream map index');
            return -1;
        }
        args = args.concat(['-map', idx]);
        const built = buildStream('a', a, outA);
        if (!built.ok) return -1;
        args = args.concat([`-c:a:${outA}`, built.codec || 'copy']);
        if (built.tokens.length) args = args.concat(built.tokens);
        if (built.filterChain) args = args.concat([`-filter:a:${outA}`, built.filterChain]);
        addStreamMetadata('a', a, outA);
        outA++;
    }

    // Subtitle streams
    const subtitleStreams = toEnumerableArray(model.SubtitleStreams, 200);
    let outS = 0;
    for (let i = 0; i < subtitleStreams.length; i++) {
        const s = subtitleStreams[i];
        if (!s || s.Deleted) continue;
        const idx = getStreamIndexString(s);
        if (!idx) {
            Logger.ELog('Could not determine subtitle stream map index');
            return -1;
        }
        args = args.concat(['-map', idx]);
        const built = buildStream('s', s, outS);
        if (!built.ok) return -1;
        args = args.concat([`-c:s:${outS}`, built.codec || 'copy']);
        if (built.tokens.length) args = args.concat(built.tokens);
        addStreamMetadata('s', s, outS);
        outS++;
    }

    // Attachments (fonts, etc) - mimic builder default behavior unless explicitly disabled.
    if (!truthy(model.RemoveAttachments)) {
        args = args.concat(['-map', '0:t?', '-c:t', 'copy']);
    }

    // Metadata parameters from model (but avoid double comment tags when we write our own).
    const metadataTokens0 = flattenTokenList(model.MetadataParameters);
    if (metadataTokens0.length) args = args.concat(stripExistingCommentMetadata(metadataTokens0));

    // Builder commonly appends this; keep it unless caller already set it.
    if (!hasArg(args, '-strict')) args = args.concat(['-strict', 'experimental']);

    // Write full ffmpeg command line into comment metadata for auditing.
    if (WriteFullArgumentsToComment) {
        const auditLine = buildAuditCommandLine(ffmpegPath, args.concat([outFile]));
        // let comment = `Created by FileFlows\nhttps://fileflows.com\n\n${auditLine}`;
        let comment = auditLine;
        if (MaxCommentLength > 0 && comment.length > MaxCommentLength) {
            comment = comment.substring(0, Math.max(0, MaxCommentLength - 20)) + '\n[truncated]';
            Logger.WLog(`Comment metadata truncated to ${MaxCommentLength} chars`);
        }
        args = args.concat(['-metadata', `comment=${comment}`]);
    }

    // Output
    args.push(outFile);

    // ===== LOG + EXECUTE =====
    const argsLine = (args || []).map((x) => helpers.quoteProcessArg(x)).join(' ');
    const audit = buildAuditCommandLine(ffmpegPath, args);
    Variables['FFmpegExecutor.LastCommandLine'] = audit;
    Variables['FFmpegExecutor.LastArgumentsLine'] = argsLine;

    Logger.ILog('FFmpeg.Arguments:\n' + argsLine);

    const timeout = model.TimeoutSeconds && model.TimeoutSeconds > 0 ? model.TimeoutSeconds : 0;

    // Use ExecuteArgs to stream stderr and update UI progress like the built-in FFmpeg Builder Executor.
    let executeArgs;
    try {
        executeArgs = new ExecuteArgs();
    } catch (err) {
        executeArgs = null;
    }

    let durationSeconds = tryGetDurationSeconds();
    if (!durationSeconds || durationSeconds <= 0) {
        // Some flows don't run the Video File node, so Duration variables may be missing.
        // Do a fast probe to get Duration from ffmpeg headers so progress still works.
        durationSeconds = helpers.probeDurationSeconds(ffmpegPath, inputFiles.length ? inputFiles[0] : '');
    }
    const progress = createFfmpegProgressHandler(durationSeconds);
    try {
        Flow.PartPercentageUpdate(0);
    } catch (err) {}

    let result;
    if (executeArgs) {
        executeArgs.command = ffmpegPath;
        executeArgs.argumentList = args;
        try {
            if (timeout > 0) executeArgs.timeout = timeout;
        } catch (err) {}
        try {
            if (timeout > 0) executeArgs.Timeout = timeout;
        } catch (err) {}
        try {
            if (timeout > 0) executeArgs.TimeoutSeconds = timeout;
        } catch (err) {}

        try {
            executeArgs.add_Error((line) => {
                progress.handleLine(line);
            });
        } catch (err) {}
        try {
            executeArgs.add_Output((line) => {
                progress.handleLine(line);
            });
        } catch (err) {}

        result = Flow.Execute(executeArgs);
    } else {
        // Fallback: no streaming support available in this runner; execute normally (no progress).
        result = Flow.Execute({ command: ffmpegPath, argumentList: args, timeout: timeout });
    }

    if (!result || result.exitCode !== 0) {
        const code = result ? result.exitCode : -1;
        Logger.ELog(`FFmpeg failed (exitCode=${code}).`);
        if (result && result.output) Logger.ELog(String(result.output).substring(0, 20000));
        if (result && result.standardError) Logger.ELog(String(result.standardError).substring(0, 20000));
        return -1;
    }

    progress.complete();

    // Update working file and optionally clear model.
    Flow.SetWorkingFile(outFile);
    tryClearModel(KeepModel);
    return 1;
}
