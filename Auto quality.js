/**
 * @name Auto quality
 * @description Automatically determines optimal CRF/quality based on VMAF scoring to minimize file size while maintaining visual quality. Uses Netflix's VMAF metric with content-aware targeting. Requires FFmpeg with libvmaf support.
 * @author Vincent Courcelle
 * @revision 3
 * @minimumVersion 24.0.0.0
 * @help Place this node between 'FFmpeg Builder: Start' and 'FFmpeg Builder: Executor'.

REQUIREMENTS:
- FFmpeg must be compiled with libvmaf support (most distributions include it)
- For best results, run a Radarr/Sonarr search script first to populate metadata (year, genres)

HOW IT WORKS:
1. Takes short samples from different parts of the video
2. Encodes samples at various CRF values using binary search
3. Calculates VMAF score for each (Netflix's perceptual quality metric)
4. Finds the highest CRF (smallest file) that meets the target VMAF
5. Applies the found CRF to the FFmpeg Builder encoder

CONTENT-AWARE TARGETING (when TargetVMAF=0):
- Old animation (pre-1995): VMAF 93 (grain removal acceptable)
- Old live action (pre-1990): VMAF 93
- Standard content: VMAF 95
- Modern/HDR/4K content: VMAF 96-97

VARIABLE OVERRIDES:
- Variables.TargetVMAF, Variables.MinCRF, Variables.MaxCRF
- Variables.AutoQualityPreset: 'quality' | 'balanced' | 'compression'

OUTPUT VARIABLES:
- Variables.AutoQuality_CRF: The CRF value found
- Variables.AutoQuality_VMAF: The VMAF score achieved
- Variables.AutoQuality_Results: JSON array of all tested CRF/VMAF pairs

 * @param {int} TargetVMAF Target VMAF score (0 = auto based on content type, 93-99 manual). Default: 0 (auto)
 * @param {int} MinCRF Minimum CRF to search (lower = higher quality, larger file). Default: 18
 * @param {int} MaxCRF Maximum CRF to search (higher = lower quality, smaller file). Default: 28
 * @param {int} SampleDurationSec Duration of each sample in seconds. Default: 8
 * @param {int} SampleCount Number of samples to take from video. Default: 3
 * @param {int} MaxSearchIterations Maximum binary search iterations. Default: 6
 * @param {bool} PreferSmaller When two CRFs meet target, prefer the smaller file (higher CRF). Default: true
 * @param {bool} UseTags Add FileFlows tags with CRF and VMAF info (premium feature). Default: false
 * @output CRF found and applied to encoder
 * @output Video already optimal (copy mode)
 */
function Script(TargetVMAF, MinCRF, MaxCRF, SampleDurationSec, SampleCount, MaxSearchIterations, PreferSmaller, UseTags) {
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
    const ffmpegPath = Flow.GetToolPath('ffmpeg');
    if (!ffmpegPath) {
        Logger.ELog('Auto quality: ffmpeg not found. Ensure ffmpeg is configured in FileFlows.');
        return -1;
    }

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

    // ===== CONTENT-AWARE TARGET VMAF =====
    let effectiveTargetVMAF = TargetVMAF;
    if (TargetVMAF === 0) {
        effectiveTargetVMAF = calculateAutoTargetVMAF();
    }
    Logger.ILog(`Target VMAF: ${effectiveTargetVMAF}`);

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

    // ===== VMAF-BASED CRF SEARCH =====
    Logger.ILog(`Starting VMAF-based CRF search: CRF ${MinCRF}-${MaxCRF}, target VMAF ${effectiveTargetVMAF}`);

    const samplePositions = calculateSamplePositions(duration, SampleCount, SampleDurationSec);
    Logger.ILog(`Sample positions: ${samplePositions.map(p => Math.round(p) + 's').join(', ')}`);

    const searchResults = [];
    let bestCRF = null;
    let bestVMAF = 0;

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
            if (existing.vmaf >= effectiveTargetVMAF) {
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

        const vmafScore = measureVMAFAtCRF(ffmpegPath, originalFile, testCRF, targetCodec, samplePositions, SampleDurationSec, is10Bit, width, height);

        if (vmafScore < 0) {
            Logger.WLog(`VMAF measurement failed for CRF ${testCRF}, skipping...`);
            // Try to continue with a different CRF
            lowCRF = testCRF + 1;
            continue;
        }

        searchResults.push({ crf: testCRF, vmaf: vmafScore });
        Logger.ILog(`CRF ${testCRF}: VMAF ${vmafScore.toFixed(2)}`);

        if (vmafScore >= effectiveTargetVMAF) {
            bestCRF = testCRF;
            bestVMAF = vmafScore;
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
        // Find the CRF with highest VMAF from our results
        if (searchResults.length > 0) {
            const best = searchResults.reduce((a, b) => a.vmaf > b.vmaf ? a : b);
            bestCRF = best.crf;
            bestVMAF = best.vmaf;
            Logger.WLog(`No CRF met target VMAF ${effectiveTargetVMAF}. Using best found: CRF ${bestCRF} (VMAF ${bestVMAF.toFixed(2)})`);
        } else {
            // Complete failure - leave quality unchanged
            Logger.ELog('VMAF search failed completely. Leaving quality settings unchanged.');
            logResultsTable(searchResults, null, effectiveTargetVMAF);
            Variables.AutoQuality_CRF = 'unchanged';
            Variables.AutoQuality_Reason = 'vmaf_failed';
            return 1;
        }
    }

    // Log results table
    logResultsTable(searchResults, bestCRF, effectiveTargetVMAF);

    // ===== APPLY CRF TO ENCODER =====
    applyCRF(video, bestCRF, targetCodec);

    // Store results
    Variables.AutoQuality_CRF = bestCRF;
    Variables.AutoQuality_VMAF = bestVMAF;
    Variables.AutoQuality_TargetVMAF = effectiveTargetVMAF;
    Variables.AutoQuality_Iterations = iterations;
    Variables.AutoQuality_Results = JSON.stringify(searchResults);

    Flow.AdditionalInfoRecorder?.('CRF', bestCRF, 1000);
    Flow.AdditionalInfoRecorder?.('VMAF', bestVMAF.toFixed(1), 1000);

    if (UseTags) {
        Flow.AddTags?.([`CRF ${bestCRF}`, `VMAF ${Math.round(bestVMAF)}`]);
    }

    Logger.ILog(`Auto quality complete: CRF ${bestCRF} (VMAF ${bestVMAF.toFixed(2)}, target was ${effectiveTargetVMAF})`);
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

    function measureVMAFAtCRF(ffmpeg, inputFile, crf, encoder, positions, sampleDur, use10Bit, w, h) {
        const tempDir = Flow.TempPath;
        const vmafScores = [];
        const pixFmt = use10Bit ? 'yuv420p10le' : 'yuv420p';

        // Determine software encoder for test encodes (hardware encoders not reliable for short samples)
        let testEncoder = encoder;
        let testCrfArg = getCRFArgument(encoder);

        // Use software encoder for VMAF testing (more reliable)
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
                // Extract and decode original sample to lossless format (for VMAF reference)
                // Using FFV1 lossless codec to preserve original quality for comparison
                const extractOriginal = Flow.Execute({
                    command: ffmpeg,
                    argumentList: [
                        '-hide_banner', '-y',
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
                    '-hide_banner', '-y',
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

                // Calculate VMAF
                // Note: libvmaf expects distorted (encoded) as first input, reference as second
                // Using scale filter to ensure same resolution, then libvmaf
                const vmafResult = Flow.Execute({
                    command: ffmpeg,
                    argumentList: [
                        '-hide_banner', '-y',
                        '-i', encodedSample,
                        '-i', originalSample,
                        '-filter_complex', `[0:v]scale=flags=bicubic[distorted];[1:v]scale=flags=bicubic[reference];[distorted][reference]libvmaf=n_threads=4`,
                        '-f', 'null', '-'
                    ],
                    timeout: 300
                });

                // Parse VMAF score from output (appears in stderr)
                const output = (vmafResult.output || '') + '\n' + (vmafResult.standardError || '');
                const vmafMatch = output.match(/VMAF score:\s*([\d.]+)/i);

                if (vmafMatch) {
                    const score = parseFloat(vmafMatch[1]);
                    vmafScores.push(score);
                    Logger.DLog(`Sample ${i + 1}: VMAF ${score.toFixed(2)}`);
                } else {
                    Logger.WLog(`Could not parse VMAF score for sample ${i + 1}`);
                }

                // Cleanup
                cleanupFiles([encodedSample, originalSample]);

            } catch (err) {
                Logger.WLog(`Error processing sample ${i + 1}: ${err}`);
                cleanupFiles([encodedSample, originalSample]);
            }
        }

        if (vmafScores.length === 0) {
            return -1;
        }

        // Return average VMAF score
        const avgVMAF = vmafScores.reduce((a, b) => a + b, 0) / vmafScores.length;
        return avgVMAF;
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

        // Add CRF parameter
        if (videoStream.EncodingParameters) {
            if (typeof videoStream.EncodingParameters.Add === 'function') {
                // For hardware encoders, the argument format may differ
                if (crfArg === '-global_quality') {
                    // QSV uses -global_quality VALUE
                    videoStream.EncodingParameters.Add('-global_quality');
                    videoStream.EncodingParameters.Add(String(crf));
                } else if (crfArg === '-cq') {
                    // NVENC uses -cq VALUE with -rc vbr
                    videoStream.EncodingParameters.Add('-rc');
                    videoStream.EncodingParameters.Add('vbr');
                    videoStream.EncodingParameters.Add('-cq');
                    videoStream.EncodingParameters.Add(String(crf));
                } else if (crfArg === '-qp') {
                    // VAAPI uses -qp VALUE
                    videoStream.EncodingParameters.Add('-qp');
                    videoStream.EncodingParameters.Add(String(crf));
                } else {
                    // Software encoders use -crf VALUE
                    videoStream.EncodingParameters.Add('-crf');
                    videoStream.EncodingParameters.Add(String(crf));
                }
            }
        }

        Logger.ILog(`Applied ${crfArg} ${crf} to encoder`);
    }

    function logResultsTable(results, winner, target) {
        if (results.length === 0) return;

        // Sort by CRF for display
        const sorted = [...results].sort((a, b) => a.crf - b.crf);

        Logger.ILog('');
        Logger.ILog('| CRF | VMAF  | Status |');
        Logger.ILog('|-----|-------|--------|');
        for (const r of sorted) {
            const status = r.vmaf >= target ? (r.crf === winner ? '* WIN' : 'OK') : 'LOW';
            const crfStr = String(r.crf).padStart(3);
            const vmafStr = r.vmaf.toFixed(2).padStart(5);
            Logger.ILog(`| ${crfStr} | ${vmafStr} | ${status.padEnd(6)} |`);
        }
        Logger.ILog('');
    }
}
