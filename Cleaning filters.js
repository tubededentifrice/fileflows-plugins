/**
 * @description Apply good filters from https://www.reddit.com/r/Piracy/comments/szig1j/reencoding_large_video_coursestutorialstv_series/
 * @author Vincent Courcelle
 * @revision 1
 * @output Cleaned video
 */
function Script() {
    let ffmpeg = Variables.FfmpegBuilderModel;
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

    const filters = [
        'hqdn3d=0:0:2:2',
        'nlmeans=s=1',
        'mpdecimate=max=6'
    ]

    Logger.ILog(`Apply cleaning filters: ${filters.join(', ')}`);
    for (let filter of filters) {
        video.Filter.Add(filter);
    }
    return 1;
}
