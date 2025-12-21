/**
 * @name ScriptHelpers
 * @uid F17EAED8-5E6F-43A8-88A5-416A2BEB7482
 * @description Common utility functions for FileFlows scripts
 * @author Vincent Courcelle
 * @revision 1
 * @minimumVersion 1.0.0.0
 */

export class ScriptHelpers {
    /**
     * Converts a value to an enumerable array (handling .NET generic lists/enumerables and JS arrays/values)
     * @param {any} value The value to convert
     * @param {int} maxItems Maximum items to return
     * @returns {Array} Javascript Array
     */
    toEnumerableArray(value, maxItems) {
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
    safeString(token) {
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
    parseDurationSeconds(value) {
        if (value === null || value === undefined) return 0;
        if (typeof value === 'number') return isFinite(value) && value > 0 ? value : 0;

        let s = '';
        if (typeof value === 'string') {
            s = value;
        } else {
            try {
                s = String(value);
            } catch (err) {
                s = this.safeString(value);
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
    secondsToClock(seconds) {
        const s0 = parseFloat(seconds || 0);
        if (isNaN(s0) || s0 <= 0) return '00:00:00';
        const total = Math.floor(s0);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = Math.floor(total % 60);

        var pad = function (n) {
            return n < 10 ? '0' + n : '' + n;
        };
        return pad(h) + ':' + pad(m) + ':' + pad(s);
    }

    /**
     * Checks if a value is "truthy" (true, 'true', 1, '1', 'yes', 'on')
     * @param {any} value
     * @returns {boolean}
     */
    truthy(value) {
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
    clampNumber(value, min, max) {
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
    runProcess(command, args, timeoutSeconds) {
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

    /**
     * Gets the resolution category of a video
     * @param {number} width
     * @param {number} height
     * @returns {string} '4K', '1080p', '720p', 'SD'
     */
    getResolution(width, height) {
        if (!width || !height) return 'SD';
        if (width >= 2500 || height >= 2000) return '4K';
        if (width >= 1700 || height >= 1000) return '1080p';
        if (width >= 1000 || height >= 700) return '720p';
        return 'SD';
    }

    /**
     * Converts bytes to Gigabytes
     * @param {number} bytes
     * @returns {number} GB
     */
    bytesToGb(bytes) {
        return Math.round(((bytes || 0) / 1024 / 1024 / 1024) * 100) / 100;
    }

    /**
     * Calculates MiB per hour
     * @param {number} fileSize bytes
     * @param {number} duration seconds
     * @returns {number} MiB/hour
     */
    calculateMiBPerHour(fileSize, duration) {
        if (!duration) return 0;
        return ((fileSize / duration) * 3600) / 1024 / 1024;
    }

    /**
     * Normalizes a language code to ISO 639-2/B (3-letter)
     * @param {string} lang
     * @returns {string} 3-letter code
     */
    normalizeToIso2(lang) {
        if (!lang) return '';
        const normalized = LanguageHelper.GetIso2Code(lang);
        return (normalized || lang).toLowerCase();
    }

    /**
     * Checks if two language codes match
     * @param {string} lang1
     * @param {string} lang2
     * @returns {boolean}
     */
    languagesMatch(lang1, lang2) {
        if (!lang1 || !lang2) return false;
        try {
            return LanguageHelper.AreSame(lang1, lang2) === true;
        } catch (err) {
            const iso2_1 = this.normalizeToIso2(lang1);
            const iso2_2 = this.normalizeToIso2(lang2);
            return iso2_1 === iso2_2;
        }
    }

    /**
     * Joins a list of tokens into a single string
     * @param {any} value
     * @returns {string}
     */
    asJoinedString(value) {
        if (!value) return '';
        const tokens = this.toEnumerableArray(value, 1000)
            .map((x) => this.safeString(x))
            .filter((x) => x);
        return tokens.join(' ');
    }

    /**
     * Adds an item to a list (JS array or .NET List)
     * @param {any} list
     * @param {any} item
     * @returns {boolean} Success
     */
    listAdd(list, item) {
        if (!list) return false;
        if (Array.isArray(list)) {
            list.push(item);
            return true;
        }
        try {
            if (typeof list.Add === 'function') {
                list.Add(item);
                return true;
            }
        } catch (err) {}
        return false;
    }

    /**
     * Adds an item to a list only if it doesn't already exist
     * @param {any} list
     * @param {any} item
     * @returns {boolean} Success
     */
    listAddUnique(list, item) {
        if (!list) return false;
        try {
            const existing = this.toEnumerableArray(list, 2000).map((x) => this.safeString(x));
            if (existing.indexOf(this.safeString(item)) >= 0) return true;
        } catch (err) {}
        return this.listAdd(list, item);
    }

    /**
     * Gets the count of items in a list
     * @param {any} list
     * @returns {number|null} Count or null if not a list
     */
    listCount(list) {
        if (!list) return null;
        if (Array.isArray(list)) return list.length;
        try {
            if (typeof list.Count === 'number') return list.Count;
        } catch (err) {}
        return null;
    }

    /**
     * Removes an item at a specific index from a list
     * @param {any} list
     * @param {number} index
     * @returns {boolean} Success
     */
    listRemoveAt(list, index) {
        if (!list) return false;
        try {
            if (Array.isArray(list)) {
                list.splice(index, 1);
                return true;
            }
        } catch (err) {}
        try {
            if (typeof list.RemoveAt === 'function') {
                list.RemoveAt(index);
                return true;
            }
        } catch (err) {}
        return false;
    }

    /**
     * Tries to reorder a .NET list or JS array
     * @param {any} list
     * @param {Array} orderedItems
     * @returns {boolean} Success
     */
    listReorder(list, orderedItems) {
        if (!list || !orderedItems) return false;
        try {
            if (Array.isArray(list)) {
                list.length = 0;
                for (let i = 0; i < orderedItems.length; i++) list.push(orderedItems[i]);
                return true;
            }
            if (typeof list.Clear === 'function' && typeof list.Add === 'function') {
                list.Clear();
                for (let i = 0; i < orderedItems.length; i++) list.Add(orderedItems[i]);
                return true;
            }
        } catch (err) {
            Logger.WLog(`Failed to reorder list: ${err}`);
        }
        return false;
    }

    /**
     * Checks if a list contains an argument matching a predicate

     * @param {any} list
     * @param {Function} predicate (token, index) => bool
     * @returns {boolean}
     */
    hasArg(list, predicate) {
        const count = this.listCount(list);
        if (count === null) return false;
        for (let i = 0; i < count; i++) {
            const t = String(this.safeString(list[i]) || '').trim();
            if (predicate(t, i)) return true;
        }
        return false;
    }

    /**
     * Ensures a flag and its value are present in an argument list
     * @param {any} list
     * @param {string} flag
     * @param {string} value
     * @param {Function} predicate Optional predicate to find the flag
     * @returns {boolean} True if added
     */
    ensureArgWithValue(list, flag, value, predicate) {
        if (this.listCount(list) === null) return false;
        const pred = predicate || ((t) => t === flag);
        if (this.hasArg(list, pred)) return false;
        this.listAdd(list, flag);
        this.listAdd(list, value);
        return true;
    }

    /**
     * Removes all instances of a flag and its subsequent value from a list
     * @param {any} list
     * @param {Function} predicate (token, index) => bool
     * @returns {Object} { removed: bool, removedCount: number }
     */
    removeArgWithValue(list, predicate) {
        const count0 = this.listCount(list);
        if (count0 === null) return { removed: false, removedCount: 0 };
        let removedCount = 0;
        let i = 0;
        while (i < this.listCount(list)) {
            const t = String(this.safeString(list[i]) || '').trim();
            if (!predicate(t, i)) {
                i++;
                continue;
            }
            if (i < this.listCount(list) - 1) {
                if (this.listRemoveAt(list, i + 1)) removedCount++;
            }
            if (this.listRemoveAt(list, i)) removedCount++;
            continue;
        }
        return { removed: removedCount > 0, removedCount };
    }

    /**
     * Extracts a year (1900-2099) from a filename pattern like .YYYY.
     * @param {string} filePath
     * @returns {number|null} Year
     */
    extractYearFromFilename(filePath) {
        if (!filePath) return null;
        const filename = String(filePath).split('/').pop().split('\\').pop();
        if (!filename) return null;

        const match = filename.match(/\.(19\d{2}|20\d{2})\./);
        if (match) {
            const year = parseInt(match[1], 10);
            const currentYear = new Date().getFullYear();
            if (year >= 1900 && year <= currentYear + 1) {
                return year;
            }
        }
        return null;
    }

    /**
     * Detects hardware encoder type from video stream parameters
     * @param {Object} videoStream
     * @returns {string|null} 'qsv', 'vaapi', 'nvenc', 'amf' or null
     */
    detectHardwareEncoder(videoStream) {
        const signature = [
            this.asJoinedString(videoStream.EncodingParameters),
            this.asJoinedString(videoStream.AdditionalParameters),
            this.asJoinedString(videoStream.Codec)
        ]
            .join(' ')
            .toLowerCase();

        if (signature.indexOf('_qsv') >= 0 || signature.indexOf(' qsv') >= 0) return 'qsv';
        if (signature.indexOf('_vaapi') >= 0 || signature.indexOf(' vaapi') >= 0) return 'vaapi';
        if (signature.indexOf('_nvenc') >= 0 || signature.indexOf(' nvenc') >= 0) return 'nvenc';
        if (signature.indexOf('_amf') >= 0 || signature.indexOf(' amf') >= 0) return 'amf';
        return null;
    }

    /**
     * Detects target output bit depth (8 or 10) from stream parameters
     * @param {Object} videoStream
     * @returns {number} 8 or 10
     */
    detectTargetBitDepth(videoStream) {
        const signature = [
            this.asJoinedString(videoStream.EncodingParameters),
            this.asJoinedString(videoStream.AdditionalParameters),
            this.asJoinedString(videoStream.Filters),
            this.asJoinedString(videoStream.OptionalFilter),
            this.asJoinedString(videoStream.Filter),
            this.safeString(videoStream.Codec)
        ]
            .join(' ')
            .toLowerCase();

        if (
            signature.indexOf('p010') >= 0 ||
            signature.indexOf('format=p010le') >= 0 ||
            signature.indexOf('main10') >= 0 ||
            signature.indexOf('10bit') >= 0 ||
            signature.indexOf('10-bit') >= 0 ||
            signature.indexOf('yuv420p10') >= 0
        ) {
            return 10;
        }
        return 8;
    }

    /**
     * Gets the most reliable video information available from global variables
     * @returns {Object} { width, height, duration }
     */
    getVideoMetadata() {
        const videoVar = Variables.video || {};
        const viVar = Variables.vi || {};
        const ffmpegModel = Variables.FfmpegBuilderModel || {};
        const videoInfo = viVar.VideoInfo || ffmpegModel.VideoInfo || {};
        const videoStreams = this.toEnumerableArray(videoInfo.VideoStreams, 10);
        const vs0 = videoStreams.length > 0 ? videoStreams[0] : {};

        const width = parseInt(videoVar.Width || vs0.Width || 0);
        const height = parseInt(videoVar.Height || vs0.Height || 0);

        let duration = videoVar.Duration || viVar.Duration || videoInfo.Duration || vs0.Duration || 0;
        if (duration && typeof duration !== 'number') {
            duration = this.parseDurationSeconds(duration);
        }

        return {
            width: width > 0 ? width : 0,
            height: height > 0 ? height : 0,
            duration: duration > 0 ? parseFloat(duration) : 0
        };
    }
}
