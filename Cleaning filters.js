/**
 * @description Apply good filters from https://www.reddit.com/r/Piracy/comments/szig1j/reencoding_large_video_coursestutorialstv_series/
 * @author Vincent Courcelle
 * @revision 1
 * @output Cleaned video
 */
function Script() {
    const year = Variables.VideoMetadata?.Year;
    const genres = Variables.VideoMetadata?.Genres;

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

    // Checkout https://mattgadient.com/in-depth-look-at-de-noising-in-handbrake-with-imagevideo-examples/
    if (genres===null || !("Animation" in genres)) {
        if (year <= 2000) {
            filters.push('hqdn3d=2:2:6:6');
        } else if (year <= 2010 || year === null) {
            filters.push('hqdn3d=1:1:4:4');
        } else if (year <= 2016) {
            filters.push('hqdn3d=1:1:2:2');
        }
    }

    if (filters.length > 0) {
        Logger.ILog(`Apply cleaning filters: ${filters.join(', ')} and genres: ${genres.join(', ')}`);
        for (let filter of filters) {
            video.Filter.Add(filter);
        }
    } else {
        Logger.ILog(`The video is from ${year} and genres: ${genres.join(', ')}, no cleaning filters needed`);
    }
    
    return 1;
}
