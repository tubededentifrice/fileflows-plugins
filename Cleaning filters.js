/**
 * @description Apply intelligent video filters based on content type, year, and genre to improve compression while maintaining quality.
 * @author Vincent Courcelle
 * @revision 5
 * @param {bool} SkipDenoise Skip all denoising filters
 * @param {bool} AggressiveCompression Enable aggressive compression for old/restored content (stronger denoise)
 * @param {bool} UseCPUFilters Use CPU filters (hqdn3d, deband) instead of QSV hardware filters. Only enable if NOT using QSV hardware encoding!
 * @output Cleaned video
 */
function Script(SkipDenoise, AggressiveCompression, UseCPUFilters) {
    const year = Variables.VideoMetadata?.Year || 2012;
    const genres = Variables.VideoMetadata?.Genres || [];

    // Override variables (set these in upstream nodes to force specific filter values)
    const forceVppQsv = Variables.vpp_qsv;          // e.g., "50" (Intel QSV hardware, 0-64)
    const forceHqdn3d = Variables.hqdn3d;           // e.g., "2:2:6:6" (CPU only, requires UseCPUFilters=true)

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
    const sourceBitrate = videoInfo?.Bitrate || 0; // in kbps
    const duration = Variables.video?.Duration || videoInfo?.VideoStreams?.[0]?.Duration || 0;
    const fileSizeMB = Variables.file?.Orig?.Size ? Variables.file.Orig.Size / (1024 * 1024) : 0;

    // Detect if content is likely a modern restoration/remaster of old content
    // High bitrate (>15 Mbps) + old year (pre-2000) = probably restored from film
    const bitrateKbps = sourceBitrate > 0 ? sourceBitrate : (fileSizeMB > 0 && duration > 0 ? (fileSizeMB * 8 * 1024) / duration : 0);
    const isHighBitrate = bitrateKbps > 15000; // >15 Mbps
    const isVeryHighBitrate = bitrateKbps > 25000; // >25 Mbps (Blu-ray quality)
    const isRestoredContent = year <= 2000 && (isHighBitrate || isVeryHighBitrate);

    // Content type detection
    const isAnimation = genres !== null && (genres.includes("Animation") || genres.includes("Anime"));
    const isDocumentary = genres !== null && genres.includes("Documentary");
    const isHorror = genres !== null && (genres.includes("Horror") || genres.includes("Thriller"));
    const isOldCelAnimation = isAnimation && year <= 1995; // Cel animation era (hand-drawn on film)

    // Log detection results
    Logger.ILog(`Content: ${year}, genres: ${genres.join(', ')}, bitrate=${Math.round(bitrateKbps/1000)}Mbps`);
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
     * QSV HARDWARE MODE (default):
     *   Uses vpp_qsv=denoise=XX (0-64 scale) which runs entirely on Intel GPU.
     *   This is the only filter compatible with the QSV hardware pipeline.
     *   Deband and mpdecimate are NOT available in QSV mode.
     *
     * CPU MODE (UseCPUFilters=true):
     *   Uses hqdn3d for denoising, can also use deband and mpdecimate.
     *   Only use this if you're NOT using QSV hardware encoding!
     *   Mixing CPU filters with QSV hardware filters will cause errors.
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
     * QSV DENOISE MAPPING:
     *   Level 0-100 maps to vpp_qsv denoise 0-64
     *   Example: Level 75 = denoise=48
     *
     * CPU DENOISE MAPPING (hqdn3d):
     *   Level 0-100 maps to hqdn3d spatial 0-8, temporal 0-16
     *   Example: Level 75 = hqdn3d=6:6:12:12
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

    // ===== APPLY DENOISE FILTER =====
    if (denoiseLevel > 0) {
        if (UseCPUFilters) {
            // ===== CPU MODE: hqdn3d =====
            // Only use if NOT using QSV hardware encoding!
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
            video.Filter.Add(`hqdn3d=${hqdn3dValue}`);
            Variables.applied_denoise = `hqdn3d=${hqdn3dValue}`;

            // CPU-only filters: deband, mpdecimate
            // These can be enabled in CPU mode

            // DEBAND - Removes color banding (CPU only)
            // Uncomment to enable:
            // if (isAnimation) {
            //     if (isOldCelAnimation && (AggressiveCompression || isRestoredContent)) {
            //         video.Filter.Add('deband=1thr=0.05:2thr=0.05:3thr=0.05:range=20:blur=1');
            //     } else if (year <= 2005) {
            //         video.Filter.Add('deband=1thr=0.04:2thr=0.04:3thr=0.04:range=16:blur=1');
            //     } else {
            //         video.Filter.Add('deband=1thr=0.02:2thr=0.02:3thr=0.02:range=12:blur=1');
            //     }
            //     Logger.ILog('Applied deband filter (CPU mode)');
            // }

            // MPDECIMATE - Remove duplicate frames (CPU only)
            // WARNING: Can cause audio sync issues
            // Uncomment to enable:
            // if (isAnimation) {
            //     video.Filter.Add('mpdecimate');
            //     Logger.ILog('Applied mpdecimate filter (CPU mode)');
            // }

        } else {
            // ===== QSV HARDWARE MODE: vpp_qsv=denoise =====
            // Default mode - compatible with QSV hardware encoding pipeline
            let qsvDenoiseValue;
            if (forceVppQsv) {
                qsvDenoiseValue = parseInt(forceVppQsv) || 32;
                Logger.ILog(`Forced QSV denoise: vpp_qsv=denoise=${qsvDenoiseValue}`);
            } else {
                // Convert level (0-100) to QSV denoise (0-64)
                qsvDenoiseValue = Math.round(denoiseLevel * 64 / 100);
                Logger.ILog(`Auto QSV denoise for ${year}: vpp_qsv=denoise=${qsvDenoiseValue} (level ${denoiseLevel}%)`);
            }
            video.Filter.Add(`vpp_qsv=denoise=${qsvDenoiseValue}`);
            Variables.applied_denoise = `vpp_qsv=denoise=${qsvDenoiseValue}`;
            Variables.qsv_denoise_value = qsvDenoiseValue;
        }
    } else {
        Logger.ILog(`No denoising needed for ${year} content`);
        Variables.applied_denoise = 'none';
    }

    /**
     * CPU-ONLY FILTERS (commented out for QSV compatibility)
     * ======================================================
     * These filters only work with CPU encoding (libx265, libx264).
     * Using them with QSV hardware encoding will cause filter chain errors.
     *
     * To use these filters:
     * 1. Set UseCPUFilters=true in the script parameters
     * 2. Make sure your Video Encode node is NOT using QSV/NVENC/VAAPI
     *
     * DEBAND - Remove color banding (essential for animation)
     *   deband=1thr=0.04:2thr=0.04:3thr=0.04:range=16:blur=1
     *   Pros: Improves gradients, reduces file size
     *   Cons: CPU-only, can blur edges slightly
     *
     * MPDECIMATE - Remove duplicate frames
     *   mpdecimate
     *   Pros: 10-30% file size reduction for animation
     *   Cons: CPU-only, can cause audio sync issues, VFR output
     *
     * NLMEANS - High quality denoiser (VERY SLOW)
     *   nlmeans=s=3.0:p=7:pc=5:r=5:rc=3
     *   Pros: Best quality denoising
     *   Cons: 10-40x slower than hqdn3d
     *
     * UNSHARP - Sharpening after denoise
     *   unsharp=5:5:0.3:5:5:0.1
     *   Pros: Restores perceived detail
     *   Cons: Can introduce halos, hurt compression
     */

    /**
     * ENCODER PARAMETERS
     * ==================
     * Note: Encoder parameters are NOT applied by this script because:
     * 1. The encoder type (QSV/CPU) is determined AFTER this script runs
     * 2. Modifying CustomParameters corrupts the x265-params format
     * 3. QSV and CPU use completely different parameter formats
     *
     * For QSV encoder optimization, use the FFmpeg Builder Custom Parameters node with:
     *   -bf 7 -refs 6 -g 256 -extbrc 1 -look_ahead_depth 40
     *
     * For CPU (libx265) encoder optimization, use Custom Parameters with:
     *   -x265-params bframes=16:ref=6:psy-rd=0.7:aq-mode=3
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
