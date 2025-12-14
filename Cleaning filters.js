/**
 * @description Apply intelligent video filters based on content type, year, and genre to improve compression while maintaining quality.
 * @author Vincent Courcelle
 * @revision 4
 * @param {bool} SkipDenoise Skip all denoising filters
 * @param {bool} SkipDeband Skip debanding filter (useful for live action with intentional banding)
 * @param {bool} SkipEncoderParams Skip adding encoder optimization parameters
 * @param {bool} AddSharpening Add mild sharpening after denoising to restore detail (experimental)
 * @param {bool} AggressiveCompression Enable aggressive compression for old/restored content (stronger denoise, max encoder efficiency)
 * @output Cleaned video
 */
function Script(SkipDenoise, SkipDeband, SkipEncoderParams, AddSharpening, AggressiveCompression) {
    const year = Variables.VideoMetadata?.Year || 2012;
    const genres = Variables.VideoMetadata?.Genres || [];

    // Override variables (set these in upstream nodes to force specific filter values)
    const forceHqdn3d = Variables.hqdn3d;           // e.g., "2:2:6:6" (CPU only)
    const forceVppQsv = Variables.vpp_qsv;          // e.g., "50" or "denoise=50" (Intel QSV hardware, 0-64)
    const forceDeband = Variables.deband;           // e.g., "1thr=0.04:2thr=0.04:3thr=0.04"
    const forceUnsharp = Variables.unsharp;         // e.g., "5:5:0.5"
    const forceEncoderParams = Variables.encoder_params; // e.g., "-bf 7 -refs 5" for QSV

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

    // Initialize arrays if they don't exist (FileFlows API requirement)
    if (!video.Filters) video.Filters = [];
    if (!video.EncodingParameters) video.EncodingParameters = [];

    // Detect hardware encoder by checking existing encoding parameters or codec
    // Look for QSV indicators in the model
    const encoderCodec = video.EncoderCodec || video.Codec || '';
    const customParams = ffmpeg.CustomParameters || [];
    const customParamsStr = customParams.join(' ').toLowerCase();

    // Detect if using hardware acceleration
    const isQSV = encoderCodec.toLowerCase().includes('qsv') ||
                  customParamsStr.includes('qsv') ||
                  customParamsStr.includes('hwaccel qsv');
    const isNVENC = encoderCodec.toLowerCase().includes('nvenc') ||
                   customParamsStr.includes('nvenc');
    const isVAAPI = encoderCodec.toLowerCase().includes('vaapi') ||
                   customParamsStr.includes('vaapi');
    const isHardwareEncoder = isQSV || isNVENC || isVAAPI;
    const isCPUEncoder = !isHardwareEncoder;

    Logger.ILog(`Encoder detection: QSV=${isQSV}, NVENC=${isNVENC}, VAAPI=${isVAAPI}, CPU=${isCPUEncoder}`);
    Logger.ILog(`EncoderCodec: ${encoderCodec}, CustomParams: ${customParamsStr.substring(0, 100)}`);

    // Get video info for bitrate detection
    const videoInfo = Variables.vi?.VideoInfo || ffmpeg.VideoInfo;
    const sourceBitrate = videoInfo?.Bitrate || 0; // in kbps
    const duration = Variables.video?.Duration || videoInfo?.VideoStreams?.[0]?.Duration || 0;
    const fileSizeMB = Variables.file?.Orig?.Size ? Variables.file.Orig.Size / (1024 * 1024) : 0;

    // Detect if content is likely a modern restoration/remaster of old content
    // High bitrate (>15 Mbps) + old year (pre-2000) = probably restored from film
    // Also check file size: >8GB for 80min (~6GB/hr) suggests high-quality restoration
    const bitrateKbps = sourceBitrate > 0 ? sourceBitrate : (fileSizeMB > 0 && duration > 0 ? (fileSizeMB * 8 * 1024) / duration : 0);
    const isHighBitrate = bitrateKbps > 15000; // >15 Mbps
    const isVeryHighBitrate = bitrateKbps > 25000; // >25 Mbps (Blu-ray quality)
    const isRestoredContent = year <= 2000 && (isHighBitrate || isVeryHighBitrate);

    // Helper functions
    const isAnimation = genres !== null && (genres.includes("Animation") || genres.includes("Anime"));
    const isDocumentary = genres !== null && genres.includes("Documentary");
    const isHorror = genres !== null && (genres.includes("Horror") || genres.includes("Thriller"));
    const isOldCelAnimation = isAnimation && year <= 1995; // Cel animation era (hand-drawn on film)

    // Log detection results
    if (isRestoredContent) {
        Logger.ILog(`Detected restored content: ${year}, bitrate=${Math.round(bitrateKbps/1000)}Mbps, file=${Math.round(fileSizeMB)}MB`);
    }
    if (isOldCelAnimation) {
        Logger.ILog(`Detected old cel animation (${year}) - will apply stronger grain removal`);
    }

    /**
     * FILTER STRATEGY
     * ===============
     *
     * HARDWARE ENCODER SUPPORT:
     *   This script detects the encoder type and uses appropriate parameters:
     *   - Intel QSV (hevc_qsv): Uses vpp_qsv=denoise (0-64), -bf, -refs, -extbrc, -look_ahead_depth
     *   - NVIDIA NVENC: Uses different parameters (not fully implemented yet)
     *   - CPU (libx265): Uses hqdn3d, x265-params like psy-rd, bframes, etc.
     *
     * RESTORED CONTENT DETECTION:
     *   Old content (pre-2000) with high bitrate (>15Mbps) is likely a modern restoration.
     *   These files are huge because they preserve film grain at high fidelity.
     *   For compression, we need to remove this grain aggressively.
     *
     * DENOISING BY HARDWARE:
     *   - Intel QSV: vpp_qsv=denoise=XX (0-64, higher=stronger)
     *   - CPU: hqdn3d=luma_s:chroma_s:luma_t:chroma_t
     *   Note: QSV denoise is very fast but less configurable than hqdn3d
     *
     * ENCODER PARAMETERS BY HARDWARE:
     *   Intel QSV (hevc_qsv):
     *     - -bf 7: B-frames (max ~7 for QSV)
     *     - -refs 5: Reference frames
     *     - -extbrc 1: Extended bitrate control (enables EncTools)
     *     - -look_ahead_depth 40: Lookahead for better quality (requires extbrc)
     *     - -g 256: GOP size (keyframe interval)
     *     - -adaptive_i 1, -adaptive_b 1: Adaptive I/B frames
     *
     *   CPU (libx265):
     *     - bframes=16: More B-frames for animation
     *     - ref=6: Reference frames
     *     - psy-rd, psy-rdoq: Psychovisual optimization
     *     - aq-mode=3: Dark scene bias
     *
     * Debanding (deband) - CPU filter, works with both:
     *   - Removes color banding artifacts common in animation
     *   - Essential for anime/animation content
     *
     * mpdecimate - Remove duplicate frames (animation only):
     *   - Can reduce file size 10-30% for animation
     *   - May cause audio sync issues
     */

    const filters = [];
    const encoderParams = [];

    // ===== DENOISING =====
    // Select denoise filter based on hardware encoder
    // QSV: vpp_qsv=denoise=XX (0-64, part of QSV filter chain)
    // CPU: hqdn3d=luma_s:chroma_s:luma_t:chroma_t
    if (!SkipDenoise) {
        if (forceVppQsv) {
            // Forced QSV hardware denoise override
            const vppValue = forceVppQsv.includes('=') ? forceVppQsv : `denoise=${forceVppQsv}`;
            Logger.ILog(`Forced QSV denoise: vpp_qsv=${vppValue}`);
            filters.push(`vpp_qsv=${vppValue}`);
        } else if (forceHqdn3d && !isQSV) {
            // Forced hqdn3d override (CPU only)
            Logger.ILog(`Forced CPU denoise: hqdn3d=${forceHqdn3d}`);
            filters.push(`hqdn3d=${forceHqdn3d}`);
        } else {
            // Auto-select denoising based on content and hardware
            // Reference: https://mattgadient.com/in-depth-look-at-de-noising-in-handbrake-with-imagevideo-examples/

            // Calculate denoise strength (0-100 scale for normalization)
            let denoiseLevel = 0; // 0 = none, 100 = maximum

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

            if (denoiseLevel > 0) {
                if (isQSV) {
                    // QSV denoise: 0-64 scale
                    // Note: QSV denoise is applied as part of vpp_qsv filter chain
                    // It should be combined with other vpp_qsv options (crop, scale, etc.)
                    const qsvDenoise = Math.round(denoiseLevel * 64 / 100);
                    Logger.ILog(`Auto QSV denoise for ${year}: vpp_qsv denoise=${qsvDenoise} (level ${denoiseLevel}%)`);
                    // Store for later - will be merged with existing vpp_qsv filter
                    Variables.qsv_denoise_value = qsvDenoise;
                    // Add denoise to vpp_qsv - this may need to be merged with existing vpp_qsv
                    filters.push(`vpp_qsv=denoise=${qsvDenoise}`);
                } else {
                    // CPU denoise: hqdn3d with spatial and temporal params
                    // Convert level to hqdn3d params: spatial 0-8, temporal 0-16
                    const spatial = (denoiseLevel * 8 / 100).toFixed(1);
                    const temporal = (denoiseLevel * 16 / 100).toFixed(1);
                    const hqdn3dParams = `${spatial}:${spatial}:${temporal}:${temporal}`;
                    Logger.ILog(`Auto CPU denoise for ${year}: hqdn3d=${hqdn3dParams} (level ${denoiseLevel}%)`);
                    filters.push(`hqdn3d=${hqdn3dParams}`);
                }
            }
        }
    }

    // ===== DEBANDING =====
    // Removes color banding - essential for animation, helpful for older compressed content
    if (!SkipDeband) {
        if (forceDeband) {
            Logger.ILog(`Forced deband: deband=${forceDeband}`);
            filters.push(`deband=${forceDeband}`);
        } else if (isAnimation) {
            // Animation almost always benefits from debanding
            // Higher threshold for older content with more banding
            if (isOldCelAnimation && (AggressiveCompression || isRestoredContent)) {
                // Stronger deband for old restored animation
                filters.push('deband=1thr=0.05:2thr=0.05:3thr=0.05:range=20:blur=1');
            } else if (year <= 2005) {
                filters.push('deband=1thr=0.04:2thr=0.04:3thr=0.04:range=16:blur=1');
            } else if (year <= 2015) {
                filters.push('deband=1thr=0.03:2thr=0.03:3thr=0.03:range=16:blur=1');
            } else {
                // Modern animation: very light deband
                filters.push('deband=1thr=0.02:2thr=0.02:3thr=0.02:range=12:blur=1');
            }
        } else if (year <= 2005) {
            // Old live action may have banding from compression
            filters.push('deband=1thr=0.02:2thr=0.02:3thr=0.02:range=8:blur=1');
        }
        // Modern live action: typically no banding issues
    }

    // ===== SHARPENING (optional) =====
    // Can restore detail lost to denoising, but use sparingly
    if (AddSharpening || forceUnsharp) {
        const sharpValue = forceUnsharp || '5:5:0.3:5:5:0.1'; // Very mild default
        Logger.ILog(`Sharpening: unsharp=${sharpValue}`);
        filters.push(`unsharp=${sharpValue}`);

        // Alternative sharpening options (commented for reference):
        // - cas=0.5 : Contrast Adaptive Sharpening (if available in ffmpeg build)
        // - unsharp=5:5:0.5 : Moderate sharpening
        // - unsharp=3:3:1.0 : Stronger but smaller kernel
    }

    // ===== ALTERNATIVE FILTERS (commented out) =====

    // NLMEANS - Best quality denoiser but VERY slow (0.5-2 fps)
    // Use for archival encodes of valuable content only
    // if (year <= 1985 && ARCHIVAL_QUALITY) {
    //     filters.push('nlmeans=s=3.0:p=7:pc=5:r=5:rc=3');
    //     // s=denoise strength, p=patch size, r=research window size
    //     // Pros: Excellent detail preservation, state-of-art quality
    //     // Cons: 10-40x slower than hqdn3d, doesn't parallelize well
    // }

    // VAGUEDENOISER - Wavelet-based, good quality, ~3x slower than hqdn3d
    // if (year <= 1995) {
    //     filters.push('vaguedenoiser=threshold=3:method=2:nsteps=6');
    //     // method=2 is Garrote, generally best balance
    //     // Pros: Good detail preservation, faster than nlmeans
    //     // Cons: Still 3x slower than hqdn3d
    // }

    // ATADENOISE - Adaptive Temporal Averaging
    // Good for preserving film grain while removing digital noise
    // if (isDocumentary && year <= 2000) {
    //     filters.push('atadenoise=0a=0.02:0b=0.04:1a=0.02:1b=0.04:2a=0.02:2b=0.04');
    //     // Pros: Preserves film grain texture
    //     // Cons: Less effective than hqdn3d for compression
    // }

    // MPDECIMATE - Remove duplicate frames (VFR output)
    // Excellent for animation, can significantly reduce file size
    // WARNING: Can cause audio sync issues, needs careful handling
    if (isAnimation) {
        filters.push('mpdecimate');
        // Requires: -vsync vfr or proper PTS handling
        // Pros: Major file size reduction for animation (10-30%)
        // Cons: Audio sync issues, VFR compatibility problems
    }

    // GRADFUN - Alternative to deband for gradient smoothing
    // if (isAnimation && year <= 2000) {
    //     filters.push('gradfun=strength=1.2:radius=16');
    //     // Pros: Good at smoothing gradients
    //     // Cons: Can blur edges, deband is generally better
    // }

    // ===== ENCODER PARAMETERS =====
    // Hardware-specific encoder parameters
    // QSV (hevc_qsv): -bf, -refs, -extbrc, -look_ahead_depth, -g
    // CPU (libx265): x265-params like bframes, ref, psy-rd, aq-mode
    if (!SkipEncoderParams) {
        if (forceEncoderParams) {
            Logger.ILog(`Forced encoder params: ${forceEncoderParams}`);
            encoderParams.push(forceEncoderParams);
        } else if (isQSV) {
            // ===== INTEL QSV ENCODER PARAMETERS =====
            // Reference: https://nelsonslog.wordpress.com/2022/08/22/ffmpeg-and-hevc_qsv-intel-quick-sync-settings/
            // Reference: https://github.com/intel/media-delivery/blob/master/doc/quality.rst

            if (AggressiveCompression || isOldCelAnimation || isRestoredContent || isAnimation) {
                // Aggressive QSV settings for animation
                // Note: QSV B-frames max is typically 7
                encoderParams.push('-bf 7');                    // Max B-frames for QSV
                encoderParams.push('-refs 6');                  // Reference frames
                encoderParams.push('-g 256');                   // GOP size (keyframe interval)
                encoderParams.push('-extbrc 1');                // Extended bitrate control (EncTools)
                encoderParams.push('-look_ahead_depth 40');     // Lookahead for quality
                encoderParams.push('-adaptive_i 1');            // Adaptive I-frame placement
                encoderParams.push('-adaptive_b 1');            // Adaptive B-frame placement
                encoderParams.push('-b_strategy 1');            // B-frame strategy

                Logger.ILog('Using aggressive QSV encoder params for animation');
            } else {
                // Standard QSV settings
                encoderParams.push('-bf 7');
                encoderParams.push('-refs 4');
                encoderParams.push('-g 250');
                encoderParams.push('-extbrc 1');
                encoderParams.push('-look_ahead_depth 20');
            }
        } else if (isNVENC) {
            // ===== NVIDIA NVENC ENCODER PARAMETERS =====
            // NVENC has different parameters
            if (isAnimation) {
                encoderParams.push('-bf 4');                    // B-frames for NVENC
                encoderParams.push('-refs 4');                  // Reference frames
                encoderParams.push('-rc-lookahead 32');         // Lookahead
                encoderParams.push('-spatial_aq 1');            // Spatial AQ
                encoderParams.push('-temporal_aq 1');           // Temporal AQ
                Logger.ILog('Using NVENC encoder params for animation');
            }
        } else {
            // ===== CPU (libx265) ENCODER PARAMETERS =====
            // These go into x265-params
            if (isAnimation) {
                if (AggressiveCompression || isOldCelAnimation || isRestoredContent) {
                    // Aggressive x265 settings for animation
                    encoderParams.push('bframes=16');
                    encoderParams.push('ref=6');
                    encoderParams.push('rc-lookahead=60');
                    encoderParams.push('aq-mode=3');
                    encoderParams.push('aq-strength=0.8');
                    encoderParams.push('psy-rd=0.7');
                    encoderParams.push('psy-rdoq=0');
                    encoderParams.push('deblock=1,1');
                    encoderParams.push('no-sao=0');
                    encoderParams.push('no-strong-intra-smoothing=1');
                    Logger.ILog('Using aggressive x265 encoder params for animation');
                } else {
                    // Standard x265 animation settings
                    encoderParams.push('bframes=8');
                    encoderParams.push('ref=4');
                    encoderParams.push('psy-rd=1.0');
                    encoderParams.push('aq-mode=3');
                    encoderParams.push('aq-strength=0.8');
                    encoderParams.push('deblock=0,0');
                    encoderParams.push('no-sao=1');
                }
            } else if (isDocumentary || isHorror) {
                encoderParams.push('psy-rd=2.0');
                encoderParams.push('psy-rdoq=2.0');
                encoderParams.push('deblock=-1,-1');
                encoderParams.push('aq-mode=2');
            } else {
                if (year <= 2000) {
                    encoderParams.push('psy-rd=1.5');
                    encoderParams.push('psy-rdoq=1.0');
                    encoderParams.push('deblock=0,0');
                    encoderParams.push('aq-mode=3');
                } else {
                    encoderParams.push('psy-rd=1.0');
                    encoderParams.push('deblock=0,0');
                    encoderParams.push('aq-mode=2');
                }
            }
        }
    }

    // Store for downstream nodes
    Variables.filters = filters.join(',');
    Variables.encoder_params_applied = encoderParams.join(' ');
    Variables.isRestoredContent = isRestoredContent;
    Variables.isOldCelAnimation = isOldCelAnimation;
    Variables.sourceBitrateKbps = Math.round(bitrateKbps);
    Variables.isQSV = isQSV;
    Variables.isNVENC = isNVENC;
    Variables.isCPUEncoder = isCPUEncoder;

    // Apply filters to video stream using correct FileFlows API
    // video.Filters is an array that gets applied as -filter:v in FFmpeg
    if (filters.length > 0) {
        Logger.ILog(`Applying ${filters.length} cleaning filter(s): ${filters.join(', ')}`);
        Logger.ILog(`Content: ${year}, genres: ${genres.join(', ')}`);
        for (let filter of filters) {
            video.Filters.push(filter);
        }
    } else {
        Logger.ILog(`No cleaning filters needed for ${year} content (genres: ${genres.join(', ')})`);
    }

    // Apply encoder parameters
    // For QSV/NVENC: these are FFmpeg encoder options (like -bf, -refs)
    // For CPU: these are x265-params (like bframes=16, psy-rd=1)
    if (encoderParams.length > 0) {
        Logger.ILog(`Applying encoder params: ${encoderParams.join(', ')}`);

        if (isQSV || isNVENC || isVAAPI) {
            // Hardware encoder: add as EncodingParameters (FFmpeg options)
            for (let param of encoderParams) {
                video.EncodingParameters.push(param);
            }
        } else {
            // CPU encoder (libx265): add to x265-params
            // These need to be formatted as a colon-separated string for -x265-params
            const x265Params = encoderParams.join(':');
            // Add to CustomParameters if not already present
            if (!ffmpeg.CustomParameters) ffmpeg.CustomParameters = [];

            // Check if x265-params already exists and append
            let found = false;
            for (let i = 0; i < ffmpeg.CustomParameters.length; i++) {
                if (ffmpeg.CustomParameters[i].includes('-x265-params')) {
                    // Append to existing x265-params
                    ffmpeg.CustomParameters[i] += ':' + x265Params;
                    found = true;
                    break;
                }
            }
            if (!found) {
                ffmpeg.CustomParameters.push('-x265-params');
                ffmpeg.CustomParameters.push(x265Params);
            }
            Logger.ILog(`Added x265-params: ${x265Params}`);
        }
    }

    return 1;
}

