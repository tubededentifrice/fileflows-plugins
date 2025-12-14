/**
 * @description Apply intelligent video filters based on content type, year, and genre to improve compression while maintaining quality.
 * @author Vincent Courcelle
 * @revision 2
 * @param {bool} SkipDenoise Skip all denoising filters
 * @param {bool} SkipDeband Skip debanding filter (useful for live action with intentional banding)
 * @param {bool} SkipEncoderParams Skip adding encoder optimization parameters
 * @param {bool} AddSharpening Add mild sharpening after denoising to restore detail (experimental)
 * @output Cleaned video
 */
function Script(SkipDenoise, SkipDeband, SkipEncoderParams, AddSharpening) {
    const year = Variables.VideoMetadata?.Year || 2012;
    const genres = Variables.VideoMetadata?.Genres || [];

    // Override variables (set these in upstream nodes to force specific filter values)
    const forceHqdn3d = Variables.hqdn3d;           // e.g., "2:2:6:6"
    const forceVppQsv = Variables.vpp_qsv;          // e.g., "denoise=medium" (Intel QSV hardware)
    const forceDeband = Variables.deband;           // e.g., "1thr=0.04:2thr=0.04:3thr=0.04"
    const forceUnsharp = Variables.unsharp;         // e.g., "5:5:0.5"
    const forceEncoderParams = Variables.encoder_params; // e.g., "psy-rd=2:aq-mode=3"

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

    // Helper functions
    const isAnimation = genres !== null && (genres.includes("Animation") || genres.includes("Anime"));
    const isDocumentary = genres !== null && genres.includes("Documentary");
    const isHorror = genres !== null && (genres.includes("Horror") || genres.includes("Thriller"));

    /**
     * FILTER STRATEGY
     * ===============
     *
     * Denoising (hqdn3d):
     *   - Fast 3D denoiser, good for mild to medium noise
     *   - Spatial params (luma_s, chroma_s): reduce grain/noise in each frame
     *   - Temporal params (luma_t, chroma_t): reduce noise across frames, better for video
     *   - Format: hqdn3d=luma_s:chroma_s:luma_t:chroma_t (0-255 each, higher=stronger)
     *   - Pros: Fast, good compression improvement
     *   - Cons: Can smear fine detail at high settings
     *
     * Debanding (deband):
     *   - Removes color banding artifacts common in animation and older encodes
     *   - Essential for anime/animation content
     *   - Pros: Improves visual quality, especially on gradients
     *   - Cons: Can slightly blur edges if threshold too high
     *
     * Sharpening (unsharp):
     *   - Can restore some detail lost to denoising
     *   - Format: unsharp=lx:ly:la:cx:cy:ca (luma matrix size, luma amount, chroma params)
     *   - Pros: Restores perceived detail
     *   - Cons: Can introduce halos, increase noise, hurt compression
     *   - Recommendation: Use sparingly, disabled by default
     *
     * ALTERNATIVE DENOISERS (commented out - for reference):
     *   - nlmeans: Best quality, but 10-40x slower than hqdn3d. Only for archival.
     *   - vaguedenoiser: Wavelet-based, 3x slower than hqdn3d, good quality
     *   - atadenoise: Adaptive temporal, good for film grain preservation
     *
     * ENCODER PARAMETERS (not filters, but affect quality/compression):
     *   - bframes: More B-frames = better compression, especially for animation
     *   - psy-rd: Psychovisual optimization, preserves detail at cost of compression
     *   - psy-rdoq: Preserves noise/grain texture
     *   - aq-mode: Adaptive quantization mode (3 = bias to dark scenes, good for anime)
     *   - deblock: Encoder-level deblocking (-1,-1 preserves more detail)
     *   - no-sao: Disable SAO to preserve grain (at cost of compression)
     */

    const filters = [];
    const encoderParams = [];

    // ===== DENOISING =====
    if (!SkipDenoise) {
        if (forceVppQsv) {
            // Intel QSV hardware denoising - very fast but requires Intel GPU
            Logger.ILog(`Forced hardware denoise: vpp_qsv=${forceVppQsv}`);
            filters.push(`vpp_qsv=${forceVppQsv}`);
        } else if (forceHqdn3d) {
            // Forced hqdn3d override
            Logger.ILog(`Forced denoise: hqdn3d=${forceHqdn3d}`);
            filters.push(`hqdn3d=${forceHqdn3d}`);
        } else {
            // Auto-select denoising based on content
            // Reference: https://mattgadient.com/in-depth-look-at-de-noising-in-handbrake-with-imagevideo-examples/

            let denoiseStrength = null;

            if (isDocumentary || isHorror) {
                // Preserve grain for atmosphere - use very light temporal-only denoising
                if (year <= 2000) {
                    denoiseStrength = '0:0:4:4'; // Temporal only, preserves film grain
                } else if (year <= 2010) {
                    denoiseStrength = '0:0:3:3';
                }
                // Modern docs/horror: skip denoising to preserve intentional grain
            } else if (isAnimation) {
                // Animation typically has no grain, but may have compression artifacts
                // Use lighter denoising since deband will handle banding
                if (year <= 1995) {
                    // Old animation: often had film grain from cel animation
                    denoiseStrength = '2:2:4:4';
                } else if (year <= 2005) {
                    // Early digital: may have compression artifacts
                    denoiseStrength = '1:1:3:3';
                } else if (year <= 2015) {
                    // Modern animation: very light cleanup
                    denoiseStrength = '0.5:0.5:2:2';
                }
                // 2016+: Skip - modern animation is usually clean
            } else {
                // Live action films
                if (year <= 1985) {
                    // Very old films: significant film grain, needs stronger denoise
                    denoiseStrength = '3:3:8:8';
                    // Alternative: nlmeans for archival quality (VERY SLOW - 0.5fps)
                    // filters.push('nlmeans=s=3.0:p=7:pc=5:r=5:rc=3');
                } else if (year <= 1995) {
                    // Old films: noticeable grain
                    denoiseStrength = '2:2:6:6';
                } else if (year <= 2005) {
                    // Late analog / early digital era
                    denoiseStrength = '1.5:1.5:5:5';
                } else if (year <= 2012) {
                    // HD era but pre-4K mastering
                    denoiseStrength = '1:1:4:4';
                } else if (year <= 2018) {
                    // Modern HD: very light cleanup
                    denoiseStrength = '0.5:0.5:3:3';
                }
                // 2019+: Skip - modern content is typically clean
            }

            if (denoiseStrength) {
                Logger.ILog(`Auto denoise for ${year} ${isAnimation ? 'animation' : 'live-action'}: hqdn3d=${denoiseStrength}`);
                filters.push(`hqdn3d=${denoiseStrength}`);
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
            if (year <= 2005) {
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
    // if (isAnimation) {
    //     filters.push('mpdecimate');
    //     // Requires: -vsync vfr or proper PTS handling
    //     // Pros: Major file size reduction for animation (10-30%)
    //     // Cons: Audio sync issues, VFR compatibility problems
    // }

    // GRADFUN - Alternative to deband for gradient smoothing
    // if (isAnimation && year <= 2000) {
    //     filters.push('gradfun=strength=1.2:radius=16');
    //     // Pros: Good at smoothing gradients
    //     // Cons: Can blur edges, deband is generally better
    // }

    // ===== ENCODER PARAMETERS =====
    // These affect x265/x264 encoding, not filtering per se
    if (!SkipEncoderParams) {
        if (forceEncoderParams) {
            Logger.ILog(`Forced encoder params: ${forceEncoderParams}`);
            encoderParams.push(forceEncoderParams);
        } else {
            if (isAnimation) {
                // Animation encoder optimizations
                encoderParams.push('bframes=8');        // More B-frames for animation
                encoderParams.push('psy-rd=1.0');       // Balance detail vs compression
                encoderParams.push('aq-mode=3');        // Dark scene bias (helps gradients)
                encoderParams.push('deblock=0,0');      // Neutral deblocking

                // For very clean modern animation, consider:
                // encoderParams.push('no-sao=1');      // Disable SAO for sharper edges
                // encoderParams.push('psy-rdoq=0.5'); // Low - animation has no grain to preserve
            } else if (isDocumentary || isHorror) {
                // Preserve grain/atmosphere
                encoderParams.push('psy-rd=2.0');       // Preserve detail
                encoderParams.push('psy-rdoq=2.0');     // Preserve grain texture
                encoderParams.push('deblock=-1,-1');    // Preserve more detail
                encoderParams.push('aq-mode=2');        // Auto-variance AQ

                // For very grainy content:
                // encoderParams.push('no-sao=1');      // Preserve grain at cost of size
            } else {
                // General live action
                if (year <= 2000) {
                    // Older content - may have grain worth preserving
                    encoderParams.push('psy-rd=1.5');
                    encoderParams.push('psy-rdoq=1.0');
                    encoderParams.push('deblock=0,0');
                    encoderParams.push('aq-mode=3');    // Dark scene bias
                } else {
                    // Modern content - cleaner source
                    encoderParams.push('psy-rd=1.0');
                    encoderParams.push('deblock=0,0');
                    encoderParams.push('aq-mode=2');
                }
            }
        }
    }

    // Store for downstream nodes
    Variables.filters = filters.join(',');
    Variables.encoder_params_applied = encoderParams.join(':');

    // Apply filters to video stream
    if (filters.length > 0) {
        Logger.ILog(`Applying ${filters.length} cleaning filter(s): ${filters.join(', ')}`);
        Logger.ILog(`Content: ${year}, genres: ${genres.join(', ')}`);
        for (let filter of filters) {
            video.Filter.Add(filter);
        }
    } else {
        Logger.ILog(`No cleaning filters needed for ${year} content (genres: ${genres.join(', ')})`);
    }

    // Apply encoder parameters
    if (encoderParams.length > 0) {
        Logger.ILog(`Applying encoder params: ${encoderParams.join(', ')}`);
        for (let param of encoderParams) {
            video.Filter.Add(param);
        }
    }

    return 1;
}
