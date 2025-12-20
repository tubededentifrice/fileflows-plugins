import { toEnumerableArray, safeString } from 'Shared/ScriptHelpers';

/**
 * @description Keeps only audio tracks matching the original language or specified additional languages.
 *              Unknown-language audio tracks are kept unless an original-language audio track exists (then unknown audio is removed).
 *              Subtitle tracks are NEVER deleted; they are only reordered using the same language priority rules as audio.
 *              Tracks are reordered: original language first (preserving relative order within each language), then additional languages in provided order, then unknown.
 *              Requires "Movie Lookup"/"TV Show Lookup" node to be executed first to set Variables.OriginalLanguage.
 * @author Vincent Courcelle
 * @revision 4
 * @minimumVersion 24.0.0.0
 * @param {string} AdditionalLanguages Comma-separated ISO 639-2/B language codes to keep IN ORDER (e.g., "eng,fra,deu"). Also accepts an array (e.g., ["eng","fra"]). Original language is always kept first.
 * @param {bool} ProcessAudio Apply to audio streams (default: true)
 * @param {bool} ProcessSubtitles Reorder subtitle streams (default: true). Subtitles are always kept.
 * @param {bool} KeepFirstIfNoneMatch If no audio tracks match any language, keep the first audio track to avoid empty audio.
 * @param {bool} ReorderTracks Reorder tracks so original language comes first, then additional languages in order specified.
 * @output Tracks were modified (deleted/undeleted or reordered)
 * @output No changes were made
 * @output No original language found (lookup node not executed?)
 */
function Script(AdditionalLanguages, ProcessAudio, ProcessSubtitles, KeepFirstIfNoneMatch, ReorderTracks) {
    Logger.ILog('Video - Language Based Track Selection.js revision 4 loaded');

    // =========================================================================
    // CONFIGURATION DEFAULTS
    // =========================================================================
    ProcessAudio = ProcessAudio !== false; // default true
    ProcessSubtitles = ProcessSubtitles !== false; // default true
    KeepFirstIfNoneMatch = KeepFirstIfNoneMatch !== false; // default true
    ReorderTracks = ReorderTracks !== false; // default true

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    // toArray is now toEnumerableArray from Shared/ScriptHelpers
    const toArray = toEnumerableArray;

    /**
     * Normalize language code to ISO 639-2/B (3-letter) using FileFlows helper.
     * Returns lowercase for consistent comparison.
     */
    function normalizeToIso2(lang) {
        if (!lang) return '';
        const normalized = LanguageHelper.GetIso2Code(lang);
        return (normalized || lang).toLowerCase();
    }

    /**
     * Check if two language codes match (handles ISO 639-1 vs ISO 639-2).
     */
    function languagesMatch(lang1, lang2) {
        if (!lang1 || !lang2) return false;
        try {
            return LanguageHelper.AreSame(lang1, lang2) === true;
        } catch (err) {
            const iso2_1 = normalizeToIso2(lang1);
            const iso2_2 = normalizeToIso2(lang2);
            return iso2_1 === iso2_2;
        }
    }

    /**
     * Get sort priority for a stream based on language preference order.
     * Lower number = higher priority (appears first).
     */
    function getLanguagePriority(streamLang, originalLang, additionalLangs) {
        if (!streamLang) return additionalLangs.length + 2; // Unknown at end

        if (languagesMatch(streamLang, originalLang)) return 0;

        // Additional languages in order specified
        for (let i = 0; i < additionalLangs.length; i++) {
            if (languagesMatch(streamLang, additionalLangs[i])) {
                return i + 1;
            }
        }

        return additionalLangs.length + 10;
    }

    function stableSortStreamsByLanguagePreference(streams, originalLang, additionalLangs) {
        const decorated = [];
        for (let i = 0; i < streams.length; i++) {
            const stream = streams[i];
            if (!stream) continue;
            const priority = getLanguagePriority(stream.Language, originalLang, additionalLangs);
            decorated.push({ stream, priority, index: i });
        }

        decorated.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.index - b.index;
        });

        return decorated.map((x) => x.stream);
    }

    /**
     * Try to clear a .NET List and rebuild with new order.
     * Returns true if successful, false if not supported.
     */
    function tryReorderNetList(netList, orderedItems) {
        if (!netList) return false;

        try {
            // Try .NET List<T>.Clear() and Add()
            if (typeof netList.Clear === 'function' && typeof netList.Add === 'function') {
                netList.Clear();
                for (let i = 0; i < orderedItems.length; i++) {
                    netList.Add(orderedItems[i]);
                }
                return true;
            }
        } catch (err) {
            Logger.WLog(`Failed to reorder .NET list: ${err}`);
        }

        return false;
    }

    // =========================================================================
    // GET ORIGINAL LANGUAGE
    // =========================================================================
    const originalLang = Variables.OriginalLanguage || Variables.VideoMetadata?.OriginalLanguage;
    if (!originalLang) {
        Logger.ELog(
            'No original language found. Ensure "Movie Lookup" or "TV Show Lookup" node runs before this script.'
        );
        return 3;
    }

    const originalLangIso2 = normalizeToIso2(originalLang);
    Logger.ILog(`Original language: ${originalLang} (ISO-2: ${originalLangIso2})`);

    // =========================================================================
    // PARSE ADDITIONAL LANGUAGES
    // =========================================================================
    const additionalLangs = [];
    let additionalTokens = [];

    if (AdditionalLanguages) {
        if (Array.isArray(AdditionalLanguages)) {
            additionalTokens = AdditionalLanguages;
        } else if (typeof AdditionalLanguages === 'string') {
            additionalTokens = AdditionalLanguages.split(',');
        } else {
            additionalTokens = toArray(AdditionalLanguages, 200);
        }
    }

    for (let i = 0; i < additionalTokens.length; i++) {
        const raw = String(additionalTokens[i] || '').trim();
        if (!raw) continue;

        const iso2 = normalizeToIso2(raw);
        if (!iso2 || iso2 === originalLangIso2) continue;

        if (additionalLangs.indexOf(iso2) >= 0) continue;
        additionalLangs.push(iso2);
        Logger.ILog(`Additional language: ${raw} -> ${iso2}`);
    }

    // Build allowed languages set (original + additional)
    const allowedLangs = new Set([originalLangIso2, ...additionalLangs]);
    Logger.ILog(`Allowed languages (ISO-2): ${Array.from(allowedLangs).join(', ')}`);

    // =========================================================================
    // GET FFMPEG BUILDER MODEL
    // =========================================================================
    const ffModel = Variables.FfmpegBuilderModel;
    if (!ffModel) {
        Logger.ELog('FFMPEG Builder model not found. Place this node after FFMPEG Builder: Start.');
        return -1;
    }

    let totalDeleted = 0;
    let totalUndeleted = 0;
    let totalReordered = 0;

    // =========================================================================
    // PROCESS AUDIO STREAMS
    // =========================================================================
    if (ProcessAudio && ffModel.AudioStreams) {
        const audioStreams = toArray(ffModel.AudioStreams, 100);
        Logger.ILog(`Processing ${audioStreams.length} audio stream(s)`);

        // Log initial state
        for (let i = 0; i < audioStreams.length; i++) {
            const a = audioStreams[i];
            Logger.ILog(`  Audio[${i}] Lang=${a.Language || 'und'} Codec=${a.Codec} Deleted=${a.Deleted}`);
        }

        const toKeep = [];
        const toDelete = [];

        const hasOriginalLanguageAudio = audioStreams.some(
            (a) => a && a.Language && languagesMatch(a.Language, originalLang)
        );
        if (hasOriginalLanguageAudio) {
            Logger.ILog('Original-language audio track found; unknown-language audio will be removed');
        } else {
            Logger.ILog('No original-language audio track found; unknown-language audio will be kept');
        }

        for (const audio of audioStreams) {
            if (!audio) continue;

            const lang = audio.Language;

            if (!lang) {
                if (hasOriginalLanguageAudio) {
                    toDelete.push(audio);
                } else {
                    toKeep.push(audio);
                }
                continue;
            }

            const iso2 = normalizeToIso2(lang);
            if (allowedLangs.has(iso2)) {
                toKeep.push(audio);
            } else {
                toDelete.push(audio);
            }
        }

        if (toKeep.length === 0 && KeepFirstIfNoneMatch) {
            const firstAudio = audioStreams.find((a) => !!a);
            if (firstAudio) {
                Logger.WLog('No audio tracks match allowed languages; keeping first audio track');
                const idx = toDelete.indexOf(firstAudio);
                if (idx >= 0) toDelete.splice(idx, 1);
                toKeep.push(firstAudio);
            }
        }

        const sortedKeep =
            ReorderTracks && toKeep.length > 1
                ? stableSortStreamsByLanguagePreference(toKeep, originalLang, additionalLangs)
                : toKeep;

        for (const audio of toDelete) {
            if (audio.Deleted !== true) {
                audio.Deleted = true;
                totalDeleted++;
                Logger.ILog(`  Deleting audio: ${audio.Language || 'unknown'}`);
            }
        }

        for (const audio of sortedKeep) {
            if (audio.Deleted === true) totalUndeleted++;
            audio.Deleted = false;
        }

        if (ReorderTracks && sortedKeep.length > 1) {
            const orderedAll = [...sortedKeep, ...toDelete];
            if (tryReorderNetList(ffModel.AudioStreams, orderedAll)) {
                totalReordered += sortedKeep.length;
                Logger.ILog(`  Reordered ${sortedKeep.length} audio streams`);
            } else {
                Logger.WLog('  Could not reorder audio streams (list manipulation not supported)');
            }
        }

        // Log final state
        Logger.ILog('Audio streams after processing:');
        const finalAudio = toArray(ffModel.AudioStreams, 100);
        for (let i = 0; i < finalAudio.length; i++) {
            const a = finalAudio[i];
            Logger.ILog(`  Audio[${i}] Lang=${a.Language || 'und'} Deleted=${a.Deleted}`);
        }
    }

    // =========================================================================
    // PROCESS SUBTITLE STREAMS
    // =========================================================================
    if (ffModel.SubtitleStreams) {
        const subtitleStreams = toArray(ffModel.SubtitleStreams, 100);
        Logger.ILog(`Processing ${subtitleStreams.length} subtitle stream(s)`);

        // Log initial state
        for (let i = 0; i < subtitleStreams.length; i++) {
            const s = subtitleStreams[i];
            Logger.ILog(`  Sub[${i}] Lang=${s.Language || 'und'} Codec=${s.Codec} Deleted=${s.Deleted}`);
        }

        const subtitles = subtitleStreams.filter((s) => !!s);

        for (const sub of subtitles) {
            if (sub.Deleted === true) totalUndeleted++;
            sub.Deleted = false;
        }

        const sortedSubs =
            ProcessSubtitles && ReorderTracks && subtitles.length > 1
                ? stableSortStreamsByLanguagePreference(subtitles, originalLang, additionalLangs)
                : subtitles;

        if (ProcessSubtitles && ReorderTracks && sortedSubs.length > 1) {
            if (tryReorderNetList(ffModel.SubtitleStreams, sortedSubs)) {
                totalReordered += sortedSubs.length;
                Logger.ILog(`  Reordered ${sortedSubs.length} subtitle streams`);
            } else {
                Logger.WLog('  Could not reorder subtitle streams (list manipulation not supported)');
            }
        }

        // Log final state
        Logger.ILog('Subtitle streams after processing:');
        const finalSub = toArray(ffModel.SubtitleStreams, 100);
        for (let i = 0; i < finalSub.length; i++) {
            const s = finalSub[i];
            Logger.ILog(`  Sub[${i}] Lang=${s.Language || 'und'} Deleted=${s.Deleted}`);
        }
    }

    // =========================================================================
    // STORE METADATA FOR DOWNSTREAM SCRIPTS
    // =========================================================================
    // These variables allow downstream scripts to access selection decisions
    // without re-parsing the FfmpegBuilderModel.

    Variables['TrackSelection.OriginalLanguage'] = originalLangIso2;
    Variables['TrackSelection.AdditionalLanguages'] = additionalLangs.join(',');
    Variables['TrackSelection.AllowedLanguages'] = Array.from(allowedLangs).join(',');
    Variables['TrackSelection.DeletedCount'] = totalDeleted;
    Variables['TrackSelection.UndeletedCount'] = totalUndeleted;
    Variables['TrackSelection.ReorderedCount'] = totalReordered;

    // =========================================================================
    // FORCE ENCODE IF CHANGES WERE MADE
    // =========================================================================
    const hasChanges = totalDeleted > 0 || totalUndeleted > 0 || totalReordered > 0;
    if (hasChanges) {
        ffModel.ForceEncode = true;
        Logger.ILog(
            `Track selection complete: ${totalDeleted} deleted, ${totalUndeleted} undeleted, ${totalReordered} reordered`
        );
        return 1;
    }

    Logger.ILog('No track changes needed');
    return 2;
}

/*
 * ============================================================================
 * DOWNSTREAM VARIABLE SPECIFICATION (for future scripts)
 * ============================================================================
 *
 * After this script runs, the following Variables are set for downstream use:
 *
 * Variables['TrackSelection.OriginalLanguage']
 *   - ISO 639-2/B code of the original language (e.g., "fre", "eng", "deu")
 *
 * Variables['TrackSelection.AdditionalLanguages']
 *   - Comma-separated ISO 639-2/B codes of additional languages kept (e.g., "eng,fra")
 *
 * Variables['TrackSelection.AllowedLanguages']
 *   - Comma-separated ISO 639-2/B codes of ALL allowed languages (original + additional)
 *
 * Variables['TrackSelection.DeletedCount']
 *   - Number of streams marked for deletion
 *
 * Variables['TrackSelection.UndeletedCount']
 *   - Number of streams un-deleted (Deleted=true -> Deleted=false)
 *
 * Variables['TrackSelection.ReorderedCount']
 *   - Number of streams reordered (0 if reordering not supported/disabled)
 *
 * ============================================================================
 * TRACK ORDERING
 * ============================================================================
 *
 * Tracks are ordered as follows (if ReorderTracks is enabled):
 *   1. Original language tracks (in original file order if multiple)
 *   2. Additional language tracks (in order specified in AdditionalLanguages)
 *   3. Unknown language tracks
 *   4. Other languages (subtitles only)
 *   5. Deleted tracks (audio only; marked with Deleted=true, won't be in output)
 *
 * AUDIO unknown-language rule:
 *   - Unknown-language audio tracks are kept only when NO original-language audio track exists.
 *   - If an original-language audio track exists, unknown-language audio tracks are marked Deleted=true.
 *
 * SUBTITLES:
 *   - Subtitle tracks are never deleted by this script.
 *   - Any existing Deleted=true flags on subtitle streams are cleared (Deleted=false).
 *
 * Note: Reordering depends on FileFlows supporting .NET List<T>.Clear/Add operations.
 * If not supported, only deletion is applied and tracks remain in original order.
 *
 * ============================================================================
 * FFMPEG MAPPING (Future Implementation)
 * ============================================================================
 *
 * If you need to manually build ffmpeg -map arguments for precise ordering,
 * iterate FfmpegBuilderModel.AudioStreams / SubtitleStreams and use:
 *
 *   stream.Deleted      - true if marked for removal
 *   stream.SourceIndex  - Original ffmpeg stream index (0:a:N, 0:s:N)
 *   stream.TypeIndex    - Type-relative index
 *   stream.Language     - ISO 639-2/B code
 *
 * Example mapping logic:
 *   for (let i = 0; i < ffModel.AudioStreams.length; i++) {
 *       const a = ffModel.AudioStreams[i];
 *       if (!a.Deleted) {
 *           args.push('-map', `0:a:${a.SourceIndex || a.TypeIndex}`);
 *       }
 *   }
 *
 * ============================================================================
 * BACKWARD COMPATIBILITY
 * ============================================================================
 *
 * This script uses the same patterns as the community repository:
 *   - stream.Deleted = true/false (compatible with all FfmpegBuilder nodes)
 *   - LanguageHelper.GetIso2Code() (FileFlows built-in)
 *   - Variables.FfmpegBuilderModel (standard access)
 *
 * Existing scripts that check stream.Deleted will work correctly.
 */
