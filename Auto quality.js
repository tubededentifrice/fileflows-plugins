/**
 * @name Auto quality
 * @description Automatically determines optimal CRF/quality based on VMAF or SSIM scoring to minimize file size while maintaining visual quality. Uses Netflix's VMAF metric when available, falls back to SSIM.
 * @author Vincent Courcelle
 * @revision 10
 * @minimumVersion 24.0.0.0
 * @help Place this node between 'FFmpeg Builder: Start' and 'FFmpeg Builder: Executor'.

QUALITY METRICS:
- VMAF (preferred): Netflix's perceptual quality metric. Requires FFmpeg with --enable-libvmaf
- SSIM (fallback): Structural Similarity Index. Built into all FFmpeg versions, less perceptually accurate

To check VMAF support: ffmpeg -h filter=libvmaf
If missing, SSIM will be used automatically.

HOW IT WORKS:
1. Takes short samples from different parts of the video
2. Analyzes luminance to detect dark content (boosts quality target for dark scenes)
3. Encodes samples at various CRF values using binary search
4. Calculates quality score (VMAF or SSIM) for each sample
5. Finds the highest CRF (smallest file) that meets the target quality
6. Applies the found CRF to the FFmpeg Builder encoder

DARK SCENE DETECTION:
- Analyzes average luminance (Y) of samples
- Very dark (<40): +3 quality boost (e.g., VMAF 95 → 98)
- Dark (40-60): +2 quality boost
- Somewhat dark (60-80): +1 quality boost
- Normal/bright (>80): no adjustment
This helps prevent banding/blocking artifacts in dark scenes.

CONTENT-AWARE TARGETING (when TargetVMAF=0):
- Old animation (pre-1995): VMAF 93 / SSIM 0.970
- Old live action (pre-1990): VMAF 93 / SSIM 0.970
- Standard content: VMAF 95 / SSIM 0.980
- Modern/HDR/4K content: VMAF 96-97 / SSIM 0.985-0.990

VARIABLE OVERRIDES:
- Variables.TargetVMAF, Variables.MinCRF, Variables.MaxCRF
- Variables.AutoQualityPreset: 'quality' | 'balanced' | 'compression'
- Variables['ffmpeg_vmaf']: Path to VMAF-enabled FFmpeg (e.g., '/app/common/ffmpeg-static/ffmpeg')

OUTPUT VARIABLES:
- Variables.AutoQuality_CRF: The CRF value found
- Variables.AutoQuality_Score: The quality score achieved
- Variables.AutoQuality_Metric: 'VMAF' or 'SSIM'
- Variables.AutoQuality_AvgLuminance: Average luminance of samples (0-255)
- Variables.AutoQuality_LuminanceBoost: Quality boost applied for dark content (0-3)
- Variables.AutoQuality_Results: JSON array of all tested CRF/score pairs

 * @param {int} TargetVMAF Target VMAF score (0 = auto based on content type, 93-99 manual). For SSIM, this is auto-converted. Default: 0 (auto)
 * @param {int} MinCRF Minimum CRF to search (lower = higher quality, larger file). Default: 18
 * @param {int} MaxCRF Maximum CRF to search (higher = lower quality, smaller file). Default: 28
 * @param {int} SampleDurationSec Duration of each sample in seconds. Default: 8
 * @param {int} SampleCount Number of samples to take from video. Default: 3
 * @param {int} MaxSearchIterations Maximum binary search iterations. Default: 6
 * @param {bool} PreferSmaller When two CRFs meet target, prefer the smaller file (higher CRF). Default: true
 * @param {bool} UseTags Add FileFlows tags with CRF and quality info (premium feature). Default: false
 * @output CRF found and applied to encoder
 * @output Video already optimal (copy mode)
 */
function Script(TargetVMAF, MinCRF, MaxCRF, SampleDurationSec, SampleCount, MaxSearchIterations, PreferSmaller, UseTags) {
    function quoteProcessArg(arg) {
        // Fallback quoting when ProcessStartInfo.ArgumentList isn't available.
        // Keep it simple: quote args containing whitespace or quotes.
        const s = String((arg === undefined || arg === null) ? '' : arg);
        if (!/[\\s\"]/g.test(s)) return s;
        return '"' + s.replace(/\"/g, '\\"') + '"';
    }

    function escapeFfmpegFilterArgValue(value) {
        // ffmpeg filter args use ':' as a separator, so escape it for Windows drive letters.
        // Use forward slashes to avoid backslash escaping rules.
        return String((value === undefined || value === null) ? '' : value).replace(/\\/g, '/').replace(/:/g, '\\:');
    }

    function executeSilently(command, argumentList, timeoutSeconds, workingDirectory) {
        // Avoid Flow.Execute for helper probes so FileFlows doesn't log the full output.
        const psi = new System.Diagnostics.ProcessStartInfo();
        psi.FileName = String(command);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        if (workingDirectory) psi.WorkingDirectory = String(workingDirectory);

        let usedArgumentList = false;
        try {
            if (psi.ArgumentList) {
                for (let i = 0; i < argumentList.length; i++) {
                    psi.ArgumentList.Add(String(argumentList[i]));
                }
                usedArgumentList = true;
            }
        } catch (e) {
            // Some runtimes may not expose ArgumentList; fall back to Arguments string.
        }

        if (!usedArgumentList) {
            psi.Arguments = (argumentList || []).map(quoteProcessArg).join(' ');
        }

        const process = new System.Diagnostics.Process();
        process.StartInfo = psi;

        const started = process.Start();
        if (!started) {
            return { exitCode: -1, standardOutput: '', standardError: 'Failed to start process', completed: false };
        }

        const timeoutMs = (timeoutSeconds && timeoutSeconds > 0) ? (timeoutSeconds * 1000) : 0;
        if (timeoutMs > 0) {
            const exited = process.WaitForExit(timeoutMs);
            if (!exited) {
                try { process.Kill(true); } catch (e) { try { process.Kill(); } catch (e2) { } }
                return { exitCode: -1, standardOutput: '', standardError: 'Process timed out', completed: false };
            }
        } else {
            process.WaitForExit();
        }

        const stdout = process.StandardOutput.ReadToEnd() || '';
        const stderr = process.StandardError.ReadToEnd() || '';
        return { exitCode: process.ExitCode, standardOutput: stdout, standardError: stderr, completed: true };
    }

    // ===== DEFAULTS =====
    if (!MinCRF || MinCRF <= 0) MinCRF = 18;
    if (!MaxCRF || MaxCRF <= 0) MaxCRF = 28;
    if (!SampleDurationSec || SampleDurationSec <= 0) SampleDurationSec = 8;
    if (!SampleCount || SampleCount <= 0) SampleCount = 3;
    if (!MaxSearchIterations || MaxSearchIterations <= 0) MaxSearchIterations = 6;
    if (PreferSmaller === undefined || PreferSmaller === null) PreferSmaller = true;
    if (TargetVMAF === undefined || TargetVMAF === null) TargetVMAF = 0;

    // Allow variable overrides
    if (Variables.TargetVMAF) TargetVMAF = parseInt(Variables.TargetVMAF);
    if (Variables.MinCRF) MinCRF = parseInt(Variables.MinCRF);
    if (Variables.MaxCRF) MaxCRF = parseInt(Variables.MaxCRF);
    if (Variables.AutoQualityPreset) {
        const preset = Variables.AutoQualityPreset.toLowerCase();
        if (preset === 'quality') { TargetVMAF = 97; MinCRF = 16; MaxCRF = 24; }
        else if (preset === 'balanced') { TargetVMAF = 95; MinCRF = 18; MaxCRF = 26; }
        else if (preset === 'compression') { TargetVMAF = 93; MinCRF = 20; MaxCRF = 30; }
    }

    // ===== VALIDATE FFMPEG BUILDER =====
    const ffmpegModel = Variables.FfmpegBuilderModel;
    if (!ffmpegModel) {
        Logger.ELog('Auto quality: FFmpeg Builder model not found. Place this node between FFmpeg Builder Start and Executor.');
        return -1;
    }

    const video = ffmpegModel.VideoStreams?.[0];
    if (!video) {
        Logger.ELog('Auto quality: No video stream found in FFmpeg Builder model.');
        return -1;
    }

    // ===== GET TOOL PATHS =====
    // Use ffmpeg_vmaf variable if set (for VMAF-enabled FFmpeg), otherwise use default
    const customFfmpeg = Variables['ffmpeg_vmaf'] || Variables.ffmpeg_vmaf;
    const ffmpegPath = customFfmpeg || Flow.GetToolPath('ffmpeg');
    if (!ffmpegPath) {
        Logger.ELog('Auto quality: ffmpeg not found. Ensure ffmpeg is configured in FileFlows or set the ffmpeg_vmaf variable.');
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
            vmafCheck = executeSilently(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-h', 'filter=libvmaf'], 30);
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
    const videoInfo = Variables.vi?.VideoInfo || ffmpegModel.VideoInfo;
    if (!videoInfo) {
        Logger.ELog('Auto quality: VideoInfo not available. Ensure Video File node ran before this.');
        return -1;
    }

    const sourceFile = Variables.file?.FullName || Flow.WorkingFile;
    const originalFile = Variables.file?.Orig?.FullName || sourceFile;

    // Get duration from multiple sources - FileFlows stores it in various places
    let duration = 0;
    // Try video stream duration first
    if (videoInfo.VideoStreams?.[0]?.Duration > 0) {
        duration = videoInfo.VideoStreams[0].Duration;
    }
    // Try Variables.video.Duration (set by Video File node)
    else if (Variables.video?.Duration > 0) {
        duration = Variables.video.Duration;
    }
    // Try overall VideoInfo duration
    else if (videoInfo.Duration > 0) {
        duration = videoInfo.Duration;
    }
    // Estimate from file size and bitrate as last resort
    else if (videoInfo.Bitrate > 0 && Variables.file?.Size > 0) {
        duration = (Variables.file.Size * 8) / videoInfo.Bitrate;
        Logger.WLog(`Estimated duration from filesize/bitrate: ${Math.round(duration)}s`);
    }

    const videoCodec = videoInfo.VideoStreams?.[0]?.Codec?.toLowerCase() || '';
    const videoBitrate = getVideoBitrate(videoInfo);
    const width = videoInfo.VideoStreams?.[0]?.Width || Variables.video?.Width || 1920;
    const height = videoInfo.VideoStreams?.[0]?.Height || Variables.video?.Height || 1080;
    const fps = videoInfo.VideoStreams?.[0]?.FramesPerSecond || 24;
    const is10Bit = videoInfo.VideoStreams?.[0]?.Is10Bit || videoInfo.VideoStreams?.[0]?.Bits === 10;
    const isHDR = videoInfo.VideoStreams?.[0]?.HDR || false;
    const isDolbyVision = videoInfo.VideoStreams?.[0]?.DolbyVision || false;

    Logger.ILog(`Source: ${width}x${height}, ${fps}fps, ${Math.round(videoBitrate/1000)}kbps, codec=${videoCodec}, HDR=${isHDR}, 10bit=${is10Bit}, duration=${Math.round(duration)}s`);

    // Validate duration - must be a positive number
    if (!duration || isNaN(duration) || duration <= 0) {
        Logger.ELog(`Auto quality: Could not determine video duration. VideoInfo.Duration=${videoInfo.Duration}, VideoStream.Duration=${videoInfo.VideoStreams?.[0]?.Duration}, Variables.video.Duration=${Variables.video?.Duration}`);
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
    const targetCodecBase = targetCodec.replace(/_qsv|_nvenc|_vaapi|_amf|lib/g, '').replace('x264', 'h264').replace('x265', 'hevc');
    const sourceCodecNormalized = videoCodec.replace('h.264', 'h264');

    if (sourceCodecNormalized === targetCodecBase || sourceCodecNormalized.includes(targetCodecBase)) {
        // Same codec - check if bitrate is acceptable
        const maxAcceptableBitrate = getMaxAcceptableBitrate(width, height);
        if (videoBitrate <= maxAcceptableBitrate && !ffmpegModel.ForceEncode) {
            Logger.ILog(`Video already in ${videoCodec} at acceptable bitrate. Skipping encode.`);
            Variables.AutoQuality_CRF = 'copy';
            Variables.AutoQuality_Reason = 'already_optimal';
            if (UseTags) Flow.AddTags?.(['Copy']);
            return 2;
        }
    }

    // ===== CALCULATE SAMPLE POSITIONS =====
    const samplePositions = calculateSamplePositions(duration, SampleCount, SampleDurationSec);
    Logger.ILog(`Sample positions: ${samplePositions.map(p => Math.round(p) + 's').join(', ')}`);

    // ===== DARK SCENE DETECTION =====
    // Analyze luminance of samples to detect dark content
    const avgLuminance = analyzeLuminance(ffmpegPath, originalFile, samplePositions, SampleDurationSec);
    let luminanceBoost = 0;

    if (avgLuminance >= 0) {
        // Luminance scale: 0 (black) to 255 (white)
        // Typical values: very dark <40, dark 40-70, normal 70-150, bright >150
        if (avgLuminance < 40) {
            luminanceBoost = 3; // Very dark content - significant quality boost
            Logger.ILog(`Dark scene detection: VERY DARK (avg luma ${avgLuminance.toFixed(1)}) - boosting quality by ${luminanceBoost}`);
        } else if (avgLuminance < 60) {
            luminanceBoost = 2; // Dark content - moderate quality boost
            Logger.ILog(`Dark scene detection: DARK (avg luma ${avgLuminance.toFixed(1)}) - boosting quality by ${luminanceBoost}`);
        } else if (avgLuminance < 80) {
            luminanceBoost = 1; // Somewhat dark - small quality boost
            Logger.ILog(`Dark scene detection: SOMEWHAT DARK (avg luma ${avgLuminance.toFixed(1)}) - boosting quality by ${luminanceBoost}`);
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
            effectiveTarget = Math.min(effectiveTarget + (luminanceBoost * 0.005), 0.999);
        }
        Logger.ILog(`Adjusted target: ${qualityMetric} ${qualityMetric === 'SSIM' ? effectiveTarget.toFixed(3) : effectiveTarget}`);
    }

    Variables.AutoQuality_AvgLuminance = avgLuminance;
    Variables.AutoQuality_LuminanceBoost = luminanceBoost;

    // ===== QUALITY-BASED CRF SEARCH =====
    const targetDisplay = qualityMetric === 'SSIM' ? effectiveTarget.toFixed(3) : effectiveTarget;
    Logger.ILog(`Starting ${qualityMetric}-based CRF search: CRF ${MinCRF}-${MaxCRF}, target ${qualityMetric} ${targetDisplay}`);

    const searchResults = [];
    let bestCRF = null;
    let bestScore = 0;

    // Binary search for optimal CRF
    let lowCRF = MinCRF;
    let highCRF = MaxCRF;
    let iterations = 0;

    while (lowCRF <= highCRF && iterations < MaxSearchIterations) {
        iterations++;
        const testCRF = Math.round((lowCRF + highCRF) / 2);

        // Check if we already tested this CRF
        const existing = searchResults.find(r => r.crf === testCRF);
        if (existing) {
            if (existing.score >= effectiveTarget) {
                highCRF = testCRF - 1;
            } else {
                lowCRF = testCRF + 1;
            }
            continue;
        }

        Logger.ILog(`[${iterations}/${MaxSearchIterations}] Testing CRF ${testCRF}...`);
        Flow.AdditionalInfoRecorder?.('Auto Quality', `CRF ${testCRF}`, 1);

        // Update progress percentage
        const progressPct = Math.round((iterations / MaxSearchIterations) * 100);
        Flow.PartPercentageUpdate?.(progressPct);

        const qualityScore = measureQualityAtCRF(ffmpegPath, originalFile, testCRF, targetCodec, samplePositions, SampleDurationSec, is10Bit, width, height, qualityMetric);

        if (qualityScore < 0) {
            Logger.WLog(`${qualityMetric} measurement failed for CRF ${testCRF}, skipping...`);
            // Try to continue with a different CRF
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
                // Try higher CRF (smaller file)
                lowCRF = testCRF + 1;
            } else {
                // Found acceptable, stop
                break;
            }
        } else {
            // Quality too low, need lower CRF
            highCRF = testCRF - 1;
        }
    }

    // If no CRF met the target, use the best we found or leave unchanged
    if (bestCRF === null) {
        // Find the CRF with highest score from our results
        if (searchResults.length > 0) {
            const best = searchResults.reduce((a, b) => a.score > b.score ? a : b);
            bestCRF = best.crf;
            bestScore = best.score;
            const scoreDisplay = qualityMetric === 'SSIM' ? bestScore.toFixed(4) : bestScore.toFixed(2);
            Logger.WLog(`No CRF met target ${qualityMetric} ${targetDisplay}. Using best found: CRF ${bestCRF} (${qualityMetric} ${scoreDisplay})`);
        } else {
            // Complete failure - leave quality unchanged
            Logger.ELog(`${qualityMetric} search failed completely. Leaving quality settings unchanged.`);
            logResultsTable(searchResults, null, effectiveTarget, qualityMetric);
            Variables.AutoQuality_CRF = 'unchanged';
            Variables.AutoQuality_Reason = 'quality_search_failed';
            return 1;
        }
    }

    // Log results table
    logResultsTable(searchResults, bestCRF, effectiveTarget, qualityMetric);

    // ===== APPLY CRF TO ENCODER =====
    applyCRF(video, bestCRF, targetCodec);

    // Store results
    Variables.AutoQuality_CRF = bestCRF;
    Variables.AutoQuality_Score = bestScore;
    Variables.AutoQuality_Metric = qualityMetric;
    Variables.AutoQuality_Target = effectiveTarget;
    Variables.AutoQuality_TargetVMAF = effectiveTargetVMAF; // Keep for backwards compatibility
    Variables.AutoQuality_Iterations = iterations;
    Variables.AutoQuality_Results = JSON.stringify(searchResults);

    const finalScoreDisplay = qualityMetric === 'SSIM' ? bestScore.toFixed(4) : bestScore.toFixed(1);
    Flow.AdditionalInfoRecorder?.('CRF', bestCRF, 1000);
    Flow.AdditionalInfoRecorder?.(qualityMetric, finalScoreDisplay, 1000);

    if (UseTags) {
        const tagScore = qualityMetric === 'SSIM' ? bestScore.toFixed(3) : Math.round(bestScore);
        Flow.AddTags?.([`CRF ${bestCRF}`, `${qualityMetric} ${tagScore}`]);
    }

    Logger.ILog(`Auto quality complete: CRF ${bestCRF} (${qualityMetric} ${finalScoreDisplay}, target was ${targetDisplay})`);
    return 1;

    // ===== HELPER FUNCTIONS =====

    function getVideoBitrate(vi) {
        let bitrate = vi.VideoStreams?.[0]?.Bitrate;
        if (!bitrate || bitrate <= 0) {
            let overall = vi.Bitrate || 0;
            if (overall > 0) {
                let calculated = overall;
                if (vi.AudioStreams?.length) {
                    for (let audio of vi.AudioStreams) {
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
        } catch (e) { }

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
        if (codec.includes('_qsv')) return '-global_quality';
        if (codec.includes('_amf')) return '-qp_i';
        return '-crf';
    }

    function calculateAutoTargetVMAF() {
        // Content-aware VMAF targeting
        // Check multiple sources for metadata (Radarr/Sonarr search scripts populate these)
        const metadata = Variables.VideoMetadata || Variables.MovieInfo || Variables.TVShowInfo || {};
        const year = metadata.Year || metadata.year || 2015;

        // Genres can be an array or string
        let genres = metadata.Genres || metadata.genres || [];
        if (typeof genres === 'string') {
            genres = genres.split(/[,|]/).map(g => g.trim());
        }

        const isAnimation = genres.some(g =>
            g.toLowerCase().includes('animation') ||
            g.toLowerCase().includes('anime') ||
            g.toLowerCase().includes('cartoon')
        );
        const isDocumentary = genres.some(g =>
            g.toLowerCase().includes('documentary')
        );

        let target = 95; // Default balanced target

        if (isAnimation) {
            // Animation can tolerate more compression (less fine detail)
            if (year <= 1995) target = 93; // Old cel animation
            else if (year <= 2010) target = 94;
            else target = 95;
        } else if (isDocumentary) {
            // Documentary often has fine details, grain for atmosphere
            target = 96;
        } else {
            // Live action films
            if (year <= 1990) target = 93; // Old films with grain
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
        Logger.ILog(`Auto VMAF target: ${target} (year=${year}, animation=${isAnimation}, HDR=${isHDR}, metadata=${hasMetadata ? 'yes' : 'default'})`);
        return target;
    }

    function getMaxAcceptableBitrate(w, h) {
        // Max bitrate thresholds based on resolution
        const pixels = w * h;
        if (pixels >= 3840 * 2160) return 25000000; // 4K: 25 Mbps
        if (pixels >= 1920 * 1080) return 12000000; // 1080p: 12 Mbps
        if (pixels >= 1280 * 720) return 6000000;   // 720p: 6 Mbps
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
            positions.push(startOffset + (spacing * i));
        }
        return positions;
    }

    function analyzeLuminance(ffmpeg, inputFile, positions, sampleDur) {
        // Analyze average luminance across sample positions using signalstats filter
        // Returns average Y (luma) value 0-255, or -1 on failure
        const luminanceValues = [];

        for (let i = 0; i < Math.min(positions.length, 3); i++) { // Limit to 3 samples for speed
            const pos = positions[i];

            try {
                // Use signalstats filter to get average luminance (YAVG)
                // Only analyze 2 seconds for speed
                const metadataFile = System.IO.Path.Combine(Flow.TempPath, 'autoquality_signalstats_' + Flow.NewGuid() + '.txt');
                let output = '';
                try {
                    const args = [
                        '-hide_banner', '-loglevel', 'error',
                        '-ss', String(Math.floor(pos)),
                        '-i', inputFile,
                        '-t', '2',
                        '-vf', 'signalstats,metadata=print:file=' + escapeFfmpegFilterArgValue(metadataFile),
                        '-f', 'null', '-'
                    ];

                    let result = null;
                    try {
                        result = executeSilently(ffmpeg, args, 60);
                        if (!result || result.completed === false) throw new Error(result?.standardError || 'silent execute failed');
                        output = (result.standardOutput || '') + '\n' + (result.standardError || '');
                    } catch (e) {
                        // Fallback: still keep output quiet by writing metadata to a file.
                        result = Flow.Execute({ command: ffmpeg, argumentList: args, timeout: 60 });
                        output = (result.output || '') + '\n' + (result.standardOutput || '') + '\n' + (result.standardError || '');
                    }

                    if (System.IO.File.Exists(metadataFile)) {
                        output += '\n' + System.IO.File.ReadAllText(metadataFile);
                    }
                } finally {
                    try { if (System.IO.File.Exists(metadataFile)) System.IO.File.Delete(metadataFile); } catch (e) { }
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

    function measureQualityAtCRF(ffmpeg, inputFile, crf, encoder, positions, sampleDur, use10Bit, w, h, metric) {
        const tempDir = Flow.TempPath;
        const scores = [];
        const pixFmt = use10Bit ? 'yuv420p10le' : 'yuv420p';

        // Determine software encoder for test encodes (hardware encoders not reliable for short samples)
        let testEncoder = encoder;
        let testCrfArg = getCRFArgument(encoder);

        // Use software encoder for quality testing (more reliable)
        if (encoder.includes('hevc') || encoder.includes('h265') || encoder.includes('x265')) {
            testEncoder = 'libx265';
            testCrfArg = '-crf';
        } else if (encoder.includes('h264') || encoder.includes('x264') || encoder.includes('avc')) {
            testEncoder = 'libx264';
            testCrfArg = '-crf';
        } else if (encoder.includes('av1')) {
            testEncoder = 'libsvtav1';
            testCrfArg = '-crf';
        }

        for (let i = 0; i < positions.length; i++) {
            const pos = positions[i];
            const sampleId = Flow.NewGuid();
            const encodedSample = `${tempDir}/${sampleId}_encoded.mkv`;
            const originalSample = `${tempDir}/${sampleId}_original.mkv`;

            try {
                // Extract and decode original sample to lossless format (for quality reference)
                // Using FFV1 lossless codec to preserve original quality for comparison
                const extractOriginal = Flow.Execute({
                    command: ffmpeg,
                    argumentList: [
                        '-hide_banner', '-loglevel', 'error', '-y',
                        '-ss', String(Math.floor(pos)),
                        '-i', inputFile,
                        '-t', String(sampleDur),
                        '-c:v', 'ffv1',
                        '-level', '3',
                        '-pix_fmt', pixFmt,
                        '-an', '-sn',
                        originalSample
                    ],
                    timeout: 180
                });

                if (extractOriginal.exitCode !== 0) {
                    Logger.WLog(`Failed to extract original sample at ${pos}s`);
                    continue;
                }

                // Encode sample at test CRF
                const encodeArgs = [
                    '-hide_banner', '-loglevel', 'error', '-y',
                    '-i', originalSample,
                    '-c:v', testEncoder,
                    testCrfArg, String(crf),
                    '-preset', 'fast', // Use fast preset for test encodes
                    '-pix_fmt', pixFmt,
                    '-an',
                    encodedSample
                ];

                // Add encoder-specific options
                if (testEncoder === 'libx265') {
                    encodeArgs.splice(encodeArgs.indexOf('-an'), 0, '-tag:v', 'hvc1');
                    if (use10Bit) {
                        encodeArgs.splice(encodeArgs.indexOf('-an'), 0, '-profile:v', 'main10');
                    }
                } else if (testEncoder === 'libx264' && use10Bit) {
                    encodeArgs.splice(encodeArgs.indexOf('-an'), 0, '-profile:v', 'high10');
                }

                const encodeResult = Flow.Execute({
                    command: ffmpeg,
                    argumentList: encodeArgs,
                    timeout: 300
                });

                if (encodeResult.exitCode !== 0) {
                    Logger.WLog(`Failed to encode sample at CRF ${crf}, pos ${pos}s`);
                    cleanupFiles([encodedSample, originalSample]);
                    continue;
                }

                // Calculate quality score based on metric
                let filterComplex;
                if (metric === 'VMAF') {
                    // libvmaf: distorted first, reference second
                    filterComplex = `[0:v]scale=flags=bicubic[distorted];[1:v]scale=flags=bicubic[reference];[distorted][reference]libvmaf=n_threads=4`;
                } else {
                    // SSIM: uses ssim filter, outputs to stderr
                    filterComplex = `[0:v]scale=flags=bicubic[distorted];[1:v]scale=flags=bicubic[reference];[distorted][reference]ssim`;
                }

                const qualityResult = Flow.Execute({
                    command: ffmpeg,
                    argumentList: [
                        '-hide_banner', '-loglevel', 'info', '-y',
                        '-i', encodedSample,
                        '-i', originalSample,
                        '-filter_complex', filterComplex,
                        '-f', 'null', '-'
                    ],
                    timeout: 300
                });

                // Parse score from output (appears in stderr at info level)
                const output = (qualityResult.output || '') + '\n' + (qualityResult.standardOutput || '') + '\n' + (qualityResult.standardError || '');

                let score = null;
                if (metric === 'VMAF') {
                    // Try multiple VMAF output formats:
                    // "VMAF score: 95.123" or "VMAF score = 95.123" or "[libvmaf...] VMAF score: 95.123"
                    const vmafMatch = output.match(/VMAF\s*score\s*[:=]\s*([\d.]+)/i);
                    if (vmafMatch) {
                        score = parseFloat(vmafMatch[1]);
                    } else {
                        // Try JSON format if log_fmt=json was used
                        const jsonMatch = output.match(/"vmaf":\s*([\d.]+)/i);
                        if (jsonMatch) {
                            score = parseFloat(jsonMatch[1]);
                        }
                    }
                } else {
                    // SSIM outputs like: SSIM Y:0.987654 (19.123456) U:0.991234 V:0.992345 All:0.989012 (19.567890)
                    // We want the "All" value
                    const ssimMatch = output.match(/All:\s*([\d.]+)/i);
                    if (ssimMatch) {
                        score = parseFloat(ssimMatch[1]);
                    }
                }

                if (score !== null) {
                    scores.push(score);
                    const scoreDisplay = metric === 'SSIM' ? score.toFixed(4) : score.toFixed(2);
                    Logger.DLog(`Sample ${i + 1}: ${metric} ${scoreDisplay}`);
                } else {
                    Logger.WLog(`Could not parse ${metric} score for sample ${i + 1}`);
                    // Log a snippet of output for debugging
                    const snippet = output.substring(0, 500).replace(/\n/g, ' ');
                    Logger.DLog(`Output snippet: ${snippet}`);
                }

                // Cleanup
                cleanupFiles([encodedSample, originalSample]);

            } catch (err) {
                Logger.WLog(`Error processing sample ${i + 1}: ${err}`);
                cleanupFiles([encodedSample, originalSample]);
            }
        }

        if (scores.length === 0) {
            return -1;
        }

        // Return average score
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        return avgScore;
    }

    function cleanupFiles(files) {
        for (const file of files) {
            try {
                if (System.IO.File.Exists(file)) {
                    System.IO.File.Delete(file);
                }
            } catch (e) { }
        }
    }

    function applyCRF(videoStream, crf, encoder) {
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
            } catch (err) { }

            try {
                if (typeof list.Count === 'number') {
                    const result = [];
                    const count = Math.min(list.Count, limit);
                    for (let i = 0; i < count; i++) result.push(String(list[i]));
                    return result;
                }
            } catch (err) { }

            return [];
        }

        function removeAt(list, index) {
            if (!list) return false;
            if (Array.isArray(list)) {
                list.splice(index, 1);
                return true;
            }
            try {
                if (typeof list.RemoveAt === 'function') {
                    list.RemoveAt(index);
                    return true;
                }
            } catch (err) { }
            return false;
        }

        function addToken(list, token) {
            if (!list) return false;
            if (Array.isArray(list)) {
                list.push(token);
                return true;
            }
            try {
                if (typeof list.Add === 'function') {
                    list.Add(token);
                    return true;
                }
            } catch (err) { }
            return false;
        }

        function hasToken(list, predicate) {
            const arr = toArray(list, 5000);
            for (let i = 0; i < arr.length; i++) if (predicate(arr[i], i)) return true;
            return false;
        }

        function stripArgAndValue(list, matcher) {
            const arr = toArray(list, 5000);
            let removed = 0;

            // Remove from end so indexes remain valid
            for (let i = arr.length - 1; i >= 0; i--) {
                const token = arr[i];
                if (!matcher(token)) continue;

                // Remove value (if present and looks like a value rather than an option)
                if (i + 1 < arr.length) {
                    const next = arr[i + 1];
                    if (next && !String(next).startsWith('-')) {
                        if (removeAt(list, i + 1)) removed++;
                    }
                }

                if (removeAt(list, i)) removed++;
            }

            return removed;
        }

        // Replace any existing quality args first (so this script can override upstream defaults cleanly)
        let removed = 0;
        if (crfArg === '-global_quality') {
            // FileFlows often uses stream specifiers here (eg: -global_quality:v)
            removed += stripArgAndValue(ep, t => String(t).startsWith('-global_quality'));
        } else if (crfArg === '-cq') {
            removed += stripArgAndValue(ep, t => String(t) === '-cq');
        } else if (crfArg === '-qp') {
            removed += stripArgAndValue(ep, t => String(t) === '-qp');
        } else {
            removed += stripArgAndValue(ep, t => String(t) === '-crf');
        }

        if (removed > 0) Logger.ILog(`Auto quality: removed ${removed} existing quality argument tokens`);

        // Add (replacement) quality parameter
        if (typeof ep.Add === 'function' || Array.isArray(ep)) {
            if (crfArg === '-global_quality') {
                // Prefer the same style FileFlows uses for QSV: -global_quality:v VALUE
                addToken(ep, '-global_quality:v');
                addToken(ep, String(crf));
                Logger.ILog(`Applied -global_quality:v ${crf} to encoder`);
                return;
            }

            if (crfArg === '-cq') {
                // Only set rate control if not already present, otherwise just replace CQ value.
                const hasRc = hasToken(ep, t => String(t) === '-rc');
                if (!hasRc) {
                    addToken(ep, '-rc');
                    addToken(ep, 'vbr');
                }
                addToken(ep, '-cq');
                addToken(ep, String(crf));
                Logger.ILog(`Applied -cq ${crf} to encoder`);
                return;
            }

            if (crfArg === '-qp') {
                addToken(ep, '-qp');
                addToken(ep, String(crf));
                Logger.ILog(`Applied -qp ${crf} to encoder`);
                return;
            }

            addToken(ep, '-crf');
            addToken(ep, String(crf));
            Logger.ILog(`Applied -crf ${crf} to encoder`);
        }
    }

    function logResultsTable(results, winner, target, metric) {
        if (results.length === 0) return;

        // Sort by CRF for display
        const sorted = [...results].sort((a, b) => a.crf - b.crf);

        const isSSIM = metric === 'SSIM';
        const header = isSSIM ? '| CRF |  SSIM  | Status |' : '| CRF | VMAF  | Status |';
        const divider = isSSIM ? '|-----|--------|--------|' : '|-----|-------|--------|';

        Logger.ILog('');
        Logger.ILog(header);
        Logger.ILog(divider);
        for (const r of sorted) {
            const status = r.score >= target ? (r.crf === winner ? '* WIN' : 'OK') : 'LOW';
            const crfStr = String(r.crf).padStart(3);
            const scoreStr = isSSIM ? r.score.toFixed(4).padStart(6) : r.score.toFixed(2).padStart(5);
            Logger.ILog(`| ${crfStr} | ${scoreStr} | ${status.padEnd(6)} |`);
        }
        Logger.ILog('');
    }
}
