/**
 * @description Common utility functions for FileFlows scripts
 * @revision 1
 */

/**
 * Converts a value to an enumerable array (handling .NET generic lists/enumerables and JS arrays/values)
 * @param {any} value The value to convert
 * @param {int} maxItems Maximum items to return
 * @returns {Array} Javascript Array
 */
export function toEnumerableArray(value, maxItems) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [value];

    const limit = maxItems || 500;

    // .NET IEnumerable via GetEnumerator()
    try {
        if (typeof value.GetEnumerator === 'function') {
            const result = [];
            const enumerator = value.GetEnumerator();
            let count = 0;
            while (enumerator.MoveNext() && count < limit) {
                result.push(enumerator.Current);
                count++;
            }
            return result;
        }
    } catch (err) {}

    // .NET List<T> style (Count + indexer)
    try {
        if (typeof value.Count === 'number') {
            const result = [];
            const count = Math.min(value.Count, limit);
            for (let i = 0; i < count; i++) {
                // Jint typically supports indexer access via [i]
                result.push(value[i]);
            }
            return result;
        }
    } catch (err) {}

    return [value];
}

/**
 * Safely converts a value to a string, handling nulls and JSON objects
 * @param {any} token The value to convert
 * @returns {string} String representation
 */
export function safeString(token) {
    if (token === null || token === undefined) return '';
    if (typeof token === 'string' || typeof token === 'number' || typeof token === 'boolean') return String(token);
    try {
        const json = JSON.stringify(token);
        if (json && json !== '{}' && json !== '[]') return json;
    } catch (err) {}
    return String(token);
}

/**
 * Parses a duration string or number into seconds
 * @param {any} value Duration value (number, string, "HH:MM:SS", .NET TimeSpan)
 * @returns {number} Seconds
 */
export function parseDurationSeconds(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return isFinite(value) && value > 0 ? value : 0;

    let s = '';
    if (typeof value === 'string') {
        s = value;
    } else {
        try {
            s = String(value);
        } catch (err) {
            s = safeString(value);
        }
    }
    s = (s || '').trim();
    if (!s) return 0;

    // Strip quotes
    if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
        s = s.substring(1, s.length - 1).trim();
    }

    // Plain number
    if (/^\d+(\.\d+)?$/.test(s)) {
        const n = parseFloat(s);
        return isFinite(n) && n > 0 ? n : 0;
    }

    function toInt(v) {
        return parseInt(v, 10) || 0;
    }

    // .NET TimeSpan: "d.hh:mm:ss.fffffff"
    let m = s.match(/^(\d+)\.(\d+):(\d{2}):(\d{2})(\.\d+)?$/);
    if (m) {
        const days = toInt(m[1]);
        const hours = toInt(m[2]);
        const minutes = toInt(m[3]);
        const seconds = toInt(m[4]);
        const frac = m[5] ? parseFloat(m[5]) : 0;
        return Math.max(0, days * 86400 + hours * 3600 + minutes * 60 + seconds + (isFinite(frac) ? frac : 0));
    }

    // "hh:mm:ss"
    m = s.match(/^(\d+):(\d{2}):(\d{2})(\.\d+)?$/);
    if (m) {
        const hours = toInt(m[1]);
        const minutes = toInt(m[2]);
        const seconds = toInt(m[3]);
        const frac = m[4] ? parseFloat(m[4]) : 0;
        return Math.max(0, hours * 3600 + minutes * 60 + seconds + (isFinite(frac) ? frac : 0));
    }

    // "mm:ss"
    m = s.match(/^(\d+):(\d{2})(\.\d+)?$/);
    if (m) {
        const minutes = toInt(m[1]);
        const seconds = toInt(m[2]);
        const frac = m[3] ? parseFloat(m[3]) : 0;
        return Math.max(0, minutes * 60 + seconds + (isFinite(frac) ? frac : 0));
    }

    const n = parseFloat(s);
    return isFinite(n) && n > 0 ? n : 0;
}

/**
 * Formats seconds into HH:MM:SS
 * @param {number} seconds
 * @returns {string} HH:MM:SS
 */
export function secondsToClock(seconds) {
    const s0 = parseFloat(seconds || 0);
    if (isNaN(s0) || s0 <= 0) return '00:00:00';
    const total = Math.floor(s0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Checks if a value is "truthy" (true, 'true', 1, '1', 'yes', 'on')
 * @param {any} value
 * @returns {boolean}
 */
export function truthy(value) {
    if (value === true || value === 1) return true;
    const s = String(value || '')
        .trim()
        .toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * Clamps a number between min and max
 * @param {any} value Input value
 * @param {number} min Minimum
 * @param {number} max Maximum
 * @returns {number}
 */
export function clampNumber(value, min, max) {
    const n = parseFloat(value);
    if (isNaN(n)) return min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/**
 * Executes a command with arguments and timeout
 * @param {string} command Command to run
 * @param {Array} args Arguments list
 * @param {number} timeoutSeconds Timeout in seconds
 * @returns {Object} Result object { exitCode, standardOutput, standardError, completed }
 */
export function runProcess(command, args, timeoutSeconds) {
    try {
        return Flow.Execute({
            command: command,
            argumentList: args || [],
            timeout: timeoutSeconds || 60
        });
    } catch (err) {
        return {
            exitCode: -1,
            standardOutput: '',
            standardError: String(err),
            completed: false
        };
    }
}
