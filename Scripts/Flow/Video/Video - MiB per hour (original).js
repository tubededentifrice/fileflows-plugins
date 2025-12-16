/**
 * @description Check the size in MiB per hour of the input by checking the full file size and dividing by the video duration.
 * @author Vincent Courcelle
 * @param {int} MaxMiBPerHour MBytes per hour threshold (1024^2)
 * @output Actual MB per hour below or equal the threshold
 * @output Actual MB per hour above the threshold
 * @output Unable to get video duration or other problem
 */
function Script(MaxMiBPerHour) {
    const OUTPUT_BELOW = 1;
    const OUTPUT_ABOVE = 2;
    const OUTPUT_UNABLE = 3;

    // Make extra sure it's actually an int
    MaxMiBPerHour = parseInt(MaxMiBPerHour);

    if (!MaxMiBPerHour) {
        Logger.ILog(`No MaxMiBPerHour was provided or is invalid number, failing: ${MaxMiBPerHour}`);
        return OUTPUT_UNABLE;
    }

    const fileSize = Variables.file.Orig.Size;
    const duration = Variables.video?.Duration;
    if(!duration) {
        Logger.ILog("No duration found");
        return OUTPUT_UNABLE;
    }

    const gb = function(bytes) {
        return Math.round(bytes / 1024 / 1024 / 1024 * 100) / 100;
    }

    const mibPerHour = fileSize / duration * 3600 / 1024 / 1024;
    Logger.ILog(`File size is ${fileSize} (${gb(fileSize)} GB) and should be below: ${gb(duration * MaxMiBPerHour * 1024 * 1024 / 3600)} GB`);
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

    Logger.ILog("Could not compute MiB per hour");
    return OUTPUT_UNABLE;
}
