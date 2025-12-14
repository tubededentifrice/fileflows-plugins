/**
 * @description Apply intelligent video filters based on content type, year, and genre to improve compression while maintaining quality.
 * @author Vincent Courcelle
 * @revision 13
 * @param {bool} SkipDenoise Skip all denoising filters
 * @param {bool} AggressiveCompression Enable aggressive compression for old/restored content (stronger denoise)
 * @param {bool} UseCPUFilters Prefer CPU filters (hqdn3d, deband, gradfun). If hardware encoding is detected, this will be ignored unless AllowCpuFiltersWithHardwareEncode is enabled.
 * @param {bool} AllowCpuFiltersWithHardwareEncode Allow CPU filters even when a hardware encoder is detected (advanced; may break hardware pipelines depending on runner settings)
 * @param {bool} AutoDeinterlace Auto-detect interlaced content and enable QSV deinterlacing (uses a quick `idet` probe)
 * @output Cleaned video
 */
function Script(SkipDenoise, AggressiveCompression, UseCPUFilters, AllowCpuFiltersWithHardwareEncode, AutoDeinterlace) {
    Logger.ILog('Cleaning filters.js revision 13 loaded');
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

    function addVideoFilter(videoStream, filter) {
        if (!filter) return null;

        if (videoStream.Filter && typeof videoStream.Filter.Add === 'function') {
            videoStream.Filter.Add(filter);
            return 'Filter.Add';
        }

        if (listAdd(videoStream.Filters, filter)) {
            return 'Filters';
        }

        // OptionalFilter is not reliably applied in all builder modes; prefer it last.
        if (listAdd(videoStream.OptionalFilter, filter)) {
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
    Logger.ILog(`Content: ${year}, genres: ${genres.join(', ')}, bitrate=${Math.round(bitrateKbps / 1000)}Mbps, encoder=${hwEncoder || 'cpu'}`);
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
    const hybridCpuFormat = targetBitDepth >= 10 ? 'yuv420p10le' : 'yuv420p';

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

    // GRADFUN - Fixes banding in gradients (lighter than deband, good for live action)
    if (!isAnimation && year <= 2005 && !SkipDenoise) {
        if (isHardwareEncode) {
            if (AllowCpuFiltersWithHardwareEncode) {
                hybridCpuFilters.push('gradfun=strength=1.2:radius=16');
                Variables.applied_gradfun = true;
                appliedFiltersSummary.push('gradfun=strength=1.2:radius=16');
                Logger.ILog('Hybrid CPU gradfun enabled');
            } else {
                Logger.ILog('Skipping gradfun due to hardware encoder (CPU filter)');
            }
        } else {
            addVideoFilter(video, 'gradfun=strength=1.2:radius=16');
            Logger.ILog('Applied gradfun filter for gradient banding');
            Variables.applied_gradfun = true;
            appliedFiltersSummary.push('gradfun=strength=1.2:radius=16');
        }
    }

    if (hybridCpuFilters.length > 0) {
        const hybrid = `hwdownload,format=${hybridCpuFormat},${hybridCpuFilters.join(',')},format=${hybridCpuFormat},hwupload=extra_hw_frames=64`;
        const addedVia = addVideoFilter(video, hybrid);
        if (!addedVia) {
            Logger.ELog(`Unable to attach hybrid CPU filter chain; no compatible filter collection found on video stream.`);
            return -1;
        }
        Variables.applied_hybrid_cpu_filters = hybridCpuFilters.join(',');
    }

    Variables.video_filters = appliedFiltersSummary.join(',');

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

    return 1;
}
