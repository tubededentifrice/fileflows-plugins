/**
 * @description Check the resolution of the video
 * @author Vincent Courcelle
 * @output 4K
 * @output 1080p
 * @output 720p
 * @output SD
 */
function Script() {
    const OUTPUT_4K = 1;
    const OUTPUT_1080 = 2;
    const OUTPUT_720 = 3;
    const OUTPUT_SD = 4;

    const videoVar = Variables.video;
    const width = videoVar && videoVar.Width;
    const height = videoVar && videoVar.Height;

    if (!width || !height) {
        Logger.ELog('No video info found, run the Video File flow element first.');
        return -1;
    }

    // This is NOT a mistake, the video can be cropped so we need to be slightly permissive
    if (width >= 2500 || height >= 2000) {
        Logger.ILog('4K video detected: ' + width + 'x' + height);
        return OUTPUT_4K;
    }

    // Same, NOT a mistake!
    if (width >= 1700 || height >= 1000) {
        Logger.ILog('1080p video detected: ' + width + 'x' + height);
        return OUTPUT_1080;
    }

    // NOT a mistake either!
    if (width >= 1000 || height >= 700) {
        Logger.ILog('720p video detected: ' + width + 'x' + height);
        return OUTPUT_720;
    }

    Logger.ILog('SD video detected: ' + width + 'x' + height);
    return OUTPUT_SD;
}
