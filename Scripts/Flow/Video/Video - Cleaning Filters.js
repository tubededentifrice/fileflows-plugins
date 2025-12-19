/**
 * @description Apply intelligent video filters based on content type, year, and genre to improve compression while maintaining quality. Preserves HDR10/DoVi color metadata.
 * @author Vincent Courcelle
 * @revision 18
 * @param {bool} SkipDenoise Skip all denoising filters
 * @param {bool} AggressiveCompression Enable aggressive compression for old/restored content (stronger denoise)
 * @param {bool} UseCPUFilters Prefer CPU filters (hqdn3d, deband, gradfun). If hardware encoding is detected, this will be ignored unless AllowCpuFiltersWithHardwareEncode is enabled.
 * @param {bool} AllowCpuFiltersWithHardwareEncode Allow CPU filters even when a hardware encoder is detected (advanced; may break hardware pipelines depending on runner settings)
 * @param {bool} AutoDeinterlace Auto-detect interlaced content and enable QSV deinterlacing (uses a quick `idet` probe)
 * @output Cleaned video
 */
function Script(SkipDenoise, AggressiveCompression, UseCPUFilters, AllowCpuFiltersWithHardwareEncode, AutoDeinterlace) {
    Logger.ILog('Cleaning filters.js revision 17 loaded');
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

    function ensureVideoFiltersInEncodingParameters(videoStream, filtersToApply) {
        const partsToApply = flattenFilterExpressions(filtersToApply);
        if (partsToApply.length === 0) return { changed: false, reason: 'no-filters' };

        const ep = videoStream ? videoStream.EncodingParameters : null;
        if (!ep) return { changed: false, reason: 'no-encoding-params' };

        const tokens = toEnumerableArray(ep, 5000).map(safeTokenString).filter(x => x);
        let filterArgIndex = -1;
        for (let i = 0; i < tokens.length - 1; i++) {
            const t = String(tokens[i] || '').trim();
            if (t === '-vf' || t.startsWith('-filter:v')) {
                filterArgIndex = i;
                break;
            }
        }

        const buildDesiredChain = () => {
            // De-dupe while preserving order.
            const seen = {};
            const ordered = [];
            for (let i = 0; i < partsToApply.length; i++) {
                const p = partsToApply[i];
                if (seen[p]) continue;
                seen[p] = true;
                ordered.push(p);
            }
            return ordered.join(',');
        };

        if (filterArgIndex < 0) {
            // No existing filter arg found in EncodingParameters; add one so the executor can pick it up.
            // Many FileFlows runner versions will skip generating their own default video filter when one is already present.
            const desired = buildDesiredChain();
            listAdd(ep, '-filter:v:0');
            listAdd(ep, desired);
            return { changed: true, reason: 'added-filter-arg', before: '', after: desired };
        }

        const before = String(tokens[filterArgIndex + 1] || '').trim();
        const existingParts = before ? before.split(',').map(x => x.trim()).filter(x => x) : [];

        // If existing is only a format-only scale_qsv and we have a vpp_qsv, replace entirely to avoid redundant format conversion.
        const isFormatOnlyScaleQsv = (p) => p === 'scale_qsv=format=p010le' || p === 'scale_qsv=format=nv12';
        const desiredHasVpp = partsToApply.some(p => p.startsWith('vpp_qsv='));
        if (desiredHasVpp && existingParts.length === 1 && isFormatOnlyScaleQsv(existingParts[0])) {
            const after = buildDesiredChain();
            if (after && after !== before) {
                listSetAt(ep, filterArgIndex + 1, after);
                return { changed: true, reason: 'replaced-format-only-scale', before, after };
            }
            return { changed: false, reason: 'no-change', before, after: before };
        }

        let mergedParts = existingParts.slice();

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

        const after = mergedParts.join(',');
        if (after && after !== before) {
            listSetAt(ep, filterArgIndex + 1, after);
            return { changed: true, reason: 'merged', before, after };
        }
        return { changed: false, reason: 'no-change', before, after };
    }

    function addVideoFilter(videoStream, filter) {
        if (!filter) return null;
        // Prefer Filters in FFmpeg Builder "New mode" (some versions still expose Filter/OptionalFilter too).
        // Also mirror into Filter when available for compatibility/visibility.
        const addedFilters = listAddUnique(videoStream.Filters, filter);
        const addedFilter = listAddUnique(videoStream.Filter, filter);
        if (addedFilters) return 'Filters';
        if (addedFilter) return 'Filter';

        // OptionalFilter is not reliably applied in all builder modes; prefer it last.
        if (listAddUnique(videoStream.OptionalFilter, filter)) {
            return 'OptionalFilter';
        }

        return null;
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

    const year = Variables.VideoMetadata?.Year || 2012;
    const genres = Variables.VideoMetadata?.Genres || [];

    // Override variables (set these in upstream nodes to force specific filter values)
    const forceVppQsv = Variables.vpp_qsv;          // e.g., "50" (Intel QSV vpp denoise, 0-64)
    const forceHqdn3d = Variables.hqdn3d;           // e.g., "2:2:6:6" (CPU)

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
    // In hybrid mode (QSV encode + some CPU filters), wrap CPU filters with hwdownload/hwupload.
    const hybridCpuFilters = [];
    const appliedFiltersSummary = [];
    const appliedFiltersForExecutor = [];
    const hybridCpuFormat = targetBitDepth >= 10 ? 'yuv420p10le' : 'yuv420p';
    const uploadHwFormat = targetBitDepth >= 10 ? 'p010le' : 'nv12';

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
                }
            } else {
                Logger.WLog('AutoDeinterlace enabled but ffmpeg path or input file missing; skipping interlace detection');
            }
        } catch (err) {
            Logger.WLog(`AutoDeinterlace failed: ${err}`);
        }
    }

    if (denoiseLevel > 0) {
        if (UseCPUFilters && !isHardwareEncode) {
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

                const addedVia = addVideoFilter(video, vppFilter);
                if (!addedVia) {
                    Logger.ELog(`Unable to attach QSV denoise filter; no compatible filter collection found on video stream.`);
                    return -1;
                }
                Logger.ILog(`Attached QSV filter via ${addedVia}: ${vppFilter}`);
                appliedFiltersForExecutor.push(vppFilter);

                Variables.applied_denoise = `vpp_qsv=denoise=${qsvDenoiseValue}`;
                Variables.qsv_denoise_value = qsvDenoiseValue;
                appliedFiltersSummary.push(Variables.applied_denoise);

                // Optional CPU filters in hybrid mode (download frames -> CPU filter -> upload frames)
                if (AllowCpuFiltersWithHardwareEncode) {
                    if (UseCPUFilters) {
                        // Treat UseCPUFilters as "allow CPU extras" in QSV mode (wrapped safely).
                        if (forceHqdn3d) {
                            Logger.ILog(`Hybrid CPU denoise forced: hqdn3d=${forceHqdn3d}`);
                            hybridCpuFilters.push(`hqdn3d=${forceHqdn3d}`);
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
                        hybridCpuFilters.push(`deband=${debandParams}`);
                        Variables.applied_deband = debandParams;
                        appliedFiltersSummary.push(`deband=${debandParams}`);
                        Logger.ILog(`Hybrid CPU deband enabled: ${debandParams}`);
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

    // ===== BANDING FIXES (heuristics) =====
    // Banding can be introduced by the source (8-bit / heavy compression) or made more visible by HDR and some displays.
    // We keep this conservative: apply mild gradfun for HDR/DoVi, and stronger deband mainly for animation/8-bit sources.
    if (!skipBandingFix) {
        const wantGradfun = (isHDR || isDolbyVision) || (!isAnimation && year <= 2005);
        if (wantGradfun) {
            const gradfun = (isHDR || isDolbyVision) ? 'gradfun=strength=0.9:radius=16' : 'gradfun=strength=1.2:radius=16';
            if (isHardwareEncode) {
                if (AllowCpuFiltersWithHardwareEncode) {
                    hybridCpuFilters.push(gradfun);
                    Variables.applied_gradfun = true;
                    appliedFiltersSummary.push(gradfun);
                    Logger.ILog(`Hybrid CPU gradfun enabled: ${gradfun}`);
                } else {
                    Logger.ILog('Skipping gradfun due to hardware encoder (CPU filter)');
                }
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
            if (isHardwareEncode) {
                if (AllowCpuFiltersWithHardwareEncode) {
                    hybridCpuFilters.push(deband);
                    Variables.applied_deband = debandParams;
                    appliedFiltersSummary.push(deband);
                    Logger.ILog(`Hybrid CPU deband enabled: ${debandParams}`);
                } else {
                    Logger.ILog('Skipping deband due to hardware encoder (CPU filter)');
                }
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
        const hybrid = `hwdownload,format=${uploadHwFormat},format=${hybridCpuFormat},${hybridCpuFilters.join(',')},format=${uploadHwFormat},hwupload=extra_hw_frames=64`;
        const addedVia = addVideoFilter(video, hybrid);
        if (!addedVia) {
            Logger.ELog(`Unable to attach hybrid CPU filter chain; no compatible filter collection found on video stream.`);
            return -1;
        }
        Variables.applied_hybrid_cpu_filters = hybridCpuFilters.join(',');
        Logger.ILog(`Attached hybrid CPU filter chain via ${addedVia}: ${hybrid}`);
        appliedFiltersForExecutor.push(hybrid);
    }

    Variables.video_filters = appliedFiltersSummary.join(',');
    const filters = appliedFiltersForExecutor.slice();
    Variables.filters = filters.join(',');

    // Some FileFlows runner/builder versions (especially FFmpeg Builder "New mode") primarily apply video filters from
    // EncodingParameters (-filter:v:0), and can ignore script-added Filter/Filters collections. Ensure our computed filters
    // are present in the encoding filter argument.
    try {
        const ensured = ensureVideoFiltersInEncodingParameters(video, appliedFiltersForExecutor);
        if (ensured.changed) {
            const b = ensured.before ? ensured.before.substring(0, 220) : '';
            const a = ensured.after ? ensured.after.substring(0, 220) : '';
            Logger.WLog(`Injected video filters into EncodingParameters (${ensured.reason}). Before: '${b}' After: '${a}'`);
        } else {
            Logger.DLog(`Video filter EncodingParameters unchanged (${ensured.reason}).`);
        }
    } catch (err) {
        Logger.WLog(`Failed ensuring filters in EncodingParameters: ${err}`);
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
     * NOT ENABLED (available for manual use):
     *   - mpdecimate: Removes duplicate frames (can cause audio sync issues)
     *   - nlmeans: High quality denoiser (very slow, use for archival)
     *   - unsharp: Sharpening after denoise (can hurt compression)
     */

    /**
     * ENCODER PARAMETERS
     * ==================
     * This script does not modify encoder parameters; keep those in FFmpeg Builder nodes to avoid corrupting
     * parameter formats (especially x265-params) and to keep hardware/CPU settings separated.
     *
     * These values are stored in Variables for reference:
     */
    if (isAnimation && (AggressiveCompression || isOldCelAnimation || isRestoredContent)) {
        Variables.recommended_qsv_params = '-bf 7 -refs 6 -g 256 -extbrc 1 -look_ahead_depth 40 -adaptive_i 1 -adaptive_b 1';
        Variables.recommended_x265_params = 'bframes=16:ref=6:rc-lookahead=60:aq-mode=3:aq-strength=0.8:psy-rd=0.7:psy-rdoq=0:deblock=1,1';
    } else {
        Variables.recommended_qsv_params = '-bf 7 -refs 4 -g 250 -extbrc 1 -look_ahead_depth 20';
        Variables.recommended_x265_params = 'bframes=8:ref=4:aq-mode=3:psy-rd=1.0';
    }

    Logger.ILog(`Recommended QSV params: ${Variables.recommended_qsv_params}`);

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

    // "Prove" the filters are present on the stream in Filter.
    try {
        for (let i = 0; i < filters.length; i++) {
            listAddUnique(video.Filter, filters[i]);
        }
        const filterList = toEnumerableArray(video.Filter, 2000).map(safeTokenString).filter(x => x);
        Logger.ILog(`ffmpeg.VideoStreams[0].Filter: ${filterList.length ? filterList.join(',') : '(empty)'}`);
    } catch (err) {
        Logger.WLog(`Unable to enumerate ffmpeg.VideoStreams[0].Filter: ${err}`);
    }

    return 1;
}
