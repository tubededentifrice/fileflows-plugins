import { ScriptHelpers } from 'Shared/ScriptHelpers';

/**
 * @description Check the size in MiB per hour of the input by checking the full file size and dividing by the video duration.
 * @author Vincent Courcelle
 * @param {int} MaxMiBPerHour4K MBytes per hour threshold (1024^2) for 4K resolutions
 * @param {int} MaxMiBPerHour1080p MBytes per hour threshold (1024^2) for 1080p resolutions
 * @param {int} MaxMiBPerHour720p MBytes per hour threshold (1024^2) for 720p resolutions
 * @param {int} MaxMiBPerHourSD MBytes per hour threshold (1024^2) for SD resolutions
 * @output Actual MB per hour below or equal the threshold
 * @output Actual MB per hour above the threshold
 * @output Unable to get video duration or other problem
 */
function Script(MaxMiBPerHour4K, MaxMiBPerHour1080p, MaxMiBPerHour720p, MaxMiBPerHourSD) {
    const helpers = new ScriptHelpers();
    const OUTPUT_BELOW = 1;
    const OUTPUT_ABOVE = 2;
    const OUTPUT_UNABLE = 3;

    const metadata = helpers.getVideoMetadata();
    const width = metadata.width;
    const height = metadata.height;
    const duration = metadata.duration;

    let MaxMiBPerHour = null;
    switch (helpers.getResolution(width, height)) {
        case '4K':
            MaxMiBPerHour = MaxMiBPerHour4K;
            break;
        case '1080p':
            MaxMiBPerHour = MaxMiBPerHour1080p;
            break;
        case '720p':
            MaxMiBPerHour = MaxMiBPerHour720p;
            break;
        case 'SD':
            MaxMiBPerHour = MaxMiBPerHourSD;
            break;
    }

    if (MaxMiBPerHour === null) {
        Logger.ILog('No MaxMiBPerHour was provided for the resolution, failing: ' + MaxMiBPerHour);
        return OUTPUT_UNABLE;
    }

    // Make extra sure it's actually an int
    MaxMiBPerHour = parseInt(MaxMiBPerHour);

    if (!MaxMiBPerHour) {
        Logger.ILog('No MaxMiBPerHour was provided or is invalid number, failing: ' + MaxMiBPerHour);
        return OUTPUT_UNABLE;
    }

    const fileSize = Variables.file.Size;
    if (!duration || isNaN(duration) || duration <= 0) {
        Logger.WLog(`Unable to determine video duration. MiB per hour calculation aborted. Duration: ${duration}`);
        return OUTPUT_UNABLE;
    }

    const mibPerHour = helpers.calculateMiBPerHour(fileSize, duration);

    const maxSizeBytes = (duration * MaxMiBPerHour * 1024 * 1024) / 3600;
    if (!Variables.MaxFileSize) {
        Variables.MaxFileSize = Math.floor(maxSizeBytes);
        Logger.ILog('Setting Variables.MaxFileSize to: ' + Variables.MaxFileSize);
    } else {
        Logger.ILog('Variables.MaxFileSize is already set to: ' + Variables.MaxFileSize + ', not overriding.');
    }

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
