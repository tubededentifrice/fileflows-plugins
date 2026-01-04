import { ScriptHelpers } from 'Shared/ScriptHelpers';

/**
 * @description Check the size in MiB per hour of the input by checking the full file size and dividing by the video duration. Uses resolution-specific thresholds.
 * @author Vincent Courcelle
 * @revision 2
 * @param {int} MaxMiBPerHour4K MBytes per hour threshold for 4K resolutions. Suggested: 2000-4000. Default: 3000
 * @param {int} MaxMiBPerHour1080p MBytes per hour threshold for 1080p resolutions. Suggested: 1000-2000. Default: 1500
 * @param {int} MaxMiBPerHour720p MBytes per hour threshold for 720p resolutions. Suggested: 700-1200. Default: 1000
 * @param {int} MaxMiBPerHourSD MBytes per hour threshold for SD resolutions. Suggested: 400-800. Default: 600
 * @output Actual MiB per hour below or equal the threshold
 * @output Actual MiB per hour above the threshold
 * @output Unable to get video duration or other problem
 */
function Script(MaxMiBPerHour4K, MaxMiBPerHour1080p, MaxMiBPerHour720p, MaxMiBPerHourSD) {
    const helpers = new ScriptHelpers();
    const OUTPUT_BELOW = 1;
    const OUTPUT_ABOVE = 2;
    const OUTPUT_UNABLE = 3;

    // Apply defaults if not provided
    if (!MaxMiBPerHour4K || MaxMiBPerHour4K <= 0) MaxMiBPerHour4K = 3000;
    if (!MaxMiBPerHour1080p || MaxMiBPerHour1080p <= 0) MaxMiBPerHour1080p = 1500;
    if (!MaxMiBPerHour720p || MaxMiBPerHour720p <= 0) MaxMiBPerHour720p = 1000;
    if (!MaxMiBPerHourSD || MaxMiBPerHourSD <= 0) MaxMiBPerHourSD = 600;

    const metadata = helpers.getVideoMetadata();
    const width = metadata.width;
    const height = metadata.height;
    const duration = metadata.duration;

    const resolution = helpers.getResolution(width, height);
    let MaxMiBPerHour = null;
    switch (resolution) {
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

    Logger.ILog('Resolution detected: ' + resolution + ', using threshold: ' + MaxMiBPerHour + ' MiB/h');

    if (MaxMiBPerHour === null) {
        Logger.WLog('Could not determine resolution-appropriate threshold, failing');
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
        Logger.WLog('Unable to determine video duration. MiB per hour calculation aborted. Duration: ' + duration);
        return OUTPUT_UNABLE;
    }

    const mibPerHour = helpers.calculateMiBPerHour(fileSize, duration);

    const maxSizeBytes = (duration * MaxMiBPerHour * 1024 * 1024) / 3600;
    if (!Variables.MaxFileSize) {
        Variables.MaxFileSize = Math.floor(maxSizeBytes);
        Logger.ILog('Setting MaxFileSize to: ' + Variables.MaxFileSize);
    } else {
        Logger.ILog('MaxFileSize is already set to: ' + Variables.MaxFileSize + ', not overriding.');
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
