import { ScriptHelpers } from 'Shared/ScriptHelpers';

/**
 * @description Automatically determines optimal CRF/quality based on VMAF or SSIM scoring to minimize file size while maintaining visual quality. Uses Netflix's VMAF metric when available, falls back to SSIM.
 * @help Place this node between 'FFmpeg Builder: Start' and 'FFmpeg Builder: Executor'.
 * @author Vincent Courcelle
 * @revision 25
 * @minimumVersion 24.0.0.0
 * @param {int} TargetVMAF Target VMAF score (0 = auto based on content type, 93-99 manual). For SSIM, this is auto-converted. Default: 0 (auto)
 * @param {int} MinCRF Minimum CRF to search (lower = higher quality, larger file). Default: 18
 * @param {int} MaxCRF Maximum CRF to search (higher = lower quality, smaller file). Default: 28
 * @param {int} SampleDurationSec Duration of each sample in seconds. Default: 8
 * @param {int} SampleCount Number of samples to take from video. Default: 3
 * @param {int} MaxSearchIterations Maximum binary search iterations. Default: 6
 * @param {bool} PreferSmaller When two CRFs meet target, prefer the smaller file (higher CRF). Default: true
 * @param {bool} UseTags Add FileFlows tags with CRF and quality info (premium feature). Default: false
 * @param {('ultrafast'|'superfast'|'veryfast'|'faster'|'fast'|'medium'|'slow'|'slower'|'veryslow')} Preset Encoder preset for quality testing and final encode. Slower = better compression. Default: veryslow
 * @output CRF found and applied to encoder
 * @output Video already optimal (copy mode)
 */
function Script(
    TargetVMAF,
    MinCRF,
    MaxCRF,
    SampleDurationSec,
    SampleCount,
    MaxSearchIterations,
    PreferSmaller,
    UseTags,
    Preset
) {
    const helpers = new ScriptHelpers();
    const toEnumerableArray = (v, m) => helpers.toEnumerableArray(v, m);
    const safeString = (v) => helpers.safeString(v);
    const detectTargetBitDepth = (v) => helpers.detectTargetBitDepth(v);
    const asJoinedString = (v) => helpers.asJoinedString(v);

    // Local alias for safeString to match previous code style if preferred, or just use safeString directly.
    const safeTokenString = safeString;

    function escapeFfmpegFilterArgValue(value) {
        // ffmpeg filter args use ':' as a separator, so escape it for Windows drive letters.
        // Use forward slashes to avoid backslash escaping rules.
        return String(value === undefined || value === null ? '' : value)
            .replace(/\\/g, '/')
            .replace(/:/g, '\\:');
    }

    // ===== DEFAULTS =====
    if (!MinCRF || MinCRF <= 0) MinCRF = 18;
    if (!MaxCRF || MaxCRF <= 0) MaxCRF = 28;
    if (!SampleDurationSec || SampleDurationSec <= 0) SampleDurationSec = 8;
    if (!SampleCount || SampleCount <= 0) SampleCount = 3;
    if (!MaxSearchIterations || MaxSearchIterations <= 0) MaxSearchIterations = 6;
    if (PreferSmaller === undefined || PreferSmaller === null) PreferSmaller = true;
    if (TargetVMAF === undefined || TargetVMAF === null) TargetVMAF = 0;
    if (!Preset) Preset = 'veryslow';

    // Allow variable overrides
    if (Variables.TargetVMAF) TargetVMAF = parseInt(Variables.TargetVMAF);
    if (Variables.MinCRF) MinCRF = parseInt(Variables.MinCRF);
    if (Variables.MaxCRF) MaxCRF = parseInt(Variables.MaxCRF);
    if (Variables.Preset) Preset = String(Variables.Preset);
    if (Variables.AutoQualityPreset) {
        const preset = Variables.AutoQualityPreset.toLowerCase();
        if (preset === 'quality') {
            TargetVMAF = 97;
            MinCRF = 16;
            MaxCRF = 24;
        } else if (preset === 'balanced') {
            TargetVMAF = 95;
            MinCRF = 18;
            MaxCRF = 26;
        } else if (preset === 'compression') {
            TargetVMAF = 93;
            MinCRF = 20;
            MaxCRF = 30;
        }
    }

    // ===== VALIDATE FFMPEG BUILDER =====
    const ffmpegModel = Variables.FfmpegBuilderModel;
    if (!ffmpegModel) {
        Logger.ELog(
            'Auto quality: FFmpeg Builder model not found. Place this node between FFmpeg Builder Start and Executor.'
        );
        return -1;
    }

    const video = ffmpegModel.VideoStreams && ffmpegModel.VideoStreams[0];
    if (!video) {
        Logger.ELog('Auto quality: No video stream found in FFmpeg Builder model.');
        return -1;
    }

    // ===== GET TOOL PATHS =====
    // Use ffmpeg_vmaf variable if set (for VMAF-enabled FFmpeg), otherwise use default
    const customFfmpeg = Variables['ffmpeg_vmaf'] || Variables.ffmpeg_vmaf;
    const ffmpegToolPath = Flow.GetToolPath('ffmpeg');
    const ffmpegPath = customFfmpeg || ffmpegToolPath;
    // Use the main configured FFmpeg for sample encodes so hw filters/encoders are available.
    const ffmpegEncodePath = ffmpegToolPath || ffmpegPath;
    if (!ffmpegPath) {
        Logger.ELog(
            'Auto quality: ffmpeg not found. Ensure ffmpeg is configured in FileFlows or set the ffmpeg_vmaf variable.'
        );
        return -1;
    }
    if (customFfmpeg) {
        Logger.ILog('Using custom FFmpeg (ffmpeg_vmaf): ' + ffmpegPath);
    } else {
        Logger.ILog('Using default FFmpeg: ' + ffmpegPath);
    }

    // ===== CHECK FOR LIBVMAF SUPPORT =====
    // Test if FFmpeg has libvmaf compiled in, fall back to SSIM if not
    let qualityMetric = 'SSIM'; // Default to SSIM (always available)
    try {
        // Use a targeted check to avoid printing the full `-filters` output to logs.
        let vmafCheck = null;
        try {
            vmafCheck = helpers.executeSilently(
                ffmpegPath,
                ['-hide_banner', '-loglevel', 'error', '-h', 'filter=libvmaf'],
                30
            );
        } catch (e) {
            // If silent exec isn't available, fall back to Flow.Execute (output is small for this command).
            vmafCheck = Flow.Execute({
                command: ffmpegPath,
                argumentList: ['-hide_banner', '-loglevel', 'error', '-h', 'filter=libvmaf'],
                timeout: 30
            });
        }

        const vmafOut = (vmafCheck.output || '') + (vmafCheck.standardOutput || '') + (vmafCheck.standardError || '');
        if (vmafCheck.exitCode === 0 && /libvmaf/i.test(vmafOut)) {
            qualityMetric = 'VMAF';
        } else {
            Logger.DLog(`libvmaf not available (exitCode=${vmafCheck.exitCode}, output=${vmafOut.length} chars)`);
        }
    } catch (e) {
        Logger.WLog(`Could not check for libvmaf support: ${e}`);
    }

    if (qualityMetric === 'VMAF') {
        Logger.ILog('Quality metric: VMAF (libvmaf available)');
    } else {
        Logger.WLog('Quality metric: SSIM (libvmaf not available, using fallback)');
        Logger.ILog('For better quality detection, install FFmpeg with --enable-libvmaf');
    }
    Variables.AutoQuality_Metric = qualityMetric;

    // ===== GATHER VIDEO INFO =====
    const metadata = helpers.getVideoMetadata();
    const duration = metadata.duration;
    const width = metadata.width || 1920;
    const height = metadata.height || 1080;

    const viVar = Variables.vi;
    const videoInfo = (viVar && viVar.VideoInfo) || ffmpegModel.VideoInfo;
    if (!videoInfo) {
        Logger.ELog('Auto quality: VideoInfo not available. Ensure Video File node ran before this.');
        return -1;
    }

    const fileVar = Variables.file;

    const sourceFile = (fileVar && fileVar.FullName) || Flow.WorkingFile;
    const originalFile = (fileVar && fileVar.Orig && fileVar.Orig.FullName) || sourceFile;

    const videoStreams = helpers.toEnumerableArray(videoInfo.VideoStreams, 10);
    const videoStream0 = videoStreams.length > 0 ? videoStreams[0] : null;

    const videoCodec = videoStream0 && videoStream0.Codec ? String(videoStream0.Codec).toLowerCase() : '';
    const videoBitrate = getVideoBitrate(videoInfo);
    const fps = (videoStream0 && videoStream0.FramesPerSecond) || 24;
    const is10Bit = (videoStream0 && videoStream0.Is10Bit) || (videoStream0 && videoStream0.Bits === 10);
    const targetBitDepth = detectTargetBitDepth(video);
    const use10BitForTests = is10Bit || targetBitDepth >= 10;
    const isHDR = (videoStream0 && videoStream0.HDR) || false;
    const isDolbyVision = (videoStream0 && videoStream0.DolbyVision) || false;

    Logger.ILog(
        `Source: ${width}x${height}, ${fps}fps, ${Math.round(videoBitrate / 1000)}kbps, codec=${videoCodec}, HDR=${isHDR}, 10bit=${use10BitForTests}, duration=${Math.round(duration)}s`
    );

    // Validate duration - must be a positive number
    if (!duration || isNaN(duration) || duration <= 0) {
        Logger.ELog(`Auto quality: Could not determine video duration.`);
        Logger.WLog('Leaving quality settings unchanged.');
        Variables.AutoQuality_CRF = 'unchanged';
        Variables.AutoQuality_Reason = 'unknown_duration';
        return 1;
    }

    if (duration < 30) {
        Logger.WLog('Auto quality: Video too short for reliable VMAF sampling. Leaving quality settings unchanged.');
        Variables.AutoQuality_CRF = 'unchanged';
        Variables.AutoQuality_Reason = 'short_video';
        return 1;
    }

    // ===== DETECT ENCODER =====
    const targetCodec = getTargetCodec(video);
    const crfArg = getCRFArgument(targetCodec);
    Logger.ILog(`Target encoder: ${targetCodec}, CRF argument: ${crfArg}`);

    // ===== UPSTREAM VIDEO FILTERS (from FFmpeg Builder) =====
    const encodingParamFilter = getVideoFilterFromEncodingParameters(video);
    const cropFilter = getCropFilterFromModel(video);
    let upstreamVideoFilters = encodingParamFilter || getUpstreamVideoFilters(video);

    // Debug: log what we found from EncodingParameters
    Logger.DLog(`Auto quality: encodingParamFilter from EncodingParameters: '${encodingParamFilter || '(empty)'}'`);

    // Fallback: if no filters found in EncodingParameters or model, try Variables.filters (set by Cleaning Filters)
    if (!upstreamVideoFilters) {
        const cleaningFiltersVar = String(Variables.filters || Variables.video_filters || '').trim();
        if (cleaningFiltersVar) {
            upstreamVideoFilters = cleaningFiltersVar;
            Variables.AutoQuality_FilterSource = 'variables-filters';
            Logger.ILog(`Auto quality: using filters from Variables.filters: ${upstreamVideoFilters}`);
        }
    }

    if (encodingParamFilter) {
        Variables.AutoQuality_FilterSource = 'encoding-params';
        if (cropFilter && upstreamVideoFilters.indexOf('crop=') < 0) {
            upstreamVideoFilters = cropFilter + ',' + upstreamVideoFilters;
        }
    } else if (!upstreamVideoFilters) {
        Variables.AutoQuality_FilterSource = 'model';
    }

    Variables.AutoQuality_UpstreamVideoFilters = upstreamVideoFilters;
    Variables.AutoQuality_EncodingParamFilter = encodingParamFilter || '';
    if (upstreamVideoFilters) {
        Logger.ILog(
            `Auto quality: using upstream video filters for sampling: ${upstreamVideoFilters} (source=${Variables.AutoQuality_FilterSource})`
        );
    } else {
        // Sanity check: warn if filters exist on the model but none are present in EncodingParameters.
        // Some runner versions may ignore Filter/Filters collections in "New mode", so prefer using Cleaning Filters (or equivalent) to inject '-filter:v:0'.
        const maybeModelFilters =
            asJoinedString(video.Filter) || asJoinedString(video.Filters) || asJoinedString(video.OptionalFilter) || '';
        if (maybeModelFilters) {
            Logger.WLog(
                'Auto quality: video filters exist on the FFmpeg Builder model, but no filter chain was found in EncodingParameters; the final executor may ignore them depending on runner version.'
            );
        }
        Logger.WLog('Auto quality: no upstream filters detected - reference and test encodes will use raw source');
    }

    // "Extra high quality" reference transcode quality used as the VMAF/SSIM reference.
    // For hardware encoders this is a "quality value" (eg QSV global_quality), not CRF.
    const referenceQuality = getReferenceQuality(MinCRF, targetCodec);
    Variables.AutoQuality_ReferenceCRF = referenceQuality;

    // ===== CONTENT-AWARE TARGET QUALITY =====
    let effectiveTargetVMAF = TargetVMAF;
    if (TargetVMAF === 0) {
        effectiveTargetVMAF = calculateAutoTargetVMAF();
    }

    // Convert VMAF target to SSIM if using SSIM metric
    // Approximate mapping: VMAF 93→SSIM 0.970, VMAF 95→SSIM 0.980, VMAF 97→SSIM 0.990
    let effectiveTarget = effectiveTargetVMAF;
    if (qualityMetric === 'SSIM') {
        // Linear interpolation: VMAF 90-100 → SSIM 0.96-1.0
        effectiveTarget = 0.96 + (effectiveTargetVMAF - 90) * 0.004;
        effectiveTarget = Math.max(0.95, Math.min(0.999, effectiveTarget));
        Logger.ILog(`Target: VMAF ${effectiveTargetVMAF} → SSIM ${effectiveTarget.toFixed(3)}`);
    } else {
        Logger.ILog(`Target VMAF: ${effectiveTargetVMAF}`);
    }

    // ===== CHECK IF ENCODING IS NEEDED =====
    const targetCodecBase = targetCodec
        .replace(/_qsv|_nvenc|_vaapi|_amf|lib/g, '')
        .replace('x264', 'h264')
        .replace('x265', 'hevc');
    const sourceCodecNormalized = videoCodec.replace('h.264', 'h264');

    if (sourceCodecNormalized === targetCodecBase || sourceCodecNormalized.includes(targetCodecBase)) {
        // Same codec - check if bitrate is acceptable
        const maxAcceptableBitrate = getMaxAcceptableBitrate(width, height);
        if (videoBitrate <= maxAcceptableBitrate && !ffmpegModel.ForceEncode) {
            Logger.ILog(`Video already in ${videoCodec} at acceptable bitrate. Skipping encode.`);
            Variables.AutoQuality_CRF = 'copy';
            Variables.AutoQuality_Reason = 'already_optimal';
            if (UseTags && typeof Flow.AddTags === 'function') {
                Flow.AddTags(['Copy']);
            }
            return 2;
        }
    }

    // ===== CALCULATE SAMPLE POSITIONS =====
    const samplePositions = calculateSamplePositions(duration, SampleCount, SampleDurationSec);
    Logger.ILog(`Sample positions: ${samplePositions.map((p) => Math.round(p) + 's').join(', ')}`);

    // Extract short video-only sample files once (provider-style) to avoid repeatedly opening/seeking the full source.
    // If extraction fails, fall back to seeking into the full source for each encode/metric run.
    const samples = extractVideoSamples(ffmpegEncodePath, originalFile, samplePositions, SampleDurationSec);
    const extractedCount = samples.filter((s) => s.isTempSample).length;
    if (extractedCount > 0) {
        Logger.ILog(`Extracted ${extractedCount}/${samplePositions.length} sample files for quality testing`);
    } else {
        Logger.WLog('Could not extract sample files; falling back to direct seeking into the source for tests');
    }

    // ===== DARK SCENE DETECTION =====
    // Analyze luminance of samples to detect dark content
    const avgLuminance = analyzeLuminance(ffmpegPath, originalFile, samplePositions, SampleDurationSec);
    let luminanceBoost = 0;

    if (avgLuminance >= 0) {
        // Luminance scale: 0 (black) to 255 (white)
        // Typical values: very dark <40, dark 40-70, normal 70-150, bright >150
        if (avgLuminance < 40) {
            luminanceBoost = 3; // Very dark content - significant quality boost
            Logger.ILog(
                `Dark scene detection: VERY DARK (avg luma ${avgLuminance.toFixed(1)}) - boosting quality by ${luminanceBoost}`
            );
        } else if (avgLuminance < 60) {
            luminanceBoost = 2; // Dark content - moderate quality boost
            Logger.ILog(
                `Dark scene detection: DARK (avg luma ${avgLuminance.toFixed(1)}) - boosting quality by ${luminanceBoost}`
            );
        } else if (avgLuminance < 80) {
            luminanceBoost = 1; // Somewhat dark - small quality boost
            Logger.ILog(
                `Dark scene detection: SOMEWHAT DARK (avg luma ${avgLuminance.toFixed(1)}) - boosting quality by ${luminanceBoost}`
            );
        } else {
            Logger.ILog(`Dark scene detection: NORMAL/BRIGHT (avg luma ${avgLuminance.toFixed(1)}) - no adjustment`);
        }
    } else {
        Logger.WLog('Dark scene detection: Could not analyze luminance, skipping adjustment');
    }

    // Apply luminance boost to target
    if (luminanceBoost > 0) {
        if (qualityMetric === 'VMAF') {
            effectiveTarget = Math.min(effectiveTarget + luminanceBoost, 99);
            effectiveTargetVMAF = Math.min(effectiveTargetVMAF + luminanceBoost, 99);
        } else {
            // SSIM: boost by ~0.005 per level
            effectiveTarget = Math.min(effectiveTarget + luminanceBoost * 0.005, 0.999);
        }
        Logger.ILog(
            `Adjusted target: ${qualityMetric} ${qualityMetric === 'SSIM' ? effectiveTarget.toFixed(3) : effectiveTarget}`
        );
    }

    Variables.AutoQuality_AvgLuminance = avgLuminance;
    Variables.AutoQuality_LuminanceBoost = luminanceBoost;

    // ===== QUALITY-BASED CRF SEARCH =====
    const targetDisplay = qualityMetric === 'SSIM' ? effectiveTarget.toFixed(3) : effectiveTarget;
    Logger.ILog(
        `Starting ${qualityMetric}-based CRF search: CRF ${MinCRF}-${MaxCRF}, target ${qualityMetric} ${targetDisplay}`
    );

    const _filtersNeedQsv = detectNeedsQsvFilters(upstreamVideoFilters);

    // Reference strategy:
    // - encoded: pre-encode high quality reference samples using the same encoder + filters as tests.
    //            This ensures apples-to-apples comparison (both go through identical pipeline, only quality differs).
    // - source: compare against the raw sample (no reference transcode). Not recommended as encoder-introduced
    //           changes (colorspace, chroma subsampling) can artificially lower scores.
    // - filtered-in-metric: apply software filters to the reference stream inside the VMAF/SSIM pass (no reference transcode).
    //
    // Default ("auto"): always use 'encoded' to ensure reference and test samples are computed identically.
    let referenceMode = 'auto';
    try {
        const rm = String(Variables.AutoQuality_ReferenceMode || '')
            .trim()
            .toLowerCase();
        if (rm) referenceMode = rm;
    } catch (e) {}
    if (referenceMode === 'auto') {
        // Always use 'encoded' so both reference and test go through the same encoding pipeline.
        // This ensures the quality measurement reflects only the difference in quality settings,
        // not encoder-introduced artifacts like colorspace conversion or chroma subsampling.
        referenceMode = 'encoded';
    }
    if (referenceMode !== 'encoded' && referenceMode !== 'source' && referenceMode !== 'filtered-in-metric') {
        referenceMode = 'encoded';
    }

    const referenceSamples =
        referenceMode === 'encoded'
            ? encodeReferenceSamplesForAutoQuality(
                  ffmpegEncodePath,
                  samples,
                  SampleDurationSec,
                  use10BitForTests,
                  video,
                  targetCodec,
                  upstreamVideoFilters,
                  referenceQuality
              )
            : [];

    if (referenceSamples.length === 0) {
        if (referenceMode === 'encoded') {
            Logger.ELog('Failed to encode any reference samples. Cannot proceed with quality search.');
            Variables.AutoQuality_CRF = 'unchanged';
            Variables.AutoQuality_Reason = 'reference_encode_failed';
            cleanupFiles(samples.filter((s) => s.isTempSample).map((s) => s.inputFile));
            return 1;
        }
    }

    const searchResults = [];
    let bestCRF = null;
    let bestScore = 0;

    let lowCRF = MinCRF;
    let highCRF = MaxCRF;
    let iterations = 0;

    try {
        while (lowCRF <= highCRF && iterations < MaxSearchIterations) {
            iterations++;
            const testCRF = Math.round((lowCRF + highCRF) / 2);

            const existing = searchResults.find((r) => r.crf === testCRF);
            if (existing) {
                if (existing.score >= effectiveTarget) {
                    highCRF = testCRF - 1;
                } else {
                    lowCRF = testCRF + 1;
                }
                continue;
            }

            Logger.ILog(`[${iterations}/${MaxSearchIterations}] Testing CRF ${testCRF}...`);
            if (typeof Flow.AdditionalInfoRecorder === 'function') {
                Flow.AdditionalInfoRecorder('Auto Quality', `CRF ${testCRF}`, 1);
            }

            const iterBase = ((iterations - 1) / MaxSearchIterations) * 100.0;
            const iterSpan = (1.0 / MaxSearchIterations) * 100.0;
            if (typeof Flow.PartPercentageUpdate === 'function') {
                Flow.PartPercentageUpdate(iterBase);
            }

            const qualityScore = measureQualityAtQualityValue(
                ffmpegEncodePath,
                ffmpegPath,
                samples,
                testCRF,
                video,
                targetCodec,
                SampleDurationSec,
                use10BitForTests,
                qualityMetric,
                upstreamVideoFilters,
                referenceMode,
                referenceSamples,
                iterBase,
                iterSpan
            );

            if (qualityScore < 0) {
                Logger.WLog(`${qualityMetric} measurement failed for CRF ${testCRF}, skipping...`);
                lowCRF = testCRF + 1;
                continue;
            }

            searchResults.push({ crf: testCRF, score: qualityScore });
            const scoreDisplay = qualityMetric === 'SSIM' ? qualityScore.toFixed(4) : qualityScore.toFixed(2);
            Logger.ILog(`CRF ${testCRF}: ${qualityMetric} ${scoreDisplay}`);

            if (qualityScore >= effectiveTarget) {
                bestCRF = testCRF;
                bestScore = qualityScore;
                if (PreferSmaller) {
                    lowCRF = testCRF + 1;
                } else {
                    break;
                }
            } else {
                highCRF = testCRF - 1;
            }
        }
    } finally {
        cleanupFiles(referenceSamples.map((r) => r.path));
        cleanupFiles(samples.filter((s) => s.isTempSample).map((s) => s.inputFile));
    }

    if (bestCRF === null) {
        if (searchResults.length > 0) {
            const best = searchResults.reduce((a, b) => (a.score > b.score ? a : b));
            bestCRF = best.crf;
            bestScore = best.score;
            const scoreDisplay = qualityMetric === 'SSIM' ? bestScore.toFixed(4) : bestScore.toFixed(2);
            Logger.WLog(
                `No CRF met target ${qualityMetric} ${targetDisplay}. Using best found: CRF ${bestCRF} (${qualityMetric} ${scoreDisplay})`
            );
        } else {
            Logger.ELog(`${qualityMetric} search failed completely. Leaving quality settings unchanged.`);
            logResultsTable(searchResults, null, effectiveTarget, qualityMetric);
            Variables.AutoQuality_CRF = 'unchanged';
            Variables.AutoQuality_Reason = 'quality_search_failed';
            return 1;
        }
    }

    logResultsTable(searchResults, bestCRF, effectiveTarget, qualityMetric);

    // ===== APPLY CRF AND PRESET TO ENCODER =====
    applyCRF(video, bestCRF, targetCodec, Preset);

    // Store results
    Variables.AutoQuality_CRF = bestCRF;
    Variables.AutoQuality_Score = bestScore;
    Variables.AutoQuality_Metric = qualityMetric;
    Variables.AutoQuality_Target = effectiveTarget;
    Variables.AutoQuality_TargetVMAF = effectiveTargetVMAF; // Keep for backwards compatibility
    Variables.AutoQuality_Iterations = iterations;
    Variables.AutoQuality_Results = JSON.stringify(searchResults);

    const finalScoreDisplay = qualityMetric === 'SSIM' ? bestScore.toFixed(4) : bestScore.toFixed(1);
    if (typeof Flow.AdditionalInfoRecorder === 'function') {
        Flow.AdditionalInfoRecorder('CRF', bestCRF, 1000);
        Flow.AdditionalInfoRecorder(qualityMetric, finalScoreDisplay, 1000);
    }

    if (UseTags) {
        const tagScore = qualityMetric === 'SSIM' ? bestScore.toFixed(3) : Math.round(bestScore);
        if (typeof Flow.AddTags === 'function') {
            Flow.AddTags([`CRF ${bestCRF}`, `${qualityMetric} ${tagScore}`]);
        }
    }

    Logger.ILog(
        `Auto quality complete: CRF ${bestCRF} (${qualityMetric} ${finalScoreDisplay}, target was ${targetDisplay})`
    );
    return 1;

    // ===== HELPER FUNCTIONS =====

    function getVideoBitrate(vi) {
        const videoStream0 = vi && vi.VideoStreams && vi.VideoStreams[0];
        let bitrate = videoStream0 ? videoStream0.Bitrate : 0;
        if (!bitrate || bitrate <= 0) {
            let overall = vi.Bitrate || 0;
            if (overall > 0) {
                let calculated = overall;
                const audioStreams = toEnumerableArray(vi.AudioStreams, 64);
                if (audioStreams.length) {
                    for (let i = 0; i < audioStreams.length; i++) {
                        const audio = audioStreams[i];
                        if (!audio) continue;
                        if (audio.Bitrate > 0) calculated -= audio.Bitrate;
                        else calculated -= overall * 0.05;
                    }
                }
                bitrate = calculated;
            }
        }
        return bitrate || 0;
    }

    function getTargetCodec(videoStream) {
        // Try to detect from encoding parameters
        const params = [];
        try {
            if (videoStream.EncodingParameters) {
                const ep = videoStream.EncodingParameters;
                if (typeof ep.GetEnumerator === 'function') {
                    const enumerator = ep.GetEnumerator();
                    while (enumerator.MoveNext()) {
                        params.push(String(enumerator.Current));
                    }
                } else if (ep.length) {
                    for (let i = 0; i < ep.length; i++) params.push(String(ep[i]));
                }
            }
        } catch (e) {}

        const signature = params.join(' ').toLowerCase();

        // Check for specific encoders in parameters
        if (signature.includes('hevc_qsv') || signature.includes('h265_qsv')) return 'hevc_qsv';
        if (signature.includes('hevc_nvenc')) return 'hevc_nvenc';
        if (signature.includes('hevc_vaapi')) return 'hevc_vaapi';
        if (signature.includes('hevc_amf')) return 'hevc_amf';
        if (signature.includes('libx265')) return 'libx265';
        if (signature.includes('h264_qsv')) return 'h264_qsv';
        if (signature.includes('h264_nvenc')) return 'h264_nvenc';
        if (signature.includes('h264_vaapi')) return 'h264_vaapi';
        if (signature.includes('libx264')) return 'libx264';
        if (signature.includes('libsvtav1') || signature.includes('av1_qsv') || signature.includes('av1_nvenc')) {
            if (signature.includes('av1_qsv')) return 'av1_qsv';
            if (signature.includes('av1_nvenc')) return 'av1_nvenc';
            return 'libsvtav1';
        }

        // Try to get from Codec property
        const codec = String(videoStream.Codec || '').toLowerCase();
        if (codec.includes('hevc') || codec.includes('h265') || codec.includes('x265')) return 'libx265';
        if (codec.includes('h264') || codec.includes('x264') || codec.includes('avc')) return 'libx264';
        if (codec.includes('av1')) return 'libsvtav1';

        // Default to libx265
        return 'libx265';
    }

    function getCRFArgument(codec) {
        if (codec.includes('_vaapi')) return '-qp';
        if (codec.includes('_nvenc')) return '-cq';
        if (codec.includes('_qsv')) return '-global_quality:v';
        if (codec.includes('_amf')) return '-qp_i';
        return '-crf';
    }

    function getReferenceQuality(minValue, targetCodec) {
        // Keep the reference noticeably higher quality than the search range.
        // For software CRF-like scales: lower is better; clamp to 0.
        // For QSV global_quality: lower is better; clamp to 1.
        const q = (parseInt(minValue) || 18) - 8;
        const codec = String(targetCodec || '').toLowerCase();
        if (codec.indexOf('_qsv') >= 0) return Math.max(1, q);
        return Math.max(0, q);
    }

    function calculateAutoTargetVMAF() {
        // Content-aware VMAF targeting
        // Check multiple sources for metadata (Radarr/Sonarr search scripts populate these)
        const metadata = Variables.VideoMetadata || Variables.MovieInfo || Variables.TVShowInfo || {};
        const year = metadata.Year || metadata.year || 2015;

        // Genres can be an array or string
        let genres = metadata.Genres || metadata.genres || [];
        if (typeof genres === 'string') {
            genres = genres.split(/[,|]/).map((g) => g.trim());
        }

        const isAnimation = genres.some(
            (g) =>
                g.toLowerCase().includes('animation') ||
                g.toLowerCase().includes('anime') ||
                g.toLowerCase().includes('cartoon')
        );
        const isDocumentary = genres.some((g) => g.toLowerCase().includes('documentary'));

        let target = 95; // Default balanced target

        if (isAnimation) {
            // Animation can tolerate more compression (less fine detail)
            if (year <= 1995)
                target = 93; // Old cel animation
            else if (year <= 2010) target = 94;
            else target = 95;
        } else if (isDocumentary) {
            // Documentary often has fine details, grain for atmosphere
            target = 96;
        } else {
            // Live action films
            if (year <= 1990)
                target = 93; // Old films with grain
            else if (year <= 2005) target = 94;
            else if (year <= 2015) target = 95;
            else target = 96; // Modern films - preserve more detail
        }

        // HDR content needs higher quality to preserve dynamic range nuances
        if (isHDR || isDolbyVision) {
            target = Math.min(target + 1, 97);
        }

        // 4K content - slightly higher target
        if (width >= 3800) {
            target = Math.min(target + 1, 97);
        }

        const hasMetadata = metadata.Year || metadata.year;
        Logger.ILog(
            `Auto VMAF target: ${target} (year=${year}, animation=${isAnimation}, HDR=${isHDR}, metadata=${hasMetadata ? 'yes' : 'default'})`
        );
        return target;
    }

    function getMaxAcceptableBitrate(w, h) {
        // Max bitrate thresholds based on resolution
        const pixels = w * h;
        if (pixels >= 3840 * 2160) return 25000000; // 4K: 25 Mbps
        if (pixels >= 1920 * 1080) return 12000000; // 1080p: 12 Mbps
        if (pixels >= 1280 * 720) return 6000000; // 720p: 6 Mbps
        return 3000000; // SD: 3 Mbps
    }

    function calculateSamplePositions(totalDuration, count, sampleDur) {
        const positions = [];
        // Avoid first and last 10% of video (often credits/intros)
        const startOffset = Math.max(30, totalDuration * 0.1);
        const endOffset = Math.max(30, totalDuration * 0.1);
        const usableDuration = totalDuration - startOffset - endOffset - sampleDur;

        if (usableDuration <= 0 || count <= 1) {
            // Video too short, take middle
            positions.push(Math.max(10, (totalDuration - sampleDur) / 2));
            return positions;
        }

        const spacing = usableDuration / (count - 1);
        for (let i = 0; i < count; i++) {
            positions.push(startOffset + spacing * i);
        }
        return positions;
    }

    function detectNeedsQsvFilters(filters) {
        const s = String(filters || '')
            .trim()
            .toLowerCase();
        if (!s) return false;
        if (s.indexOf('vpp_qsv') >= 0) return true;
        if (s.indexOf('scale_qsv') >= 0) return true;
        if (s.indexOf('deinterlace_qsv') >= 0) return true;
        if (s.indexOf('tonemap_qsv') >= 0) return true;
        if (s.indexOf('hwupload') >= 0 || s.indexOf('hwdownload') >= 0) return true;
        return /_qsv(?:=|,|:|$)/i.test(s);
    }

    function extractVideoSamples(ffmpegExtract, inputFile, positions, sampleDur) {
        // Provider-style: extract short video-only sample files once, then run encodes/metrics against those.
        // Returns an array of sample descriptors; if extraction fails, entries fall back to seeking into inputFile.
        const results = [];
        const tempDir = Flow.TempPath;

        const pad6 = (n) => ('000000' + String(n)).slice(-6);

        for (let i = 0; i < (positions || []).length; i++) {
            const pos = positions[i];
            const sec = Math.max(0, Math.floor(pos || 0));
            const sampleName = `sample_${pad6(sec)}`;
            const samplePath = `${tempDir}/${sampleName}.mkv`;

            let extracted = false;
            try {
                const args = [
                    '-hide_banner',
                    '-loglevel',
                    'error',
                    '-y',
                    '-progress',
                    'pipe:2',
                    '-nostats',
                    '-ss',
                    String(sec),
                    '-i',
                    inputFile,
                    '-t',
                    String(sampleDur),
                    '-map',
                    '0:v:0',
                    '-an',
                    '-sn',
                    '-c:v',
                    'copy',
                    '-map_chapters',
                    '-1',
                    samplePath
                ];

                const r = helpers.executeFfmpegWithProgress(ffmpegExtract, args, 120, sampleDur, 0, 100);
                if (r && r.exitCode === 0 && System.IO.File.Exists(samplePath)) {
                    extracted = true;
                }
            } catch (e) {}

            if (extracted) {
                results.push({
                    pos: pos,
                    inputFile: samplePath,
                    seekSeconds: 0,
                    durationSeconds: sampleDur,
                    isTempSample: true,
                    key: sampleName
                });
            } else {
                try {
                    if (System.IO.File.Exists(samplePath)) System.IO.File.Delete(samplePath);
                } catch (e) {}
                results.push({
                    pos: pos,
                    inputFile: inputFile,
                    seekSeconds: sec,
                    durationSeconds: sampleDur,
                    isTempSample: false,
                    key: sampleName
                });
            }
        }

        return results;
    }

    function analyzeLuminance(ffmpeg, inputFile, positions, _sampleDur) {
        // Analyze average luminance across sample positions using signalstats filter
        // Returns average Y (luma) value 0-255, or -1 on failure
        const luminanceValues = [];

        for (let i = 0; i < Math.min(positions.length, 3); i++) {
            // Limit to 3 samples for speed
            const pos = positions[i];

            try {
                // Use signalstats filter to get average luminance (YAVG)
                // Only analyze 2 seconds for speed
                const metadataFile = System.IO.Path.Combine(
                    Flow.TempPath,
                    'autoquality_signalstats_' + Flow.NewGuid() + '.txt'
                );
                let output = '';
                try {
                    const args = [
                        '-hide_banner',
                        '-loglevel',
                        'error',
                        '-ss',
                        String(Math.floor(pos)),
                        '-i',
                        inputFile,
                        '-t',
                        '2',
                        '-vf',
                        'signalstats,metadata=print:file=' + escapeFfmpegFilterArgValue(metadataFile),
                        '-f',
                        'null',
                        '-'
                    ];

                    let result = null;
                    try {
                        result = helpers.executeSilently(ffmpeg, args, 60);
                        if (!result || result.completed === false)
                            throw new Error((result && result.standardError) || 'silent execute failed');
                        output = (result.standardOutput || '') + '\n' + (result.standardError || '');
                    } catch (e) {
                        // Fallback: still keep output quiet by writing metadata to a file.
                        result = Flow.Execute({ command: ffmpeg, argumentList: args, timeout: 60 });
                        output =
                            (result.output || '') +
                            '\n' +
                            (result.standardOutput || '') +
                            '\n' +
                            (result.standardError || '');
                    }

                    if (System.IO.File.Exists(metadataFile)) {
                        output += '\n' + System.IO.File.ReadAllText(metadataFile);
                    }
                } finally {
                    try {
                        if (System.IO.File.Exists(metadataFile)) System.IO.File.Delete(metadataFile);
                    } catch (e) {}
                }

                // Parse YAVG values from output
                // Format: lavfi.signalstats.YAVG=123.456
                const yavgMatches = output.matchAll(/YAVG[=:](\d+\.?\d*)/gi);
                const yavgValues = [];
                for (const match of yavgMatches) {
                    const val = parseFloat(match[1]);
                    if (!isNaN(val) && val >= 0 && val <= 255) {
                        yavgValues.push(val);
                    }
                }

                if (yavgValues.length > 0) {
                    // Average the YAVG values from this sample
                    const sampleAvg = yavgValues.reduce((a, b) => a + b, 0) / yavgValues.length;
                    luminanceValues.push(sampleAvg);
                    Logger.DLog(`Luminance sample ${i + 1} at ${Math.round(pos)}s: avg Y = ${sampleAvg.toFixed(1)}`);
                }
            } catch (err) {
                Logger.DLog(`Luminance analysis failed for sample ${i + 1}: ${err}`);
            }
        }

        if (luminanceValues.length === 0) {
            return -1;
        }

        // Return overall average luminance
        const overallAvg = luminanceValues.reduce((a, b) => a + b, 0) / luminanceValues.length;
        return overallAvg;
    }

    function encodeReferenceSamplesForAutoQuality(
        ffmpegEncode,
        samples,
        sampleDur,
        use10Bit,
        videoStream,
        encoder,
        upstreamFilters,
        referenceQuality
    ) {
        // Pre-encode high-quality reference samples (only used when upstream filters require QSV filters).
        // Returns array of {key, pos, path, filterMode, activeFilters}.
        const tempDir = Flow.TempPath;
        const results = [];

        const upstreamFiltersStr = String(upstreamFilters || '').trim();
        const upstreamNeedsQsv = detectNeedsQsvFilters(upstreamFiltersStr);

        function getQualityArgForSampling(codec) {
            const base = getCRFArgument(String(codec || ''));
            if (base === '-global_quality') return '-global_quality:v';
            return base;
        }

        const encSig = String(encoder || '').toLowerCase();
        const outputIsQsvEncoder = encSig.indexOf('_qsv') >= 0;
        const qualityArg = getQualityArgForSampling(encoder);

        function buildBaseEncodeTokens() {
            const raw = toEnumerableArray(videoStream && videoStream.EncodingParameters, 5000)
                .map(safeTokenString)
                .filter((x) => x);
            const kept = [];
            const encoderToken = String(encoder || '')
                .trim()
                .toLowerCase();

            for (let i = 0; i < raw.length; i++) {
                const t = String(raw[i] || '').replace(/\{index\}/gi, '0');
                if (!t) continue;
                if (encoderToken && String(t).trim().toLowerCase() === encoderToken) continue;

                if (t === '-vf' || t === '-filter_complex') {
                    i++;
                    continue;
                }
                if (t === '-pix_fmt') {
                    i++;
                    continue;
                }
                if (
                    t === '-loglevel' ||
                    t === '-ss' ||
                    t === '-t' ||
                    t === '-i' ||
                    t === '-map' ||
                    t === '-map_chapters'
                ) {
                    i++;
                    continue;
                }

                if (t === '-crf' || t.startsWith('-crf')) {
                    i++;
                    continue;
                }
                if (t === '-cq' || t.startsWith('-cq')) {
                    i++;
                    continue;
                }
                if (t === '-qp' || t.startsWith('-qp') || t.startsWith('-qp_i')) {
                    i++;
                    continue;
                }
                if (t === '-global_quality' || t.startsWith('-global_quality')) {
                    i++;
                    continue;
                }
                if (t.startsWith('-filter:v')) {
                    i++;
                    continue;
                }
                if (t.startsWith('-c:v')) {
                    i++;
                    continue;
                }
                if (t.startsWith('-pix_fmt')) {
                    i++;
                    continue;
                }
                if (t === '-an' || t === '-sn' || t === '-dn' || t === '-y' || t === '-hide_banner' || t === '-nostats')
                    continue;

                kept.push(t);
            }

            kept.push('-c:v', String(encoder));
            if (encSig.indexOf('_qsv') >= 0) {
                const pf = use10Bit ? 'p010le' : 'nv12';
                kept.push('-pix_fmt', pf);
            } else {
                const pf = use10Bit ? 'yuv420p10le' : 'yuv420p';
                kept.push('-pix_fmt', pf);
                kept.push('-preset', Preset);
            }

            return kept;
        }

        const baseEncodeTokens = buildBaseEncodeTokens();

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

        function isHwuploadSegment(seg) {
            return /^hwupload(=|$)/i.test(String(seg || '').trim());
        }
        function isHwdownloadSegment(seg) {
            return /^hwdownload(=|$)/i.test(String(seg || '').trim());
        }
        function isQsvFilterSegment(seg) {
            const s = String(seg || '')
                .trim()
                .toLowerCase();
            if (!s) return false;
            if (
                s.startsWith('vpp_qsv') ||
                s.startsWith('scale_qsv') ||
                s.startsWith('deinterlace_qsv') ||
                s.startsWith('tonemap_qsv')
            )
                return true;
            if (/^[a-z0-9_]+_qsv(=|$)/.test(s)) return true;
            return false;
        }

        function buildSamplingFilterGraph(filters, wantSoftwareFrames) {
            let vf = String(filters || '').trim();
            if (!vf) return '';
            const qsvRequired = detectNeedsQsvFilters(vf);
            if (!qsvRequired) return vf;

            const segments = splitFilterChain(vf);
            if (segments.length === 0) return '';

            const uploadFmt = use10Bit ? 'p010le' : 'nv12';
            let firstQsv = -1;
            for (let i = 0; i < segments.length; i++) {
                if (isQsvFilterSegment(segments[i])) {
                    firstQsv = i;
                    break;
                }
            }
            if (firstQsv < 0) firstQsv = 0;

            let hasHwuploadBefore = false;
            for (let i = 0; i < firstQsv; i++) {
                if (isHwuploadSegment(segments[i])) {
                    hasHwuploadBefore = true;
                    break;
                }
            }
            if (!hasHwuploadBefore) {
                segments.splice(firstQsv, 0, `format=${uploadFmt}`, 'hwupload=extra_hw_frames=64');
            }

            if (wantSoftwareFrames) {
                let lastQsv = -1;
                for (let i = segments.length - 1; i >= 0; i--) {
                    if (isQsvFilterSegment(segments[i])) {
                        lastQsv = i;
                        break;
                    }
                }
                if (lastQsv < 0) lastQsv = segments.length - 1;

                let hasHwdownloadAfter = false;
                for (let i = lastQsv + 1; i < segments.length; i++) {
                    if (isHwdownloadSegment(segments[i])) {
                        hasHwdownloadAfter = true;
                        break;
                    }
                }
                if (!hasHwdownloadAfter) {
                    const downloadFmt = use10Bit ? 'p010le' : 'nv12';
                    const pixFmt = use10Bit ? 'yuv420p10le' : 'yuv420p';
                    if (downloadFmt === pixFmt) {
                        segments.splice(lastQsv + 1, 0, 'hwdownload', `format=${downloadFmt}`);
                    } else {
                        segments.splice(lastQsv + 1, 0, 'hwdownload', `format=${downloadFmt}`, `format=${pixFmt}`);
                    }
                }
            }

            return segments.join(',');
        }

        function stripQsvOnlyFilters(filters) {
            const vf = String(filters || '').trim();
            if (!vf) return '';
            const segs = splitFilterChain(vf);
            const kept = [];
            for (let i = 0; i < segs.length; i++) {
                const seg = segs[i];
                if (isQsvFilterSegment(seg)) continue;
                if (isHwuploadSegment(seg) || isHwdownloadSegment(seg)) continue;
                kept.push(seg);
            }
            return kept.join(',');
        }

        const softwareFilters = upstreamNeedsQsv ? stripQsvOnlyFilters(upstreamFiltersStr) : upstreamFiltersStr;

        Logger.ILog(`Pre-encoding ${samples.length} reference samples at quality ${referenceQuality} (${encoder})...`);

        function buildEncodeArgs(sample, qValue, outputFile, filters) {
            const args = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-nostats', '-y'];
            const qsvRequired = detectNeedsQsvFilters(filters);
            if (qsvRequired) {
                args.push('-init_hw_device', 'qsv=qsv', '-filter_hw_device', 'qsv');
            }
            if (sample.seekSeconds && sample.seekSeconds > 0) args.push('-ss', String(sample.seekSeconds));
            args.push('-i', sample.inputFile);
            args.push('-t', String(sampleDur));
            args.push('-map', '0:v:0');
            const vf = buildSamplingFilterGraph(filters, !outputIsQsvEncoder);
            if (vf) {
                args.push('-vf', vf);
            }
            for (let i = 0; i < baseEncodeTokens.length; i++) args.push(baseEncodeTokens[i]);
            args.push(qualityArg, String(qValue));
            args.push('-an', '-sn', outputFile);
            return args;
        }

        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            const referencePath = `${tempDir}/${sample.key}_reference.mkv`;

            let activeFilters = upstreamFiltersStr;
            let filterMode = 'upstream';

            try {
                let refResult = helpers.executeFfmpegWithProgress(
                    ffmpegEncode,
                    buildEncodeArgs(sample, referenceQuality, referencePath, activeFilters),
                    600,
                    sampleDur,
                    0,
                    100
                );

                if (refResult.exitCode !== 0 && upstreamNeedsQsv && softwareFilters !== upstreamFiltersStr) {
                    Logger.WLog(
                        `Reference sample ${i + 1} failed with QSV filters (${sample.key}); retrying with software-only filters`
                    );
                    activeFilters = softwareFilters;
                    filterMode = 'software-fallback';
                    refResult = helpers.executeFfmpegWithProgress(
                        ffmpegEncode,
                        buildEncodeArgs(sample, referenceQuality, referencePath, activeFilters),
                        600,
                        sampleDur,
                        0,
                        100
                    );
                }

                if (refResult.exitCode !== 0) {
                    Logger.WLog(`Failed to encode reference sample ${i + 1} (${sample.key})`);
                    continue;
                }

                results.push({
                    key: sample.key,
                    pos: sample.pos,
                    path: referencePath,
                    filterMode: filterMode,
                    activeFilters: activeFilters
                });
                Logger.DLog(`Reference sample ${i + 1} encoded (${sample.key}, ${filterMode})`);
            } catch (err) {
                Logger.WLog(`Error encoding reference sample ${i + 1} (${sample.key}): ${err}`);
            }
        }

        if (results.length === 0) {
            Logger.ELog('Failed to encode any reference samples');
        } else {
            Logger.ILog(`Successfully pre-encoded ${results.length}/${samples.length} reference samples`);
        }

        return results;
    }

    function measureQualityAtQualityValue(
        ffmpegEncode,
        ffmpegMetric,
        samples,
        qualityValue,
        videoStream,
        encoder,
        sampleDur,
        use10Bit,
        metric,
        upstreamFilters,
        referenceMode,
        referenceSamples,
        progressBase,
        progressSpan
    ) {
        const tempDir = Flow.TempPath;
        const scores = [];

        if (!samples || samples.length === 0) {
            Logger.ELog('No samples available for quality measurement');
            return -1;
        }

        const upstreamFiltersStr = String(upstreamFilters || '').trim();
        const encSig = String(encoder || '').toLowerCase();
        const outputIsQsvEncoder = encSig.indexOf('_qsv') >= 0;

        function getQualityArgForSampling(codec) {
            const base = getCRFArgument(String(codec || ''));
            if (base === '-global_quality') return '-global_quality:v';
            return base;
        }

        const qualityArg = getQualityArgForSampling(encoder);

        function buildBaseEncodeTokens() {
            const raw = toEnumerableArray(videoStream && videoStream.EncodingParameters, 5000)
                .map(safeTokenString)
                .filter((x) => x);
            const kept = [];
            const encoderToken = String(encoder || '')
                .trim()
                .toLowerCase();

            for (let i = 0; i < raw.length; i++) {
                const t = String(raw[i] || '').replace(/\{index\}/gi, '0');
                if (!t) continue;
                if (encoderToken && String(t).trim().toLowerCase() === encoderToken) continue;

                if (t === '-vf' || t === '-filter_complex') {
                    i++;
                    continue;
                }
                if (t === '-pix_fmt') {
                    i++;
                    continue;
                }
                if (
                    t === '-loglevel' ||
                    t === '-ss' ||
                    t === '-t' ||
                    t === '-i' ||
                    t === '-map' ||
                    t === '-map_chapters'
                ) {
                    i++;
                    continue;
                }

                if (t === '-crf' || t.startsWith('-crf')) {
                    i++;
                    continue;
                }
                if (t === '-cq' || t.startsWith('-cq')) {
                    i++;
                    continue;
                }
                if (t === '-qp' || t.startsWith('-qp') || t.startsWith('-qp_i')) {
                    i++;
                    continue;
                }
                if (t === '-global_quality' || t.startsWith('-global_quality')) {
                    i++;
                    continue;
                }
                if (t.startsWith('-filter:v')) {
                    i++;
                    continue;
                }
                if (t.startsWith('-c:v')) {
                    i++;
                    continue;
                }
                if (t.startsWith('-pix_fmt')) {
                    i++;
                    continue;
                }
                if (t === '-an' || t === '-sn' || t === '-dn' || t === '-y' || t === '-hide_banner' || t === '-nostats')
                    continue;

                kept.push(t);
            }

            kept.push('-c:v', String(encoder));
            if (encSig.indexOf('_qsv') >= 0) {
                const pf = use10Bit ? 'p010le' : 'nv12';
                kept.push('-pix_fmt', pf);
            } else {
                const pf = use10Bit ? 'yuv420p10le' : 'yuv420p';
                kept.push('-pix_fmt', pf);
                kept.push('-preset', Preset);
            }

            return kept;
        }

        const baseEncodeTokens = buildBaseEncodeTokens();

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

        function isHwuploadSegment(seg) {
            return /^hwupload(=|$)/i.test(String(seg || '').trim());
        }
        function isHwdownloadSegment(seg) {
            return /^hwdownload(=|$)/i.test(String(seg || '').trim());
        }
        function isQsvFilterSegment(seg) {
            const s = String(seg || '')
                .trim()
                .toLowerCase();
            if (!s) return false;
            if (
                s.startsWith('vpp_qsv') ||
                s.startsWith('scale_qsv') ||
                s.startsWith('deinterlace_qsv') ||
                s.startsWith('tonemap_qsv')
            )
                return true;
            if (/^[a-z0-9_]+_qsv(=|$)/.test(s)) return true;
            return false;
        }

        function buildSamplingFilterGraph(filters, wantSoftwareFrames) {
            let vf = String(filters || '').trim();
            if (!vf) return '';
            const qsvRequired = detectNeedsQsvFilters(vf);
            if (!qsvRequired) return vf;

            const segments = splitFilterChain(vf);
            if (segments.length === 0) return '';

            const uploadFmt = use10Bit ? 'p010le' : 'nv12';
            let firstQsv = -1;
            for (let i = 0; i < segments.length; i++) {
                if (isQsvFilterSegment(segments[i])) {
                    firstQsv = i;
                    break;
                }
            }
            if (firstQsv < 0) firstQsv = 0;

            let hasHwuploadBefore = false;
            for (let i = 0; i < firstQsv; i++) {
                if (isHwuploadSegment(segments[i])) {
                    hasHwuploadBefore = true;
                    break;
                }
            }
            if (!hasHwuploadBefore) {
                segments.splice(firstQsv, 0, `format=${uploadFmt}`, 'hwupload=extra_hw_frames=64');
            }

            if (wantSoftwareFrames) {
                let lastQsv = -1;
                for (let i = segments.length - 1; i >= 0; i--) {
                    if (isQsvFilterSegment(segments[i])) {
                        lastQsv = i;
                        break;
                    }
                }
                if (lastQsv < 0) lastQsv = segments.length - 1;

                let hasHwdownloadAfter = false;
                for (let i = lastQsv + 1; i < segments.length; i++) {
                    if (isHwdownloadSegment(segments[i])) {
                        hasHwdownloadAfter = true;
                        break;
                    }
                }
                if (!hasHwdownloadAfter) {
                    const downloadFmt = use10Bit ? 'p010le' : 'nv12';
                    const pixFmt = use10Bit ? 'yuv420p10le' : 'yuv420p';
                    if (downloadFmt === pixFmt) {
                        segments.splice(lastQsv + 1, 0, 'hwdownload', `format=${downloadFmt}`);
                    } else {
                        segments.splice(lastQsv + 1, 0, 'hwdownload', `format=${downloadFmt}`, `format=${pixFmt}`);
                    }
                }
            }

            return segments.join(',');
        }

        function buildEncodeArgs(sample, qValue, outputFile, filters) {
            const args = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-nostats', '-y'];
            const qsvRequired = detectNeedsQsvFilters(filters);
            if (qsvRequired) {
                args.push('-init_hw_device', 'qsv=qsv', '-filter_hw_device', 'qsv');
            }
            if (sample.seekSeconds && sample.seekSeconds > 0) args.push('-ss', String(sample.seekSeconds));
            args.push('-i', sample.inputFile);
            args.push('-t', String(sampleDur));
            args.push('-map', '0:v:0');
            const vf = buildSamplingFilterGraph(filters, !outputIsQsvEncoder);
            if (vf) {
                args.push('-vf', vf);
            }
            for (let i = 0; i < baseEncodeTokens.length; i++) args.push(baseEncodeTokens[i]);
            args.push(qualityArg, String(qValue));
            args.push('-an', '-sn', outputFile);
            return args;
        }

        const refByKey = {};
        if (referenceSamples && referenceSamples.length) {
            for (let i = 0; i < referenceSamples.length; i++) {
                const r = referenceSamples[i];
                if (r && r.key) refByKey[r.key] = r;
            }
        }

        let vmafNSubsample = 1;
        try {
            const desired = parseFloat(Variables.AutoQuality_VmafFps || Variables.VmafFps || 0);
            if (metric === 'VMAF' && desired > 0 && fps > 0) {
                vmafNSubsample = Math.max(1, Math.round(fps / desired));
            }
        } catch (e) {}

        const metricFilter =
            metric === 'VMAF'
                ? `libvmaf=n_threads=4${vmafNSubsample > 1 ? ':n_subsample=' + vmafNSubsample : ''}:shortest=1:eof_action=endall`
                : 'ssim';

        const pb = parseFloat(progressBase || 0);
        const ps = parseFloat(progressSpan || 100);
        const totalSteps = Math.max(1, samples.length * 2);
        const stepSpan = ps / totalSteps;

        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            const encodedSample = `${tempDir}/${sample.key}_encoded_quality_${qualityValue}.mkv`;

            const ref = refByKey[sample.key];
            const activeFilters = (ref && ref.activeFilters) || upstreamFiltersStr;
            const filterMode = (ref && ref.filterMode) || (upstreamFiltersStr ? 'upstream' : 'none');

            try {
                const encStepBase = pb + stepSpan * (i * 2 + 0);
                const encResult = helpers.executeFfmpegWithProgress(
                    ffmpegEncode,
                    buildEncodeArgs(sample, qualityValue, encodedSample, activeFilters),
                    600,
                    sampleDur,
                    encStepBase,
                    stepSpan
                );

                if (encResult.exitCode !== 0) {
                    Logger.WLog(`Failed to encode sample (${sample.key}) at quality ${qualityValue} (${encoder})`);
                    continue;
                }

                if (filterMode === 'software-fallback') {
                    Variables.AutoQuality_FilterMode = 'software-fallback';
                } else if (!Variables.AutoQuality_FilterMode) {
                    Variables.AutoQuality_FilterMode = upstreamFiltersStr ? 'upstream' : 'none';
                }

                const applyRefFiltersInMetric = referenceMode === 'filtered-in-metric' && upstreamFiltersStr;
                const refChain = applyRefFiltersInMetric
                    ? `setpts=PTS-STARTPTS,${upstreamFiltersStr},scale=flags=bicubic`
                    : 'setpts=PTS-STARTPTS,scale=flags=bicubic';
                const filterComplex = `[0:v]setpts=PTS-STARTPTS,scale=flags=bicubic[distorted];[1:v]${refChain}[reference];[distorted][reference]${metricFilter}`;

                const metricArgs = [
                    '-hide_banner',
                    '-loglevel',
                    'info',
                    '-progress',
                    'pipe:2',
                    '-nostats',
                    '-y',
                    '-i',
                    encodedSample
                ];

                if (referenceMode === 'encoded') {
                    const referencePath = ref && ref.path;
                    if (!referencePath) {
                        Logger.WLog(`Missing reference for sample ${sample.key}`);
                        continue;
                    }
                    metricArgs.push('-i', referencePath);
                } else {
                    if (sample.seekSeconds && sample.seekSeconds > 0)
                        metricArgs.push('-ss', String(sample.seekSeconds));
                    metricArgs.push('-t', String(sampleDur));
                    metricArgs.push('-i', sample.inputFile);
                }

                metricArgs.push('-filter_complex', filterComplex, '-f', 'null', '-');

                const metricStepBase = pb + stepSpan * (i * 2 + 1);
                const qualityResult = helpers.executeFfmpegWithProgress(
                    ffmpegMetric,
                    metricArgs,
                    300,
                    sampleDur,
                    metricStepBase,
                    stepSpan
                );

                const output =
                    (qualityResult.output || '') +
                    '\n' +
                    (qualityResult.standardOutput || '') +
                    '\n' +
                    (qualityResult.standardError || '');

                let score = null;
                if (metric === 'VMAF') {
                    const vmafMatch = output.match(/VMAF score[^0-9]*([0-9]+(?:[.][0-9]+)?)/i);
                    if (vmafMatch) score = parseFloat(vmafMatch[1]);
                    else {
                        const jsonMatch = output.match(/"vmaf"[^0-9]*([0-9]+(?:[.][0-9]+)?)/i);
                        if (jsonMatch) score = parseFloat(jsonMatch[1]);
                    }
                } else {
                    const ssimMatch = output.match(/All:[^0-9]*([0-9]+(?:[.][0-9]+)?)/i);
                    if (ssimMatch) score = parseFloat(ssimMatch[1]);
                }

                if (score !== null) {
                    scores.push(score);
                    const scoreDisplay = metric === 'SSIM' ? score.toFixed(4) : score.toFixed(2);
                    Logger.DLog(`Sample ${i + 1} (${sample.key}): ${metric} ${scoreDisplay}`);
                } else {
                    Logger.WLog(`Could not parse ${metric} score for sample ${sample.key}`);
                    const snippet = output.substring(0, 500).split('\n').join(' ');
                    Logger.DLog(`Output snippet: ${snippet}`);
                }
            } catch (err) {
                Logger.WLog(`Error processing sample ${sample.key}: ${err}`);
            } finally {
                cleanupFiles([encodedSample]);
            }
        }

        if (scores.length === 0) return -1;
        return scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    function cleanupFiles(files) {
        for (const file of files) {
            try {
                if (System.IO.File.Exists(file)) {
                    System.IO.File.Delete(file);
                }
            } catch (e) {}
        }
    }

    function applyCRF(videoStream, crf, encoder, preset) {
        const crfArg = getCRFArgument(encoder);
        const ep = videoStream.EncodingParameters;
        if (!ep) return;

        function toArray(list, maxItems) {
            if (!list) return [];
            if (Array.isArray(list)) return list.slice();
            const limit = maxItems || 5000;
            try {
                if (typeof list.GetEnumerator === 'function') {
                    const result = [];
                    const e = list.GetEnumerator();
                    let count = 0;
                    while (e.MoveNext() && count < limit) {
                        result.push(String(e.Current));
                        count++;
                    }
                    return result;
                }
            } catch (e) {}
            return [];
        }

        const args = toArray(ep);
        ep.Clear();

        // Rebuild args, replacing any existing CRF/Preset
        let skipNext = false;

        for (let i = 0; i < args.length; i++) {
            if (skipNext) {
                skipNext = false;
                continue;
            }
            const arg = args[i];
            const lower = arg.toLowerCase();

            const isKnownQualityArg =
                lower === '-crf' ||
                lower.startsWith('-crf:') ||
                lower === '-cq' ||
                lower.startsWith('-cq:') ||
                lower === '-qp' ||
                lower.startsWith('-qp:') ||
                lower === '-qp_i' ||
                lower.startsWith('-qp_i:') ||
                lower === '-global_quality' ||
                lower.startsWith('-global_quality:');

            if (isKnownQualityArg || lower === crfArg || lower.startsWith(crfArg + ':')) {
                skipNext = true;
                continue;
            }

            if (lower === '-preset') {
                skipNext = true;
                continue;
            }

            ep.Add(arg);
        }

        ep.Add(crfArg);
        ep.Add(String(crf));

        if (preset && !encoder.includes('_qsv')) {
            // QSV presets are often handled differently or hardcoded in the node,
            // but for SW encoding we enforce the preset here.
            ep.Add('-preset');
            ep.Add(preset);
        }

        Logger.ILog(`Applied settings: ${crfArg} ${crf}, preset ${preset || 'default'}`);
    }

    function getVideoFilterFromEncodingParameters(videoStream) {
        // In FFmpeg Builder "New mode" the executor may rely on filters being present in EncodingParameters
        // (eg: '-filter:v:0 <chain>'). Prefer this chain for sampling when available so tests match the final pass.
        try {
            const ep = toEnumerableArray(videoStream && videoStream.EncodingParameters, 2000)
                .map(safeTokenString)
                .filter((x) => x);
            Logger.DLog(`getVideoFilterFromEncodingParameters: found ${ep.length} tokens in EncodingParameters`);

            // Debug: show first 20 tokens to help diagnose issues
            if (ep.length > 0) {
                const preview = ep
                    .slice(0, 20)
                    .map((t, i) => `[${i}]${t}`)
                    .join(' ');
                Logger.DLog(`EncodingParameters preview (first 20): ${preview}`);
            }

            for (let i = 0; i < ep.length - 1; i++) {
                const t = String(ep[i] || '');
                if (t === '-vf' || t.startsWith('-filter:v')) {
                    const val = String(ep[i + 1] || '').trim();
                    Logger.DLog(
                        `Found filter arg at index ${i}: '${t}' -> '${val.substring(0, 100)}${val.length > 100 ? '...' : ''}'`
                    );
                    if (val) return val;
                }
            }
            Logger.DLog('No -vf or -filter:v found in EncodingParameters');
        } catch (err) {
            Logger.WLog(`getVideoFilterFromEncodingParameters error: ${err}`);
        }
        return '';
    }

    function getCropFilterFromModel(videoStream) {
        try {
            const crop = videoStream && videoStream.Crop;
            if (crop && crop.Width > 0 && crop.Height > 0) {
                const cx = crop.X !== null && crop.X !== undefined ? crop.X : 0;
                const cy = crop.Y !== null && crop.Y !== undefined ? crop.Y : 0;
                return `crop=${crop.Width}:${crop.Height}:${cx}:${cy}`;
            }
        } catch (err) {}
        return '';
    }

    function getUpstreamVideoFilters(videoStream) {
        const filters = [];

        const addAll = (value) => {
            const items = toEnumerableArray(value, 500);
            for (let i = 0; i < items.length; i++) {
                const s = safeTokenString(items[i]).trim();
                if (!s) continue;
                filters.push(s);
            }
        };

        // FileFlows versions vary: some expose Filter, some Filters/OptionalFilter, sometimes all.
        addAll(videoStream.Filter);
        addAll(videoStream.Filters);
        addAll(videoStream.OptionalFilter);

        // Crop can be stored separately on the model (and later translated to a filter by the builder).
        try {
            const crop = videoStream.Crop;
            if (crop && crop.Width > 0 && crop.Height > 0) {
                const cx = crop.X !== null && crop.X !== undefined ? crop.X : 0;
                const cy = crop.Y !== null && crop.Y !== undefined ? crop.Y : 0;
                filters.unshift(`crop=${crop.Width}:${crop.Height}:${cx}:${cy}`);
            }
        } catch (err) {}

        // Some builder nodes encode filters directly into EncodingParameters (eg: -filter:v:0 scale_qsv=...).
        try {
            const ep = toEnumerableArray(videoStream.EncodingParameters, 2000)
                .map(safeTokenString)
                .filter((x) => x);
            for (let i = 0; i < ep.length - 1; i++) {
                const t = String(ep[i] || '');
                if (t === '-vf' || t.startsWith('-filter:v')) {
                    const val = String(ep[i + 1] || '').trim();
                    if (val) filters.push(val);
                }
            }
        } catch (err) {}

        if (filters.length === 0) return '';

        // De-dupe while preserving order.
        const seen = {};
        const deduped = [];
        for (let i = 0; i < filters.length; i++) {
            const f = filters[i];
            if (seen[f]) continue;
            seen[f] = true;
            deduped.push(f);
        }

        return deduped.join(',');
    }

    function logResultsTable(results, bestCrf, target, metric) {
        if (!results || results.length === 0) return;
        results.sort((a, b) => a.crf - b.crf);

        const table = [];
        table.push('CRF  | Score  | Status');
        table.push('-----|--------|-------');
        for (const r of results) {
            const isBest = r.crf === bestCrf;
            const meets = r.score >= target;
            const scoreStr = metric === 'SSIM' ? r.score.toFixed(4) : r.score.toFixed(2);
            let status = meets ? 'Pass' : 'Fail';
            if (isBest) status += ' (Selected)';
            table.push(`${String(r.crf).padEnd(4)} | ${scoreStr.padEnd(6)} | ${status}`);
        }
        Logger.ILog('\n' + table.join('\n'));
    }
}
