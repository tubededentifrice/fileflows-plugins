/**
 * @name FfmpegHelpers
 * @uid 8A3F2E91-4B7C-49D8-B5E6-1C9D3A8F7E2B
 * @description FFmpeg filter manipulation, codec detection, and command-line utilities
 * @author Vincent Courcelle
 * @revision 1
 * @minimumVersion 24.0.0.0
 */

export class FfmpegHelpers {
    constructor() {
        // No class fields - Jint compatibility
    }

    /**
     * Split a command line string into tokens, respecting quotes and escapes
     * @param {string} s - Command line string
     * @returns {string[]} Array of tokens
     */
    splitCommandLine(s) {
        var input = String(s || '');
        var out = [];
        var cur = '';
        var inQuotes = false;
        var escape = false;
        for (var i = 0; i < input.length; i++) {
            var ch = input[i];
            if (escape) {
                cur += ch;
                escape = false;
                continue;
            }
            if (ch === '\\') {
                escape = true;
                continue;
            }
            if (ch === '"') {
                inQuotes = !inQuotes;
                continue;
            }
            if (!inQuotes && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) {
                if (cur.length) {
                    out.push(cur);
                    cur = '';
                }
                continue;
            }
            cur += ch;
        }
        if (cur.length) out.push(cur);
        return out;
    }

    /**
     * Flatten a token list, expanding any embedded command lines
     * @param {any} value - Array or enumerable of tokens
     * @param {function} toEnumerableArray - Helper to convert .NET lists to arrays
     * @param {function} safeString - Helper to safely convert to string
     * @returns {string[]} Flattened array of tokens
     */
    flattenTokenList(value, toEnumerableArray, safeString) {
        var self = this;
        var items = toEnumerableArray(value, 5000)
            .map(safeString)
            .map(function (x) {
                return String(x || '').trim();
            })
            .filter(function (x) {
                return x;
            });
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.indexOf(' ') >= 0 || item.indexOf('\t') >= 0) {
                var split = self.splitCommandLine(item);
                for (var j = 0; j < split.length; j++) out.push(split[j]);
            } else {
                out.push(item);
            }
        }
        return out;
    }

    /**
     * Flatten filter expressions, splitting comma-separated filters
     * @param {string[]} filters - Array of filter expressions
     * @returns {string[]} Flattened array of individual filters
     */
    flattenFilterExpressions(filters) {
        var parts = [];
        for (var i = 0; i < (filters || []).length; i++) {
            var f = String(filters[i] || '').trim();
            if (!f) continue;
            var split = this.splitFilterChain(f);
            for (var j = 0; j < split.length; j++) parts.push(split[j]);
        }
        return parts;
    }

    /**
     * Split a filter chain string by commas, respecting escapes
     * @param {string} chain - Filter chain string
     * @returns {string[]} Array of individual filters
     */
    splitFilterChain(chain) {
        var s = String(chain || '');
        var parts = [];
        var cur = '';
        var escaped = false;
        for (var i = 0; i < s.length; i++) {
            var ch = s[i];
            if (escaped) {
                cur += ch;
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                cur += ch;
                escaped = true;
                continue;
            }
            if (ch === ',') {
                var t = cur.trim();
                if (t) parts.push(t);
                cur = '';
                continue;
            }
            cur += ch;
        }
        var tail = cur.trim();
        if (tail) parts.push(tail);
        return parts;
    }

    /**
     * Deduplicate array items while preserving order
     * @param {string[]} items - Array of items
     * @returns {string[]} Deduplicated array
     */
    dedupePreserveOrder(items) {
        var seen = {};
        var out = [];
        for (var i = 0; i < (items || []).length; i++) {
            var v = String(items[i] || '').trim();
            if (!v) continue;
            if (seen[v]) continue;
            seen[v] = true;
            out.push(v);
        }
        return out;
    }

    /**
     * Merge multiple filter expressions into a single comma-separated chain
     * @param {string[]} filterExpressions - Array of filter expressions
     * @returns {string} Merged filter chain
     */
    mergeFilters(filterExpressions) {
        var flat = [];
        for (var i = 0; i < (filterExpressions || []).length; i++) {
            var f = String(filterExpressions[i] || '').trim();
            if (!f) continue;
            var parts = this.splitFilterChain(f);
            for (var j = 0; j < parts.length; j++) flat.push(parts[j]);
        }

        // Remove redundant scale_qsv=format=p010le if already present elsewhere
        var lowered = flat.map(function (x) {
            return x.toLowerCase();
        });
        var hasP010 = lowered.some(function (x) {
            return x.indexOf('format=p010le') >= 0 || x.indexOf('p010le') >= 0;
        });
        if (hasP010) {
            for (var k = flat.length - 1; k >= 0; k--) {
                var seg = lowered[k];
                if (seg === 'scale_qsv=format=p010le') {
                    flat.splice(k, 1);
                    lowered.splice(k, 1);
                }
            }
        }

        return this.dedupePreserveOrder(flat).join(',');
    }

    /**
     * Merge two vpp_qsv filter expressions, combining their options
     * @param {string} existing - Existing vpp_qsv filter
     * @param {string} desired - New vpp_qsv filter to merge
     * @returns {string} Merged vpp_qsv filter
     */
    mergeVppQsv(existing, desired) {
        var parse = function (s) {
            var result = { name: '', items: [], map: {} };
            if (!s) return result;
            var t = String(s).trim();
            var eq = t.indexOf('=');
            if (eq < 0) {
                result.name = t;
                return result;
            }
            result.name = t.substring(0, eq);
            var opts = t
                .substring(eq + 1)
                .split(':')
                .map(function (x) {
                    return x.trim();
                })
                .filter(function (x) {
                    return x;
                });
            for (var i = 0; i < opts.length; i++) {
                var o = opts[i];
                var p = o.indexOf('=');
                if (p > 0) {
                    var k = o.substring(0, p);
                    var v = o.substring(p + 1);
                    result.items.push({ k: k, v: v });
                    result.map[k] = v;
                } else {
                    result.items.push({ k: o, v: null });
                    result.map[o] = null;
                }
            }
            return result;
        };

        var a = parse(existing);
        var b = parse(desired);
        if (a.name !== 'vpp_qsv' || b.name !== 'vpp_qsv') return desired || existing;

        var merged = [];
        var seen = {};

        // Keep existing order, override values when desired provides them
        for (var i = 0; i < a.items.length; i++) {
            var it = a.items[i];
            var key = it.k;
            if (key in b.map) {
                merged.push(key + (b.map[key] !== null ? '=' + b.map[key] : ''));
                seen[key] = true;
            } else {
                merged.push(key + (it.v !== null ? '=' + it.v : ''));
                seen[key] = true;
            }
        }

        // Append desired-only keys
        for (var j = 0; j < b.items.length; j++) {
            var item = b.items[j];
            if (seen[item.k]) continue;
            merged.push(item.k + (item.v !== null ? '=' + item.v : ''));
        }

        return 'vpp_qsv=' + merged.join(':');
    }

    /**
     * Extract and strip filter arguments from token list
     * @param {string[]} tokens - Array of ffmpeg argument tokens
     * @param {string} typeChar - 'v' for video, 'a' for audio
     * @returns {{tokens: string[], filters: string[]}} Stripped tokens and extracted filters
     */
    extractAndStripFilterArgs(tokens, typeChar) {
        var out = [];
        var filters = [];
        for (var i = 0; i < (tokens || []).length; i++) {
            var t = String(tokens[i] || '').trim();
            var lower = t.toLowerCase();
            var tc = String(typeChar || 'v').toLowerCase();
            var isVideo = tc === 'v';
            var isAudio = tc === 'a';
            var isFilterFlag =
                (isVideo && (lower === '-vf' || lower === '-filter:v' || lower.indexOf('-filter:v:') === 0)) ||
                (isAudio && (lower === '-af' || lower === '-filter:a' || lower.indexOf('-filter:a:') === 0));
            if (!isFilterFlag) {
                out.push(t);
                continue;
            }
            var val = i + 1 < tokens.length ? String(tokens[i + 1] || '').trim() : '';
            if (val) filters.push(val);
            i++; // skip value token
        }
        return { tokens: out, filters: filters };
    }

    /**
     * Extract codec from ffmpeg arguments
     * @param {string[]} tokens - Array of ffmpeg argument tokens
     * @returns {string} Detected codec or empty string
     */
    extractCodecFromArgs(tokens) {
        for (var i = 0; i < (tokens || []).length - 1; i++) {
            var t = String(tokens[i] || '')
                .trim()
                .toLowerCase();
            if (t === '-c' || t.indexOf('-c:') === 0) {
                var codec = String(tokens[i + 1] || '').trim();
                if (codec) return codec;
            }
        }
        return '';
    }

    /**
     * Strip codec arguments from token list
     * @param {string[]} tokens - Array of ffmpeg argument tokens
     * @returns {string[]} Tokens with codec args removed
     */
    stripCodecArgs(tokens) {
        var out = [];
        for (var i = 0; i < (tokens || []).length; i++) {
            var t = String(tokens[i] || '').trim();
            if (!t) continue;
            var lower = t.toLowerCase();
            if (lower === '-c' || lower.indexOf('-c:') === 0) {
                i++;
                continue;
            }
            out.push(t);
        }
        return out;
    }

    /**
     * Rewrite stream index tokens to use a new index
     * @param {string[]} tokens - Array of ffmpeg argument tokens
     * @param {string} typeChar - 'v' for video, 'a' for audio
     * @param {number} outIndex - New stream index
     * @returns {string[]} Tokens with rewritten indices
     */
    rewriteStreamIndexTokens(tokens, typeChar, outIndex) {
        var out = [];
        var re = new RegExp('(:' + typeChar + ':)(\\d+)$', 'i');
        for (var i = 0; i < (tokens || []).length; i++) {
            var t = String(tokens[i] || '').trim();
            var m = t.match(re);
            if (m) out.push(t.replace(re, '$1' + String(outIndex)));
            else out.push(t);
        }
        return out;
    }

    /**
     * Detect target codec from video stream encoding parameters
     * @param {object} videoStream - FFmpeg Builder video stream object
     * @returns {string} Detected codec name
     */
    getTargetCodec(videoStream) {
        var params = [];
        try {
            if (videoStream.EncodingParameters) {
                var ep = videoStream.EncodingParameters;
                if (typeof ep.GetEnumerator === 'function') {
                    var enumerator = ep.GetEnumerator();
                    while (enumerator.MoveNext()) {
                        params.push(String(enumerator.Current));
                    }
                } else if (ep.length) {
                    for (var i = 0; i < ep.length; i++) params.push(String(ep[i]));
                }
            }
        } catch (e) {}

        var signature = params.join(' ').toLowerCase();

        // Check for specific encoders
        if (signature.indexOf('hevc_qsv') >= 0 || signature.indexOf('h265_qsv') >= 0) return 'hevc_qsv';
        if (signature.indexOf('hevc_nvenc') >= 0) return 'hevc_nvenc';
        if (signature.indexOf('hevc_vaapi') >= 0) return 'hevc_vaapi';
        if (signature.indexOf('hevc_amf') >= 0) return 'hevc_amf';
        if (signature.indexOf('libx265') >= 0) return 'libx265';
        if (signature.indexOf('h264_qsv') >= 0) return 'h264_qsv';
        if (signature.indexOf('h264_nvenc') >= 0) return 'h264_nvenc';
        if (signature.indexOf('h264_vaapi') >= 0) return 'h264_vaapi';
        if (signature.indexOf('libx264') >= 0) return 'libx264';
        if (
            signature.indexOf('libsvtav1') >= 0 ||
            signature.indexOf('av1_qsv') >= 0 ||
            signature.indexOf('av1_nvenc') >= 0
        ) {
            if (signature.indexOf('av1_qsv') >= 0) return 'av1_qsv';
            if (signature.indexOf('av1_nvenc') >= 0) return 'av1_nvenc';
            return 'libsvtav1';
        }

        // Try Codec property
        var codec = String(videoStream.Codec || '').toLowerCase();
        if (codec.indexOf('hevc') >= 0 || codec.indexOf('h265') >= 0 || codec.indexOf('x265') >= 0) return 'libx265';
        if (codec.indexOf('h264') >= 0 || codec.indexOf('x264') >= 0 || codec.indexOf('avc') >= 0) return 'libx264';
        if (codec.indexOf('av1') >= 0) return 'libsvtav1';

        return 'libx265';
    }

    /**
     * Get the CRF/quality argument for a given codec
     * @param {string} codec - Codec name
     * @returns {string} Quality argument (-crf, -global_quality:v, etc.)
     */
    getCRFArgument(codec) {
        var c = String(codec || '').toLowerCase();
        if (c.indexOf('_vaapi') >= 0) return '-qp';
        if (c.indexOf('_nvenc') >= 0) return '-cq';
        if (c.indexOf('_qsv') >= 0) return '-global_quality:v';
        if (c.indexOf('_amf') >= 0) return '-qp_i';
        return '-crf';
    }

    /**
     * Check if a filter flag matches video or audio type
     * @param {string} flag - The flag to check
     * @param {string} typeChar - 'v' or 'a'
     * @returns {boolean} True if matches
     */
    isFilterFlag(flag, typeChar) {
        var lower = String(flag || '').toLowerCase();
        var tc = String(typeChar || 'v').toLowerCase();
        if (tc === 'v') {
            return lower === '-vf' || lower === '-filter:v' || lower.indexOf('-filter:v:') === 0;
        }
        if (tc === 'a') {
            return lower === '-af' || lower === '-filter:a' || lower.indexOf('-filter:a:') === 0;
        }
        return false;
    }
}
