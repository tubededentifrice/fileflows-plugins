import { ScriptHelpers } from 'Shared/ScriptHelpers';

/**
 * @description Check the resolution of the video
 * @author Vincent Courcelle
 * @output 4K
 * @output 1080p
 * @output 720p
 * @output SD
 */
function Script() {
    const helpers = new ScriptHelpers();
    const OUTPUT_4K = 1;
    const OUTPUT_1080 = 2;
    const OUTPUT_720 = 3;
    const OUTPUT_SD = 4;

    const metadata = helpers.getVideoMetadata();
    const width = metadata.width;
    const height = metadata.height;

    if (!width || !height) {
        Logger.ELog('No video info found, run the Video File flow element first.');
        return -1;
    }

    const resolution = helpers.getResolution(width, height);
    Logger.ILog('Resolution detected: ' + resolution + ' (' + width + 'x' + height + ')');

    if (resolution === '4K') return OUTPUT_4K;
    if (resolution === '1080p') return OUTPUT_1080;
    if (resolution === '720p') return OUTPUT_720;
    return OUTPUT_SD;
}
