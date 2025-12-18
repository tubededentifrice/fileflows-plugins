/**
 * @description Keeps only audio/subtitle tracks matching the original language or specified additional languages. 
 *              Tracks are reordered: original language first, then in the order specified. Non-matching tracks are marked for deletion.
 *              Requires "Movie Lookup"/"TV Show Lookup" node to be executed first to set Variables.OriginalLanguage.
 * @author Vincent Courcelle
 * @revision 1
 * @minimumVersion 24.0.0.0
 * @param {string} AdditionalLanguages Comma-separated ISO 639-2/B language codes to keep IN ORDER (e.g., "eng,fra,deu"). Original language is always kept first.
 * @param {bool} ProcessAudio Apply to audio streams (default: true)
 * @param {bool} ProcessSubtitles Apply to subtitle streams (default: true)
 * @param {bool} TreatUnknownAsBad Treat tracks with no language set as unwanted (delete them). If false, unknown tracks are kept.
 * @param {bool} KeepFirstIfNoneMatch If no tracks match any language, keep the first track of each type to avoid empty streams.
 * @param {bool} ReorderTracks Reorder tracks so original language comes first, then additional languages in order specified. If false, only deletion is applied.
 * @output Tracks were modified (deleted or reordered)
 * @output No changes were made
 * @output No original language found (lookup node not executed?)
 */
function Script(AdditionalLanguages, ProcessAudio, ProcessSubtitles, TreatUnknownAsBad, KeepFirstIfNoneMatch, ReorderTracks) {
    Logger.ILog('Video - Language Based Track Selection.js revision 1 loaded');

    // =========================================================================
    // CONFIGURATION DEFAULTS
    // =========================================================================
    ProcessAudio = ProcessAudio !== false; // default true
    ProcessSubtitles = ProcessSubtitles !== false; // default true
    TreatUnknownAsBad = !!TreatUnknownAsBad; // default false
    KeepFirstIfNoneMatch = KeepFirstIfNoneMatch !== false; // default true
    ReorderTracks = ReorderTracks !== false; // default true

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    /**
     * Converts .NET IEnumerable / List<T> to JavaScript array.
     */
    function toArray(value, maxItems) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
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
                for (let i = 0; i < count; i++) {
                    result.push(value[i]);
                }
                return result;
            }
        } catch (err) { }

        return [value];
    }

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
        const iso2_1 = normalizeToIso2(lang1);
        const iso2_2 = normalizeToIso2(lang2);
        return iso2_1 === iso2_2;
    }

    /**
     * Get sort priority for a stream based on language preference order.
     * Lower number = higher priority (appears first).
     */
    function getLanguagePriority(streamLang, originalLang, additionalLangs) {
        if (!streamLang) return additionalLangs.length + 2; // Unknown at end

        const iso2 = normalizeToIso2(streamLang);
        const origIso2 = normalizeToIso2(originalLang);

        // Original language always first
        if (iso2 === origIso2) return 0;

        // Additional languages in order specified
        for (let i = 0; i < additionalLangs.length; i++) {
            if (iso2 === normalizeToIso2(additionalLangs[i])) {
                return i + 1;
            }
        }

        // Not in list
        return additionalLangs.length + 10;
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
        Logger.ELog('No original language found. Ensure "Movie Lookup" or "TV Show Lookup" node runs before this script.');
        return 3;
    }

    const originalLangIso2 = normalizeToIso2(originalLang);
    Logger.ILog(`Original language: ${originalLang} (ISO-2: ${originalLangIso2})`);

    // =========================================================================
    // PARSE ADDITIONAL LANGUAGES
    // =========================================================================
    const additionalLangs = [];
    if (AdditionalLanguages && typeof AdditionalLanguages === 'string') {
        const parts = AdditionalLanguages.split(',').map(s => s.trim()).filter(s => s);
        for (const lang of parts) {
            const iso2 = normalizeToIso2(lang);
            if (iso2 && iso2 !== originalLangIso2) {
                additionalLangs.push(iso2);
                Logger.ILog(`Additional language: ${lang} -> ${iso2}`);
            }
        }
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

        // Determine which streams to keep
        const toKeep = [];
        const toDelete = [];

        for (const audio of audioStreams) {
            if (!audio) continue;

            const lang = audio.Language;
            const iso2 = normalizeToIso2(lang);

            if (!lang) {
                // Unknown language
                if (TreatUnknownAsBad) {
                    toDelete.push(audio);
                } else {
                    toKeep.push(audio);
                }
                continue;
            }

            if (allowedLangs.has(iso2)) {
                toKeep.push(audio);
            } else {
                toDelete.push(audio);
            }
        }

        // Safety: keep first if none match
        if (toKeep.length === 0 && KeepFirstIfNoneMatch && audioStreams.length > 0) {
            Logger.WLog('No audio tracks match allowed languages; keeping first track');
            const first = toDelete.shift();
            if (first) toKeep.push(first);
        }

        // Sort kept streams by language priority
        if (ReorderTracks && toKeep.length > 1) {
            toKeep.sort((a, b) => {
                const pa = getLanguagePriority(a.Language, originalLang, additionalLangs);
                const pb = getLanguagePriority(b.Language, originalLang, additionalLangs);
                return pa - pb;
            });
        }

        // Mark deleted streams
        for (const audio of toDelete) {
            if (!audio.Deleted) {
                audio.Deleted = true;
                totalDeleted++;
                Logger.ILog(`  Deleting audio: ${audio.Language || 'unknown'}`);
            }
        }

        // Ensure kept streams are not deleted
        for (const audio of toKeep) {
            audio.Deleted = false;
        }

        // Try to reorder the list (may not work depending on FileFlows version)
        if (ReorderTracks && toKeep.length > 1) {
            // Build full ordered list: kept (sorted) + deleted (original order)
            const orderedAll = [...toKeep, ...toDelete];
            if (tryReorderNetList(ffModel.AudioStreams, orderedAll)) {
                totalReordered += toKeep.length;
                Logger.ILog(`  Reordered ${toKeep.length} audio streams`);
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
    if (ProcessSubtitles && ffModel.SubtitleStreams) {
        const subtitleStreams = toArray(ffModel.SubtitleStreams, 100);
        Logger.ILog(`Processing ${subtitleStreams.length} subtitle stream(s)`);

        // Log initial state
        for (let i = 0; i < subtitleStreams.length; i++) {
            const s = subtitleStreams[i];
            Logger.ILog(`  Sub[${i}] Lang=${s.Language || 'und'} Codec=${s.Codec} Deleted=${s.Deleted}`);
        }

        // Determine which streams to keep
        const toKeep = [];
        const toDelete = [];

        for (const sub of subtitleStreams) {
            if (!sub) continue;

            const lang = sub.Language;
            const iso2 = normalizeToIso2(lang);

            if (!lang) {
                if (TreatUnknownAsBad) {
                    toDelete.push(sub);
                } else {
                    toKeep.push(sub);
                }
                continue;
            }

            if (allowedLangs.has(iso2)) {
                toKeep.push(sub);
            } else {
                toDelete.push(sub);
            }
        }

        // Safety: keep first if none match
        if (toKeep.length === 0 && KeepFirstIfNoneMatch && subtitleStreams.length > 0) {
            Logger.WLog('No subtitle tracks match allowed languages; keeping first track');
            const first = toDelete.shift();
            if (first) toKeep.push(first);
        }

        // Sort kept streams by language priority
        if (ReorderTracks && toKeep.length > 1) {
            toKeep.sort((a, b) => {
                const pa = getLanguagePriority(a.Language, originalLang, additionalLangs);
                const pb = getLanguagePriority(b.Language, originalLang, additionalLangs);
                return pa - pb;
            });
        }

        // Mark deleted streams
        for (const sub of toDelete) {
            if (!sub.Deleted) {
                sub.Deleted = true;
                totalDeleted++;
                Logger.ILog(`  Deleting subtitle: ${sub.Language || 'unknown'}`);
            }
        }

        // Ensure kept streams are not deleted
        for (const sub of toKeep) {
            sub.Deleted = false;
        }

        // Try to reorder
        if (ReorderTracks && toKeep.length > 1) {
            const orderedAll = [...toKeep, ...toDelete];
            if (tryReorderNetList(ffModel.SubtitleStreams, orderedAll)) {
                totalReordered += toKeep.length;
                Logger.ILog(`  Reordered ${toKeep.length} subtitle streams`);
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
    Variables['TrackSelection.ReorderedCount'] = totalReordered;

    // =========================================================================
    // FORCE ENCODE IF CHANGES WERE MADE
    // =========================================================================
    const hasChanges = totalDeleted > 0 || totalReordered > 0;
    if (hasChanges) {
        ffModel.ForceEncode = true;
        Logger.ILog(`Track selection complete: ${totalDeleted} deleted, ${totalReordered} reordered`);
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
 *   3. Unknown language tracks (if TreatUnknownAsBad is false)
 *   4. Deleted tracks (marked with Deleted=true, won't be in output)
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
