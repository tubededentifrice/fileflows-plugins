/**
 * @description Apply good filters from https://www.reddit.com/r/Piracy/comments/szig1j/reencoding_large_video_coursestutorialstv_series/
 * @author Vincent Courcelle
 * @revision 1
 * @output Cleaned video
 */
function Script() {
    const year = Variables.VideoMetadata?.Year || 2012;
    const genres = Variables.VideoMetadata?.Genres || [];
    const hqdn3d = Variables.hqdn3d;

    const ffmpeg = Variables.FfmpegBuilderModel;
    if(!ffmpeg) {
        Logger.ELog('FFMPEG Builder variable not found');
        return -1;
    }

    const video = ffmpeg.VideoStreams[0];
    if(!video) {
        Logger.ELog('FFMPEG Builder no video stream found');
        return -1;
    }
    
    /**
     * A tiny bit of filtering, simple edge-preserving spatial smooth and temporal filtering. Just enough to reduce visibility of the artifacts from the previous compression.
     * You only want this on weak. Any detail it might destroy has already been lost in the previous compression anyway, given the typical capabilities of 2000s-era codecs.
     * Duplicate frame dropping and VFR. Usually won't do anything noticeable on filmed video, but works wonders on animation. Faster encodes, smaller files!
    */

    const filters = [];

    if (hqdn3d) {
        Logger.ILog(`Received forced filter hqdn3d=${hqdn3d}`);
        filters.push(`hqdn3d=${hqdn3d}`);
    } else {
        // Checkout https://mattgadient.com/in-depth-look-at-de-noising-in-handbrake-with-imagevideo-examples/
        if (year <= 1990) {
            // At this age, even Animation needs denoising
            filters.push('hqdn3d=2:2:6:6');
        } else if (genres===null || !genres.includes("Animation")) {
            // Cleanup depending on how old it is, newer movies doesn't have noise at all
            if (year <= 2000) {
                filters.push('hqdn3d=2:2:6:6');
            } else if (year <= 2010 || year === null) {
                filters.push('hqdn3d=1:1:4:4');
            } else if (year <= 2016) {
                filters.push('hqdn3d=1:1:3:3');
            } else {
                // On more recent movies, just do a little bit of temporal denoising, just in case, should not be noticeable except for file size
                filters.push('hqdn3d=0:0:3:3');
            }
        }
    }
    

    // if (year <= 1990 || (year < 2016 && !genres.includes("Animation"))) {
    //     // filters.push('nlmeans=1.0:7:5:3:3'); // Very good results but super slow -- can't make the OpenCl or Vulkan versions work; probably not strong enough though
    //     // filters.push('vaguedenoiser=method=1:threshold=4'); // Too strong and super slow
    //     // filters.push('hqdn3d=1:1:4:4');
    // }

    Variables.filters = filters.join(',');

    if (filters.length > 0) {
        Logger.ILog(`Apply cleaning filters: ${filters.join(', ')} (${year} / genres: ${genres.join(', ')})`);
        for (let filter of filters) {
            video.Filter.Add(filter);
        }
    } else {
        Logger.ILog(`The video is from ${year} and genres: ${genres.join(', ')}, no cleaning filters needed`);
    }
    
    return 1;
}
