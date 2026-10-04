import { SafeFileReplace } from 'Shared/SafeFileReplace';
import { ScriptHelpers } from 'Shared/ScriptHelpers';

/**
 * @name Video - Safe Replace Original
 * @uid c55058e2-4739-47ae-9eae-b3a0a7e8e5f4
 * @description Copies and checks the encoded file before replacing the original. Keeps a recovery file if replacement fails.
 * @author Vincent Courcelle
 * @revision 1
 * @minimumVersion 25.0.0.0
 * @param {string} RecoveryDirectory Directory outside runner cleanup. Default: /temp/FileFlows-Recovery.
 * @param {bool} PreserveOriginalDates Keep the original modification and access times. Default: true.
 * @output Replaced original
 */
function Script(RecoveryDirectory, PreserveOriginalDates) {
    const helpers = new ScriptHelpers();
    const source = helpers.safeString(Flow.WorkingFile);
    const original = helpers.originalSourcePath(Variables['file.Orig.FullName'], Variables.file);
    const recovery = helpers.safeString(RecoveryDirectory).trim() || '/temp/FileFlows-Recovery';
    if (!Flow.IsLinux || !source || !original || !Flow.TempPath) {
        Logger.ELog('Safe replacement requires Linux, Python 3, and local source paths.');
        return -1;
    }
    if (source === original) {
        if (Variables.MaxFileSize || Variables['AutoQuality.SizePriority']) {
            Logger.ELog('Mandatory conversion has no separate encoded file.');
            return -1;
        }
        return 1;
    }
    const result = Flow.Execute({
        command: 'python3',
        argumentList: [
            '-c',
            new SafeFileReplace().python(),
            source,
            original,
            recovery,
            helpers.safeString(Flow.TempPath),
            PreserveOriginalDates === false ? 'false' : 'true'
        ],
        timeout: 3600
    });
    const output = helpers.safeString(result && result.standardOutput);
    const error = helpers.safeString(result && result.standardError);
    if (!result || result.exitCode !== 0 || result.completed === false) {
        Logger.ELog('Replacement failed.\n' + output + '\n' + error);
        return -1;
    }
    const match = /(?:^|\n)REPLACED (.+)/.exec(output);
    if (!match) {
        Logger.ELog('Replacement command returned no result.\n' + output);
        return -1;
    }
    const replaced = JSON.parse(match[1]);
    Flow.SetWorkingFile(replaced.destination, true);
    Variables['SafeReplace.Destination'] = replaced.destination;
    Variables['SafeReplace.Bytes'] = replaced.bytes;
    Logger.ILog('Replaced original: ' + replaced.destination + ' (' + replaced.bytes + ' bytes).');
    return 1;
}
