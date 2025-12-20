/**
 * @description Helpers for matching FileFlows FFmpeg Builder executor default arguments.
 * @revision 3
 * @minimumVersion 1.0.0.0
 */

function lower(s) {
    try { return String(s || '').toLowerCase(); } catch (e) { return ''; }
}

function hasArg(args, tokenLower) {
    const t = String(tokenLower || '').toLowerCase();
    if (!t) return false;
    for (let i = 0; i < (args || []).length; i++) {
        if (lower(args[i]) === t) return true;
    }
    return false;
}

/**
 * Ensures the given ffmpeg argument array includes the same default flags used by
 * `Video - FFmpeg Builder Executor (Single Filter).js` (without duplicating user-provided values).
 *
 * Defaults:
 * - `-fflags +genpts`
 * - `-probesize 300M`
 * - `-analyzeduration 240000000`
 * - `-y`
 * - `-stats_period 5`
 * - `-progress pipe:2`
 * - `-nostats`
 *
 * @param {string[]} args existing argument array
 * @returns {string[]} a new argument array with defaults prepended if missing
 */
export class FfmpegBuilderDefaults {
    /**
     * Ensures the given ffmpeg argument array includes the same default flags used by
     * `Video - FFmpeg Builder Executor (Single Filter).js` (without duplicating user-provided values).
     *
     * Defaults:
     * - `-fflags +genpts`
     * - `-probesize 300M`
     * - `-analyzeduration 240000000`
     * - `-y`
     * - `-stats_period 5`
     * - `-progress pipe:2`
     * - `-nostats`
     *
     * @param {string[]} args existing argument array
     * @returns {string[]} a new argument array with defaults prepended if missing
     */
    static ApplyFfmpegBuilderExecutorDefaults(args) {
        const input = Array.isArray(args) ? args : [];
        const out = [];

        if (!hasArg(input, '-fflags')) out.push('-fflags', '+genpts');
        if (!hasArg(input, '-probesize')) out.push('-probesize', '300M');
        if (!hasArg(input, '-analyzeduration')) out.push('-analyzeduration', '240000000');
        if (!hasArg(input, '-y')) out.push('-y');
        if (!hasArg(input, '-stats_period')) out.push('-stats_period', '5');
        if (!hasArg(input, '-progress')) out.push('-progress', 'pipe:2');
        if (!hasArg(input, '-nostats')) out.push('-nostats');

        for (let i = 0; i < input.length; i++) out.push(input[i]);
        return out;
    }
}
