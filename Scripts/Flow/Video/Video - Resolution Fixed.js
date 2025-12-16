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

    const width = Variables.video?.Width;
    const height = Variables.video?.Height;

    if (!width || !height) {
        Logger.ELog("No video info found, run the Video File flow element first.");
        return -1;
    }

    if (width >= 2592 || height >= 2160) {
        Logger.ILog(`4K video detected: ${width}x${height}`);
        return OUTPUT_4K;
    }

    if (width >= 1800 || height >= 1080) {
        Logger.ILog(`1080p video detected: ${width}x${height}`);
        return OUTPUT_1080;
    }

    if (width >= 1200 || height >= 720) {
        Logger.ILog(`720p video detected: ${width}x${height}`);
        return OUTPUT_720;
    }

    Logger.ILog(`SD video detected: ${width}x${height}`);
    return OUTPUT_SD;
}
