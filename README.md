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
    - [Video - Resolution Fixed](#video---resolution-fixed)
- [DockerMods](#dockermods)

---

## Integration Pattern

The scripts are designed to work in a specific workflow:

1.  **Lookup**: Retrieve metadata from Radarr/Sonarr (Original Language, Year, Genres).
2.  **Process**: Apply filters and quality settings based on that metadata.
3.  **Refresh**: Notify Radarr/Sonarr to rescan the file after processing.

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
- `Variables.MaxFileSize`: If set, the script will increase CRF if the estimated size exceeds this limit (requires `EnforceMaxSize=true`).
- `Variables.ffmpeg_vmaf`: Path to a custom ffmpeg binary with libvmaf support if the system default lacks it.

</details>

### Video - Auto Tag Missing Language

Detects language for "Unknown" (und) audio/subtitle tracks using heuristics (filenames) and offline AI models (SpeechBrain, Whisper).

**Pros:**

- Fixes "Unknown" tracks so players select the right language.
- Can tag files in-place (MKV) without full remuxing.
- Uses local AI (privacy-friendly, no API limits).

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
- `CleaningFilters.QsvTune.*`: Fine-tune Intel QSV encoder settings (LookAhead, BFrames, Refs).

</details>

### Video - FFmpeg Builder Executor (Single Filter)

A replacement for the standard "FFmpeg Builder: Executor" that fixes a critical issue where multiple video filters might be ignored or applied incorrectly. It merges all filters into a single complex filter chain.

**Pros:**

- Guarantees all filters (Denoise, Subtitles, Watermarks) are applied.
- Prevents "only the last filter was applied" bugs.
- Supports progress reporting in the FileFlows UI.

<details>
<summary><strong>Configuration</strong></summary>

| Parameter                     | Default   | Description                                                       |
| :---------------------------- | :-------- | :---------------------------------------------------------------- |
| `HardwareDecoding`            | Automatic | Enables hardware decoding if QSV filters are used.                |
| `WriteFullArgumentsToComment` | true      | Writes the full FFmpeg command to the file metadata for auditing. |

</details>

### Video - Language Based Track Selection

Keeps only specific languages and removes the rest. Designed to keep "Original Language" + "Your Language".

**Logic:**

1.  Always keeps **Original Language** (found via Lookup script).
2.  Keeps **Additional Languages** specified in settings.
3.  Keeps **Unknown** language tracks _only_ if no Original Language track exists.
4.  **Subtitles** are never deleted, only reordered (Original -> Additional -> Others).

<details>
<summary><strong>Configuration</strong></summary>

| Parameter              | Description                                               |
| :--------------------- | :-------------------------------------------------------- |
| `AdditionalLanguages`  | Comma-separated list (e.g., `eng,fra`).                   |
| `ProcessAudio`         | Apply logic to audio tracks.                              |
| `ProcessSubtitles`     | Reorder subtitle tracks.                                  |
| `KeepFirstIfNoneMatch` | Safety net: keep track 1 if nothing matches requirements. |

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
