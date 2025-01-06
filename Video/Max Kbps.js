/**
 * @description Check the bytes per second of the input by checking the full file size and dividing by the video duration.
 * @author Vincent Courcelle
 * @version 0.0.1
 * @param {int} MaxBitrateKbps Bytes per second threshold
 * @output Actual bytes per second equal or below the threshold
 * @output Actual bytes per second above the threshold
 * @output Unable to parse video
 */
function Script(MaxBitrateKbps) {
    const OUTPUT_BELOW = 1;
    const OUTPUT_ABOVE = 2;
    const OUTPUT_UNABLE = 3;

    if (!MaxBitrateKbps) {
        Logger.ILog("No MaxBitrateKbps was provided, failing: " + MaxBitrateKbps);
        return OUTPUT_UNABLE;
    }

    const fileSize = Variables.file.Orig.Size;
    const duration = Variables.video?.Duration;
    if(!duration) {
        Logger.ILog("No duration found");
        return OUTPUT_UNABLE;
    }

    const bitrateKbps = fileSize / duration / 1000;
    Logger.ILog("File size: " + fileSize);
    Logger.ILog("Duration: " + duration);
    Logger.ILog("Detected BitrateKbps: " + bitrateKbps);

    if (bitrateKbps <= MaxBitrateKbps) {
        Logger.ILog("Below threshold of " + MaxBitrateKbps);
        return OUTPUT_BELOW;
    }
    if (bitrateKbps > MaxBitrateKbps) {
        Logger.ILog("Above threshold of " + MaxBitrateKbps);
        return OUTPUT_ABOVE;
    }

    Logger.ILog("Could not compute bytes per second");
    return OUTPUT_UNABLE;
}
