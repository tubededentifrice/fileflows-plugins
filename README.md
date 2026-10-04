# FileFlows Plugins

This repository contains custom scripts and plugins for [FileFlows](https://fileflows.com/), a video processing automation tool. These scripts provide advanced functionality for media organization, quality optimization, and content-aware processing.

## Table of Contents

- [FileFlows Tools](#fileflows-tools)
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

## FileFlows Tools

Use `python3 Tools/fileflows.py` from this repository. It needs Python 3.8 or later locally and in the container, Docker, and SSH access. It uses the API inside the container through SSH. Set the required `--host SSH_HOST` before the command. Replace `SSH_HOST` with your SSH host name or `user@host`. Defaults: container `fileflows`, API `http://localhost:5000`. Set `--container` and `--base` before the command for another installation.

```sh
python3 Tools/fileflows.py --host SSH_HOST status
python3 Tools/fileflows.py --host SSH_HOST wait FILE_UID --timeout 1800
python3 Tools/fileflows.py --host SSH_HOST failed
python3 Tools/fileflows.py --host SSH_HOST diagnose --output /tmp/fileflows-diagnosis.json
python3 Tools/fileflows.py --host SSH_HOST media-check FILE_UID --output /tmp/media-check.json
python3 Tools/fileflows.py --host SSH_HOST media-check FILE_UID --starts 500 --duration 15 --no-qsv
python3 Tools/fileflows.py --host SSH_HOST docker-logs --since 48h --match 'error|failed|warning' --context 3
python3 Tools/fileflows.py --host SSH_HOST docker-logs --since 48h --output /tmp/fileflows-docker.log
python3 Tools/fileflows.py --host SSH_HOST mods
python3 Tools/fileflows.py --host SSH_HOST upload-mod DockerMods/AudioLangIDDockerMod.sh --uid DOCKER_MOD_UID
python3 Tools/fileflows.py --host SSH_HOST scripts
python3 Tools/fileflows.py --host SSH_HOST flows
python3 Tools/fileflows.py --host SSH_HOST upload Scripts/Shared/FfmpegHelpers.js
python3 Tools/fileflows.py --host SSH_HOST upload "Scripts/Flow/Video/Video - Auto Quality.js"
python3 Tools/fileflows.py --host SSH_HOST log FILE_UID --match 'CRF|complete|ERRR' --lines 30
python3 Tools/fileflows.py --host SSH_HOST log FILE_UID --source nas --match 'error|failed' --lines 30
python3 Tools/fileflows.py --host SSH_HOST get flow FLOW_UID --output /tmp/flow.json
python3 Tools/fileflows.py --host SSH_HOST save-flow /tmp/flow.json
python3 Tools/fileflows.py --host SSH_HOST backup script SCRIPT_UID
python3 Tools/fileflows.py --host SSH_HOST restore /path/to/backup/object.json
python3 Tools/fileflows.py --host SSH_HOST reprocess FILE_UID --var MinCRF=10
python3 Tools/fileflows.py --host SSH_HOST add --flow-uid TEST_FLOW_UID /temp/extract.mkv
```

Upload finds an existing script by name. Use `--uid SCRIPT_UID` for an exact match. It validates the source, makes a backup, saves, and compares the saved code. FileFlows removes the metadata comment on save. Script header UIDs can differ from the installed object UID; use the `scripts` command to find the installed UID.

Backups are private files under `~/.cache/fileflows/backups`. Use `--backup-dir` to change this path. Each script backup includes `object.json` and the complete exported `source.js`. Flow backups contain the full object. Restore makes a new backup before it writes. Keep backups outside Git: flow objects can contain credentials. Log output removes credential lines and image data. `get --output` keeps exact data in a new file with mode 0600.

`docker-logs` reads both Docker output streams through SSH. It defaults to the last 48 hours and all retained lines. Use `--tail COUNT` to limit the input, `--match REGEX` to filter it, and `--context COUNT` to keep adjacent lines. Plain Docker text keeps comparison operators such as `setuptools<82`. Output files are private and must be new.

`log --source nas` reads retained `.log` and `.log.gz` files directly from the container. Use it when the API's HTML log ends before the failure. It requires the file log to be stored on the selected NAS. The default source is `api`.

`diagnose [FILE_UID ...]` reads retained plain logs for selected files, or all failed files. It reports the failure class, terminal errors, quality trials, recorded size limits, automatic target steps, actual-size attempts, and TrueHD checksum error count. It identifies retention at the automatic quality floor. A missing log has its own result. The failure class is based on log text. Use source decode checks to assess file damage. Old logs can omit the working size budget.

`media-check FILE_UID` runs `Tools/media_check.py` inside the container. It probes all tracks, then decodes eight seconds near the start, middle, and end. Software checks include all audio and non-cover video tracks. QSV checks decode the primary video. It enables CRC checks and records error-level text even when FFmpeg returns zero. VA-API information lines are counted separately. Default decoder threads: 1; `--threads 2` can help compare decoder behavior. `--starts`, `--duration`, `--timeout`, `--ffmpeg`, `--ffprobe`, and `--no-qsv` control the tests. `--full-audio-index N` checks a complete audio track by absolute stream index. Exit 0 means the selected checks were clean; exit 2 means a check failed, timed out, or logged diagnostics. Reports save to new private files with `--output`. The tool writes no media files. Sample checks cover only the selected intervals.

`upload-mod` checks Bash syntax, backs up the selected custom DockerMod, saves it, and checks the stored code and settings. It keeps the name, order, and enabled state. It accepts the server's removal of the final newline and skips saves when the code is equal. Repository DockerMods cannot be selected. `backup dockermod UID`, `get dockermod UID`, and `restore BACKUP/object.json` also support DockerMods; their backup includes `source.sh`. Saving an enabled DockerMod starts its installation on the server and can update agent configuration. Check active jobs first.

`wait` shows progress changes until the file finishes, fails, is held, or reaches the timeout. Exit 0 means processed; exit 2 means failure, hold, or timeout.

Reprocess accepts selected file UIDs. `--flow-uid` selects another flow; `--bottom` queues the files last. `add` accepts paths inside the container. `--var NAME=VALUE` reads JSON values when possible, or uses text. Reprocess uses API `Mode=1` to merge these values with the file’s stored variables; without `--var`, it keeps the stored values. Test extracts with a flow that writes to a test directory before you use a flow that replaces media.

Use `Tools/qsv_benchmark.py` inside the container to compare QSV denoise levels and encoder quality values. It makes short video-only extracts, removes inherited duration tags, and records bytes, speed, MiB/hour, mean VMAF, and the 10th percentile frame score. It also measures VMAF against an identical reference. Results and video extracts stay in a new output directory.

```sh
ssh SSH_HOST 'docker exec -u RUNNER_UID:RUNNER_GID -i fileflows python3 - /temp/source.mkv --output /temp/qsv-test --starts 30 120 --duration 12 --denoise 0 30 50 --quality 14 18' < Tools/qsv_benchmark.py
```

Set `--ffmpeg`, `--ffprobe`, `--metric-ffmpeg`, `--device`, `--crop`, and `--preset` for another installation. The QSV device must be named `gpu`. VMAF compares each candidate with a high-quality reference at the same denoise level. Compare the source and denoised frames visually to check detail loss from denoise. Use moderate levels first. Native HDR VMAF is an encoding check; inspect tone-mapped frames for visual review. This tool keeps source files.

`--compare-denoise` also compares each high-quality denoised reference with the zero-denoise reference. Include level 0 in `--denoise`. This measures filter changes separately from encoding loss. The tool creates missing parent directories and refuses an existing output directory.

Use `Tools/denoise_detail.py` to check existing high-quality reference clips without more encodes. It compares center crops at native resolution and reports decoded hashes, changed pixels, mean differences, and fine brightness/color variation separately. High-frequency values include grain and image detail. Use frames with the same filters and quality apart from denoise.

```sh
ssh SSH_HOST 'docker exec -i fileflows python3 - --reference /temp/qsv-test/sample0-d0-q1.mkv --candidates /temp/qsv-test/sample0-d30-q1.mkv /temp/qsv-test/sample0-d50-q1.mkv' < Tools/denoise_detail.py
```

`--software-decode` uses software decode and hardware upload, as in Auto Quality. `--field-mode progressive` adds `setfield=prog` before hardware processing; use it for content confirmed as progressive. `--field-mode deinterlace` adds QSV deinterlacing. Default field mode: `source`. Compare these modes when an interlaced source has unusually low quality scores at near-lossless settings.

Use the runner's user for test extracts. Replace `RUNNER_UID:RUNNER_GID` with the runner's user and group IDs. Benchmark directories have mode 0700. A directory created as root needs its owner changed before a runner can read it. `media-check --user RUNNER_UID:RUNNER_GID` checks source access as that user.

Checks: `npm test` and `python3 -m unittest discover -s Tests -p 'test_*.py'`.

`Tools/qsv_multistream_check.py` tests two generated video tracks with 8-bit and 10-bit sources. It checks that global QSV decoding reproduces the CPU encoder failure, scoped decoding succeeds, all output tracks decode, and a copied second track keeps the same packet hashes. It requires a new output directory and keeps test files and logs there.

```sh
ssh SSH_HOST 'docker exec -i fileflows python3 - --output /temp/qsv-multistream-test' < Tools/qsv_multistream_check.py
```

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

- Requires the selected sample scores to meet the quality target.
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
| `TargetVMAF`        | 95       | Target quality score (93-99). Quality=97, Balanced=95, Compression=93.   | **Higher:** Better quality, larger files.<br>**Lower:** Smaller files, risk of artifacts.                     |
| `MinCRF`            | 18       | Lowest allowed CRF (highest quality cap). Suggested: 16-20.              | **Lower:** Prevents blockiness in simple scenes.<br>**Higher:** Saves space on uncompressable content.        |
| `MaxCRF`            | 26       | Highest allowed CRF (lowest quality cap). Suggested: 24-30.              | **Higher:** Allows massive reduction on easy content.<br>**Lower:** Guarantees minimum quality floor.         |
| `Preset`            | veryslow | Encoder preset for tests and final encode.                               | **Slower:** Better compression/quality ratio.<br>**Faster:** Quicker processing, larger files.                |
| `SampleDurationSec` | 8        | Length of each test sample.                                              | **Longer:** More accurate score.<br>**Shorter:** Faster testing.                                              |
| `ScoreAggregation`  | average  | How to aggregate scores from multiple samples ('min', 'max', 'average'). | **min:** Safest (all parts must look good).<br>**average:** Best for overall quality.<br>**max:** Optimistic. |
| `MinimumVMAF`       | 0        | Permitted target floor: 90–99; 0 keeps the requested target.             | A lower floor can meet the size limit. More sample tests and complete encodes can take longer.                |
| `MinSizeReduction`  | 0        | Minimum % size reduction to proceed.                                     | Set to e.g., 10 to skip files that won't shrink much.                                                         |

#### Advanced Variables

- With `MinimumVMAF=0`, manual `TargetVMAF` values stay fixed. `TargetVMAF=0` uses content and dark-scene adjustments. Set `AutoQuality.DarkSceneBoost=true` to also apply the dark-scene adjustment to a manual target. VMAF can score an identical animation below 100; do not assume that 98 or 99 is reachable for every scene.
- `Variables.AutoQualityPreset`: Set to 'quality', 'balanced', or 'compression' to override numerical targets.
- `Variables.ForceCRF`: If set, bypasses quality search and forces this CRF value (e.g. "23"). Useful for manual overrides.
- `Variables.MaxFileSize`: Sets the size limit in bytes. A positive value enables size enforcement. Strict mode fails if no tested value meets both limits. Adaptive mode retains the original at its quality floor.
- `AutoQuality.SizeSafetyPercent`: Reserves part of the size limit for sample variation and container overhead. The full-movie test was about 31% larger than its sample estimate; the default reserve covers a 33% increase. Default: 25; range: 0–30. Use `ScoreAggregation=min` to require every sample to pass.
- The results log shows the working `Size Budget` in GiB. Each trial reports `Quality Fail`, `Size Fail`, or `Pass`. A quality pass above the working budget is rejected. Older Auto Quality logs label these binary sizes as GB.
- `EnforceMaxSize`: Node parameter. A positive `MaxFileSize` also enables it.
- QSV sample uploads use the source bit depth. The executor uses the tested encoder options. An encoder error after a successful quality search stops the job; it does not change the settings and retry the full encode.
- `Variables['AutoQuality_VmafFps']`: Override VMAF subsampling FPS (default is source FPS). Lower values = faster VMAF calculation.

##### Variables Set by Script (Output)

- The Single Filter executor copies the primary video stream when Auto Quality returns copy mode, even if output 2 connects to that executor.
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
- `MinimumVMAF`: Lowest permitted automatic target, 90–99. Default 0 keeps strict target enforcement. Set it to 90 to try VMAF 95, 94, 93, 92, 91, then 90 when the size limit requires it. `AutoQuality.MinimumVMAF` is the variable override.
- Adaptive mode rejects `ForceCRF` and a floor above the requested target. It retains clips with missing duration or less than 30 seconds. It requires libvmaf and an explicit original source path. It compares each candidate with a separate high-quality reference encoded from the same source samples with the same cleaning filters. It never encodes a candidate from the reference or a prior candidate.
- Measurements are reused across target steps. Auto Quality prepares measured higher-Q options for the executor. The executor checks the complete output size, including audio and attachments, and retries from the original video until a measured option fits. Filters, preset, frame size, and bit depth stay fixed. Secondary video tracks must be copied.
- Adaptive mode uses the full size limit for its default sample budget. Actual-size checks replace the strict mode's default 25% reserve. An explicit `AutoQuality.SizeSafetyPercent` still applies.
- If no measured option meets the permitted quality floor and size limit, the flow completes with the original retained. It sets `AutoQuality_Reason=original_retained_quality_floor` and stops before replacement or processed-marker nodes. Measurement, source-change, and encoder errors still fail the flow.
- `Variables.AutoQuality_AdaptivePlan`: Original source stamp, measured video settings, output limit, and retry candidates. Do not edit it between Auto Quality and the custom executor.
- `Variables['FFmpegExecutor.SizeAttempts']`: Quality, measured score, actual bytes, and source for each complete encode. Only a fitting output becomes the working file. Quality tags are added after this check and report the fitting quality value.

- `Variables.AutoQuality_UpstreamVideoFilters`: Video filters detected upstream (e.g., from Cleaning Filters).
- `Variables.AutoQuality_EncodingParamFilter`: Any `-filter:v:*` found in EncodingParameters.
- `Variables.AutoQuality_FilterSource`: Source of filters ('variables-filters', 'encoding-params', or 'model').
- `Variables.AutoQuality_FilterMode`: Filter mode used ('upstream' or 'none').
- `Variables.AutoQuality_Validated`: True after a successful search. Used by the executor to keep the tested settings.
- `Variables.AutoQuality_SizeBudget`: Size limit after the safety margin, in bytes.
- Reference and metric runs must succeed for all samples. Metric logs must cover at least 85% of the requested frames. Extracts remove inherited duration tags. Hardware filters are not removed to make a failed test pass. Explicit audio bitrate arguments are included in the size estimate.

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

The interlace probe reads the populated `idet` result when FFmpeg first prints an empty result during filter reconfiguration. It converts numeric and time-string durations to seconds and keeps sample positions within short extracts. When at least 500 sampled frames and 90% of all sampled frames are progressive, the script adds `setfield=prog` before QSV processing. This corrects interlaced flags on progressive segmented content. Confirmed interlaced content uses `deinterlace_qsv`. Failed or empty probes do not force progressive flags.

QSV denoise runs in the source format. Crop uses a separate GPU pass, followed by output format conversion if needed. On the tested Intel driver, a combined crop/denoise or conversion/denoise pass skipped denoise. The same filter plan is used for sample and final encodes.

**Intelligent Filter Pipeline.**
Applies video filters based on the movie's age, genre, and technical properties (HDR, Grain, Interlacing).

**Features:**

- **Auto-Denoise:** Selects noise removal from the source and content settings. QSV noise removal uses the source format. A separate `scale_qsv` pass converts 8-bit sources to Main10. This avoids skipped denoise on Intel drivers when format conversion and denoise share one pass.
- **Smart Deband:** Removes color banding in animation.
- **MpDecimate:** Drops duplicate frames in animation (Variable Frame Rate) to save space.
- **10-bit processing:** Keeps 10-bit sources in P010. Dynamic Dolby Vision and HDR10+ metadata require a separate preservation path during re-encoding.
- **Attached Pictures Safe:** Scopes QSV tuning options to `v:0` when the file contains extra "attached picture" video streams (cover art/logo), preventing FFmpeg failures (eg MJPEG + B-frames).

<details>
<summary><strong>Configuration (Knobs & Dials)</strong></summary>

#### Node Parameters

| Parameter                           | Default | Description                                                                                               | Pros / Cons                                                                                                  |
| :---------------------------------- | :------ | :-------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `NoiseRetention`                    | 3       | How much noise/grain to keep (1=aggressive denoise, 10=keep all noise). Animation tolerates lower values. | **Lower (1-3):** Maximum compression, may smooth fine detail.<br>**Higher (7-10):** Preserves film grain.    |
| `SkipDenoise`                       | false   | Disable all denoising (overrides NoiseRetention).                                                         | **True:** Retains all film grain.<br>**False:** Better compression.                                          |
| `AggressiveCompression`             | false   | Stronger filters for old/restored content (auto-enabled for pre-1990).                                    | **True:** Removes heavy grain/noise.<br>**False:** More faithful to source.                                  |
| `AutoDeinterlace`                   | true    | Probes for interlacing (idet) and fixes it.                                                               | Essential for old TV content. Adds probe time.                                                               |
| `MpDecimateAnimation`               | false   | Allow duplicate-frame removal for Animation/Anime after an auto probe.                                    | **True:** Can save space but may affect A/V sync on some sources.<br>**False:** Keeps original timing safer. |
| `UseCPUFilters`                     | false   | Prefer `hqdn3d` over hardware `vpp`.                                                                      | **True:** Consistent visual result across GPUs.<br>**False:** Faster (keeps video on GPU).                   |
| `AllowCpuFiltersWithHardwareEncode` | true    | Allow CPU filters with hardware encoders (hybrid hw+cpu pipelines).                                       | **True:** More filter options.<br>**False:** Pure hardware pipeline (faster but limited).                    |
| `DenoiseMode`                       | auto    | Select `auto`, `qsv`, `cpu`, `both`, or `off`.                                                            | Use `qsv` for GPU denoise on an Intel QSV encoder.                                                           |
| `QsvLookAhead`                      | true    | Enable QSV encoder lookahead (slower but better compression/quality).                                     | **True:** Better compression at cost of ~10-20% slower encode.<br>**False:** Faster encodes.                 |

#### Advanced Variables

- `CleaningFilters.DenoiseBoost`: Add/subtract from the calculated denoise level (e.g., +10 or -10).
- `CleaningFilters.DenoiseMin` / `CleaningFilters.DenoiseMax`: Clamp denoise level to a specific range.
- `CleaningFilters.DenoiseMode`: Override the node `DenoiseMode` parameter (`auto`, `qsv`, `cpu`, `both`, or `off`). For GPU processing, set `UseCPUFilters=false` and `AllowCpuFiltersWithHardwareEncode=false`. These settings also disable CPU deband and gradfun.
- `CleaningFilters.HybridCpuUpload`: When using hybrid CPU filters on QSV decode surfaces, also `hwupload` back to QSV surfaces (default: false; usually unnecessary since `hevc_qsv` can accept system-memory frames).
- `Variables.hqdn3d`: Force CPU denoise filter params (e.g. `2:2:6:6`). When set, the script auto-enables CPU filters (including with QSV hardware encode) to apply it.
- `Variables.vpp_qsv`: Force QSV denoise level (0-100).
- `CleaningFilters.SkipMpDecimate` / `Variables.SkipDecimate`: Disable mpdecimate completely.
- `Variables.ForceMpDecimate`: Force-enable mpdecimate even if `MpDecimateAnimation` is false or heuristics would disable it.
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
- `Variables.output_video_stream_count`: Count of non-deleted output video streams in the builder model (helps diagnose attached pictures).
- `Variables.applied_qsv_profile`: QSV profile set ('main10' for 10-bit).
- `Variables.source_bit_depth`: Source bit depth detected.
- `Variables.is_hdr`: Whether source is HDR.
- `Variables.is_dolby_vision`: Whether source has Dolby Vision.
- `Variables.isRestoredContent`: Whether content is detected as a modern restoration of old content.
- `Variables.isOldCelAnimation`: Whether content is old cel animation (<=1995).
- `Variables.sourceBitrateKbps`: Source bitrate in Kbps.

**Noise Probe:**

- `Variables.NoiseRetention`: The NoiseRetention setting used (1-10).
- `Variables.noise_probe_ok`: Whether noise probe succeeded (true/false).
- `Variables.noise_probe_reason`: Reason for probe result or failure.
- `Variables.noise_probe_offsets`: Noise level offsets detected across samples.
- `Variables.noise_probe_samples`: Noise levels detected for each sample.
- `Variables.noise_probe_score`: Overall noise score (lower = cleaner).
- `Variables.noise_threshold`: Noise threshold below which denoise is skipped (based on NoiseRetention).
- `Variables.noise_probe_computed_level`: Computed denoise level based on noise score and NoiseRetention.
- `Variables.denoise_skipped_reason`: Reason denoise was skipped (e.g., 'low-noise-detected').

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

Automatic QSV decoding is set per source video track and input file. CPU encoders receive software frames. Unchanged video tracks use stream copy when their codec matches the source and no encoding arguments or filters are set. This keeps additional HEVC tracks from being sent to a CPU encoder by default.

A replacement for the standard "FFmpeg Builder: Executor" that fixes a critical issue where multiple video filters might be ignored or applied incorrectly. It merges all filters into a single complex filter chain.

**Pros:**

- Guarantees all filters (Denoise, Subtitles, Watermarks) are applied.
- Prevents "only the last filter was applied" bugs.
- Supports progress reporting in the FileFlows UI.
- Prevents unscoped video encoder options from breaking attached picture streams (eg `-bf` bleeding into MJPEG cover art).
- Copies cover-art/attached-picture streams (when unfiltered) instead of re-encoding to avoid ffmpeg decode/probe failures on badly-tagged inputs.
- Retries QSV encoder init failures with safer options; optional software fallback for the main video stream (opt-in).
- Caps AC3/EAC3 output at 5.1 when upstream audio parameters request unsupported 7.1/8-channel output.
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
- `Variables['FFmpegExecutor.EnableSoftwareFallbackOnQsvFailure']`: Set to `true` to fall back to software encoding for the main video stream when the QSV encoder cannot be initialized (unsupported profile/driver/runtime options).
- `Variables['FFmpegExecutor.DisableSoftwareFallbackOnQsvFailure']`: Legacy override; set to `true` to forcibly disable software fallback.
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
4.  **Subtitles** are never deleted, only reordered (Preferred Subs -> Original -> Unknown -> Others).
5.  When audio or subtitle streams are reordered, the matching `VideoInfo` stream metadata arrays are reordered too so downstream scripts see the same order that FFmpeg will output.

**Requirements:**

- Must run after Movie/TV Show Lookup to have `Variables.OriginalLanguage` available.
- Must run after FFmpeg Builder: Start to have `Variables.FfmpegBuilderModel` available.

<details>
<summary><strong>Configuration</strong></summary>

| Parameter               | Description                                                                      |
| :---------------------- | :------------------------------------------------------------------------------- |
| `AdditionalLanguages`   | Comma-separated list (e.g., `eng,fra`).                                          |
| `ProcessAudio`          | Apply logic to audio tracks.                                                     |
| `ProcessSubtitles`      | Reorder subtitle tracks.                                                         |
| `KeepFirstIfNoneMatch`  | Safety net: keep track 1 if nothing matches requirements.                        |
| `ReorderTracks`         | Enable reordering (audio + subtitles).                                           |
| `SubtitleSortLanguages` | Subtitle language priority (e.g., `eng,fra`); defaults to `AdditionalLanguages`. |

#### Advanced Variables

- `Variables['OriginalLanguage']`: ISO-639-2/B code of original language (set by Lookup scripts).

##### Variables Set by Script (Output)

- `Variables['TrackSelection.OriginalLanguage']`: Original language ISO code (e.g., "fre", "eng").
- `Variables['TrackSelection.AdditionalLanguages']`: Additional languages kept (comma-separated).
- `Variables['TrackSelection.AllowedLanguages']`: All allowed languages (original + additional).
- `Variables['TrackSelection.DeletedCount']`: Number of streams marked for deletion.
- `Variables['TrackSelection.UndeletedCount']`: Number of streams kept (undeleted).
- `Variables['TrackSelection.ReorderedCount']`: Number of streams reordered.

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
    - Uses a Python venv and one constraints file for all dependency installs: `setuptools<82` for PyTorch and `huggingface_hub==0.19.4` for SpeechBrain. Runs `pip check` after installation.
    - Builds the exact `whisper-cli` target with CMake 3.24 or later. Uses a fresh cache in `build-fileflows` and static Whisper/GGML libraries, so container compiler changes cannot reuse old library paths. Checks the CLI before replacing the installed binary.
    - Uses the SpeechBrain wrapper for model preloading and runtime checks. Keeps models under `/opt/fileflows-langid`. A build, model, or dependency error stops installation. Parallel installer runs use a file lock.
