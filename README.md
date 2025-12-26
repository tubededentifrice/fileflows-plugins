# FileFlows Plugins

This repository contains custom scripts and plugins for [FileFlows](https://fileflows.com/), a video processing automation tool. These scripts provide advanced functionality for media organization, quality optimization, and content-aware processing.

## Table of Contents

- [Integration Pattern](#integration-pattern)
- [Application Scripts](#application-scripts)
    - [Radarr - Movie Lookup](#radarr---movie-lookup)
    - [Radarr - Refresh](#radarr---refresh)
    - [Sonarr - TV Show Lookup](#sonarr---tv-show-lookup)
    - [Sonarr - Refresh](#sonarr---refresh)
- [Video Processing Scripts](#video-processing-scripts)
    - [Video - Auto Quality](#video---auto-quality)
    - [Video - Auto Tag Missing Language](#video---auto-tag-missing-language)
    - [Video - Cleaning Filters](#video---cleaning-filters)
    - [Video - FFmpeg Builder Executor (Single Filter)](#video---ffmpeg-builder-executor-single-filter)
    - [Video - Language Based Track Selection](#video---language-based-track-selection)
    - [Video - Audio Format Converter](#video---audio-format-converter)
    - [Video - Resolution Fixed](#video---resolution-fixed)
- [DockerMods](#dockermods)

---

## Integration Pattern

The scripts are designed to work in a specific workflow:

1.  **Lookup**: Retrieve metadata from Radarr/Sonarr (Original Language, Year, Genres).
2.  **Process**: Apply filters and quality settings based on that metadata.
3.  **Refresh**: Notify Radarr/Sonarr to rescan the file after processing.

### Global Integration Variables

The following Variables are set by Lookup scripts and consumed by other scripts:

- `Variables.VideoMetadata`: Object containing movie/show metadata (Year, Genres, OriginalLanguage).
- `Variables.MovieInfo`: Radarr-specific movie metadata (Radarr/Sonarr Refresh reads this).
- `Variables.TVShowInfo`: Sonarr-specific TV show metadata (Sonarr Refresh reads this).
- `Variables.OriginalLanguage`: ISO-639-2/B code of original content language.
- `Variables.FfmpegBuilderModel`: FFmpeg Builder model (set by "FFmpeg Builder: Start" node).
- `Variables['Radarr.Url']` / `Variables['Radarr.ApiKey']`: Radarr connection settings.
- `Variables['Sonarr.Url']` / `Variables['Sonarr.ApiKey']`: Sonarr connection settings.

---

## Application Scripts

These scripts integrate with your \*Arr applications to fetch metadata and trigger refreshes.

### Radarr - Movie Lookup

Looks up the movie in Radarr to retrieve metadata like Year, Genres, and Original Language.

- **Variables Set:** `Variables.MovieInfo`, `Variables.VideoMetadata`

<details>
<summary><strong>Configuration (Knobs & Dials)</strong></summary>

| Parameter       | Type    | Description                                                                                   |
| :-------------- | :------ | :-------------------------------------------------------------------------------------------- |
| `URL`           | String  | Radarr URL (e.g., `http://radarr:7878`). Can be set globally via `Variables['Radarr.Url']`.   |
| `ApiKey`        | String  | Radarr API Key. Can be set globally via `Variables['Radarr.ApiKey']`.                         |
| `UseFolderName` | Boolean | Search by folder name instead of file name. Useful for messy filenames but organized folders. |

</details>

### Radarr - Refresh

Triggers a "Rescan Movie" command in Radarr for the processed file.

<details>
<summary><strong>Configuration</strong></summary>

| Parameter | Type   | Description     |
| :-------- | :----- | :-------------- |
| `URI`     | String | Radarr URL.     |
| `ApiKey`  | String | Radarr API Key. |

</details>

### Sonarr - TV Show Lookup

Looks up the episode in Sonarr. Handles season packs and special folder naming conventions.

- **Variables Set:** `Variables.TVShowInfo`, `Variables.VideoMetadata`

<details>
<summary><strong>Configuration (Knobs & Dials)</strong></summary>

| Parameter             | Type    | Description                                                           |
| :-------------------- | :------ | :-------------------------------------------------------------------- | ------- | ------ | -------- | --------- |
| `URL`                 | String  | Sonarr URL. Can be set globally via `Variables['Sonarr.Url']`.        |
| `ApiKey`              | String  | Sonarr API Key. Can be set globally via `Variables['Sonarr.ApiKey']`. |
| `UseFolderName`       | Boolean | Search by folder name.                                                |
| `IgnoredFoldersRegex` | String  | Regex to ignore parent folders (e.g., "Season 1"). Default: `^(Season | Staffel | Saison | Specials | S[0-9]+)` |

</details>

### Sonarr - Refresh

Refreshes the series in Sonarr. Can optionally handle manual import if Sonarr fails to auto-detect the change.

---

## Video Processing Scripts

These scripts handle the complex logic of transcoding decisions.

### Video - Auto Quality

**The "Set and Forget" Quality Node.**
Automatically determines the optimal CRF (Constant Rate Factor) by running fast test encodes on small samples of the video. It uses VMAF (Netflix's perceptual metric) or SSIM to find the highest compression that meets your quality target.

**Pros:**

- Guarantees specific visual quality regardless of source.
- Prevents bloated files (stops if no size reduction).
- Content-aware defaults (Animation gets different targets than Live Action).

**Cons:**

- Slower start time (needs to run test encodes).
- Requires CPU/GPU resources for sampling.

<details>
<summary><strong>Configuration (Knobs & Dials)</strong></summary>

#### Node Parameters

| Parameter           | Default  | Description                                                              | Pros / Cons                                                                                                   |
| :------------------ | :------- | :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------ |
| `TargetVMAF`        | 0 (Auto) | Target quality score (93-99). 0 uses smart defaults based on Year/Genre. | **Higher:** Better quality, larger files.<br>**Lower:** Smaller files, risk of artifacts.                     |
| `MinCRF`            | 18       | Lowest allowed CRF (highest quality cap).                                | **Lower:** Prevents blockiness in simple scenes.<br>**Higher:** Saves space on uncompressable content.        |
| `MaxCRF`            | 28       | Highest allowed CRF (lowest quality cap).                                | **Higher:** Allows massive reduction on easy content.<br>**Lower:** Guarantees minimum quality floor.         |
| `Preset`            | veryslow | Encoder preset for tests and final encode.                               | **Slower:** Better compression/quality ratio.<br>**Faster:** Quicker processing, larger files.                |
| `SampleDurationSec` | 8        | Length of each test sample.                                              | **Longer:** More accurate score.<br>**Shorter:** Faster testing.                                              |
| `ScoreAggregation`  | min      | How to aggregate scores from multiple samples ('min', 'max', 'average'). | **min:** Safest (all parts must look good).<br>**average:** Best for overall quality.<br>**max:** Optimistic. |
| `MinSizeReduction`  | 0        | Minimum % size reduction to proceed.                                     | Set to e.g., 10 to skip files that won't shrink much.                                                         |

#### Advanced Variables

- `Variables.AutoQualityPreset`: Set to 'quality', 'balanced', or 'compression' to override numerical targets.
- `Variables.ForceCRF`: If set, bypasses quality search and forces this CRF value (e.g. "23"). Useful for manual overrides.
- `Variables.MaxFileSize`: If set, the script will increase CRF if the estimated size exceeds this limit (in bytes).
- `Variables.EnforceMaxSize`: Set to `true` to enable MaxFileSize enforcement (otherwise MaxFileSize is only informational).
- `Variables['AutoQuality_VmafFps']`: Override VMAF subsampling FPS (default is source FPS). Lower values = faster VMAF calculation.

##### Variables Set by Script (Output)

- `Variables.AutoQuality_CRF`: Final CRF value chosen ('copy', 'unchanged', or numeric value).
- `Variables.AutoQuality_Reason`: Why the decision was made (e.g., 'forced_by_variable', 'already_optimal', 'insufficient_reduction').
- `Variables.AutoQuality_Metric`: Quality metric used ('vmaf' or 'ssim').
- `Variables.AutoQuality_Target`: Effective quality target used.
- `Variables.AutoQuality_Iterations`: Number of binary search iterations performed.
- `Variables.AutoQuality_Results`: JSON string with detailed search results.
- `Variables.AutoQuality_AvgLuminance`: Average scene brightness (for HDR content awareness).
- `Variables.AutoQuality_LuminanceBoost`: Luminance-based adjustment applied to target.
- `Variables.AutoQuality_ReferenceCRF`: CRF of reference encode (if applicable).
- `Variables.AutoQuality_Score`: Final quality score achieved.
- `Variables.AutoQuality_EstimatedReduction`: Estimated size reduction percentage.
- `Variables.AutoQuality_TargetVMAF`: Backwards compatible VMAF target.
- `Variables.AutoQuality_UpstreamVideoFilters`: Video filters detected upstream (e.g., from Cleaning Filters).
- `Variables.AutoQuality_EncodingParamFilter`: Any `-filter:v:*` found in EncodingParameters.
- `Variables.AutoQuality_FilterSource`: Source of filters ('variables-filters', 'encoding-params', or 'model').
- `Variables.AutoQuality_FilterMode`: Filter mode used ('software-fallback', 'upstream', or 'none').

</details>

### Video - Auto Tag Missing Language

Detects language for "Unknown" (und) audio/subtitle tracks using heuristics (filenames) and offline AI models (SpeechBrain, Whisper).

**Pros:**

- Fixes "Unknown" tracks so players select the right language.
- Can tag files in-place (MKV) without full remuxing.
- Uses local AI (privacy-friendly, no API limits).
- Updates in-memory VideoInfo/FfmpegBuilderModel for immediate downstream access.

**Cons:**

- SpeechBrain/Whisper requires downloading models (handled by DockerMod).
- Sampling takes a few seconds per track.

<details>
<summary><strong>Configuration (Knobs & Dials)</strong></summary>

| Parameter            | Default | Description                                                           |
| :------------------- | :------ | :-------------------------------------------------------------------- |
| `UseHeuristics`      | true    | Guess from track titles (e.g., "[English]"). Extremely fast.          |
| `UseSpeechBrain`     | true    | Use audio analysis. highly accurate for speech.                       |
| `UseWhisperFallback` | true    | Use Whisper.cpp if SpeechBrain is unsure. Slower but robust.          |
| `PreferMkvPropEdit`  | true    | Modifies MKV headers directly (Instant). Uncheck to force full remux. |
| `ForceRetag`         | false   | Run even if language is already set (useful to fix bad tags).         |
| `TagSubtitles`       | true    | Also tag subtitle tracks missing language.                            |

#### Advanced Variables

- `Variables['AudioLangID.ForceRetag']`: Override the node's ForceRetag parameter.
- `Variables['AudioLangID.TagSubtitles']`: Override the node's TagSubtitles parameter.
- `Variables['AudioLangID.SampleStartSeconds']`: Override audio sample start position (default: auto, avoids intros).
- `Variables['AudioLangID.SampleDurationSeconds']`: Override audio sample duration in seconds (default: 25, range: 6-120).

##### Variables Set by Script (Output)

- `Variables['AudioLangID.UpdatedAudioLanguagesByIndex']`: JSON string mapping overall stream indices to ISO-639-2/B language codes.
- `Variables['AudioLangID.UpdatedAudioLanguagesByTypeIndex']`: JSON string mapping audio type indices (0:a:N) to language codes.
- `Variables['AudioLangID.UpdatedSubtitleLanguagesByIndex']`: JSON string mapping subtitle stream indices to language codes.
- `Variables['AudioLangID.UpdatedSubtitleLanguagesByTypeIndex']`: JSON string mapping subtitle type indices (0:s:N) to language codes.

</details>

### Video - Cleaning Filters

**Intelligent Filter Pipeline.**
Applies video filters based on the movie's age, genre, and technical properties (HDR, Grain, Interlacing).

**Features:**

- **Auto-Denoise:** Stronger for 90s anime, lighter for 2000s live action, off for modern clean digital.
- **Smart Deband:** Removes color banding in animation.
- **MpDecimate:** Drops duplicate frames in animation (Variable Frame Rate) to save space.
- **HDR/DoVi Safe:** Preserves dynamic range metadata.

<details>
<summary><strong>Configuration (Knobs & Dials)</strong></summary>

#### Node Parameters

| Parameter               | Description                                 | Pros / Cons                                                                                                 |
| :---------------------- | :------------------------------------------ | :---------------------------------------------------------------------------------------------------------- |
| `SkipDenoise`           | Disable all denoising.                      | **True:** Retains all film grain.<br>**False:** Better compression.                                         |
| `AggressiveCompression` | Stronger filters for old/restored content.  | **True:** Removes heavy grain/noise.<br>**False:** More faithful to source.                                 |
| `AutoDeinterlace`       | Probes for interlacing (idet) and fixes it. | Essential for old TV content. Adds probe time.                                                              |
| `MpDecimateAnimation`   | Drop duplicate frames in Anime.             | **True:** Massive space savings for Anime.<br>**False:** Keeps Constant Frame Rate (safer for old players). |
| `UseCPUFilters`         | Prefer `hqdn3d` over hardware `vpp`.        | **True:** Consistent visual result across GPUs.<br>**False:** Faster (keeps video on GPU).                  |

#### Advanced Variables

- `CleaningFilters.DenoiseBoost`: Add/subtract from the calculated denoise level (e.g., +10 or -10).
- `CleaningFilters.DenoiseMin` / `CleaningFilters.DenoiseMax`: Clamp denoise level to a specific range.
- `CleaningFilters.SkipMpDecimate` / `Variables.SkipDecimate`: Disable mpdecimate completely.
- `Variables.ForceMpDecimate`: Force-enable mpdecimate even if heuristics would disable it.
- `Variables.MpDecimateCfrRate` / `Variables.CfrRate`: Override CFR output framerate.
- `CleaningFilters.SkipQsvTuning`: Skip all QSV encoder tuning parameter application.
- `CleaningFilters.QsvTune.Override`: Override existing QSV tuning parameters instead of only adding missing ones.
- `CleaningFilters.QsvTune.ExtBrc` / `CleaningFilters.QsvTune.ExtBRC`: Extended bitrate control (0-1, default: 1).
- `CleaningFilters.QsvTune.BFrames` / `CleaningFilters.QsvTune.Bf`: B-frames count (0-16, default: 7 for animation, 4 for live action).
- `CleaningFilters.QsvTune.Refs`: Reference frames (1-16, default: 6 for anime, 4 for live action).
- `CleaningFilters.QsvTune.GopSeconds`: GOP length in seconds (1-20, default: 5).
- `CleaningFilters.QsvTune.LookAheadDepth` / `CleaningFilters.QsvTune.LookAhead`: Lookahead depth (1-200).
- `CleaningFilters.QsvTune.AdaptiveI`: Adaptive I-frames (0-1, default: 1).
- `CleaningFilters.QsvTune.AdaptiveB`: Adaptive B-frames (0-1, default: 1).
- `Variables.SkipBandingFix`: Disable all debanding logic.
- `Variables.ForceDeband`: Force-enable debanding.
- `CleaningFilters.ForceEncodingParamFilter`: Force injection of filters into EncodingParameters even when Filters array is used.

##### Variables Set by Script (Output)

**Detection & Metadata:**

- `Variables.detected_hw_encoder`: Detected hardware encoder ('qsv', 'vaapi', 'nvenc', 'none').
- `Variables.hw_frames_likely`: Whether hardware frames are likely in the filtergraph.
- `Variables.target_bit_depth`: Target output bit depth (8 or 10).
- `Variables.applied_qsv_profile`: QSV profile set ('main10' for 10-bit).
- `Variables.source_bit_depth`: Source bit depth detected.
- `Variables.is_hdr`: Whether source is HDR.
- `Variables.is_dolby_vision`: Whether source has Dolby Vision.
- `Variables.isRestoredContent`: Whether content is detected as a modern restoration of old content.
- `Variables.isOldCelAnimation`: Whether content is old cel animation (<=1995).
- `Variables.sourceBitrateKbps`: Source bitrate in Kbps.

**Noise Probe:**

- `Variables.noise_probe_ok`: Whether noise probe succeeded (true/false).
- `Variables.noise_probe_reason`: Reason for probe result or failure.
- `Variables.noise_probe_offsets`: Noise level offsets detected across samples.
- `Variables.noise_probe_samples`: Noise levels detected for each sample.
- `Variables.noise_probe_score`: Overall noise score (lower = cleaner).
- `Variables.noise_probe_adjust`: Adjustment applied to denoise level based on noise score.

**Denoise:**

- `Variables.denoiseLevel`: Final denoise level (0-100).
- `Variables.denoise_boost`: Denoise boost applied.
- `Variables.denoise_min` / `Variables.denoise_max`: Min/max clamps applied.
- `Variables.applied_denoise`: The denoise filter applied (`hqdn3d=...` or `vpp_qsv=denoise=...`).
- `Variables.qsv_denoise_value`: Raw QSV denoise value (0-100).

**Deband:**

- `Variables.applied_deband`: The deband filter applied (e.g., `deband=1thr=0.04:...`).

**MpDecimate:**

- `Variables.mpdecimate_enabled`: Whether mpdecimate was enabled.
- `Variables.mpdecimate_reason`: Reason for enable/disable decision.
- `Variables.mpdecimate_filter`: The mpdecimate filter string used.
- `Variables.mpdecimate_probe_ss`, `Variables.mpdecimate_probe_seconds`, `Variables.mpdecimate_probe_base_frames`, `Variables.mpdecimate_probe_dec_frames`, `Variables.mpdecimate_probe_drop_ratio`: Probe results.
- `Variables.applied_fps_mode`: FPS mode applied ('cfr' if mpdecimate enabled).
- `Variables.applied_r`: Output framerate set.
- `Variables.applied_mpdecimate`: Summary of mpdecimate action.

**Interlace Detection:**

- `Variables.interlace_detect_reason`: Interlace detection result.
- `Variables.interlace_tff`: Top-field-first frame count.
- `Variables.interlace_bff`: Bottom-field-first frame count.
- `Variables.interlace_progressive`: Progressive frame count.
- `Variables.interlace_undetermined`: Undetermined frame count.
- `Variables.detected_interlaced`: Whether content is interlaced.

**Filters:**

- `Variables.applied_vpp_qsv_filter`: Full QSV vpp filter string.
- `Variables.applied_hybrid_cpu_filters`: CPU filters used in hybrid mode.
- `Variables.applied_hybrid_cpu_filters_mode`: Hybrid filter mode ('hwdownload+hwupload' or 'hwdownload-only').
- `Variables.video_filters`: Summary of video filters applied (for downstream).
- `Variables.filters`: Filter list passed to executor.

**QSV Tuning:**

- `Variables.applied_qsv_tuning`: QSV tuning parameters applied.
- `Variables.applied_hdr_color_params`: HDR color metadata params added.

</details>

### Video - FFmpeg Builder Executor (Single Filter)

A replacement for the standard "FFmpeg Builder: Executor" that fixes a critical issue where multiple video filters might be ignored or applied incorrectly. It merges all filters into a single complex filter chain.

**Pros:**

- Guarantees all filters (Denoise, Subtitles, Watermarks) are applied.
- Prevents "only the last filter was applied" bugs.
- Supports progress reporting in the FileFlows UI.
- Writes full FFmpeg command to metadata for auditing.

**Cons:**

- Slightly more complex execution than standard executor.

<details>
<summary><strong>Configuration</strong></summary>

| Parameter                     | Default   | Description                                                       |
| :---------------------------- | :-------- | :---------------------------------------------------------------- |
| `HardwareDecoding`            | Automatic | Enables hardware decoding if QSV filters are used.                |
| `KeepModel`                   | false     | Keep the FfmpegBuilderModel variable after execution.             |
| `WriteFullArgumentsToComment` | true      | Writes the full FFmpeg command to the file metadata for auditing. |
| `MaxCommentLength`            | 32000     | Maximum characters for comment metadata (0 = unlimited).          |

#### Advanced Variables

- `Variables.ForceEncode`: Force execution even if no changes are detected.
- `Variables['FFmpegExecutor.AudioFilterFallbackCodec']`: If audio filters are present but the audio codec is `copy`, re-encode audio using this codec (default: source codec when known/encodable, otherwise `eac3` for MKV and `aac` for MP4/MOV).
- `Variables['ffmpeg']` / `Variables['FFmpeg']` / `Variables.ffmpeg` / `Variables.FFmpeg`: Custom FFmpeg binary path.

##### Variables Set by Script (Output)

- `Variables['FFmpegExecutor.LastCommandLine']`: Full audit command line that was executed.
- `Variables['FFmpegExecutor.LastArgumentsLine']`: Full FFmpeg arguments as a single string.

</details>

### Video - Language Based Track Selection

Keeps only specific languages and removes the rest. Designed to keep "Original Language" + "Your Language".

**Logic:**

1.  Always keeps **Original Language** (found via Lookup script).
2.  Keeps **Additional Languages** specified in settings.
3.  Keeps **Unknown** language tracks _only_ if no Original Language track exists.
4.  **Subtitles** are never deleted, only reordered (Original -> Additional -> Others).

**Requirements:**

- Must run after Movie/TV Show Lookup to have `Variables.OriginalLanguage` available.
- Must run after FFmpeg Builder: Start to have `Variables.FfmpegBuilderModel` available.

<details>
<summary><strong>Configuration</strong></summary>

| Parameter              | Description                                               |
| :--------------------- | :-------------------------------------------------------- |
| `AdditionalLanguages`  | Comma-separated list (e.g., `eng,fra`).                   |
| `ProcessAudio`         | Apply logic to audio tracks.                              |
| `ProcessSubtitles`     | Reorder subtitle tracks.                                  |
| `KeepFirstIfNoneMatch` | Safety net: keep track 1 if nothing matches requirements. |

#### Advanced Variables

- `Variables['OriginalLanguage']`: ISO-639-2/B code of original language (set by Lookup scripts).

##### Variables Set by Script (Output)

- `Variables['TrackSelection.OriginalLanguage']`: Original language ISO code (e.g., "fre", "eng").
- `Variables['TrackSelection.AdditionalLanguages']`: Additional languages kept (comma-separated).
- `Variables['TrackSelection.AllowedLanguages']`: All allowed languages (original + additional).
- `Variables['TrackSelection.DeletedCount']`: Number of streams marked for deletion.
- `Variables['TrackSelection.UndeletedCount']`: Number of streams kept (undeleted).
- `Variables['TrackSelection.ReorderedCount']`: Number of subtitle streams reordered.

</details>

### Video - Audio Format Converter

Converts remaining (non-deleted) audio tracks to a target codec and caps bitrate/sample rate. Intended to run after `Video - Language Based Track Selection` and before `Video - FFmpeg Builder Executor (Single Filter)`.

Note: the script’s “smart copy” behavior is disabled when audio filters are present, since filters require decoding/re-encoding (stream copy can’t be filtered).

<details>
<summary><strong>Configuration</strong></summary>

| Parameter           | Default | Description                                                                                                       |
| :------------------ | :------ | :---------------------------------------------------------------------------------------------------------------- |
| `Codec`             | eac3    | Target audio codec (`eac3`, `ac3`, `aac`, `libopus`, `flac`, or `copy`).                                          |
| `BitratePerChannel` | 96      | Kbps per channel cap (total cap = channels × value). Source bitrate is kept if already lower. Set `0` to disable. |
| `MaxSampleRate`     | 48000   | Maximum sample rate (`48000`, `44100`, or `Same as Source`).                                                      |

##### Variables Modified

- `Variables.FfmpegBuilderModel.AudioStreams[*].Codec`
- `Variables.FfmpegBuilderModel.AudioStreams[*].EncodingParameters`
- `Variables.FfmpegBuilderModel.ForceEncode` (set when changes are made)

</details>

### Video - Resolution Fixed

Simple helper node that outputs the resolution (4K, 1080p, 720p, SD) based on video width/height. Useful for flow branching.

---

## DockerMods

These scripts are used to install dependencies inside the FileFlows Docker container.

- **FFmpegDockerMod.sh**: Installs a "Super Build" of FFmpeg (Jellyfin or BtbN) that supports:
    - `libvmaf` (for Auto Quality)
    - `qsv` / `vaapi` (Hardware acceleration)
    - `libsvtav1` (AV1 encoding)
- **AudioLangIDDockerMod.sh**: Installs Python, SpeechBrain, and Whisper.cpp for the Language ID script.
