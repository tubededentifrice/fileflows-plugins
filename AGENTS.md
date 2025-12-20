# AGENTS.md

This file provides guidance to Agents when working with code in this repository.
After any change, ensure this file is kept up to date.
DRY principles should be respected: helper functions, etc. should be moved to a script in `Scripts/Shared` and properly imported (eg. `import { RadarrVc } from "Shared/RadarrVc";`).

## Quality & Consistency

### Linting and Formatting

This repository uses ESLint and Prettier to maintain code quality and consistent formatting.

- **Prettier**: Configured with a 4-space indent to match standard FileFlows community scripts.
- **ESLint**: Configured with FileFlows-specific globals (`Logger`, `Variables`, `Flow`, `http`, `System`, etc.).

**Instructions for Agents:**

1. After editing or creating scripts, run `npm run lint:fix` to ensure code quality and apply automatic fixes.
2. Run `npm run format` to ensure the file matches the project's formatting standards.
3. If `lsp_diagnostics` are unavailable or incomplete, these tools are the source of truth for code standards in this repo.

## Project Overview

This repository contains custom FileFlows scripts for media file processing automation. [FileFlows](https://fileflows.com/) is a self-hosted file processing application that uses flow-based workflows. Scripts are written in JavaScript and executed using the [Jint](https://github.com/sebastienros/jint) engine, which also allows .NET interop.

**Source Code**: [github.com/revenz/FileFlows](https://github.com/revenz/FileFlows) but now invalid since the program was made closed source.

## Script Types

FileFlows has three script types ([docs](https://fileflows.com/docs/webconsole/config/extensions/scripts)):

### Flow Scripts

Scripts available as nodes in FileFlows flows. Must follow strict format with comment block and `Script()` entry point. See [Flow Scripts Documentation](https://fileflows.com/docs/scripting/javascript/flow-scripts/).

Community scripts: [community-repository/Scripts/Flow](https://github.com/fileflows/community-repository) cloned in `/Volumes/External/git/community-repository` for easier reference.

### Shared Scripts (`Scripts/Shared/` directory)

Reusable libraries imported by other scripts. Use ES6 module syntax. Official examples: [community-repository/Scripts/Shared](https://github.com/fileflows/community-repository/tree/main/Scripts/Shared)

```javascript
// Export (in Scripts/Shared/RadarrVc.js):
export class RadarrVc { ... }

// Import (in other scripts):
import { RadarrVc } from "Shared/RadarrVc";
```

### System Scripts

Scripts for scheduled tasks or pre-execute tasks. Return truthy/falsey values - falsey stops the action.

## Script Format

### Comment Block Metadata ([docs](https://fileflows.com/docs/scripting/javascript/flow-scripts/))

```javascript
/**
 * @description Brief description of what the script does
 * @author Author Name
 * @revision 1
 * @minimumVersion 1.0.0.0
 * @param {string} ParamName Parameter description
 * @param {int} MaxValue Integer parameter
 * @param {bool} EnableFeature Boolean parameter
 * @param {('option1'|'option2')} SelectParam Single select dropdown
 * @param {('opt1'|'opt2')[]} MultiSelect Multi-select (array)
 * @output Description of output 1
 * @output Description of output 2
 */
function Script(ParamName, MaxValue, EnableFeature, SelectParam, MultiSelect) {
    return 1; // Output number (1-based)
}
```

### Return Values

- `1+` - Follow output connection N (1 = first @output, 2 = second, etc.)
- `0` - Complete flow successfully (stops immediately)
- `-1` - Error, stop flow as unsuccessful

## FileFlows Built-in Objects

### Variables ([docs](https://fileflows.com/docs/scripting/javascript/flow/variables))

Global map for accessing file info and passing data between nodes. Variables depend on preceding flow nodes.

```javascript
// File properties
Variables.file.FullName; // Current working file path
Variables.file.Name; // Filename with extension (e.g., "MyFile.mkv")
Variables.file.Size; // Current file size in bytes
Variables.file.Orig.FullName; // Original file path
Variables.file.Orig.Size; // Original file size
Variables.file.Orig.FileName; // Original filename
Variables.file.Orig.FileNameNoExtension; // Filename without extension

// Folder properties
Variables.folder.FullName; // Current folder path
Variables.folder.Orig.FullName; // Original folder path

// Video properties (from Video File node, prefix: vi)
Variables.vi?.VideoInfo; // Full VideoInfo object
Variables.video?.Duration; // Video duration in seconds
Variables.video?.Width; // Video width in pixels
Variables.video?.Height; // Video height in pixels
Variables.video?.Resolution; // Computed: 4K/1080p/720p/480p/SD
Variables.video?.HDR; // HDR status

// Custom variables
Variables.MyCustomVar = 'value'; // Set for downstream nodes
Variables['Radarr.Url']; // Access by string key
```

### VideoInfo Object Structure ([docs](https://fileflows.com/docs/plugins/video-nodes/video-file))

```javascript
// VideoInfo class
VideoInfo.FileName; // string
VideoInfo.Bitrate; // number
VideoInfo.VideoStreams; // VideoStream[]
VideoInfo.AudioStreams; // AudioStream[]
VideoInfo.SubtitleStreams; // SubtitleStream[]
VideoInfo.Chapters; // Chapter[]

// VideoStream (extends VideoFileStream)
(VideoStream.Width, Height, FramesPerSecond, Duration); // number
(VideoStream.HDR, DolbyVision); // bool
VideoStream.Bits; // bit depth (0 if undetected)

// AudioStream (extends VideoFileStream)
AudioStream.Language; // string
AudioStream.Channels; // number
AudioStream.SampleRate; // number
AudioStream.Duration; // number

// SubtitleStream (extends VideoFileStream)
SubtitleStream.Language; // string
SubtitleStream.Forced; // bool

// VideoFileStream (base class)
(VideoFileStream.Index, TypeIndex); // number
(VideoFileStream.Title, Codec); // string
VideoFileStream.Bitrate; // number
VideoFileStream.IsImage; // bool
```

### FfmpegBuilderModel ([docs](https://fileflows.com/docs/plugins/video-nodes/ffmpeg-builder/))

For video filter manipulation. Access via `Variables.FfmpegBuilderModel`.

```javascript
const ffmpeg = Variables.FfmpegBuilderModel;
const video = ffmpeg.VideoStreams[0];

// Add filters (forces re-encoding)
video.Filter.Add('hqdn3d=2:2:6:6');
video.Filters.push('scale=1920:1080');

// FfmpegBuilderModel properties
ffmpeg.VideoStreams; // FfmpegVideoStream[]
ffmpeg.AudioStreams; // FfmpegAudioStream[]
ffmpeg.SubtitleStreams; // FfmpegSubtitleStream[]
ffmpeg.Extension; // Output format
ffmpeg.ForceEncode; // bool
ffmpeg.VideoInfo; // Original VideoInfo

// FfmpegVideoStream
video.Filters; // string[] - forces change if set
video.OptionalFilter; // string[] - only if change detected
video.EncodingParameters; // string[]

// FfmpegAudioStream / FfmpegSubtitleStream (stream manipulation)
stream.Deleted; // bool - Set true to remove stream from output
stream.Language; // string - ISO 639-2/B code (e.g., "eng", "fre")
stream.IsDefault; // bool - Mark stream as default
stream.Title; // string - Stream title/description
stream.Index; // number - Overall stream index
stream.TypeIndex; // number - Type-relative index (for -map 0:a:N)
stream.Codec; // string - Codec name
stream.Channels; // number - Audio channels (e.g., 5.1 = 6)
```

When working with `EncodingParameters` and filter injection (e.g. `-filter:v:0`), the FFmpeg Builder docs are the primary reference: [FFmpeg Builder](https://fileflows.com/docs/plugins/video-nodes/ffmpeg-builder/).

### Stream Manipulation Patterns

```javascript
// Remove streams by language
for (let audio of ffmpeg.AudioStreams) {
    if (!LanguageHelper.AreSame(audio.Language, 'eng')) {
        audio.Deleted = true; // Marks for removal
    }
}
ffmpeg.ForceEncode = true; // Required when modifying streams

// Set default track
ffmpeg.AudioStreams[0].IsDefault = true;
```

### Logger

```javascript
Logger.ILog('info message'); // Information
Logger.WLog('warning message'); // Warning
Logger.ELog('error message'); // Error
Logger.DLog('debug message'); // Debug
```

### Flow Object ([docs](https://fileflows.com/docs/scripting/javascript/flow/))

```javascript
// File operations
Flow.TempPath; // Temp directory path
Flow.NewGuid(); // Generate unique ID
Flow.SetWorkingFile(path, dontDelete); // Set current working file
Flow.ResetWorkingFile(); // Revert to original file
Flow.MoveFile(destination); // Move file
Flow.CopyToTemp(filename); // Copy to temp path
Flow.GetDirectorySize(path); // Directory size in bytes

// Tool execution
Flow.GetToolPath('ffmpeg'); // Get configured tool path
Flow.Execute(args); // Execute external command

// Flow reporting (shown in the Processing Runner UI)
// See: https://fileflows.com/docs/scripting/javascript/flow/
Flow.AdditionalInfoRecorder(name, value, steps);

// Properties
(Flow.FileName, Flow.WorkingFile, Flow.WorkingFileName);
(Flow.IsDocker, Flow.IsWindows, Flow.IsLinux, Flow.IsMac);
```

### Flow.Execute ([docs](https://fileflows.com/docs/scripting/javascript/flow/execute))

```javascript
let process = Flow.Execute({
    command: Flow.GetToolPath('ffmpeg'),
    argumentList: ['-i', Variables.file.FullName, '-c:v', 'libx265', output],
    workingDirectory: '/path/to/dir', // optional
    timeout: 3600 // optional, seconds
});

// Result object
process.exitCode; // number
process.standardOutput; // string
process.standardError; // string
process.completed; // bool
```

### HTTP Client (for API calls)

Uses .NET HttpClient. See [Microsoft HttpClient docs](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient).

```javascript
// GET request
let response = http.GetAsync(url).Result;
let body = response.Content.ReadAsStringAsync().Result;
response.IsSuccessStatusCode; // bool

// POST/PUT with headers
http.DefaultRequestHeaders.Add('X-API-Key', apiKey);
let response = http.PostAsync(endpoint, JsonContent(jsonData)).Result;
http.DefaultRequestHeaders.Remove('X-API-Key');
```

### Other Built-ins

```javascript
Sleep(milliseconds); // Pause execution
MissingVariable('VarName'); // Report missing required variable
LanguageHelper.GetIso1Code('English'); // Convert to ISO 639-1 (2-letter: 'en')
LanguageHelper.GetIso2Code('en'); // Convert to ISO 639-2/B (3-letter: 'eng')
LanguageHelper.AreSame('fre', 'fra'); // Compare languages (handles fre/fra/fr/French)
LanguageHelper.GetEnglishFor('fre'); // Get English name ('French')

// .NET interop
System.IO.Path.GetFileName(path);
System.IO.Path.GetDirectoryName(path);
System.IO.File.Create(path);
System.IO.Directory.GetFiles(path);
new System.IO.FileInfo(path).Directory;
```

## Repository Structure

```
DockerMods/       - Container helper scripts (Docker Mods)
Scripts/          - FileFlows script root (matches community-repository layout)
Scripts/Shared/   - Reusable script libraries (Radarr.js, Sonarr.js)
Scripts/Flow/     - Flow scripts available as nodes
```

### Key Scripts

- `Scripts/Flow/Applications/Radarr/Radarr - Movie Lookup.js` / `Scripts/Flow/Applications/Sonarr/Sonarr - TV Show Lookup.js` - Look up media metadata from \*arr apps
- `Scripts/Flow/Applications/Radarr/Radarr - Refresh.js` / `Scripts/Flow/Applications/Sonarr/Sonarr - Refresh.js` - Notify \*arr apps after processing
- `Scripts/Flow/Video/Video - Cleaning Filters.js` - Adaptive filters: QSV `vpp_qsv=denoise` (merged into crop/format vpp when needed) + optional `deinterlace_qsv` (auto-detect via `idet`), plus optional CPU deband/gradfun and heuristic `mpdecimate` for Animation/Anime (duplicate-frame removal; keeps output CFR via `-fps_mode cfr` + `-r`, adds `setpts` after `mpdecimate` to keep timestamps monotonic) with safe hw-frame bridging (`hwdownload` to `nv12`/`p010le`, optional convert to planar `yuv420p` for 8-bit CPU detours, and (Main10-safe) ensure the CPU detour ends in `p010le` before `hwupload` for QSV encodes); avoids “double `-filter:v:0`” with FFmpeg Builder Video Encode Advanced 10-bit QSV by removing `-pix_fmt p010le` when `vpp_qsv` already outputs `p010le` (prevents Builder injecting a second `scale_qsv=format=p010le` filter); de-dupes existing `-filter:v:0` args and optionally injects a single `-filter:v:0` into `VideoStreams[0].EncodingParameters` when `Variables['CleaningFilters.ForceEncodingParamFilter']` is set; also applies conservative QSV tuning params (lookahead/extbrc/GOP/B-frames/refs) when missing. Year fallback: extracts from filename (`.YYYY.` pattern, e.g., `Movie.1986.BluRay.mkv`) when `Variables.VideoMetadata.Year` is unavailable
- `Scripts/Flow/Video/Video - FFmpeg Builder Executor (Single Filter).js` - Drop-in replacement for the `FFmpeg Builder: Executor` node that merges all upstream video filters (from `Filter`/`Filters`/`OptionalFilter` and any `-vf`/`-filter:v:*` present in `EncodingParameters`) into a single `-filter:v:N` per output stream to avoid FFmpeg only applying the last filter; reports UI progress using ffmpeg `-progress pipe:2` output (`out_time_ms`, with `time=` / `Duration:` fallbacks); optionally writes the full ffmpeg command line into the output container `comment` tag for auditing.
- `Scripts/Flow/Video/Video - Auto Quality.js` - VMAF-based automatic quality detection (VMAF preferred; SSIM fallback) using binary search to find the highest compression that meets target quality (content-aware targets). Encodes test samples using the FFmpeg Builder encoder + `EncodingParameters` (e.g. QSV stays QSV; uses `-global_quality:v` for QSV) so results match the final pass, and extracts short video-only samples once to avoid repeatedly seeking the full file. If upstream filters require QSV, it pre-encodes high-quality filtered reference samples once; otherwise it compares against the raw/filtered source in the metric pass. Supports VMAF subsampling via `Variables.AutoQuality_VmafFps`; streams ffmpeg progress to the UI while sampling/metric runs are executing.
- `Scripts/Flow/Video/Video - Auto Tag Missing Language.js` - Detects missing/`und` (or force re-tags via `Variables['AudioLangID.ForceRetag']`) audio track languages using heuristics + offline LID (SpeechBrain; whisper.cpp fallback) and tags tracks via `mkvpropedit` (MKV; sets legacy `language` and modern `language-ietf`/BCP47 when possible) or ffmpeg remux; sample timing can be overridden via `Variables['AudioLangID.SampleStartSeconds']` / `Variables['AudioLangID.SampleDurationSeconds']`, duration fields are parsed from numeric seconds or `TimeSpan`-style strings, auto sampling avoids intros when duration is unknown, and the script updates in-memory `VideoInfo`/`FfmpegBuilderModel` audio `Language` properties so downstream nodes can read the new tags immediately (also stores `Variables['AudioLangID.UpdatedAudioLanguagesByIndex']`).
- `DockerMods/FFmpegDockerMod.sh` - Container helper to install an FFmpeg that supports the filters/encoders required by `Scripts/Flow/Video/Video - Cleaning Filters.js` and `Scripts/Flow/Video/Video - Auto Quality.js` (QSV/VAAPI, OpenCL runtime deps best-effort, and metrics like `libvmaf`/`ssim`). Installs Jellyfin + BtbN builds and sets `/usr/local/bin/ffmpeg` to either the best single build or a small selector wrapper (`FFMPEG_FORCE=jellyfin|btbn`).
- `DockerMods/AudioLangIDDockerMod.sh` - Container helper to install offline audio language detection tools used by `Scripts/Flow/Video/Video - Auto Tag Missing Language.js` (`mkvpropedit`, SpeechBrain LID wrapper, whisper.cpp fallback, and cached models); installs Python deps into a venv under `/opt/fileflows-langid/venv` to avoid PEP 668 pip failures (pins `huggingface_hub` for SpeechBrain compatibility and forces caches under `/opt/fileflows-langid`), includes `sox`/`libsox-fmt-all` so torchaudio backends are available, symlinks wrappers into `/usr/bin` in case `/usr/local/bin` isn’t on `PATH`, and creates an uninstall shim named `"<script> --uninstall"` to work around FileFlows sudo quoting during DockerMod uninstall.
- `Scripts/Flow/Video/Video - Language Based Track Selection.js` - Keeps only audio tracks matching the original language or specified additional languages; keeps unknown-language audio unless an original-language audio track exists; marks non-matching audio tracks with `Deleted=true`; never deletes subtitles (only reorders them using the same language priority rules); stores selection metadata in `Variables['TrackSelection.*']` for downstream scripts. Requires Movie/TV Show Lookup to run first for `Variables.OriginalLanguage`.
- `Scripts/Flow/Video/*.js` - Bitrate (MiB/hour) and resolution detection utilities

## Integration Pattern

Scripts follow this workflow:

1. **Search script** (`*search.js`) looks up media in Radarr/Sonarr via API, stores in `Variables.VideoMetadata`, `Variables.MovieInfo`/`Variables.TVShowInfo`
2. **Processing** happens (video conversion with FFmpeg Builder)
3. **Refresh script** (`*Refresh.js`) notifies Radarr/Sonarr to rescan using stored IDs

Required variables: `Variables['Radarr.Url']`, `Variables['Radarr.ApiKey']`, `Variables['Sonarr.Url']`, `Variables['Sonarr.ApiKey']`

## Documentation Links

### Official Documentation

- [FileFlows Main Site](https://fileflows.com/)
- [Scripting Overview](https://fileflows.com/docs/scripting/)
- [Flow Scripts](https://fileflows.com/docs/scripting/javascript/flow-scripts/)
- [Variables](https://fileflows.com/docs/scripting/javascript/flow/variables)
- [Flow Object](https://fileflows.com/docs/scripting/javascript/flow/) - Flow API and `AdditionalInfoRecorder(...)` for flow reporting (progress/info to the Processing Runner UI)
- [Flow.Execute](https://fileflows.com/docs/scripting/javascript/flow/execute)
- [Function Examples](https://fileflows.com/docs/scripting/javascript/function-examples)
- [Video File Node](https://fileflows.com/docs/plugins/video-nodes/video-file)
- [FFmpeg Builder](https://fileflows.com/docs/plugins/video-nodes/ffmpeg-builder/)
- [Function Node](https://docs.fileflows.com/plugins/basic-nodes/function)
- [Variables Guide](https://docs.fileflows.com/guides/variables)

### Repositories

- [FileFlows Source Code](https://github.com/revenz/FileFlows)
- [Community Script Repository](https://github.com/fileflows/community-repository)
- [Shared Scripts Examples](https://github.com/fileflows/community-repository/tree/main/Scripts/Shared)

### API References

- [Radarr API v3](https://radarr.video/docs/api/)
- [Sonarr API v3](https://sonarr.tv/docs/api/)
