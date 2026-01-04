/**
 * @name FfmpegBuilderDefaults
 * @uid 9979D52A-22E4-493A-8045-9251561CDD68
 * @description Helpers for matching FileFlows FFmpeg Builder executor default arguments.
 * @author Vincent Courcelle
 * @revision 3
 * @minimumVersion 1.0.0.0
 */

export class FfmpegBuilderDefaults {
    lower(s) {
        try {
            return String(s || '').toLowerCase();
        } catch (e) {
            return '';
        }
    }

    hasArg(args, tokenLower) {
        const t = String(tokenLower || '').toLowerCase();
        if (!t) return false;
        for (let i = 0; i < (args || []).length; i++) {
            if (this.lower(args[i]) === t) return true;
        }
        return false;
    }

    /**
     * Ensures the given ffmpeg argument array includes the same default flags used by
     * `Video - FFmpeg Builder Executor (Single Filter).js` (without duplicating user-provided values).
     *
     * Defaults:
     * - `-fflags +genpts`
     * - `-probesize 500M`
     * - `-analyzeduration 240000000`
     * - `-y`
     * - `-stats_period 5`
     * - `-progress pipe:2`
     * - `-nostats`
     *
     * @param {string[]} args existing argument array
     * @returns {string[]} a new argument array with defaults prepended if missing
     */
    ApplyFfmpegBuilderExecutorDefaults(args) {
        const input = Array.isArray(args) ? args : [];
        const out = [];

        if (!this.hasArg(input, '-fflags')) out.push('-fflags', '+genpts');
        if (!this.hasArg(input, '-probesize')) out.push('-probesize', '500M');
        if (!this.hasArg(input, '-analyzeduration')) out.push('-analyzeduration', '240000000');
        if (!this.hasArg(input, '-y')) out.push('-y');
        if (!this.hasArg(input, '-stats_period')) out.push('-stats_period', '5');
        if (!this.hasArg(input, '-progress')) out.push('-progress', 'pipe:2');
        if (!this.hasArg(input, '-nostats')) out.push('-nostats');

        for (let i = 0; i < input.length; i++) out.push(input[i]);
        return out;
    }
}
