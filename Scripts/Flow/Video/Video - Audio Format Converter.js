import { ScriptHelpers } from 'Shared/ScriptHelpers';

/**
 * @description Converts all audio tracks to a specific codec with intelligent bitrate limits.
 * @author Sisyphus
 * @revision 3
 * @minimumVersion 1.0.0.0
 * @param {('eac3'|'ac3'|'aac'|'libopus'|'flac'|'copy')} Codec The target audio codec (default: eac3).
 * @param {int} BitratePerChannel Kbps per channel limit (e.g. 96 or 128). Calculates total limit based on channel count. Set 0 to disable. Default: 96.
 * @param {('48000'|'44100'|'Same as Source')} MaxSampleRate Maximum sample rate. Default: 48000.
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

    const audioStreams = helpers.toEnumerableArray(ffModel.AudioStreams, 200);
    if (!audioStreams || audioStreams.length === 0) {
        Logger.ILog('No audio streams found.');
        return 2;
    }

    Codec = Codec || 'eac3';
    BitratePerChannel = parseInt(BitratePerChannel, 10);
    if (isNaN(BitratePerChannel)) BitratePerChannel = 96;

    MaxSampleRate = MaxSampleRate || '48000';
    let maxSampleRateVal = 0;
    if (String(MaxSampleRate) === '48000') maxSampleRateVal = 48000;
    else if (String(MaxSampleRate) === '44100') maxSampleRateVal = 44100;

    let changes = 0;

    function normalizeCodecName(value) {
        return String(value || '')
            .trim()
            .toLowerCase();
    }

    function codecsCompatibleForCopy(sourceCodec, targetCodec) {
        const s = normalizeCodecName(sourceCodec);
        const t = normalizeCodecName(targetCodec);
        if (!s || !t) return false;
        if (s === t) return true;
        // FFmpeg reports Opus as "opus" but encoder is "libopus"
        if ((s === 'opus' && t === 'libopus') || (s === 'libopus' && t === 'opus')) return true;
        return false;
    }

    function hasAnyAudioFilters(stream) {
        const filterLists = []
            .concat(helpers.toEnumerableArray(stream ? stream.Filter : null, 200))
            .concat(helpers.toEnumerableArray(stream ? stream.Filters : null, 200))
            .concat(helpers.toEnumerableArray(stream ? stream.OptionalFilter : null, 200));

        for (let i = 0; i < filterLists.length; i++) {
            const v = String(filterLists[i] || '').trim();
            if (v) return true;
        }

        const tokens = helpers.toEnumerableArray(stream ? stream.EncodingParameters : null, 2000);
        for (let i = 0; i < tokens.length; i++) {
            const t = String(tokens[i] || '')
                .trim()
                .toLowerCase();
            if (!t) continue;
            if (t === '-af') return true;
            if (t === '-filter:a') return true;
            if (t.indexOf('-filter:a:') === 0) return true;
        }

        return false;
    }

    for (let i = 0; i < audioStreams.length; i++) {
        const stream = audioStreams[i];
        if (stream.Deleted) continue;

        const sourceCodec = normalizeCodecName(stream.Codec);
        const targetCodec = normalizeCodecName(Codec);
        const isCopy = targetCodec === 'copy';

        let smartCopy = false;

        const channels = stream.Channels > 0 ? stream.Channels : 2;
        const targetTotalKbps = channels * BitratePerChannel;
        const targetTotalBits = targetTotalKbps * 1000;
        const sourceBitrate = stream.Bitrate > 0 ? stream.Bitrate : 0;
        const sourceRate = stream.SampleRate > 0 ? stream.SampleRate : 0;

        const hasFilters = hasAnyAudioFilters(stream);

        if (!isCopy && codecsCompatibleForCopy(sourceCodec, targetCodec)) {
            // If bitrate/sample rate info is missing, assume OK (prefer copy over unnecessary re-encode).
            const bitrateOk = BitratePerChannel <= 0 || sourceBitrate <= 0 || sourceBitrate <= targetTotalBits;
            const sampleRateOk = maxSampleRateVal <= 0 || sourceRate <= 0 || sourceRate <= maxSampleRateVal;

            if (bitrateOk && sampleRateOk && !hasFilters) {
                smartCopy = true;
            }
        }

        if (isCopy || smartCopy) {
            if (normalizeCodecName(stream.Codec) !== 'copy') {
                stream.Codec = 'copy';
                if (stream.EncodingParameters) {
                    helpers.removeArgWithValue(stream.EncodingParameters, (t) => t === '-b:a' || t.startsWith('-b:a:'));
                    helpers.removeArgWithValue(stream.EncodingParameters, (t) => t === '-ar');
                }
                changes++;
            }
            continue;
        }

        if (normalizeCodecName(stream.Codec) !== targetCodec) {
            stream.Codec = targetCodec;
            changes++;
        }

        if (!stream.EncodingParameters) stream.EncodingParameters = [];

        // Bitrate/sample-rate options should be set per-stream by placing them in this stream's EncodingParameters,
        // and using the non-indexed form (-b:a / -ar). The executor adds these tokens in stream order, which targets
        // the correct output audio stream.
        if (BitratePerChannel > 0 && targetCodec !== 'flac') {
            let finalBitrate = sourceBitrate > 0 ? Math.min(sourceBitrate, targetTotalBits) : targetTotalBits;

            // AC3 hard limit: 640 kbps total
            if (targetCodec === 'ac3') {
                finalBitrate = Math.min(finalBitrate, 640000);
            }

            helpers.removeArgWithValue(stream.EncodingParameters, (t) => t === '-b:a' || t.startsWith('-b:a:'));
            stream.EncodingParameters.push('-b:a');
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
