/**
 * @description Executes the FFmpeg Builder model but guarantees only one video filter option per output stream by merging all upstream filters into a single `-filter:v:N` argument.
 * @author Vincent Courcelle
 * @revision 7
 * @minimumVersion 25.0.0.0
 * @param {('Automatic'|'On'|'Off')} HardwareDecoding Hardware decoding mode. Automatic enables it when QSV filters/encoders are detected. Default: Automatic.
 * @param {bool} KeepModel Keep the builder model variable after executing. Default: false.
 * @param {bool} WriteFullArgumentsToComment Write the full ffmpeg command-line into the output container `comment` tag (useful for auditing encodes). Default: true.
 * @param {int} MaxCommentLength Max chars for the comment metadata (0 = unlimited). Default: 32000.
 * @output Executed FFmpeg
 * @output Skipped (no changes)
 */
function Script(HardwareDecoding, KeepModel, WriteFullArgumentsToComment, MaxCommentLength) {
    function truthy(value) { return value === true || value === 'true' || value === 1 || value === '1'; }

    function safeTokenString(token) {
        if (token === null || token === undefined) return '';
        if (typeof token === 'string' || typeof token === 'number' || typeof token === 'boolean') return String(token);
        try {
            const json = JSON.stringify(token);
            if (json && json !== '{}' && json !== '[]') return json;
        } catch (err) { }
        return String(token);
    }

    function toEnumerableArray(value, maxItems) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [value];

        const limit = maxItems || 500;

        // .NET IEnumerable via GetEnumerator()
        try {
            if (typeof value.GetEnumerator === 'function') {
                const result = [];
                const enumerator = value.GetEnumerator();
                let count = 0;
                while (enumerator.MoveNext() && count < limit) {
                    result.push(enumerator.Current);
                    count++;
                }
                return result;
            }
        } catch (err) { }

        // .NET List<T> style (Count + indexer)
        try {
            if (typeof value.Count === 'number') {
                const result = [];
                const count = Math.min(value.Count, limit);
                for (let i = 0; i < count; i++) result.push(value[i]);
                return result;
            }
        } catch (err) { }

        return [value];
    }

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
                } catch (err) { }
            }
            return s;
        }
        if (typeof value === 'object') {
            try { if (value.FileName) return String(value.FileName).trim(); } catch (err) { }
            try { if (value.FullName) return String(value.FullName).trim(); } catch (err) { }
            try { if (value.Path) return String(value.Path).trim(); } catch (err) { }
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
            if (escape) { cur += ch; escape = false; continue; }
            if (ch === '\\\\') { escape = true; continue; }
            if (ch === '"') { inQuotes = !inQuotes; continue; }
            if (!inQuotes && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) {
                if (cur.length) { out.push(cur); cur = ''; }
                continue;
            }
            cur += ch;
        }
        if (cur.length) out.push(cur);
        return out;
    }

    function flattenTokenList(value) {
        const items = toEnumerableArray(value, 5000).map(safeTokenString).map(x => String(x || '').trim()).filter(x => x);
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

    function quoteForAudit(arg) {
        const s = String((arg === undefined || arg === null) ? '' : arg);
        if (s.length === 0) return '""';
        if (!/[\\s\"]/g.test(s)) return s;
        return '"' + s.replace(/\\/g, '\\\\').replace(/\"/g, '\\"') + '"';
    }

    function buildAuditCommandLine(executable, args) {
        const tokens = [quoteForAudit(executable)];
        for (let i = 0; i < (args || []).length; i++) tokens.push(quoteForAudit(args[i]));
        return tokens.join(' ');
    }

    function splitFilterChain(chain) {
        const s = String(chain || '');
        const parts = [];
        let cur = '';
        let escaped = false;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (escaped) { cur += ch; escaped = false; continue; }
            if (ch === '\\\\') { cur += ch; escaped = true; continue; }
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
        const lowered = flat.map(x => x.toLowerCase());
        const hasP010 = lowered.some(x => x.indexOf('format=p010le') >= 0 || x.indexOf('p010le') >= 0);
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
            const val = (i + 1 < tokens.length) ? String(tokens[i + 1] || '').trim() : '';
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
            const t = String(tokens[i] || '').trim().toLowerCase();
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
            if (lower === '-c' || lower.indexOf('-c:') === 0) { i++; continue; }
            out.push(t);
        }
        return out;
    }

    function stripBareCodecToken(tokens, codec) {
        const c = String(codec || '').trim().toLowerCase();
        if (!c) return tokens || [];
        const out = [];
        for (let i = 0; i < (tokens || []).length; i++) {
            const t = String(tokens[i] || '').trim();
            if (!t) continue;
            if (t.toLowerCase() === c) {
                const prev = (i > 0) ? String(tokens[i - 1] || '').trim().toLowerCase() : '';
                const prevIsCodecFlag = (prev === '-c' || prev.indexOf('-c:') === 0);
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
            if (stream && stream.TypeIndex !== undefined && stream.TypeIndex !== null) return parseInt(stream.TypeIndex);
        } catch (err) { }
        try {
            const s = (stream && stream.Stream) ? stream.Stream : null;
            if (s && s.TypeIndex !== undefined && s.TypeIndex !== null) return parseInt(s.TypeIndex);
        } catch (err) { }
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
            if (lower === '-map') { i++; continue; }
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
            const vs = toEnumerableArray((model && model.VideoStreams) ? model.VideoStreams : null, 20);
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
        } catch (err) { }

        return false;
    }

    function getToolPath() {
        try { return Flow.GetToolPath('ffmpeg'); } catch (e) { }
        try { return Flow.GetToolPath('FFmpeg'); } catch (e) { }
        // fallback to common variables
        return Variables['ffmpeg'] || Variables['FFmpeg'] || Variables.ffmpeg || Variables.FFmpeg || '';
    }

    function hasArg(tokens, flag) {
        const f = String(flag || '').toLowerCase();
        for (let i = 0; i < (tokens || []).length; i++) {
            if (String(tokens[i] || '').toLowerCase() === f) return true;
        }
        return false;
    }

    function stripExistingCommentMetadata(tokens) {
        // Remove pairs like: -metadata comment=...
        const out = [];
        for (let i = 0; i < (tokens || []).length; i++) {
            const t = String(tokens[i] || '').trim();
            if (t.toLowerCase() !== '-metadata') { out.push(t); continue; }
            const val = (i + 1 < tokens.length) ? String(tokens[i + 1] || '') : '';
            if (/^comment=/i.test(val || '')) { i++; continue; }
            out.push(t);
            if (i + 1 < tokens.length) { out.push(tokens[i + 1]); i++; }
        }
        return out;
    }

    function getOutputExtension(model) {
        const ext = String((model && model.Extension) ? model.Extension : '').trim();
        if (ext) return ext.replace(/^\\./, '');
        // fallback to current file extension
        try {
            const varFile = (Variables && Variables.file) ? Variables.file : null;
            const fn = String(Flow.WorkingFileName || (varFile ? varFile.Name : '') || '');
            const idx = fn.lastIndexOf('.');
            if (idx > 0) return fn.substring(idx + 1);
        } catch (err) { }
        return 'mkv';
    }

    function getStreamIndexString(stream) {
        try {
            const s = (stream && stream.Stream) ? stream.Stream : null;
            if (s && s.IndexString) return String(s.IndexString);
        } catch (err) { }
        // fallback: inputFileIndex:type:typeIndex
        try {
            const s = (stream && stream.Stream) ? stream.Stream : null;
            if (s && s.InputFileIndex !== undefined && s.InputFileIndex !== null && s.TypeIndex !== undefined && s.TypeIndex !== null && s.Type) {
                const type = String(s.Type || '').toLowerCase();
                let typeChar = 'v';
                if (type.indexOf('audio') >= 0) typeChar = 'a';
                else if (type.indexOf('subtitle') >= 0) typeChar = 's';
                return `${s.InputFileIndex}:${typeChar}:${s.TypeIndex}`;
            }
        } catch (err) { }
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

    function tryClearModel(keep) {
        if (keep) return;
        try { Variables.FfmpegBuilderModel = null; } catch (err) { }
        try { delete Variables.FfmpegBuilderModel; } catch (err) { }
        try { if (typeof Variables.Remove === 'function') Variables.Remove('FfmpegBuilderModel'); } catch (err) { }
        try { if (typeof Variables.Remove === 'function') Variables.Remove('FFmpegBuilderModel'); } catch (err) { }
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
    WriteFullArgumentsToComment = (WriteFullArgumentsToComment === undefined || WriteFullArgumentsToComment === null) ? true : truthy(WriteFullArgumentsToComment);
    MaxCommentLength = parseInt(MaxCommentLength || 32000);
    if (isNaN(MaxCommentLength) || MaxCommentLength < 0) MaxCommentLength = 32000;

    // ===== INPUT FILES =====
    let inputFiles = toEnumerableArray(model.InputFiles, 20).map(normalizeInputFile).filter(x => x);
    if (inputFiles.length === 0) {
        const current = (Variables.file && Variables.file.FullName) ? String(Variables.file.FullName) : String(Flow.WorkingFile || '');
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
    let args = [
        '-fflags', '+genpts',
        '-probesize', '300M',
        '-analyzeduration', '240000000',
        '-y',
        '-stats_period', '5'
    ];

    // Include model custom parameters early so input options (probesize/analyzeduration/etc) still apply.
    const customTokens0 = flattenTokenList(model.CustomParameters);
    if (customTokens0.length) args = args.concat(customTokens0);

    // Hardware decoding: keep it minimal and only auto-enable QSV when needed.
    const needQsv = detectNeedsQsv(model);
    const hwMode = (HardwareDecoding || 'Automatic').toLowerCase();
    const hwAllowed = hwMode !== 'off' && (hwMode === 'on' || (hwMode === 'automatic' && needQsv));
    const hasHwaccelAlready = args.some(t => String(t || '').toLowerCase() === '-hwaccel');
    const hasInitHw = args.some(t => String(t || '').toLowerCase() === '-init_hw_device');

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
        const streamCodec = (stream && stream.Codec) ? String(stream.Codec).trim() : '';
        const acceptStreamCodec = streamCodec && streamCodec.indexOf('-') === -1;
        const codec = String(codecFromArgs || bare.codec || (acceptStreamCodec ? streamCodec : '') || 'copy').trim();

        if (filterChain && codec.toLowerCase() === 'copy') {
            Logger.ELog(`Filters are present for ${typeChar}:${outIndex} but codec is copy; cannot filter with stream copy.`);
            return { ok: false, reason: 'copy-with-filters' };
        }

        tokens = stripCodecArgs(tokens);
        tokens = stripBareCodecToken(tokens, codec);
        return { ok: true, codec, tokens, filterChain };
    }

    function addStreamMetadata(typeChar, stream, outIndex) {
        try {
            if (stream.Language) args = args.concat([`-metadata:s:${typeChar}:${outIndex}`, `language=${String(stream.Language)}`]);
        } catch (err) { }
        try {
            if (stream.Title) args = args.concat([`-metadata:s:${typeChar}:${outIndex}`, `title=${String(stream.Title)}`]);
        } catch (err) { }
        try {
            if (stream.IsDefault === true) args = args.concat([`-disposition:${typeChar}:${outIndex}`, 'default']);
            else if (stream.IsDefault === false) args = args.concat([`-disposition:${typeChar}:${outIndex}`, '0']);
        } catch (err) { }
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
    const argsLine = (args || []).map(quoteForAudit).join(' ');
    const audit = buildAuditCommandLine(ffmpegPath, args);
    Variables['FFmpegExecutor.LastCommandLine'] = audit;
    Variables['FFmpegExecutor.LastArgumentsLine'] = argsLine;

    Logger.ILog('FFmpeg.Arguments:\n' + argsLine);

    const timeout = (model.TimeoutSeconds && model.TimeoutSeconds > 0) ? model.TimeoutSeconds : 0;
    const result = Flow.Execute({ command: ffmpegPath, argumentList: args, timeout: timeout });

    if (!result || result.exitCode !== 0) {
        const code = result ? result.exitCode : -1;
        Logger.ELog(`FFmpeg failed (exitCode=${code}).`);
        if (result && result.output) Logger.ELog(String(result.output).substring(0, 3000));
        if (result && result.standardError) Logger.ELog(String(result.standardError).substring(0, 3000));
        return -1;
    }

    // Update working file and optionally clear model.
    Flow.SetWorkingFile(outFile);
    tryClearModel(KeepModel);
    return 1;
}
