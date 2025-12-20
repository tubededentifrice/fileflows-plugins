/**
 * @description Apply intelligent video filters based on content type, year, and genre to improve compression while maintaining quality. Preserves HDR10/DoVi color metadata.
 * @author Vincent Courcelle
 * @revision 34
 * @param {bool} SkipDenoise Skip all denoising filters
 * @param {bool} AggressiveCompression Enable aggressive compression for old/restored content (stronger denoise)
 * @param {bool} UseCPUFilters Prefer CPU filters (hqdn3d, deband, gradfun). If hardware encoding is detected, this will be ignored unless AllowCpuFiltersWithHardwareEncode is enabled.
 * @param {bool} AllowCpuFiltersWithHardwareEncode Allow CPU filters even when a hardware encoder is detected (advanced; may break hardware pipelines depending on runner settings)
 * @param {bool} AutoDeinterlace Auto-detect interlaced content and enable QSV deinterlacing (uses a quick `idet` probe)
 * @param {bool} MpDecimateAnimation Force-enable `mpdecimate` for animation/anime sources (unchecked = auto; drops duplicate frames; forces VFR output via `-vsync vfr`)
 * @output Cleaned video
 */
function Script(SkipDenoise, AggressiveCompression, UseCPUFilters, AllowCpuFiltersWithHardwareEncode, AutoDeinterlace, MpDecimateAnimation) {
    Logger.ILog('Cleaning filters.js revision 34 loaded');
    const truthyVar = (value) => value === true || value === 'true' || value === 1 || value === '1';
    SkipDenoise = truthyVar(SkipDenoise) || truthyVar(Variables.SkipDenoise);
    AggressiveCompression = truthyVar(AggressiveCompression) || truthyVar(Variables.AggressiveCompression);
    MpDecimateAnimation = truthyVar(MpDecimateAnimation) || truthyVar(Variables.MpDecimateAnimation);
    function normalizeBitrateToKbps(value) {
        if (!value || isNaN(value)) return 0;
        // FileFlows VideoInfo.Bitrate is typically in bits/sec. If it's already in kbps this won't trip.
        if (value > 1000000) return Math.round(value / 1000);
        return Math.round(value);
    }

    function toEnumerableArray(value, maxItems) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [value];

        const limit = maxItems || 200;

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
                for (let i = 0; i < count; i++) {
                    // Jint typically supports indexer access via [i]
                    result.push(value[i]);
                }
                return result;
            }
        } catch (err) { }

        return [value];
    }

    function safeTokenString(token) {
        if (token === null || token === undefined) return '';
        if (typeof token === 'string' || typeof token === 'number' || typeof token === 'boolean') return String(token);
        try {
            const json = JSON.stringify(token);
            if (json && json !== '{}') return json;
        } catch (err) { }
        return String(token);
    }

    function asJoinedString(value) {
        if (!value) return '';
        const tokens = toEnumerableArray(value, 500).map(safeTokenString).filter(x => x);
        if (tokens.length) return tokens.join(' ');
        return safeTokenString(value);
    }

    function listAdd(list, item) {
        if (!list) return false;
        if (Array.isArray(list)) {
            list.push(item);
            return true;
        }
        try {
            if (typeof list.Add === 'function') {
                list.Add(item);
                return true;
            }
        } catch (err) { }
        return false;
    }

    function listAddUnique(list, item) {
        if (!list) return false;
        try {
            const existing = toEnumerableArray(list, 2000).map(safeTokenString);
            if (existing.indexOf(item) >= 0) return true;
        } catch (err) { }
        return listAdd(list, item);
    }

    function listSetAt(list, index, value) {
        if (!list) return false;
        try {
            // JS array or .NET indexer
            list[index] = value;
            return true;
        } catch (err) { }
        try {
            if (typeof list.RemoveAt === 'function' && typeof list.Insert === 'function') {
                list.RemoveAt(index);
                list.Insert(index, value);
                return true;
            }
        } catch (err) { }
        return false;
    }

    function listRemoveAt(list, index) {
        if (!list) return false;
        try {
            if (Array.isArray(list)) {
                list.splice(index, 1);
                return true;
            }
        } catch (err) { }
        try {
            if (typeof list.RemoveAt === 'function') {
                list.RemoveAt(index);
                return true;
            }
        } catch (err) { }
        return false;
    }

    function listCount(list) {
        if (!list) return null;
        if (Array.isArray(list)) return list.length;
        try {
            if (typeof list.Count === 'number') return list.Count;
        } catch (err) { }
        return null;
    }

    function findArgIndex(list, predicate) {
        const count = listCount(list);
        if (count === null) return -1;
        for (let i = 0; i < count; i++) {
            const t = String(safeTokenString(list[i]) || '').trim();
            if (predicate(t, i)) return i;
        }
        return -1;
    }

    function hasArg(list, predicate) {
        return findArgIndex(list, predicate) >= 0;
    }

    function removeArgWithValue(list, predicate) {
        const count0 = listCount(list);
        if (count0 === null) return { removed: false, removedCount: 0 };
        let removedCount = 0;
        let i = 0;
        while (i < listCount(list)) {
            const t = String(safeTokenString(list[i]) || '').trim();
            if (!predicate(t, i)) { i++; continue; }
            if (i < (listCount(list) - 1)) {
                if (listRemoveAt(list, i + 1)) removedCount++;
            }
            if (listRemoveAt(list, i)) removedCount++;
            continue;
        }
        return { removed: removedCount > 0, removedCount };
    }

    function ensureArgWithValue(list, flag, value, predicate) {
        const count0 = listCount(list);
        if (count0 === null) return false;
        const pred = predicate || ((t) => t === flag);
        if (hasArg(list, pred)) return false;
        listAdd(list, flag);
        listAdd(list, value);
        return true;
    }

    function flattenFilterExpressions(filters) {
        const parts = [];
        for (let i = 0; i < (filters || []).length; i++) {
            const f = String(filters[i] || '').trim();
            if (!f) continue;
            const split = f.split(',').map(x => x.trim()).filter(x => x);
            for (let j = 0; j < split.length; j++) parts.push(split[j]);
        }
        return parts;
    }

    function mergeVppQsv(existing, desired) {
        // existing/desired like: vpp_qsv=denoise=13:format=p010le
        const parse = (s) => {
            const result = { name: '', items: [], map: {} };
            if (!s) return result;
            const t = String(s).trim();
            const eq = t.indexOf('=');
            if (eq < 0) { result.name = t; return result; }
            result.name = t.substring(0, eq);
            const opts = t.substring(eq + 1).split(':').map(x => x.trim()).filter(x => x);
            for (let i = 0; i < opts.length; i++) {
                const o = opts[i];
                const p = o.indexOf('=');
                if (p > 0) {
                    const k = o.substring(0, p);
                    const v = o.substring(p + 1);
                    result.items.push({ k, v });
                    result.map[k] = v;
                } else {
                    result.items.push({ k: o, v: null });
                    result.map[o] = null;
                }
            }
            return result;
        };

        const a = parse(existing);
        const b = parse(desired);
        if (a.name !== 'vpp_qsv' || b.name !== 'vpp_qsv') return desired || existing;

        const merged = [];
        const seen = {};

        // Keep existing order, override values when desired provides them.
        for (let i = 0; i < a.items.length; i++) {
            const it = a.items[i];
            const key = it.k;
            if (key in b.map) {
                merged.push(key + (b.map[key] !== null ? '=' + b.map[key] : ''));
                seen[key] = true;
            } else {
                merged.push(key + (it.v !== null ? '=' + it.v : ''));
                seen[key] = true;
            }
        }

        // Append desired-only keys in desired order.
        for (let i = 0; i < b.items.length; i++) {
            const it = b.items[i];
            if (seen[it.k]) continue;
            merged.push(it.k + (it.v !== null ? '=' + it.v : ''));
        }

        return 'vpp_qsv=' + merged.join(':');
    }

    function tryAppendFilterToBuilderList(videoStream, propName, filter) {
        if (!videoStream || !propName || !filter) return false;
        let current = null;
        try { current = videoStream[propName]; } catch (err) { return false; }

        // Some runner versions expose Filter as a single string (one filtergraph).
        try {
            if (typeof current === 'string') {
                const existing = String(current || '').trim();
                if (!existing) {
                    videoStream[propName] = filter;
                    return true;
                }
                const parts = existing.split(',').map(x => x.trim()).filter(x => x);
                if (parts.indexOf(filter) >= 0) return true;
                videoStream[propName] = existing + ',' + filter;
                return true;
            }
        } catch (err) { }

        // If it's already a mutable JS/.NET list, use it.
        if (listAddUnique(current, filter)) return true;

        // Try replacing fixed-size arrays (eg: System.String[]) with a new array that includes the filter.
        try {
            const existing = toEnumerableArray(current, 2000).map(safeTokenString).filter(x => x);
            if (existing.indexOf(filter) >= 0) return true;
            const newArr = System.Array.CreateInstance(System.String, existing.length + 1);
            for (let i = 0; i < existing.length; i++) newArr.SetValue(existing[i], i);
            newArr.SetValue(filter, existing.length);
            videoStream[propName] = newArr;
            return true;
        } catch (err) { }

        // Last resort: assign a JS array and hope the runner can enumerate it.
        try {
            const existing = toEnumerableArray(current, 2000).map(safeTokenString).filter(x => x);
            if (existing.indexOf(filter) >= 0) return true;
            videoStream[propName] = existing.concat([filter]);
            return true;
        } catch (err) { }

        return false;
    }

    function ensureSingleVideoFilterArgAcrossParams(videoStream, filtersToApply, addIfMissing) {
        const rawFilters = (filtersToApply || []).map(x => String(x || '').trim()).filter(x => x);
        if (rawFilters.length === 0) return { changed: false, reason: 'no-filters' };

        const ep = videoStream ? videoStream.EncodingParameters : null;
        const ap = videoStream ? videoStream.AdditionalParameters : null;
        if (!ep && !ap) return { changed: false, reason: 'no-param-lists' };

        const isVideoFilterFlag = (t) => {
            const s = String(t || '').trim();
            return s === '-vf' || s === '-filter:v' || s === '-filter:v:0';
        };

        const collectFilterChains = (list) => {
            const chains = [];
            const count = listCount(list);
            if (count === null) return chains;
            for (let i = 0; i < count - 1; i++) {
                const t = safeTokenString(list[i]);
                if (!isVideoFilterFlag(t)) continue;
                const v = safeTokenString(list[i + 1]);
                if (v) chains.push(String(v).trim());
                i++;
            }
            return chains;
        };

        const removeAllVideoFilterArgs = (list) => {
            const count0 = listCount(list);
            if (count0 === null) return false;
            let removed = false;
            let i = 0;
            while (i < (listCount(list) - 1)) {
                const t = safeTokenString(list[i]);
                if (!isVideoFilterFlag(t)) { i++; continue; }
                if (listRemoveAt(list, i + 1)) removed = true;
                if (listRemoveAt(list, i)) removed = true;
                continue;
            }
            return removed;
        };

        const existingChains = [
            ...collectFilterChains(ep),
            ...collectFilterChains(ap)
        ].filter(x => x);

        if (!addIfMissing && existingChains.length === 0) {
            return { changed: false, reason: 'no-existing-filter-args', before: '', after: '' };
        }

        const before = existingChains.join(' | ');

        // IMPORTANT: If our desired chain contains hwdownload/hwupload, we must preserve ordering and duplicates
        // (eg: format=p010le may be needed before and after CPU filters). Avoid splitting/deduping in this case.
        const preserveOrderAndDuplicates = rawFilters.some(f => f.indexOf('hwdownload') >= 0 || f.indexOf('hwupload') >= 0);
        if (preserveOrderAndDuplicates) {
            const after = rawFilters.join(',');
            const removedEp = removeAllVideoFilterArgs(ep);
            const removedAp = removeAllVideoFilterArgs(ap);

            const target = ep || ap;
            if (!target) return { changed: false, reason: 'no-target-list', before, after: '' };

            listAdd(target, '-filter:v:0');
            listAdd(target, after);

            const changed = removedEp || removedAp || (String(before || '').trim() !== String(after || '').trim());
            return { changed, reason: 'replaced-preserve-order', before, after };
        }

        const partsToApply = flattenFilterExpressions(rawFilters);
        const existingParts = flattenFilterExpressions(existingChains);

        let mergedParts = [];
        if (existingParts.length) {
            const seen = {};
            for (let i = 0; i < existingParts.length; i++) {
                const p = existingParts[i];
                if (!p || seen[p]) continue;
                seen[p] = true;
                mergedParts.push(p);
            }
        }

        const isFormatOnlyScaleQsv = (p) => p === 'scale_qsv=format=p010le' || p === 'scale_qsv=format=nv12';
        const desiredHasVpp = partsToApply.some(p => p.startsWith('vpp_qsv='));

        for (let i = 0; i < partsToApply.length; i++) {
            const desired = partsToApply[i];
            if (!desired) continue;

            if (desired.startsWith('vpp_qsv=')) {
                const vppIndex = mergedParts.findIndex(p => p.startsWith('vpp_qsv='));
                if (vppIndex >= 0) {
                    mergedParts[vppIndex] = mergeVppQsv(mergedParts[vppIndex], desired);
                    continue;
                }
                const scaleIndex = mergedParts.findIndex(p => isFormatOnlyScaleQsv(p));
                if (scaleIndex >= 0) {
                    mergedParts[scaleIndex] = desired;
                    continue;
                }
            }

            if (mergedParts.indexOf(desired) < 0) mergedParts.push(desired);
        }

        // If we have vpp_qsv with an explicit format, drop redundant format-only scale_qsv.
        if (desiredHasVpp) {
            const hasFormatInVpp = mergedParts.some(p => p.startsWith('vpp_qsv=') && p.indexOf('format=') >= 0);
            if (hasFormatInVpp) mergedParts = mergedParts.filter(p => !isFormatOnlyScaleQsv(p));
        }

        const after = mergedParts.join(',');

        const removedEp = removeAllVideoFilterArgs(ep);
        const removedAp = removeAllVideoFilterArgs(ap);

        const target = ep || ap;
        if (!target) return { changed: false, reason: 'no-target-list', before, after: '' };

        listAdd(target, '-filter:v:0');
        listAdd(target, after);

        const changed = removedEp || removedAp || (String(before || '').trim() !== String(after || '').trim());
        return { changed, reason: existingChains.length ? 'merged-and-deduped' : 'added-filter-arg', before, after };
    }

    function preventQsvPixFmtDoubleFilter(videoStream, hwEncoder, targetBitDepth, filtersToApply) {
        if (!videoStream || hwEncoder !== 'qsv' || !(targetBitDepth >= 10)) return { changed: false, reason: 'not-qsv-10bit' };

        // Only remove -pix_fmt if our computed filters already force p010le (so we still get 10-bit surfaces).
        const filterSig = flattenFilterExpressions(filtersToApply).join(',').toLowerCase();
        if (filterSig.indexOf('p010le') < 0) return { changed: false, reason: 'filters-not-forcing-p010le' };

        try {
            const pixFmtPred = (t) => t === '-pix_fmt' || t.startsWith('-pix_fmt:') || t.startsWith('-pix_fmt:v');
            const r1 = removeArgWithValue(videoStream.EncodingParameters, pixFmtPred);
            const r2 = removeArgWithValue(videoStream.AdditionalParameters, pixFmtPred);

            let changed = r1.removed || r2.removed;

            if (changed) {
                Variables.removed_pix_fmt_for_qsv = true;
                Logger.WLog('Removed -pix_fmt from QSV encoder args; filters already force p010le so this prevents Builder injecting a second -filter:v:0 scale_qsv=format=p010le');
            }

            // Ensure we still request a 10-bit HEVC profile when targeting 10-bit output.
            const encSig = (asJoinedString(videoStream.EncodingParameters) + ' ' + asJoinedString(videoStream.Codec)).toLowerCase();
            const isHevcQsv = encSig.indexOf('hevc_qsv') >= 0;
            if (isHevcQsv) {
                const ep = videoStream.EncodingParameters;
                const profilePred = (t) => t === '-profile' || t.startsWith('-profile:') || t.startsWith('-profile:v');
                if (listCount(ep) !== null) {
                    const addedProfile = ensureArgWithValue(ep, '-profile:v:0', 'main10', profilePred);
                    if (addedProfile) {
                        Variables.applied_qsv_profile = 'main10';
                        Logger.ILog('Applied QSV profile: -profile:v:0 main10');
                        changed = true;
                    }
                }
            }

            return { changed, reason: changed ? 'removed-pix_fmt' : 'no-change' };
        } catch (err) {
            return { changed: false, reason: 'error', error: String(err) };
        }
    }

    function addVideoFilter(videoStream, filter) {
        if (!filter) return null;
        // Prefer Filter (singular) - this is what the Builder checks for pixel format conversion.
        // If Filter has content, the Builder may skip adding its own scale_qsv filter.
        if (tryAppendFilterToBuilderList(videoStream, 'Filter', filter)) return 'Filter';
        // Filters (plural) is often null in FFmpeg Builder; try it second.
        if (tryAppendFilterToBuilderList(videoStream, 'Filters', filter)) return 'Filters';
        // OptionalFilter is not reliably applied in all builder modes; prefer it last.
        if (tryAppendFilterToBuilderList(videoStream, 'OptionalFilter', filter)) return 'OptionalFilter';
        return null;
    }

    function removeScaleQsvFormatFilters(videoStream) {
        // The Video Encode Advanced node adds `scale_qsv=format=p010le` (or nv12) to the video stream's
        // filter properties when 10-bit output is selected. This causes a duplicate `-filter:v:0` argument
        // when we also add our vpp_qsv filter. Remove any format-only scale_qsv filters so ours takes precedence.
        const isFormatOnlyScaleQsv = (s) => {
            const t = String(s || '').trim().toLowerCase();
            return t === 'scale_qsv=format=p010le' || t === 'scale_qsv=format=nv12';
        };

        let removed = 0;
        const propNames = ['Filter', 'Filters', 'OptionalFilter'];

        for (const propName of propNames) {
            try {
                const current = videoStream[propName];
                if (!current) continue;

                // Handle string property (single filter chain)
                if (typeof current === 'string') {
                    const parts = current.split(',').map(x => x.trim()).filter(x => x && !isFormatOnlyScaleQsv(x));
                    const newValue = parts.join(',');
                    if (newValue !== current) {
                        videoStream[propName] = newValue || null;
                        removed++;
                        Logger.ILog(`Removed scale_qsv format filter from video.${propName}`);
                    }
                    continue;
                }

                // Handle list/array property
                const count = listCount(current);
                if (count === null) continue;

                let i = 0;
                while (i < listCount(current)) {
                    const item = safeTokenString(current[i]);
                    if (isFormatOnlyScaleQsv(item)) {
                        if (listRemoveAt(current, i)) {
                            removed++;
                            Logger.ILog(`Removed scale_qsv format filter from video.${propName}[${i}]`);
                            continue;
                        }
                    }
                    i++;
                }
            } catch (err) {
                Logger.DLog(`Error checking video.${propName} for scale_qsv: ${err}`);
            }
        }

        return removed;
    }

    function detectHardwareEncoder(videoStream) {
        const signature = [
            asJoinedString(videoStream.EncodingParameters),
            asJoinedString(videoStream.AdditionalParameters),
            asJoinedString(videoStream.Codec)
        ].join(' ').toLowerCase();

        if (signature.includes('_qsv') || signature.includes(' qsv')) return 'qsv';
        if (signature.includes('_vaapi') || signature.includes(' vaapi')) return 'vaapi';
        if (signature.includes('_nvenc') || signature.includes(' nvenc')) return 'nvenc';
        if (signature.includes('_amf') || signature.includes(' amf')) return 'amf';
        return null;
    }

    function detectTargetBitDepth(videoStream) {
        const signature = [
            asJoinedString(videoStream.EncodingParameters),
            asJoinedString(videoStream.AdditionalParameters)
        ].join(' ').toLowerCase();

        if (signature.includes('p010') || signature.includes('main10') || signature.includes('10bit') || signature.includes('10-bit')) return 10;
        return 8;
    }

    function ensureVsyncVfrInEncodingParameters(videoStream) {
        try {
            const ep = videoStream ? videoStream.EncodingParameters : null;
            if (!ep) return { changed: false, reason: 'no-encoding-params' };

            const tokens = toEnumerableArray(ep, 5000).map(safeTokenString).filter(x => x);
            for (let i = 0; i < tokens.length; i++) {
                const t = String(tokens[i] || '').trim().toLowerCase();
                if (t === '-vsync' || t.startsWith('-vsync:') || t.startsWith('-fps_mode')) {
                    return { changed: false, reason: 'already-present' };
                }
            }

            listAdd(ep, '-vsync');
            listAdd(ep, 'vfr');
            return { changed: true, reason: 'added' };
        } catch (err) {
            return { changed: false, reason: 'error', error: String(err) };
        }
    }

    function detectHardwareFramesLikely(videoStream) {
        try {
            const tokens = [
                ...toEnumerableArray(videoStream.EncodingParameters, 5000).map(safeTokenString),
                ...toEnumerableArray(videoStream.AdditionalParameters, 5000).map(safeTokenString)
            ].map(x => String(x || '').trim()).filter(x => x);

            for (let i = 0; i < tokens.length - 1; i++) {
                const t = tokens[i].toLowerCase();
                const n = (tokens[i + 1] || '').toLowerCase();
                if (t === '-hwaccel_output_format' && (n === 'qsv' || n === 'vaapi' || n === 'cuda' || n === 'd3d11va')) return true;
                if (t === '-hwaccel' && (n === 'qsv' || n === 'vaapi' || n === 'cuda' || n === 'd3d11va')) return true;
            }

            const sig = tokens.join(' ').toLowerCase();
            if (sig.includes('init_hw_device') || sig.includes('filter_hw_device') || sig.includes('hwupload') || sig.includes('hwmap')) return true;
        } catch (err) { }
        return false;
    }

    function parseProgressFrameCount(outputText) {
        const text = String(outputText || '');
        const re = /(?:^|\n)frame=(\d+)(?:\n|$)/g;
        let m;
        let last = null;
        while ((m = re.exec(text)) !== null) last = parseInt(m[1]) || 0;
        return last;
    }

    function measureFramesForSegment(ffmpegPath, inputFile, ssSeconds, sampleSeconds, vf) {
        const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-ss', String(ssSeconds), '-i', inputFile, '-an', '-sn', '-t', String(sampleSeconds)];
        if (vf) {
            args.push('-vf');
            args.push(vf);
        }
        args.push('-f');
        args.push('null');
        args.push('-');

        const process = Flow.Execute({
            command: ffmpegPath,
            argumentList: args,
            timeout: 180
        });

        if (!process || process.exitCode !== 0) return null;
        const combined = (process.standardOutput || '') + '\n' + (process.standardError || '');
        const frames = parseProgressFrameCount(combined);
        if (!frames || frames <= 0) return null;
        return frames;
    }

    function shouldEnableMpDecimateAuto(ffmpegPath, inputFile, durationSeconds, sourceFps, year, isAnimation) {
        if (!isAnimation) return { enable: false, reason: 'not-animation' };

        // High-FPS anime encodes (59.94/60) are common and often contain lots of duplicates (24p content in a 60p stream).
        if (sourceFps && sourceFps >= 48) return { enable: true, reason: 'high-fps' };

        // Older animation tends to have more repeats/holds; probe to avoid unnecessary VFR outputs.
        if (!ffmpegPath || !inputFile) return { enable: false, reason: 'no-probe' };

        const sampleSeconds = 12;
        let ss = 0;
        if (durationSeconds && durationSeconds > (sampleSeconds + 40)) {
            ss = Math.min(300, Math.max(30, Math.floor(durationSeconds * 0.25)));
        }

        const baseFrames = measureFramesForSegment(ffmpegPath, inputFile, ss, sampleSeconds, null);
        const decFrames = measureFramesForSegment(ffmpegPath, inputFile, ss, sampleSeconds, mpDecimateFilter);
        if (!baseFrames || !decFrames) return { enable: false, reason: 'probe-failed' };

        const dropRatio = 1 - (decFrames / baseFrames);
        Variables.mpdecimate_probe_ss = ss;
        Variables.mpdecimate_probe_seconds = sampleSeconds;
        Variables.mpdecimate_probe_base_frames = baseFrames;
        Variables.mpdecimate_probe_dec_frames = decFrames;
        Variables.mpdecimate_probe_drop_ratio = Math.round(dropRatio * 1000) / 1000;

        // Enable when we save a meaningful number of frames (helps compression) without forcing VFR for negligible gains.
        const threshold = year <= 2010 ? 0.05 : 0.08;
        return dropRatio >= threshold ? { enable: true, reason: `probe-drop>=${threshold}` } : { enable: false, reason: `probe-drop<${threshold}` };
    }

    function buildMpDecimateFilter(force) {
        if (force === null || force === undefined) return 'mpdecimate';
        if (force === true || force === 1 || force === '1' || String(force).toLowerCase() === 'true') return 'mpdecimate';

        const s = String(force).trim();
        if (!s) return 'mpdecimate';
        const lower = s.toLowerCase();
        if (lower === 'mpdecimate') return 'mpdecimate';
        if (lower.startsWith('mpdecimate=')) return s;
        if (lower.startsWith('mpdecimate:')) return s;
        return 'mpdecimate=' + s;
    }

    function getVppQsvFormat(bitDepth) {
        return bitDepth >= 10 ? 'p010le' : 'nv12';
    }

    function hasCrop(videoStream) {
        try {
            return !!(videoStream.Crop && (videoStream.Crop.Width > 0 || videoStream.Crop.Height > 0));
        } catch (err) {
            return false;
        }
    }

    function buildVppQsvFilterWithExistingCrop(videoStream, options) {
        const parts = [];

        const crop = videoStream.Crop;
        if (crop && crop.Width && crop.Height) {
            if (crop.Width > 0) parts.push(`cw=${crop.Width}`);
            if (crop.Height > 0) parts.push(`ch=${crop.Height}`);
            if (crop.X !== null && crop.X !== undefined) parts.push(`cx=${crop.X}`);
            if (crop.Y !== null && crop.Y !== undefined) parts.push(`cy=${crop.Y}`);
        }

        for (const opt of options) parts.push(opt);

        return `vpp_qsv=${parts.join(':')}`;
    }

    function extractYearFromFilename(filePath) {
        if (!filePath) return null;
        const filename = String(filePath).split('/').pop().split('\\').pop();
        if (!filename) return null;

        // Pattern: .YYYY. (year 1900-2099 enclosed in dots, common in scene releases)
        const match = filename.match(/\.(19\d{2}|20\d{2})\./);
        if (match) {
            const year = parseInt(match[1], 10);
            const currentYear = new Date().getFullYear();
            if (year >= 1900 && year <= currentYear + 1) {
                return year;
            }
        }
        return null;
    }

    function detectInterlacedWithIdet(ffmpegPath, inputFile, durationSeconds) {
        const framesPerSample = 250;
        const timeSamples = [];

        // Prefer a few different points to avoid false negatives.
        if (durationSeconds && durationSeconds > 0) {
            timeSamples.push(60);
            timeSamples.push(Math.max(60, Math.floor(durationSeconds * 0.5)));
            timeSamples.push(Math.max(60, Math.floor(durationSeconds * 0.9)));
        } else {
            timeSamples.push(60);
            timeSamples.push(300);
            timeSamples.push(600);
        }

        let tff = 0;
        let bff = 0;
        let progressive = 0;
        let undetermined = 0;

        for (let i = 0; i < timeSamples.length; i++) {
            const ss = timeSamples[i];

            const process = Flow.Execute({
                command: ffmpegPath,
                argumentList: ['-hide_banner', '-nostats', '-ss', String(ss), '-i', inputFile, '-an', '-sn', '-vf', 'idet', '-frames:v', String(framesPerSample), '-f', 'null', '-'],
                timeout: 300
            });

            const output = (process.standardError || '') + '\n' + (process.standardOutput || '');
            const match = output.match(/Multi frame detection:\\s*TFF:\\s*(\\d+)\\s*BFF:\\s*(\\d+)\\s*Progressive:\\s*(\\d+)\\s*Undetermined:\\s*(\\d+)/i);
            if (match) {
                tff += parseInt(match[1]) || 0;
                bff += parseInt(match[2]) || 0;
                progressive += parseInt(match[3]) || 0;
                undetermined += parseInt(match[4]) || 0;
            }
        }

        const total = tff + bff + progressive + undetermined;
        if (total <= 0) return { interlaced: false, reason: 'idet-no-data', tff, bff, progressive, undetermined };

        const interlacedFrames = tff + bff;
        // Conservative: require at least 50 interlaced frames and at least 15% of samples.
        const interlaced = interlacedFrames >= 50 && (interlacedFrames / total) >= 0.15;
        return { interlaced, reason: 'idet', tff, bff, progressive, undetermined };
    }

    const workingFile = Variables.file?.FullName || Flow.WorkingFile;
    const filenameYear = extractYearFromFilename(workingFile);
    const year = Variables.VideoMetadata?.Year || filenameYear || 2012;
    if (!Variables.VideoMetadata?.Year && filenameYear) {
        Logger.ILog(`Year extracted from filename: ${filenameYear}`);
    }
    const genres = Variables.VideoMetadata?.Genres || [];

    // Override variables (set these in upstream nodes to force specific filter values)
    const forceVppQsv = Variables.vpp_qsv;          // e.g., "50" (Intel QSV vpp denoise, 0-64)
    const forceHqdn3d = Variables.hqdn3d;           // e.g., "2:2:6:6" (CPU)
    const forceMpDecimateValue = Variables.mpdecimate;  // e.g., "hi=768:lo=320:frac=0.33" or "mpdecimate=hi=..."
    const mpDecimateFilter = buildMpDecimateFilter(forceMpDecimateValue);

    const ffmpeg = Variables.FfmpegBuilderModel;
    if (!ffmpeg) {
        Logger.ELog('FFMPEG Builder variable not found');
        return -1;
    }

    const video = ffmpeg.VideoStreams[0];
    if (!video) {
        Logger.ELog('FFMPEG Builder no video stream found');
        return -1;
    }

    // Get video info for bitrate detection
    const videoInfo = Variables.vi?.VideoInfo || ffmpeg.VideoInfo;
    const sourceBitrateKbps = normalizeBitrateToKbps(videoInfo?.Bitrate || 0);
    const duration = Variables.video?.Duration || videoInfo?.VideoStreams?.[0]?.Duration || 0;
    const sourceFps = videoInfo?.VideoStreams?.[0]?.FramesPerSecond || 0;
    const fileSizeMB = Variables.file?.Orig?.Size ? Variables.file.Orig.Size / (1024 * 1024) : 0;

    // Detect if content is likely a modern restoration/remaster of old content
    // High bitrate (>15 Mbps) + old year (pre-2000) = probably restored from film
    const estimatedBitrateKbps = fileSizeMB > 0 && duration > 0 ? (fileSizeMB * 8 * 1024) / duration : 0;
    const bitrateKbps = sourceBitrateKbps > 0 ? sourceBitrateKbps : estimatedBitrateKbps;
    const isHighBitrate = bitrateKbps > 15000; // >15 Mbps
    const isVeryHighBitrate = bitrateKbps > 25000; // >25 Mbps (Blu-ray quality)
    const isRestoredContent = year <= 2000 && (isHighBitrate || isVeryHighBitrate);

    // Content type detection
    const isAnimation = genres !== null && (genres.includes("Animation") || genres.includes("Anime"));
    const isDocumentary = genres !== null && genres.includes("Documentary");
    const isHorror = genres !== null && (genres.includes("Horror") || genres.includes("Thriller"));
    const isOldCelAnimation = isAnimation && year <= 1995; // Cel animation era (hand-drawn on film)

    // Detect encoder type (best-effort) so we can avoid breaking hardware pipelines
    const hwEncoder = detectHardwareEncoder(video);
    const isHardwareEncode = !!hwEncoder;
    Variables.detected_hw_encoder = hwEncoder || 'none';
    const hwFramesLikely = detectHardwareFramesLikely(video);
    Variables.hw_frames_likely = hwFramesLikely;
    let addedHardwareOnlyFilters = false; // eg: vpp_qsv / deinterlace_qsv implies HW frames in filtergraph
    const targetBitDepth = detectTargetBitDepth(video);
    Variables.target_bit_depth = targetBitDepth;
    const sourceBits = videoInfo?.VideoStreams?.[0]?.Bits || (videoInfo?.VideoStreams?.[0]?.Is10Bit ? 10 : 0);
    Variables.source_bit_depth = sourceBits || 'unknown';
    const isHDR = Variables.video?.HDR || videoInfo?.VideoStreams?.[0]?.HDR || false;
    const isDolbyVision = videoInfo?.VideoStreams?.[0]?.DolbyVision || false;
    Variables.is_hdr = isHDR;
    Variables.is_dolby_vision = isDolbyVision;

    // Optional overrides via upstream variables
    const skipBandingFix = Variables.SkipBandingFix === true || Variables.SkipBandingFix === 'true' || Variables.SkipBandingFix === 1 || Variables.SkipBandingFix === '1';
    const forceDeband = Variables.ForceDeband === true || Variables.ForceDeband === 'true' || Variables.ForceDeband === 1 || Variables.ForceDeband === '1';

    if (!hwEncoder) {
        const sig = [
            asJoinedString(video.EncodingParameters),
            asJoinedString(video.AdditionalParameters),
            asJoinedString(video.Codec)
        ].join(' ').trim();
        if (sig) Logger.DLog(`Hardware encoder detection signature (first 200 chars): ${sig.substring(0, 200)}`);
    }

    if (isHardwareEncode && UseCPUFilters && !AllowCpuFiltersWithHardwareEncode) {
        Logger.WLog(`Hardware encoder detected (${hwEncoder}); ignoring UseCPUFilters to avoid filter pipeline failures.`);
        UseCPUFilters = false;
    }

    // Log detection results
    Logger.ILog(`Content: ${year}, genres: ${genres.join(', ')}, bitrate=${Math.round(bitrateKbps / 1000)}Mbps, encoder=${hwEncoder || 'cpu'}, sourceBits=${sourceBits || 'unk'}, HDR=${isHDR}, DoVi=${isDolbyVision}`);
    if (isRestoredContent) {
        Logger.ILog(`Detected restored content (high bitrate old content)`);
    }
    if (isOldCelAnimation) {
        Logger.ILog(`Detected old cel animation (${year}) - will apply stronger grain removal`);
    }

    /**
     * FILTER STRATEGY
     * ===============
     *
     * This script tries to detect hardware encoders from FFmpeg Builder stream parameters:
     *   - QSV:   *_qsv / qsv
     *   - VAAPI: *_vaapi / vaapi
     *   - NVENC: *_nvenc / nvenc
     *   - AMF:   *_amf / amf
     *
     * If a hardware encoder is detected, CPU filters are skipped by default (they often break when the runner uses
     * hardware frames via `-hwaccel_output_format`). You can override this with AllowCpuFiltersWithHardwareEncode.
     *
     * DENOISE:
     *   - CPU: hqdn3d (plus optional deband/gradfun)
     *   - QSV: vpp_qsv=denoise=XX (0-64)
     *
     * IMPORTANT: Do not use video.Denoise for QSV. In current FileFlows runners it maps to CPU hqdn3d which fails
     * when decoding to QSV surfaces.
     *
     * DENOISE LEVELS (0-100 normalized scale):
     *   - Documentary/Horror: 10-15 (preserve grain for atmosphere)
     *   - Old cel animation (restored): 75-90 (aggressive grain removal)
     *   - Old cel animation (normal): 45-60
     *   - Modern animation: 15-25
     *   - Old live action: 30-50
     *   - Modern live action: 10-20
     *   - Very modern (2019+): 0 (skip)
     *
     * MAPPINGS:
     *   - QSV: Level 0-100 -> denoise 0-64
     *   - CPU: Level 0-100 -> hqdn3d spatial 0-8, temporal 0-16
     */

    // ===== CALCULATE DENOISE LEVEL =====
    let denoiseLevel = 0; // 0 = none, 100 = maximum

    if (!SkipDenoise) {
        if (isDocumentary || isHorror) {
            // Preserve grain for atmosphere - minimal denoising
            if (year <= 2000) {
                denoiseLevel = 15;
            } else if (year <= 2010) {
                denoiseLevel = 10;
            }
            // Modern: skip to preserve intentional grain
        } else if (isAnimation) {
            if (isOldCelAnimation && (AggressiveCompression || isRestoredContent)) {
                // AGGRESSIVE: Old cel animation restored at high bitrate
                if (year <= 1980) {
                    denoiseLevel = 90; // Very strong for 70s animation
                } else {
                    denoiseLevel = 75; // Strong for 80s-early 90s
                }
                Logger.ILog(`Using aggressive denoise for restored cel animation`);
            } else if (year <= 1985) {
                denoiseLevel = 60;
            } else if (year <= 1995) {
                denoiseLevel = 45;
            } else if (year <= 2005) {
                denoiseLevel = 25;
            } else if (year <= 2015) {
                denoiseLevel = 15;
            }
            // 2016+: Skip
        } else {
            // Live action films
            if (year <= 1985) {
                denoiseLevel = 50;
            } else if (year <= 1995) {
                denoiseLevel = 40;
            } else if (year <= 2005) {
                denoiseLevel = 30;
            } else if (year <= 2012) {
                denoiseLevel = 20;
            } else if (year <= 2018) {
                denoiseLevel = 10;
            }
            // 2019+: Skip
        }
    }

    // Store computed values for downstream nodes
    Variables.denoiseLevel = denoiseLevel;
    Variables.isRestoredContent = isRestoredContent;
    Variables.isOldCelAnimation = isOldCelAnimation;
    Variables.sourceBitrateKbps = Math.round(bitrateKbps);

    // ===== APPLY FILTERS =====
    // When the filtergraph is using hardware frames (eg via QSV), CPU-only filters must be wrapped with
    // hwdownload (and hwupload when needed). We accumulate CPU filters that require bridging in hybridCpuFilters.
    const hybridCpuFilters = [];
    const appliedFiltersSummary = [];
    const appliedFiltersForExecutor = [];
    // NOTE: For QSV hwframes, hwdownload only supports a limited set of SW formats (typically nv12/p010le).
    // CPU-only filters often prefer planar formats (yuv420p/yuv420p10le), so we download to nv12/p010le first,
    // then convert to a CPU-friendly planar format before applying CPU filters.
    const hybridCpuFormat = targetBitDepth >= 10 ? 'yuv420p10le' : 'yuv420p';
    const uploadHwFormat = targetBitDepth >= 10 ? 'p010le' : 'nv12';
    const skipMpDecimate = truthyVar(Variables.SkipMpDecimate) || truthyVar(Variables.SkipDecimate);
    const forceMpDecimate = MpDecimateAnimation || truthyVar(Variables.ForceMpDecimate);
    let enableMpDecimate = false;
    let mpDecimateReason = 'disabled';
    if (skipMpDecimate) {
        enableMpDecimate = false;
        mpDecimateReason = 'skipped (Variables.SkipMpDecimate=true)';
    } else if (!isAnimation) {
        enableMpDecimate = false;
        mpDecimateReason = 'not-animation';
    } else if (hwEncoder && hwEncoder !== 'qsv') {
        enableMpDecimate = false;
        mpDecimateReason = `unsupported-hw-encoder:${hwEncoder}`;
    } else {
        if (forceMpDecimate) {
            enableMpDecimate = true;
            mpDecimateReason = 'forced';
        } else {
            try {
                const ffmpegPath = Flow.GetToolPath('FFmpeg') || Flow.GetToolPath('ffmpeg') || Variables.ffmpeg;
                const inputFile = Variables.file?.Orig?.FullName || Variables.file?.FullName || Flow.WorkingFile;
                const decision = shouldEnableMpDecimateAuto(ffmpegPath, inputFile, duration, sourceFps, year, isAnimation);
                enableMpDecimate = decision.enable;
                mpDecimateReason = decision.reason;
            } catch (err) {
                enableMpDecimate = false;
                mpDecimateReason = `auto-error:${err}`;
            }
        }
    }

    Variables.mpdecimate_enabled = enableMpDecimate;
    Variables.mpdecimate_reason = mpDecimateReason;
    Variables.mpdecimate_filter = mpDecimateFilter;

    // We'll attach mpdecimate after denoise decisions, but inject -vsync vfr up-front when it's enabled.
    if (enableMpDecimate) {
        const vs = ensureVsyncVfrInEncodingParameters(video);
        if (vs.changed) Logger.WLog('Added -vsync vfr due to mpdecimate (VFR output).');
        Variables.applied_vsync = 'vfr';
        Logger.ILog(`mpdecimate decision: enabled (${mpDecimateReason})`);
    } else {
        Variables.applied_mpdecimate = `skipped (${mpDecimateReason})`;
        Logger.DLog(`mpdecimate decision: disabled (${mpDecimateReason})`);
    }

    // ===== AUTO DEINTERLACE (optional) =====
    if (AutoDeinterlace) {
        try {
            const ffmpegPath = Flow.GetToolPath('FFmpeg') || Flow.GetToolPath('ffmpeg') || Variables.ffmpeg;
            const inputFile = Variables.file?.Orig?.FullName || Variables.file?.FullName || Flow.WorkingFile;
            if (ffmpegPath && inputFile) {
                const idet = detectInterlacedWithIdet(ffmpegPath, inputFile, duration);
                Variables.interlace_detect_reason = idet.reason;
                Variables.interlace_tff = idet.tff;
                Variables.interlace_bff = idet.bff;
                Variables.interlace_progressive = idet.progressive;
                Variables.interlace_undetermined = idet.undetermined;
                Variables.detected_interlaced = idet.interlaced;

                Logger.ILog(`Interlace detect: interlaced=${idet.interlaced} (TFF=${idet.tff}, BFF=${idet.bff}, P=${idet.progressive}, U=${idet.undetermined})`);

                if (idet.interlaced) {
                    const addedVia = addVideoFilter(video, 'deinterlace_qsv');
                    if (!addedVia) {
                        Logger.ELog('Unable to attach deinterlace_qsv filter');
                        return -1;
                    }
                    appliedFiltersSummary.push('deinterlace_qsv');
                    appliedFiltersForExecutor.push('deinterlace_qsv');
                    addedHardwareOnlyFilters = true;
                }
            } else {
                Logger.WLog('AutoDeinterlace enabled but ffmpeg path or input file missing; skipping interlace detection');
            }
        } catch (err) {
            Logger.WLog(`AutoDeinterlace failed: ${err}`);
        }
    }

    const cpuFiltersNeedHwBridge = () => hwFramesLikely || addedHardwareOnlyFilters;

    if (denoiseLevel > 0) {
        if (UseCPUFilters && !isHardwareEncode && !cpuFiltersNeedHwBridge()) {
            // ===== CPU MODE: hqdn3d =====
            let hqdn3dValue;
            if (forceHqdn3d) {
                hqdn3dValue = forceHqdn3d;
                Logger.ILog(`Forced CPU denoise: hqdn3d=${hqdn3dValue}`);
            } else {
                // Convert level to hqdn3d params: spatial 0-8, temporal 0-16
                const spatial = (denoiseLevel * 8 / 100).toFixed(1);
                const temporal = (denoiseLevel * 16 / 100).toFixed(1);
                hqdn3dValue = `${spatial}:${spatial}:${temporal}:${temporal}`;
                Logger.ILog(`Auto CPU denoise for ${year}: hqdn3d=${hqdn3dValue} (level ${denoiseLevel}%)`);
            }
            const addedVia = addVideoFilter(video, `hqdn3d=${hqdn3dValue}`);
            if (!addedVia) {
                Logger.ELog(`Unable to attach CPU denoise filter; no compatible filter collection found on video stream.`);
                return -1;
            }
            Variables.applied_denoise = `hqdn3d=${hqdn3dValue}`;
            appliedFiltersSummary.push(Variables.applied_denoise);
            appliedFiltersForExecutor.push(Variables.applied_denoise);

            // DEBAND - Removes color banding (essential for animation)
            if (isAnimation && year <= 2010) {
                let debandParams;
                if (isOldCelAnimation && (AggressiveCompression || isRestoredContent)) {
                    // Aggressive debanding for old restored animation
                    debandParams = '1thr=0.06:2thr=0.06:3thr=0.06:range=24:blur=1';
                } else if (year <= 1995) {
                    debandParams = '1thr=0.05:2thr=0.05:3thr=0.05:range=20:blur=1';
                } else {
                    debandParams = '1thr=0.04:2thr=0.04:3thr=0.04:range=16:blur=1';
                }
                addVideoFilter(video, `deband=${debandParams}`);
                Logger.ILog(`Applied deband filter: ${debandParams}`);
                Variables.applied_deband = debandParams;
                appliedFiltersSummary.push(`deband=${debandParams}`);
                appliedFiltersForExecutor.push(`deband=${debandParams}`);
            }

        } else if (UseCPUFilters && !isHardwareEncode && cpuFiltersNeedHwBridge()) {
            // ===== CPU FILTERS WITH HW FRAMES: download to system memory, apply CPU filters, (no upload needed for CPU encoders) =====
            let hqdn3dValue;
            if (forceHqdn3d) {
                hqdn3dValue = forceHqdn3d;
                Logger.ILog(`Forced CPU denoise (hwdownload path): hqdn3d=${hqdn3dValue}`);
            } else {
                const spatial = (denoiseLevel * 8 / 100).toFixed(1);
                const temporal = (denoiseLevel * 16 / 100).toFixed(1);
                hqdn3dValue = `${spatial}:${spatial}:${temporal}:${temporal}`;
                Logger.ILog(`Auto CPU denoise (hwdownload path) for ${year}: hqdn3d=${hqdn3dValue} (level ${denoiseLevel}%)`);
            }
            hybridCpuFilters.push(`hqdn3d=${hqdn3dValue}`);
            Variables.applied_denoise = `hqdn3d=${hqdn3dValue}`;
            appliedFiltersSummary.push(Variables.applied_denoise);

            if (isAnimation && year <= 2010) {
                let debandParams;
                if (isOldCelAnimation && (AggressiveCompression || isRestoredContent)) {
                    debandParams = '1thr=0.06:2thr=0.06:3thr=0.06:range=24:blur=1';
                } else if (year <= 1995) {
                    debandParams = '1thr=0.05:2thr=0.05:3thr=0.05:range=20:blur=1';
                } else {
                    debandParams = '1thr=0.04:2thr=0.04:3thr=0.04:range=16:blur=1';
                }
                hybridCpuFilters.push(`deband=${debandParams}`);
                Logger.ILog(`Applied deband filter (hwdownload path): ${debandParams}`);
                Variables.applied_deband = debandParams;
                appliedFiltersSummary.push(`deband=${debandParams}`);
            }

        } else {
            // ===== HARDWARE MODE =====
            // When hardware encoding is used, avoid CPU filters unless explicitly allowed (they commonly break hwaccel pipelines).
            if (hwEncoder === 'qsv') {
                // Use vpp_qsv denoise explicitly. Do NOT use video.Denoise (it maps to CPU hqdn3d in current runners).
                let qsvDenoiseValue;
                if (forceVppQsv) {
                    qsvDenoiseValue = Math.max(0, Math.min(64, parseInt(forceVppQsv) || 32));
                    Logger.ILog(`Forced QSV denoise: vpp_qsv=denoise=${qsvDenoiseValue}`);
                } else {
                    qsvDenoiseValue = Math.max(0, Math.min(64, Math.round(denoiseLevel * 64 / 100)));
                    Logger.ILog(`Auto QSV denoise for ${year}: vpp_qsv=denoise=${qsvDenoiseValue} (level ${denoiseLevel}%)`);
                }

                const vppFormat = getVppQsvFormat(targetBitDepth);

                // FileFlows generates a vpp_qsv filter when crop/scale is configured. Adding a second vpp_qsv filter is dropped.
                // To ensure denoise is actually applied, take over the crop and generate a single vpp_qsv filter with denoise+crop+format.
                let vppFilter;
                if (hasCrop(video)) {
                    vppFilter = buildVppQsvFilterWithExistingCrop(video, [`denoise=${qsvDenoiseValue}`, `format=${vppFormat}`]);
                    try { video.Crop = null; } catch (err) { }
                } else {
                    vppFilter = `vpp_qsv=denoise=${qsvDenoiseValue}:format=${vppFormat}`;
                }
                Variables.applied_vpp_qsv_filter = vppFilter;
                addedHardwareOnlyFilters = true;

                // Remove any scale_qsv format filters added by Video Encode Advanced node
                // to prevent duplicate -filter:v:0 arguments in the final command.
                const removedScaleQsv = removeScaleQsvFormatFilters(video);
                if (removedScaleQsv > 0) {
                    Logger.ILog(`Removed ${removedScaleQsv} scale_qsv format filter(s) from video stream; vpp_qsv will handle format conversion`);
                }

                // Debug: Deep dump of FfmpegBuilderModel and Video stream to JSON
                function dumpValue(val, depth, maxDepth, path) {
                    if (depth > maxDepth) return '[depth limit]';
                    if (val === null) return null;
                    if (val === undefined) return null;
                    if (typeof val === 'function') return '[fn]';
                    if (typeof val === 'string') return val;
                    if (typeof val === 'number' || typeof val === 'boolean') return val;

                    // Check for .NET List with Count property
                    try {
                        if (typeof val.Count === 'number' && typeof val.get_Item === 'function') {
                            const items = [];
                            for (let i = 0; i < Math.min(val.Count, 20); i++) {
                                items.push(dumpValue(val.get_Item(i), depth + 1, maxDepth, path + '[' + i + ']'));
                            }
                            return items;
                        }
                    } catch (e) { }

                    // Check for IEnumerable
                    try {
                        if (typeof val.GetEnumerator === 'function') {
                            const items = [];
                            const enumerator = val.GetEnumerator();
                            let count = 0;
                            while (enumerator.MoveNext() && count < 20) {
                                items.push(dumpValue(enumerator.Current, depth + 1, maxDepth, path + '[' + count + ']'));
                                count++;
                            }
                            if (items.length > 0) return items;
                        }
                    } catch (e) { }

                    // Regular object - enumerate properties
                    if (typeof val === 'object') {
                        const result = {};
                        let propCount = 0;
                        for (const key in val) {
                            if (propCount > 30) { result['...'] = 'truncated'; break; }
                            try {
                                const propVal = val[key];
                                if (typeof propVal !== 'function') {
                                    result[key] = dumpValue(propVal, depth + 1, maxDepth, path + '.' + key);
                                    propCount++;
                                }
                            } catch (e) {
                                result[key] = '[err]';
                            }
                        }
                        return result;
                    }
                    return String(val).substring(0, 100);
                }

                try {
                    const videoDump = {
                        Stream: video.Stream ? String(video.Stream) : null,
                        Codec: video.Codec,
                        Index: video.Index,
                        HasChange: video.HasChange,
                        ForcedChange: video.ForcedChange,
                        Deleted: video.Deleted,
                        Filter: dumpValue(video.Filter, 0, 2, 'Filter'),
                        Filters: dumpValue(video.Filters, 0, 2, 'Filters'),
                        OptionalFilter: dumpValue(video.OptionalFilter, 0, 2, 'OptionalFilter'),
                        FilterComplex: dumpValue(video.FilterComplex, 0, 2, 'FilterComplex'),
                        EncodingParameters: dumpValue(video.EncodingParameters, 0, 2, 'EncodingParameters'),
                        AdditionalParameters: dumpValue(video.AdditionalParameters, 0, 2, 'AdditionalParameters'),
                        Crop: video.Crop,
                        Scaling: video.Scaling,
                        Deinterlace: video.Deinterlace,
                        Denoise: video.Denoise,
                        ConvertToSdr: video.ConvertToSdr,
                        Fps: video.Fps,
                        Tag: video.Tag,
                        Metadata: dumpValue(video.Metadata, 0, 2, 'Metadata')
                    };
                    Logger.ILog(`VIDEO STREAM JSON:\n${JSON.stringify(videoDump, null, 2)}`);
                } catch (err) {
                    Logger.WLog(`Could not dump video stream: ${err}`);
                }

                // Use the simple approach from community scripts: video.Filter.Add()
                // This is a .NET List<string> that the FFmpeg Builder processes.
                try {
                    video.Filter.Add(vppFilter);
                    Logger.ILog(`Added QSV filter via video.Filter.Add(): ${vppFilter}`);
                } catch (err) {
                    Logger.ELog(`Failed to add filter via video.Filter.Add(): ${err}`);
                    return -1;
                }

                appliedFiltersForExecutor.push(vppFilter);

                Variables.applied_denoise = `vpp_qsv=denoise=${qsvDenoiseValue}`;
                Variables.qsv_denoise_value = qsvDenoiseValue;
                appliedFiltersSummary.push(Variables.applied_denoise);

                // Optional CPU filters in hybrid mode (download frames -> CPU filter -> upload frames)
                if (AllowCpuFiltersWithHardwareEncode) {
                    if (UseCPUFilters) {
                        // Treat UseCPUFilters as "allow CPU extras" in QSV mode (wrapped safely).
                        if (forceHqdn3d) {
                            Logger.ILog(`CPU denoise extra enabled: hqdn3d=${forceHqdn3d}`);
                            if (cpuFiltersNeedHwBridge()) {
                                hybridCpuFilters.push(`hqdn3d=${forceHqdn3d}`);
                            } else {
                                const addedVia = addVideoFilter(video, `hqdn3d=${forceHqdn3d}`);
                                if (!addedVia) {
                                    Logger.ELog('Unable to attach CPU denoise filter (QSV extras)');
                                    return -1;
                                }
                                appliedFiltersForExecutor.push(`hqdn3d=${forceHqdn3d}`);
                            }
                            appliedFiltersSummary.push(`hqdn3d=${forceHqdn3d}`);
                        }
                    }

                    if (isAnimation && year <= 2010) {
                        let debandParams;
                        if (isOldCelAnimation && (AggressiveCompression || isRestoredContent)) {
                            debandParams = '1thr=0.06:2thr=0.06:3thr=0.06:range=24:blur=1';
                        } else if (year <= 1995) {
                            debandParams = '1thr=0.05:2thr=0.05:3thr=0.05:range=20:blur=1';
                        } else {
                            debandParams = '1thr=0.04:2thr=0.04:3thr=0.04:range=16:blur=1';
                        }
                        if (cpuFiltersNeedHwBridge()) {
                            hybridCpuFilters.push(`deband=${debandParams}`);
                        } else {
                            const deband = `deband=${debandParams}`;
                            const addedVia = addVideoFilter(video, deband);
                            if (!addedVia) {
                                Logger.ELog('Unable to attach deband filter (QSV extras)');
                                return -1;
                            }
                            appliedFiltersForExecutor.push(deband);
                        }
                        Variables.applied_deband = debandParams;
                        appliedFiltersSummary.push(`deband=${debandParams}`);
                        Logger.ILog(`CPU deband enabled: ${debandParams}`);
                    }
                }
            } else {
                Logger.WLog(`Hardware encoder detected (${hwEncoder}), but no safe hardware denoise is configured in this script; skipping denoise.`);
                Variables.applied_denoise = 'none (hardware)';
            }
        }
    } else {
        Logger.ILog(`No denoising needed for ${year} content`);
        Variables.applied_denoise = 'none';
    }

    // ===== OPTIONAL DUPLICATE FRAME REMOVAL (mpdecimate) =====
    // mpdecimate drops near-duplicate frames and typically produces VFR output. Force -vsync vfr so ffmpeg
    // doesn't re-duplicate frames to match a CFR output, and so audio stays in sync.
    if (enableMpDecimate) {
        if (cpuFiltersNeedHwBridge()) {
            // Hardware frames path: use hwdownload (and hwupload when QSV encode is used).
            hybridCpuFilters.push(mpDecimateFilter);
            Variables.applied_mpdecimate = `${mpDecimateFilter} (hybrid)`;
            appliedFiltersSummary.push(mpDecimateFilter);
            Logger.ILog(`mpdecimate enabled (hybrid): ${mpDecimateFilter}`);
        } else {
            // CPU frames path: attach directly, even if encoding is QSV (FFmpeg will upload frames for the encoder).
            const addedVia = addVideoFilter(video, mpDecimateFilter);
            if (!addedVia) {
                Logger.ELog('Unable to attach mpdecimate filter');
                return -1;
            }
            Variables.applied_mpdecimate = mpDecimateFilter;
            appliedFiltersSummary.push(mpDecimateFilter);
            appliedFiltersForExecutor.push(mpDecimateFilter);
            Logger.ILog(`Applied mpdecimate via ${addedVia}: ${mpDecimateFilter}`);
        }
    }

    // ===== BANDING FIXES (heuristics) =====
    // Banding can be introduced by the source (8-bit / heavy compression) or made more visible by HDR and some displays.
    // We keep this conservative: apply mild gradfun for HDR/DoVi, and stronger deband mainly for animation/8-bit sources.
    if (!skipBandingFix) {
        const wantGradfun = (isHDR || isDolbyVision) || (!isAnimation && year <= 2005);
        if (wantGradfun) {
            const gradfun = (isHDR || isDolbyVision) ? 'gradfun=strength=0.9:radius=16' : 'gradfun=strength=1.2:radius=16';
            if (isHardwareEncode && !AllowCpuFiltersWithHardwareEncode) {
                Logger.ILog('Skipping gradfun due to hardware encoder (CPU filter)');
            } else if (cpuFiltersNeedHwBridge()) {
                hybridCpuFilters.push(gradfun);
                Variables.applied_gradfun = true;
                appliedFiltersSummary.push(gradfun);
                Logger.ILog(`CPU gradfun enabled (hwdownload path): ${gradfun}`);
            } else {
                addVideoFilter(video, gradfun);
                Variables.applied_gradfun = true;
                appliedFiltersSummary.push(gradfun);
                Logger.ILog(`Applied gradfun: ${gradfun}`);
                appliedFiltersForExecutor.push(gradfun);
            }
        }

        // Deband is more aggressive; keep it mostly to animation and 8-bit sources where banding is common.
        const likely8bitSource = sourceBits === 8 || (sourceBits === 0 && targetBitDepth >= 10);
        const wantDeband = forceDeband || (isAnimation && year <= 2015) || (likely8bitSource && (isHDR || isDolbyVision));
        if (wantDeband && !Variables.applied_deband) {
            let debandParams;
            if (isHDR || isDolbyVision) {
                // Mild deband for HDR/DoVi (avoid flattening details)
                debandParams = '1thr=0.02:2thr=0.02:3thr=0.02:range=16:blur=1';
            } else if (isAnimation && year <= 1995 && (AggressiveCompression || isRestoredContent)) {
                debandParams = '1thr=0.06:2thr=0.06:3thr=0.06:range=24:blur=1';
            } else if (isAnimation && year <= 2005) {
                debandParams = '1thr=0.04:2thr=0.04:3thr=0.04:range=16:blur=1';
            } else {
                debandParams = '1thr=0.03:2thr=0.03:3thr=0.03:range=16:blur=1';
            }

            const deband = `deband=${debandParams}`;
            if (isHardwareEncode && !AllowCpuFiltersWithHardwareEncode) {
                Logger.ILog('Skipping deband due to hardware encoder (CPU filter)');
            } else if (cpuFiltersNeedHwBridge()) {
                hybridCpuFilters.push(deband);
                Variables.applied_deband = debandParams;
                appliedFiltersSummary.push(deband);
                Logger.ILog(`CPU deband enabled (hwdownload path): ${debandParams}`);
            } else {
                addVideoFilter(video, deband);
                Variables.applied_deband = debandParams;
                appliedFiltersSummary.push(deband);
                Logger.ILog(`Applied deband: ${debandParams}`);
                appliedFiltersForExecutor.push(deband);
            }
        }
    } else {
        Logger.ILog('Banding fixes skipped (Variables.SkipBandingFix=true)');
    }

    if (hybridCpuFilters.length > 0) {
        // Build a single, ordered CPU segment that safely bridges HW->SW (and back to HW for QSV encodes when needed).
        const needUploadBackToHw = isHardwareEncode && hwEncoder === 'qsv';
        const parts = ['hwdownload', `format=${uploadHwFormat}`];
        if (hybridCpuFormat !== uploadHwFormat) parts.push(`format=${hybridCpuFormat}`);
        for (let i = 0; i < hybridCpuFilters.length; i++) parts.push(hybridCpuFilters[i]);
        if (needUploadBackToHw) {
            parts.push(`format=${uploadHwFormat}`);
            parts.push('hwupload=extra_hw_frames=64');
        }
        const hybrid = parts.join(',');
        const addedVia = addVideoFilter(video, hybrid);
        if (!addedVia) {
            Logger.ELog(`Unable to attach hybrid CPU filter chain; no compatible filter collection found on video stream.`);
            return -1;
        }
        Variables.applied_hybrid_cpu_filters = hybridCpuFilters.join(',');
        Variables.applied_hybrid_cpu_filters_mode = needUploadBackToHw ? 'hwdownload+hwupload' : 'hwdownload-only';
        Logger.ILog(`Attached hybrid CPU filter chain (${Variables.applied_hybrid_cpu_filters_mode}) via ${addedVia}: ${hybrid}`);
        appliedFiltersForExecutor.push(hybrid);
    }

    Variables.video_filters = appliedFiltersSummary.join(',');
    const filters = appliedFiltersForExecutor.slice();
    Variables.filters = filters.join(',');

    // Prevent FFmpeg Builder from emitting a second `-filter:v:0 scale_qsv=format=p010le` when using QSV 10-bit,
    // which would override our computed filter chain.
    try {
        const p = preventQsvPixFmtDoubleFilter(video, hwEncoder, targetBitDepth, appliedFiltersForExecutor);
        if (p.changed) {
            Logger.ILog(`QSV pix_fmt/scale workaround applied (${p.reason})`);
        } else {
            Logger.DLog(`QSV pix_fmt/scale workaround skipped (${p.reason})`);
        }
    } catch (err) {
        Logger.WLog(`Failed applying QSV pix_fmt/scale workaround: ${err}`);
    }

    // Some FileFlows runner/builder versions (especially FFmpeg Builder "New mode") primarily apply video filters from
    // EncodingParameters (-filter:v:0), and can ignore script-added Filter/Filters collections. Ensure our computed filters
    // are present in the encoding filter argument.
    // IMPORTANT: When we have filters to apply, ALWAYS inject them into EncodingParameters to ensure they're used,
    // since the Video Encode Advanced node adds its own `-filter:v:0 scale_qsv=format=p010le` which would override ours.
    try {
        const hasFiltersToApply = appliedFiltersForExecutor.length > 0;
        const forceEncodingParamFilter = hasFiltersToApply || truthyVar(Variables['CleaningFilters.ForceEncodingParamFilter']);
        const ensured = ensureSingleVideoFilterArgAcrossParams(video, appliedFiltersForExecutor, forceEncodingParamFilter);
        if (ensured.changed) {
            const b = ensured.before ? ensured.before.substring(0, 220) : '';
            const a = ensured.after ? ensured.after.substring(0, 220) : '';
            Logger.WLog(`Ensured single video filter arg (${ensured.reason}). Before: '${b}' After: '${a}'`);
        } else {
            Logger.DLog(`Video filter args unchanged (${ensured.reason}).`);
        }
    } catch (err) {
        Logger.WLog(`Failed ensuring single video filter arg: ${err}`);
    }

    /**
     * FILTER SUMMARY
     * ==============
     * Applied filters based on content type:
     *
     * DENOISE:
     *   - CPU mode: hqdn3d (spatial + temporal denoising)
     *   - QSV mode: vpp_qsv denoise (hardware accelerated)
     *
     * DEBAND (animation <= 2010):
     *   - Removes color banding common in older animation
     *   - Strength varies by age and restoration status
     *
     * GRADFUN (live action <= 2005):
     *   - Light gradient debanding for older live action
     *
     * MPDECIMATE (heuristic for Animation/Anime):
     *   - Drops near-duplicate frames and forces VFR output via -vsync vfr
     *   - Auto-enabled when it meaningfully reduces frame count (or forced via param/Variables)
     *
     * OPTIONAL (manual use / not implemented here):
     *   - nlmeans: High quality denoiser (very slow, use for archival)
     *   - unsharp: Sharpening after denoise (can hurt compression)
    */

    // Apply QSV tuning (only add if missing).
    if (hwEncoder === 'qsv') {
        try {
            const ep = video.EncodingParameters;
            if (listCount(ep) === null) {
                Logger.WLog('Unable to apply QSV tuning params: EncodingParameters is not a mutable list');
            } else {
                const fps = parseFloat(Variables.video?.FramesPerSecond || Variables.vi?.FramesPerSecond || Variables.vi?.FPS || Variables.video?.FPS || 24) || 24;
                const gop = Math.max(48, Math.min(300, Math.round(fps * 5))); // ~5 seconds keyframe interval

                const isFlag = (flag) => (t) => t === flag || t.startsWith(flag + ':') || t.startsWith(flag + ':v');
                const added = [];

                if (ensureArgWithValue(ep, '-look_ahead', '1', isFlag('-look_ahead'))) added.push('-look_ahead 1');
                if (ensureArgWithValue(ep, '-look_ahead_depth', (isAnimation ? '40' : '20'), isFlag('-look_ahead_depth'))) {
                    added.push(`-look_ahead_depth ${isAnimation ? '40' : '20'}`);
                }
                if (ensureArgWithValue(ep, '-extbrc', '1', isFlag('-extbrc'))) added.push('-extbrc 1');

                // B-frames / refs (mostly impacts compression at same quality).
                if (ensureArgWithValue(ep, '-bf', '7', isFlag('-bf'))) added.push('-bf 7');
                const desiredRefs = (isAnimation && (AggressiveCompression || isOldCelAnimation || isRestoredContent)) ? '6' : '4';
                if (ensureArgWithValue(ep, '-refs', desiredRefs, isFlag('-refs'))) added.push(`-refs ${desiredRefs}`);

                // Adaptive frame decisions.
                if (ensureArgWithValue(ep, '-adaptive_i', '1', isFlag('-adaptive_i'))) added.push('-adaptive_i 1');
                if (ensureArgWithValue(ep, '-adaptive_b', '1', isFlag('-adaptive_b'))) added.push('-adaptive_b 1');

                // GOP (seekability + compression tradeoff). Do not override if the node already set one.
                const gopPred = (t) => t === '-g' || t === '-g:v' || t.startsWith('-g:') || t.startsWith('-g:v');
                if (ensureArgWithValue(ep, '-g:v', String(gop), gopPred)) added.push(`-g:v ${gop}`);

                if (added.length > 0) {
                    Variables.applied_qsv_tuning = added.join(' ');
                    Logger.ILog(`Applied QSV tuning params: ${Variables.applied_qsv_tuning}`);
                } else {
                    Logger.DLog('QSV tuning params already present; no changes made');
                }
            }
        } catch (err) {
            Logger.WLog(`Failed applying QSV tuning params: ${err}`);
        }
    }

    // ===== HDR COLOR METADATA PRESERVATION =====
    // These FFmpeg-level options work with any encoder (QSV, NVENC, libx265, etc.) and ensure
    // HDR10/Dolby Vision color signaling is preserved in the output stream.
    if (isHDR || isDolbyVision) {
        const hdrColorParams = [
            '-color_primaries', 'bt2020',
            '-color_trc', 'smpte2084',
            '-colorspace', 'bt2020nc'
        ];

        try {
            const ep = video.EncodingParameters;
            if (ep) {
                for (let i = 0; i < hdrColorParams.length; i++) {
                    listAdd(ep, hdrColorParams[i]);
                }
                Variables.applied_hdr_color_params = hdrColorParams.join(' ');
                Logger.ILog(`HDR color metadata params added: ${Variables.applied_hdr_color_params}`);
            } else {
                Logger.WLog('Could not add HDR color params: EncodingParameters not available');
            }
        } catch (err) {
            Logger.WLog(`Failed to add HDR color metadata params: ${err}`);
        }
    }

    // Log the stream filter state (do not mutate the builder model here).
    try {
        const filterList = toEnumerableArray(video.Filter, 2000).map(safeTokenString).filter(x => x);
        const filtersList = toEnumerableArray(video.Filters, 2000).map(safeTokenString).filter(x => x);
        const optionalList = toEnumerableArray(video.OptionalFilter, 2000).map(safeTokenString).filter(x => x);
        Logger.ILog(`ffmpeg.VideoStreams[0].Filter: ${filterList.length ? filterList.join(',') : '(empty)'}`);
        Logger.ILog(`ffmpeg.VideoStreams[0].Filters: ${filtersList.length ? filtersList.join(',') : '(empty)'}`);
        Logger.ILog(`ffmpeg.VideoStreams[0].OptionalFilter: ${optionalList.length ? optionalList.join(',') : '(empty)'}`);
    } catch (err) {
        Logger.WLog(`Unable to enumerate ffmpeg.VideoStreams[0] filter properties: ${err}`);
    }

    return 1;
}
