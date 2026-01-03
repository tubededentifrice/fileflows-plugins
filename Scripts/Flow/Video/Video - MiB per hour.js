import { ScriptHelpers } from 'Shared/ScriptHelpers';

/**
 * @description Check the size in MiB per hour of the input by checking the full file size and dividing by the video duration. Use 'MiB per hour per resolution' for resolution-specific thresholds with defaults.
 * @author Vincent Courcelle
 * @revision 2
 * @param {int} MaxMiBPerHour MBytes per hour threshold. Suggested: 4K=3000, 1080p=1500, 720p=1000, SD=600. Required.
 * @output Actual MiB per hour below or equal the threshold
 * @output Actual MiB per hour above the threshold
 * @output Unable to get video duration or other problem
 */
function Script(MaxMiBPerHour) {
    const helpers = new ScriptHelpers();
    const OUTPUT_BELOW = 1;
    const OUTPUT_ABOVE = 2;
    const OUTPUT_UNABLE = 3;

    // Make extra sure it's actually an int
    MaxMiBPerHour = parseInt(MaxMiBPerHour);

    if (!MaxMiBPerHour) {
        Logger.ILog('No MaxMiBPerHour was provided or is invalid number, failing: ' + MaxMiBPerHour);
        return OUTPUT_UNABLE;
    }

    const metadata = helpers.getVideoMetadata();
    const fileSize = Variables.file.Size;
    const duration = metadata.duration;
    if (!duration) {
        Logger.ILog('No duration found');
        return OUTPUT_UNABLE;
    }

    const mibPerHour = helpers.calculateMiBPerHour(fileSize, duration);
    Logger.ILog(
        'File size is ' +
            fileSize +
            ' (' +
            helpers.bytesToGb(fileSize) +
            ' GB) and should be below: ' +
            helpers.bytesToGb((duration * MaxMiBPerHour * 1024 * 1024) / 3600) +
            ' GB'
    );
    Logger.ILog('Duration: ' + duration + ' seconds');
    Logger.ILog('Detected mibPerHour: ' + mibPerHour);

    if (mibPerHour <= MaxMiBPerHour) {
        Logger.ILog('Below threshold of ' + MaxMiBPerHour);
        return OUTPUT_BELOW;
    }
    if (mibPerHour > MaxMiBPerHour) {
        Logger.ILog('Above threshold of ' + MaxMiBPerHour);
        return OUTPUT_ABOVE;
    }

    Logger.ILog('Could not compute MiB per hour');
    return OUTPUT_UNABLE;
}
