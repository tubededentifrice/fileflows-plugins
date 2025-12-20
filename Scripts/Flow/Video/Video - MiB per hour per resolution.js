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
    const OUTPUT_BELOW = 1;
    const OUTPUT_ABOVE = 2;
    const OUTPUT_UNABLE = 3;

    let MaxMiBPerHour = null;
    switch (getResolution(Variables.video?.Width, Variables.video?.Height)) {
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
        Logger.ILog(`No MaxMiBPerHour was provided for the resolution, failing: ${MaxMiBPerHour}`);
        return OUTPUT_UNABLE;
    }

    // Make extra sure it's actually an int
    MaxMiBPerHour = parseInt(MaxMiBPerHour);

    if (!MaxMiBPerHour) {
        Logger.ILog(`No MaxMiBPerHour was provided or is invalid number, failing: ${MaxMiBPerHour}`);
        return OUTPUT_UNABLE;
    }

    const fileSize = Variables.file.Size;
    const duration = Variables.video?.Duration;
    if (!duration) {
        Logger.ILog('No duration found');
        return OUTPUT_UNABLE;
    }

    const gb = function (bytes) {
        return Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100;
    };

    const mibPerHour = ((fileSize / duration) * 3600) / 1024 / 1024;
    Logger.ILog(
        `File size is ${fileSize} (${gb(fileSize)} GB) and should be below: ${gb((duration * MaxMiBPerHour * 1024 * 1024) / 3600)} GB`
    );
    Logger.ILog(`Duration: ${duration} seconds`);
    Logger.ILog(`Detected mibPerHour: ${mibPerHour}`);

    if (mibPerHour <= MaxMiBPerHour) {
        Logger.ILog(`Below threshold of ${MaxMiBPerHour}`);
        return OUTPUT_BELOW;
    }
    if (mibPerHour > MaxMiBPerHour) {
        Logger.ILog(`Above threshold of ${MaxMiBPerHour}`);
        return OUTPUT_ABOVE;
    }

    Logger.ILog('Could not compute MiB per hour');
    return OUTPUT_UNABLE;
}

function getResolution(width, height) {
    if (!width || !height) {
        Logger.ELog('No video info found, run the Video File flow element first.');
        return null;
    }

    if (width >= 2592 || height >= 2160) {
        Logger.ILog(`4K video detected: ${width}x${height}`);
        return '4K';
    }

    if (width >= 1800 || height >= 1080) {
        Logger.ILog(`1080p video detected: ${width}x${height}`);
        return '1080p';
    }

    if (width >= 1200 || height >= 720) {
        Logger.ILog(`720p video detected: ${width}x${height}`);
        return '720p';
    }

    Logger.ILog(`SD video detected: ${width}x${height}`);
    return 'SD';
}
