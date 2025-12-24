import { ScriptHelpers } from 'Shared/ScriptHelpers';

/**
 * @description Converts all audio tracks to a specific codec with intelligent bitrate limits.
 * @author Sisyphus
 * @revision 2
 * @minimumVersion 1.0.0.0
 * @param {('eac3'|'ac3'|'aac'|'libopus'|'flac'|'copy')} Codec The target audio codec (default: eac3).
 * @param {int} BitratePerChannel Kbps per channel limit (e.g. 160). Calculates total limit based on channel count. Set 0 to disable.
 * @param {('48000'|'44100'|'Same as Source')} MaxSampleRate Maximum sample rate (default: 48000).
 * @output Tracks converted
 * @output No changes needed
 */
function Script(Codec, BitratePerChannel, MaxSampleRate) {
    const helpers = new ScriptHelpers();
    const ffModel = Variables.FfmpegBuilderModel;

    if (!ffModel) {
        Logger.ELog('FFmpeg Builder Model not found. Ensure this runs after "FFmpeg Builder: Start".');
        return -1;
    }

    if (!ffModel.AudioStreams || ffModel.AudioStreams.length === 0) {
        Logger.ILog('No audio streams found.');
        return 2;
    }

    Codec = Codec || 'eac3';
    BitratePerChannel = parseInt(BitratePerChannel, 10);
    if (isNaN(BitratePerChannel)) BitratePerChannel = 160;

    let maxSampleRateVal = 0;
    if (String(MaxSampleRate) === '48000') maxSampleRateVal = 48000;
    else if (String(MaxSampleRate) === '44100') maxSampleRateVal = 44100;

    let changes = 0;

    for (let i = 0; i < ffModel.AudioStreams.length; i++) {
        const stream = ffModel.AudioStreams[i];
        if (stream.Deleted) continue;

        const sourceCodec = String(stream.Codec || '').toLowerCase();
        const targetCodec = String(Codec || '').toLowerCase();
        const isCopy = targetCodec === 'copy';

        let smartCopy = false;

        const channels = stream.Channels > 0 ? stream.Channels : 2;
        const targetTotalKbps = channels * BitratePerChannel;
        const targetTotalBits = targetTotalKbps * 1000;
        const sourceBitrate = stream.Bitrate > 0 ? stream.Bitrate : 0;
        const sourceRate = stream.SampleRate > 0 ? stream.SampleRate : 0;

        if (!isCopy && sourceCodec === targetCodec) {
            const bitrateOk = BitratePerChannel <= 0 || (sourceBitrate > 0 && sourceBitrate <= targetTotalBits);
            const sampleRateOk = maxSampleRateVal <= 0 || (sourceRate > 0 && sourceRate <= maxSampleRateVal);
            
            if (bitrateOk && sampleRateOk) {
                smartCopy = true;
            }
        }

        if (isCopy || smartCopy) {
            if (stream.Codec !== 'copy') {
                stream.Codec = 'copy';
                if (stream.EncodingParameters) {
                    helpers.removeArgWithValue(stream.EncodingParameters, (t) => t === '-b:a' || t.startsWith('-b:a:'));
                    helpers.removeArgWithValue(stream.EncodingParameters, (t) => t === '-ar');
                }
                changes++;
            }
            continue; 
        }

        if (stream.Codec !== targetCodec) {
            stream.Codec = targetCodec;
            changes++;
        }

        if (!stream.EncodingParameters) stream.EncodingParameters = [];

        if (BitratePerChannel > 0) {
            const finalBitrate = sourceBitrate > 0 ? Math.min(sourceBitrate, targetTotalBits) : targetTotalBits;

            helpers.removeArgWithValue(stream.EncodingParameters, (t) => t === '-b:a' || t.startsWith('-b:a:'));
            stream.EncodingParameters.push(`-b:a:{index}`);
            stream.EncodingParameters.push(String(finalBitrate));
            changes++;
        }

        if (maxSampleRateVal > 0) {
            if (sourceRate > 0 && sourceRate > maxSampleRateVal) {
                helpers.removeArgWithValue(stream.EncodingParameters, (t) => t === '-ar');
                stream.EncodingParameters.push('-ar');
                stream.EncodingParameters.push(String(maxSampleRateVal));
                changes++;
            }
        }
    }

    if (changes > 0) {
        ffModel.ForceEncode = true;
        Logger.ILog(`Updated ${changes} audio parameters.`);
        return 1;
    }

    return 2;
}
