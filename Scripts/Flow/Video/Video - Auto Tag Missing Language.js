/**
 * @description Detect missing audio track languages (empty/und) and tag them using heuristics + offline models (SpeechBrain LID, with whisper.cpp fallback).
 * @help Run after a "Video File" node so `vi.VideoInfo` is available. For MKV outputs, `mkvpropedit` is used for instant in-place tagging; otherwise an ffmpeg stream-copy remux is done.
 * @author Vincent Courcelle
 * @revision 10
 * @minimumVersion 24.0.0.0
 * @param {bool} DryRun Log what would change, but do not modify the file. Default: false
 * @param {bool} UseHeuristics Infer language from track title / filename tags (e.g. "English", "[jpn]"). Default: true
 * @param {bool} UseSpeechBrain Use offline CPU SpeechBrain language-id classifier (`fflangid-sb`). Default: true
 * @param {int} SpeechBrainMinConfidence Minimum confidence (0-100) required to accept SpeechBrain result. Default: 75
 * @param {bool} UseWhisperFallback If SpeechBrain is unavailable/low-confidence, fall back to whisper.cpp language detection (`fflangid-whisper`). Default: true
 * @param {int} SampleStartSeconds Start time for the audio sample (0 = auto). Default: 0
 * @param {int} SampleDurationSeconds Duration of the audio sample in seconds. Default: 25
 * @param {bool} PreferMkvPropEdit For MKV, prefer mkvpropedit over remuxing. Default: true
 * @param {bool} ForceRetag Force detection/tagging even if tracks already have a language tag. Can be overridden by `Variables['AudioLangID.ForceRetag']`. Default: false
 * @output Tagged languages
 * @output No changes needed
 * @output Error
 */
function Script(DryRun, UseHeuristics, UseSpeechBrain, SpeechBrainMinConfidence, UseWhisperFallback, SampleStartSeconds, SampleDurationSeconds, PreferMkvPropEdit, ForceRetag) {
    Logger.ILog('Audio - Auto tag missing language.js revision 10 loaded');

    function toEnumerableArray(value, maxItems) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [value];

        const limit = maxItems || 500;
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
        } catch (err) { }

        try {
            if (typeof value.Count === 'number') {
                const result = [];
                const count = Math.min(value.Count, limit);
                for (let i = 0; i < count; i++) result.push(value[i]);
                return result;
            }
        } catch (err) { }

        return [value];
    }

    function safeString(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
        try {
            const json = JSON.stringify(value);
            if (json && json !== '{}') return json;
        } catch (err) { }
        return String(value);
    }

    function toInt(value, fallback) {
        const n = parseInt(value, 10);
        return isNaN(n) ? fallback : n;
    }

    function parseDurationSeconds(value) {
        if (value === null || value === undefined) return 0;
        if (typeof value === 'number') return (isFinite(value) && value > 0) ? value : 0;

        let s = '';
        if (typeof value === 'string') {
            s = value;
        } else {
            // Important: for .NET types (eg TimeSpan), prefer .ToString() over JSON.stringify,
            // otherwise we may lose the textual time representation and end up with "{}".
            try { s = String(value); } catch (err) { s = safeString(value); }
        }
        s = (s || '').trim();
        if (!s) return 0;

        // Strip accidental JSON string quotes, e.g. "\"01:23:45\"" -> "01:23:45"
        if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
            s = s.substring(1, s.length - 1).trim();
        }

        // Plain number string (seconds)
        if (/^\d+(\.\d+)?$/.test(s)) {
            const n = parseFloat(s);
            return (isFinite(n) && n > 0) ? n : 0;
        }

        // .NET TimeSpan ToString can be: "d.hh:mm:ss.fffffff" or "hh:mm:ss.fffffff" or "mm:ss.fffffff"
        let m = s.match(/^(\d+)\.(\d+):(\d{2}):(\d{2})(\.\d+)?$/);
        if (m) {
            const days = toInt(m[1], 0);
            const hours = toInt(m[2], 0);
            const minutes = toInt(m[3], 0);
            const seconds = toInt(m[4], 0);
            const frac = m[5] ? parseFloat(m[5]) : 0;
            return Math.max(0, (days * 86400) + (hours * 3600) + (minutes * 60) + seconds + (isFinite(frac) ? frac : 0));
        }

        m = s.match(/^(\d+):(\d{2}):(\d{2})(\.\d+)?$/);
        if (m) {
            const hours = toInt(m[1], 0);
            const minutes = toInt(m[2], 0);
            const seconds = toInt(m[3], 0);
            const frac = m[4] ? parseFloat(m[4]) : 0;
            return Math.max(0, (hours * 3600) + (minutes * 60) + seconds + (isFinite(frac) ? frac : 0));
        }

        m = s.match(/^(\d+):(\d{2})(\.\d+)?$/);
        if (m) {
            const minutes = toInt(m[1], 0);
            const seconds = toInt(m[2], 0);
            const frac = m[3] ? parseFloat(m[3]) : 0;
            return Math.max(0, (minutes * 60) + seconds + (isFinite(frac) ? frac : 0));
        }

        // Last resort: parseFloat (handles "123.4ms" poorly, but avoids returning 1 for "01:23:45").
        const n = parseFloat(s);
        return (isFinite(n) && n > 0) ? n : 0;
    }

    function parseBool(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'boolean') return value;
        const s = safeString(value).trim().toLowerCase();
        if (!s) return null;
        if (s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on') return true;
        if (s === '0' || s === 'false' || s === 'no' || s === 'n' || s === 'off') return false;
        return null;
    }

    function clampInt(value, minValue, maxValue) {
        if (value < minValue) return minValue;
        if (value > maxValue) return maxValue;
        return value;
    }

    function normalizeLangToIso6392b(codeOrName) {
        const raw = safeString(codeOrName).trim().toLowerCase();
        if (!raw) return '';
        if (raw === 'und' || raw === 'unknown' || raw === 'none' || raw === 'n/a') return '';

        // Prefer ISO-639-2/B for container tagging (Matroska uses ISO-639-2).
        const map = {
            // English
            'en': 'eng', 'eng': 'eng', 'english': 'eng',
            // French
            'fr': 'fre', 'fra': 'fre', 'fre': 'fre', 'french': 'fre',
            // German
            'de': 'ger', 'deu': 'ger', 'ger': 'ger', 'german': 'ger',
            // Spanish
            'es': 'spa', 'spa': 'spa', 'spanish': 'spa',
            // Italian
            'it': 'ita', 'ita': 'ita', 'italian': 'ita',
            // Portuguese
            'pt': 'por', 'por': 'por', 'portuguese': 'por',
            // Dutch
            'nl': 'dut', 'nld': 'dut', 'dut': 'dut', 'dutch': 'dut',
            // Swedish / Norwegian / Danish / Finnish
            'sv': 'swe', 'swe': 'swe', 'swedish': 'swe',
            'no': 'nor', 'nor': 'nor', 'norwegian': 'nor', 'nb': 'nor', 'nob': 'nor', 'nn': 'nor', 'nno': 'nor',
            'da': 'dan', 'dan': 'dan', 'danish': 'dan',
            'fi': 'fin', 'fin': 'fin', 'finnish': 'fin',
            // Slavic (common)
            'ru': 'rus', 'rus': 'rus', 'russian': 'rus',
            'uk': 'ukr', 'ukr': 'ukr', 'ukrainian': 'ukr',
            'pl': 'pol', 'pol': 'pol', 'polish': 'pol',
            'cs': 'cze', 'ces': 'cze', 'cze': 'cze', 'czech': 'cze',
            'sk': 'slo', 'slk': 'slo', 'slo': 'slo', 'slovak': 'slo',
            'bg': 'bul', 'bul': 'bul', 'bulgarian': 'bul',
            'sr': 'srp', 'srp': 'srp', 'serbian': 'srp',
            'hr': 'hrv', 'hrv': 'hrv', 'croatian': 'hrv',
            'sl': 'slv', 'slv': 'slv', 'slovenian': 'slv',
            // East Asian
            'ja': 'jpn', 'jpn': 'jpn', 'japanese': 'jpn',
            'ko': 'kor', 'kor': 'kor', 'korean': 'kor',
            'zh': 'chi', 'zho': 'chi', 'chi': 'chi', 'chinese': 'chi', 'mandarin': 'chi',
            // Middle East / South Asia
            'ar': 'ara', 'ara': 'ara', 'arabic': 'ara',
            'he': 'heb', 'iw': 'heb', 'heb': 'heb', 'hebrew': 'heb',
            'fa': 'per', 'fas': 'per', 'per': 'per', 'persian': 'per',
            'hi': 'hin', 'hin': 'hin', 'hindi': 'hin',
            // SE Asia
            'th': 'tha', 'tha': 'tha', 'thai': 'tha',
            'vi': 'vie', 'vie': 'vie', 'vietnamese': 'vie',
            'id': 'ind', 'ind': 'ind', 'indonesian': 'ind',
            'ms': 'may', 'msa': 'may', 'may': 'may', 'malay': 'may',
            // Other common
            'el': 'gre', 'ell': 'gre', 'gre': 'gre', 'greek': 'gre',
            'tr': 'tur', 'tur': 'tur', 'turkish': 'tur',
            'hu': 'hun', 'hun': 'hun', 'hungarian': 'hun',
            'et': 'est', 'est': 'est', 'estonian': 'est',
            'lv': 'lav', 'lav': 'lav', 'latvian': 'lav',
            'lt': 'lit', 'lit': 'lit', 'lithuanian': 'lit',
            'ro': 'rum', 'ron': 'rum', 'rum': 'rum', 'romanian': 'rum'
        };

        if (map[raw]) return map[raw];

        // If it's already a 3-letter code (including ISO-639-3), keep it as-is.
        if (/^[a-z]{3}$/.test(raw)) return raw;

        return '';
    }

    function guessLanguageFromText(text) {
        const s = safeString(text).toLowerCase();
        if (!s) return '';

        // Keep patterns conservative to avoid false positives (e.g., "encoder" matching "en").
        const candidates = [
            { iso: 'eng', re: /(^|[^a-z])(eng|english)([^a-z]|$)/i },
            { iso: 'fre', re: /(^|[^a-z])(fre|fra|french)([^a-z]|$)/i },
            { iso: 'ger', re: /(^|[^a-z])(ger|deu|german)([^a-z]|$)/i },
            { iso: 'spa', re: /(^|[^a-z])(spa|spanish|español)([^a-z]|$)/i },
            { iso: 'ita', re: /(^|[^a-z])(ita|italian)([^a-z]|$)/i },
            { iso: 'por', re: /(^|[^a-z])(por|portuguese)([^a-z]|$)/i },
            { iso: 'dut', re: /(^|[^a-z])(dut|nld|dutch)([^a-z]|$)/i },
            { iso: 'rus', re: /(^|[^a-z])(rus|russian)([^a-z]|$)/i },
            { iso: 'jpn', re: /(^|[^a-z])(jpn|japanese)([^a-z]|$)/i },
            { iso: 'kor', re: /(^|[^a-z])(kor|korean)([^a-z]|$)/i },
            { iso: 'chi', re: /(^|[^a-z])(chi|zho|chinese|mandarin)([^a-z]|$)/i },
            { iso: 'ara', re: /(^|[^a-z])(ara|arabic)([^a-z]|$)/i },
            { iso: 'heb', re: /(^|[^a-z])(heb|hebrew)([^a-z]|$)/i },
            { iso: 'hin', re: /(^|[^a-z])(hin|hindi)([^a-z]|$)/i },
            { iso: 'tha', re: /(^|[^a-z])(tha|thai)([^a-z]|$)/i },
            { iso: 'vie', re: /(^|[^a-z])(vie|vietnamese)([^a-z]|$)/i },
            { iso: 'ind', re: /(^|[^a-z])(ind|indonesian)([^a-z]|$)/i }
        ];

        for (const c of candidates) {
            if (c.re.test(s)) return c.iso;
        }
        return '';
    }

    function runProcess(command, args, timeoutSeconds) {
        try {
            return Flow.Execute({ command: command, argumentList: args || [], timeout: timeoutSeconds || 60 });
        } catch (err) {
            return { exitCode: -1, standardOutput: '', standardError: safeString(err), completed: false };
        }
    }

    function toolWorks(command, versionArgs) {
        const proc = runProcess(command, versionArgs || ['--version'], 15);
        return (proc && proc.exitCode === 0);
    }

    function tryParseJson(text) {
        const s = safeString(text).trim();
        if (!s) return null;
        try { return JSON.parse(s); } catch (err) { }
        // Some wrappers might log extra lines; try last line.
        try {
            const lines = s.split('\n').map(x => x.trim()).filter(x => x);
            if (!lines.length) return null;
            return JSON.parse(lines[lines.length - 1]);
        } catch (err2) { }
        return null;
    }

    function computeAutoStartSeconds(durationSeconds, sampleDurationSeconds) {
        const dur = (durationSeconds && durationSeconds > 0) ? durationSeconds : 0;
        if (dur <= 0) return 0;
        if (dur <= sampleDurationSeconds + 2) return 0;
        // Avoid intros. Use ~10% in, with a minimum offset that increases for longer content.
        // This helps when movies have little/no audio for the first few minutes.
        let minStart = 0;
        if (dur >= 3600) minStart = 300;        // 1h+ => 5 min
        else if (dur >= 1800) minStart = 240;   // 30m+ => 4 min
        else if (dur >= 1200) minStart = 180;   // 20m+ => 3 min
        else if (dur >= 600) minStart = 120;    // 10m+ => 2 min
        else if (dur >= 300) minStart = 60;     // 5m+  => 1 min
        const preferred = Math.floor(dur * 0.10);
        return clampInt(Math.max(minStart, preferred), 0, Math.max(0, dur - sampleDurationSeconds - 1));
    }

    function extractAudioSampleWav(ffmpegPath, inputFile, typeIndex, startSeconds, durationSeconds) {
        const outPath = System.IO.Path.Combine(Flow.TempPath, Flow.NewGuid() + '.wav');
        const args = [
            '-hide_banner', '-nostats', '-loglevel', 'error',
            '-y',
            '-ss', String(startSeconds),
            '-i', inputFile,
            '-map', '0:a:' + String(typeIndex),
            '-vn', '-sn', '-dn',
            '-ac', '1',
            '-ar', '16000',
            '-t', String(durationSeconds),
            '-c:a', 'pcm_s16le',
            outPath
        ];
        const proc = runProcess(ffmpegPath, args, 300);
        if (!proc || proc.exitCode !== 0) {
            Logger.WLog('ffmpeg sample extraction failed for 0:a:' + typeIndex + ': ' + safeString((proc && (proc.standardError || proc.standardOutput)) || ''));
            return '';
        }
        return outPath;
    }

    function getFileSizeBytes(path) {
        try {
            const fi = new System.IO.FileInfo(path);
            return fi && fi.Length ? Number(fi.Length) : 0;
        } catch (err) { return 0; }
    }

    function extractAudioSampleWavChecked(ffmpegPath, inputFile, typeIndex, startSeconds, durationSeconds, minBytes) {
        const outPath = extractAudioSampleWav(ffmpegPath, inputFile, typeIndex, startSeconds, durationSeconds);
        if (!outPath) return '';
        const size = getFileSizeBytes(outPath);
        if (size <= 0 || (minBytes && size < minBytes)) {
            try { System.IO.File.Delete(outPath); } catch (err) { }
            return '';
        }
        return outPath;
    }

    function detectLanguageSpeechBrain(sampleWavPath) {
        const proc = runProcess('fflangid-sb', [sampleWavPath], 300);
        if (!proc || proc.exitCode !== 0) return null;
        return tryParseJson(proc.standardOutput);
    }

    function detectLanguageWhisper(sampleWavPath) {
        const proc = runProcess('fflangid-whisper', [sampleWavPath], 600);
        if (!proc || proc.exitCode !== 0) return null;
        return tryParseJson(proc.standardOutput);
    }

    const dryRun = !!DryRun;
    const forceRetagParam = (ForceRetag === undefined || ForceRetag === null) ? false : !!ForceRetag;
    const useHeuristics = (UseHeuristics === undefined || UseHeuristics === null) ? true : !!UseHeuristics;
    const useSpeechBrain = (UseSpeechBrain === undefined || UseSpeechBrain === null) ? true : !!UseSpeechBrain;
    const speechBrainMinConfidence = clampInt(toInt(SpeechBrainMinConfidence, 75), 0, 100);
    const useWhisperFallback = (UseWhisperFallback === undefined || UseWhisperFallback === null) ? true : !!UseWhisperFallback;
    const sampleStartSecondsParamDefault = clampInt(toInt(SampleStartSeconds, 0), 0, 24 * 3600);
    const sampleDurationSecondsDefault = clampInt(toInt(SampleDurationSeconds, 25), 6, 120);
    const preferMkvPropEdit = (PreferMkvPropEdit === undefined || PreferMkvPropEdit === null) ? true : !!PreferMkvPropEdit;

    function getVariablesKey(key) {
        try { return (Variables && key) ? Variables[key] : null; } catch (err) { return null; }
    }

    const forceRetagVar = parseBool(getVariablesKey('AudioLangID.ForceRetag'));
    const forceRetag = (forceRetagVar === null) ? forceRetagParam : !!forceRetagVar;

    const sampleStartSecondsOverride = toInt(getVariablesKey('AudioLangID.SampleStartSeconds'), null);
    const sampleDurationSecondsOverride = toInt(getVariablesKey('AudioLangID.SampleDurationSeconds'), null);
    const sampleStartSecondsParam = clampInt((sampleStartSecondsOverride === null) ? sampleStartSecondsParamDefault : sampleStartSecondsOverride, 0, 24 * 3600);
    const sampleDurationSeconds = clampInt((sampleDurationSecondsOverride === null) ? sampleDurationSecondsDefault : sampleDurationSecondsOverride, 6, 120);

    const variablesFile = getVariablesKey('file');
    const inputFile = (variablesFile && variablesFile.FullName) ? variablesFile.FullName : Flow.WorkingFile;
    if (!inputFile) {
        Logger.ELog('No working file found (missing file metadata / working file)');
        return -1;
    }

    const viVar = (typeof vi !== 'undefined' && vi) ? vi : getVariablesKey('vi');
    const videoVar = (typeof video !== 'undefined' && video) ? video : getVariablesKey('video');
    const ffmpegModel = getVariablesKey('FfmpegBuilderModel');

    function getVideoInfoCandidates(primaryVideoInfo, viObj, videoObj, ffModel) {
        const candidates = [];
        function addCandidate(obj) {
            if (!obj) return;
            if (candidates.indexOf(obj) >= 0) return;
            candidates.push(obj);
        }

        // The selected primary reference
        addCandidate(primaryVideoInfo);

        // Video File node globals/variables might expose VideoInfo either directly or nested
        if (viObj) {
            try {
                if (viObj['VideoInfo']) addCandidate(viObj['VideoInfo']);
                else if (viObj['AudioStreams'] || viObj['VideoStreams']) addCandidate(viObj);
            } catch (err) { }
        }
        if (videoObj) {
            try {
                if (videoObj['VideoInfo']) addCandidate(videoObj['VideoInfo']);
                else if (videoObj['AudioStreams'] || videoObj['VideoStreams']) addCandidate(videoObj);
            } catch (err) { }
        }

        // FFmpeg Builder model may also carry a VideoInfo reference used later in the flow
        if (ffModel) {
            try { if (ffModel['VideoInfo']) addCandidate(ffModel['VideoInfo']); } catch (err) { }
        }

        return candidates;
    }

    function applyInMemoryLanguageUpdates(changesList, primaryVideoInfo, viObj, videoObj, ffModel) {
        if (!changesList || changesList.length === 0) return;

        let updatedAudioStreams = 0;
        let updatedBuilderStreams = 0;
        let failedUpdates = 0;

        function updateAudioStreamsOnVideoInfo(videoInfoObj, label) {
            if (!videoInfoObj) return;

            let audioList = null;
            try { audioList = videoInfoObj.AudioStreams; } catch (err) { audioList = null; }
            if (!audioList) return;

            const list = toEnumerableArray(audioList, 500);
            if (!list || list.length === 0) return;

            for (const c of changesList) {
                if (!c || !c.iso) continue;

                // Prefer matching by TypeIndex (0:a:N) when available; fall back to list index.
                let target = null;
                for (let i = 0; i < list.length; i++) {
                    const s = list[i];
                    if (!s) continue;
                    try {
                        if (s.TypeIndex !== undefined && s.TypeIndex !== null && Number(s.TypeIndex) === Number(c.typeIndex)) {
                            target = s;
                            break;
                        }
                    } catch (err) { }
                }
                if (!target) target = (c.audioIndex >= 0 && c.audioIndex < list.length) ? list[c.audioIndex] : null;
                if (!target) continue;

                try {
                    target.Language = c.iso;
                    updatedAudioStreams++;
                } catch (err2) {
                    failedUpdates++;
                    Logger.WLog('Failed to update in-memory audio language on ' + label + ' for 0:a:' + String(c.typeIndex) + ': ' + safeString(err2));
                }
            }
        }

        function updateFfmpegBuilderAudioStreams(ffModelObj) {
            if (!ffModelObj) return;
            let audioList = null;
            try { audioList = ffModelObj.AudioStreams; } catch (err) { audioList = null; }
            if (!audioList) return;

            const list = toEnumerableArray(audioList, 500);
            if (!list || list.length === 0) return;

            for (const c of changesList) {
                if (!c || !c.iso) continue;

                let target = null;
                for (let i = 0; i < list.length; i++) {
                    const s = list[i];
                    if (!s) continue;
                    try {
                        if (s.TypeIndex !== undefined && s.TypeIndex !== null && Number(s.TypeIndex) === Number(c.typeIndex)) {
                            target = s;
                            break;
                        }
                    } catch (err) { }
                }
                if (!target) continue;

                try {
                    target.Language = c.iso;
                    updatedBuilderStreams++;
                } catch (err2) {
                    failedUpdates++;
                    Logger.WLog('Failed to update in-memory FFmpeg Builder audio language for 0:a:' + String(c.typeIndex) + ': ' + safeString(err2));
                }
            }
        }

        const candidates = getVideoInfoCandidates(primaryVideoInfo, viObj, videoObj, ffModel);
        for (let i = 0; i < candidates.length; i++) {
            updateAudioStreamsOnVideoInfo(candidates[i], 'VideoInfo[' + i + ']');
        }

        updateFfmpegBuilderAudioStreams(ffModel);

        // Expose a compact mapping for downstream nodes, even if a .NET object property is not writable.
        // Keyed by TypeIndex (0:a:N), value is ISO-639-2/B code.
        try {
            const map = {};
            for (const c of changesList) {
                if (!c || !c.iso) continue;
                map[String(c.typeIndex)] = String(c.iso);
            }
            Variables['AudioLangID.UpdatedAudioLanguagesByTypeIndex'] = JSON.stringify(map);
        } catch (err) { }

        Logger.ILog('Updated in-memory audio language metadata: VideoInfo=' + updatedAudioStreams + ', FfmpegBuilderModel=' + updatedBuilderStreams + (failedUpdates ? (', failed=' + failedUpdates) : ''));
    }

    const videoInfo =
        (viVar && viVar['VideoInfo']) ||
        getVariablesKey('vi.VideoInfo') ||
        (videoVar && videoVar['VideoInfo']) ||
        getVariablesKey('video.VideoInfo') ||
        (ffmpegModel && ffmpegModel['VideoInfo']) ||
        getVariablesKey('FfmpegBuilderModel.VideoInfo');
    if (!videoInfo) {
        Logger.ELog('VideoInfo not found. Ensure a "Video File" node ran before this script.');
        return -1;
    }

    const audioStreams = toEnumerableArray(videoInfo.AudioStreams, 500);
    if (!audioStreams || audioStreams.length === 0) {
        Logger.ILog('No audio streams found.');
        return 2;
    }

    const overallDurationSeconds = parseDurationSeconds((videoInfo && videoInfo.Duration) ? videoInfo.Duration : 0) ||
        parseDurationSeconds((videoInfo && videoInfo.VideoStreams && videoInfo.VideoStreams[0] && videoInfo.VideoStreams[0].Duration) ? videoInfo.VideoStreams[0].Duration : 0) ||
        parseDurationSeconds((videoVar && videoVar.Duration) ? videoVar.Duration : 0) ||
        0;

    const fileName = safeString((variablesFile && variablesFile.Name) ? variablesFile.Name : (Flow.WorkingFileName || System.IO.Path.GetFileName(inputFile)));
    const fileExt = safeString(System.IO.Path.GetExtension(inputFile)).toLowerCase();
    const isMkv = (fileExt === '.mkv' || fileExt === '.mk3d' || fileExt === '.mka');

    const ffmpegPath = Flow.GetToolPath('ffmpeg') || 'ffmpeg';
    const canUseMkvPropEdit = isMkv && preferMkvPropEdit && toolWorks('mkvpropedit', ['--version']);
    const canUseSpeechBrain = useSpeechBrain && toolWorks('fflangid-sb', ['--version']);
    const canUseWhisper = useWhisperFallback && toolWorks('fflangid-whisper', ['--version']);

    if (useSpeechBrain && !canUseSpeechBrain) Logger.WLog('SpeechBrain detector not available (expected `fflangid-sb`).');
    if (useWhisperFallback && !canUseWhisper) Logger.WLog('Whisper detector not available (expected `fflangid-whisper`).');
    if (isMkv && preferMkvPropEdit && !canUseMkvPropEdit) Logger.WLog('mkvpropedit not available; will fall back to ffmpeg remux.');

    const pending = [];
    for (let i = 0; i < audioStreams.length; i++) {
        const stream = audioStreams[i];
        const lang = safeString(stream && stream.Language).trim().toLowerCase();
        const hasLang = !!lang && lang !== 'und';
        if (!forceRetag && hasLang) continue;

        pending.push({
            streamRef: stream,
            audioIndex: i,
            typeIndex: (stream && stream.TypeIndex !== undefined && stream.TypeIndex !== null) ? stream.TypeIndex : i,
            title: safeString(stream && stream.Title),
            codec: safeString(stream && stream.Codec),
            duration: parseDurationSeconds((stream && stream.Duration) ? stream.Duration : 0) || 0,
            existingLang: safeString(stream && stream.Language)
        });
    }

    if (!pending.length) {
        Logger.ILog('All audio tracks already have language tags.' + (forceRetag ? ' (ForceRetag enabled but no audio tracks found?)' : ''));
        return 2;
    }

    Logger.ILog((forceRetag ? 'Audio tracks selected for (re)tagging: ' : 'Audio tracks missing language tags: ') + pending.length);

    const changes = [];
    let detectedCount = 0;
    let detectedSameAsExistingCount = 0;
    for (const track of pending) {
        const trackLabel = 'a:' + track.audioIndex + ' (0:a:' + track.typeIndex + ')';
        let detectedIso = '';
        let detectedSource = '';
        let detectedConfidence = 0;

        const existingIso = normalizeLangToIso6392b(track.existingLang);

        if (useHeuristics) {
            const h = guessLanguageFromText(track.title + ' ' + fileName);
            if (h) {
                detectedIso = h;
                detectedSource = 'heuristics';
                detectedConfidence = 100;
            }
        }

        let sampleWav = '';
        if (!detectedIso && (canUseSpeechBrain || canUseWhisper)) {
            const trackDurationSeconds = (track.duration && track.duration > 0) ? track.duration : overallDurationSeconds;

            // If we can't determine the real duration, avoid always sampling t=0 (intros/silence).
            // Try a few offsets; if extraction yields an empty/tiny wav, fall back to later/earlier offsets.
            const minBytes = Math.max(80000, Math.floor(sampleDurationSeconds * 16000 * 2 * 0.10)); // ~>2.5s or 10% of expected PCM size
            const starts = [];
            if (sampleStartSecondsParam > 0) {
                starts.push(sampleStartSecondsParam);
            } else if (trackDurationSeconds && trackDurationSeconds > 0) {
                const maxStart = Math.max(0, Math.floor(trackDurationSeconds - sampleDurationSeconds - 1));
                starts.push(clampInt(computeAutoStartSeconds(trackDurationSeconds, sampleDurationSeconds), 0, maxStart));
            } else {
                starts.push(300, 180, 120, 60, 0);
            }

            for (let si = 0; si < starts.length && !sampleWav; si++) {
                const startSeconds = Math.max(0, Math.floor(starts[si]));
                Logger.DLog('Sampling ' + trackLabel + ' from t=' + startSeconds + 's for ' + sampleDurationSeconds + 's' +
                    ((sampleStartSecondsParam > 0) ? ' (manual)' : ' (auto)') +
                    ((trackDurationSeconds && trackDurationSeconds > 0) ? (' duration=' + Math.floor(trackDurationSeconds) + 's') : ''));
                sampleWav = extractAudioSampleWavChecked(ffmpegPath, inputFile, track.typeIndex, startSeconds, sampleDurationSeconds, minBytes);
            }

            if (!sampleWav) {
                Logger.WLog('Failed to extract a usable audio sample for ' + trackLabel + ' (tried ' + starts.length + ' start positions).');
            }
        }

        if (!detectedIso && canUseSpeechBrain && sampleWav) {
            const result = detectLanguageSpeechBrain(sampleWav);
            const lang = normalizeLangToIso6392b((result && (result.lang || result.language || result.code || result.label)) || '');
            const conf = (result && (result.confidence !== undefined && result.confidence !== null)) ? Number(result.confidence) : 0;
            const confPct = (conf <= 1.0 && conf > 0) ? Math.round(conf * 100) : Math.round(conf);
            if (lang && confPct >= speechBrainMinConfidence) {
                detectedIso = lang;
                detectedSource = 'speechbrain';
                detectedConfidence = confPct;
            } else if (lang) {
                Logger.DLog('SpeechBrain low confidence for ' + trackLabel + ': ' + lang + ' @ ' + confPct + '%');
            }
        }

        if (!detectedIso && canUseWhisper && sampleWav) {
            const result = detectLanguageWhisper(sampleWav);
            const lang = normalizeLangToIso6392b((result && (result.lang || result.language || result.code || result.label)) || '');
            if (lang) {
                detectedIso = lang;
                detectedSource = 'whisper';
                detectedConfidence = 0;
            }
        }

        if (sampleWav) {
            try { System.IO.File.Delete(sampleWav); } catch (err) { }
        }

        if (!detectedIso) {
            Logger.WLog('Could not detect language for ' + trackLabel + ' title="' + track.title + '" codec=' + track.codec);
            continue;
        }

        detectedCount++;
        if (existingIso && existingIso === detectedIso) {
            Logger.DLog('Detected language matches existing tag for ' + trackLabel + ': ' + detectedIso);
            detectedSameAsExistingCount++;
            continue;
        }

        changes.push({
            streamRef: track.streamRef,
            audioIndex: track.audioIndex,
            typeIndex: track.typeIndex,
            iso: detectedIso,
            source: detectedSource,
            confidence: detectedConfidence,
            title: track.title
        });

        Logger.ILog('Detected ' + detectedIso + ' for ' + trackLabel + ' via ' + detectedSource + (detectedConfidence ? (' @ ' + detectedConfidence + '%') : ''));
    }

    if (!changes.length) {
        if (detectedCount > 0 && detectedSameAsExistingCount === detectedCount) {
            Logger.ILog('Languages were detected, but all audio tracks already had matching tags; nothing changed.');
        } else if (detectedCount > 0) {
            Logger.ILog('Languages were detected, but no tag updates were required; nothing changed.');
        } else {
            Logger.ILog('No language tags could be inferred; nothing changed.');
        }
        return 2;
    }

    if (dryRun) {
        Logger.WLog('DryRun enabled: no files will be modified.');
        return 1;
    }

    if (canUseMkvPropEdit) {
        const args = [inputFile];
        for (const c of changes) {
            // mkvpropedit uses 1-based audio track selection (track:a1 is first audio track).
            const trackNumber = c.audioIndex + 1;
            args.push('--edit', 'track:a' + String(trackNumber));
            args.push('--set', 'language=' + c.iso);
        }
        const proc = runProcess('mkvpropedit', args, 300);
        if (!proc || proc.exitCode !== 0) {
            Logger.ELog('mkvpropedit failed: ' + safeString((proc && (proc.standardError || proc.standardOutput)) || ''));
            return -1;
        }

        // Ensure downstream nodes can see updated languages without re-parsing the file.
        applyInMemoryLanguageUpdates(changes, videoInfo, viVar, videoVar, ffmpegModel);
        Logger.ILog('Tagged languages in-place with mkvpropedit.');
        return 1;
    }

    // Fallback: stream-copy remux with ffmpeg and per-audio-stream metadata.
    const outputFile = System.IO.Path.Combine(Flow.TempPath, Flow.NewGuid() + fileExt);
    const ffArgs = ['-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-i', inputFile, '-map', '0', '-c', 'copy'];
    for (const c of changes) {
        ffArgs.push('-metadata:s:a:' + String(c.audioIndex));
        ffArgs.push('language=' + c.iso);
    }
    ffArgs.push(outputFile);

    const remux = runProcess(ffmpegPath, ffArgs, 3600);
    if (!remux || remux.exitCode !== 0) {
        Logger.ELog('ffmpeg remux tagging failed: ' + safeString((remux && (remux.standardError || remux.standardOutput)) || ''));
        return -1;
    }

    Flow.SetWorkingFile(outputFile);

    // Ensure downstream nodes can see updated languages without re-parsing the file.
    applyInMemoryLanguageUpdates(changes, videoInfo, viVar, videoVar, ffmpegModel);
    Logger.ILog('Tagged languages via ffmpeg remux and updated working file.');
    return 1;
}
