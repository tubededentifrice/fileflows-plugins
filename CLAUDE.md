# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains custom FileFlows scripts for media file processing automation. FileFlows is a self-hosted file processing application that uses flow-based workflows. Scripts are written in JavaScript and executed using the Jint engine.

## Script Types

### Flow Scripts
Scripts available as nodes in FileFlows flows. Must follow strict format with comment block and `Script()` entry point.

### Shared Scripts (`Shared/` directory)
Reusable libraries imported by other scripts. Use ES6 module syntax:
```javascript
// Export (in Shared/Radarr.js):
export class Radarr { ... }

// Import (in other scripts):
import { Radarr } from "Shared/Radarr";
```

## Script Format

### Comment Block (Required)
```javascript
/**
 * @description Brief description of what the script does
 * @author Author Name
 * @revision 1
 * @param {string} ParamName Parameter description
 * @param {int} MaxValue Integer parameter
 * @param {bool} EnableFeature Boolean parameter
 * @output Description of output 1
 * @output Description of output 2
 */
function Script(ParamName, MaxValue, EnableFeature) {
    // Script logic
    return 1; // Output number (1-based)
}
```

### Return Values
- Return `1+` to specify which output connection to follow (1 = first output, 2 = second, etc.)
- Return `0` to complete flow successfully (stops immediately)
- Return `-1` to indicate error and stop flow as unsuccessful

## FileFlows Built-in Objects

### Variables
Global map for accessing file info and passing data between nodes:
```javascript
Variables.file.Orig.FullName      // Original file path
Variables.file.Orig.Size          // Original file size
Variables.folder.Orig.FullName    // Original folder path
Variables.video?.Duration         // Video duration in seconds
Variables.video?.Width            // Video width
Variables.video?.Height           // Video height
Variables.FfmpegBuilderModel      // FFMPEG builder (for video filters)
Variables.VideoMetadata           // Custom metadata object
Variables['Radarr.Url']           // Variable by string key
```

### Logger
```javascript
Logger.ILog('info message');     // Information
Logger.WLog('warning message');  // Warning
Logger.ELog('error message');    // Error
Logger.DLog('debug message');    // Debug
```

### HTTP (for API calls)
```javascript
let response = http.GetAsync(url).Result;
let body = response.Content.ReadAsStringAsync().Result;
response.IsSuccessStatusCode  // boolean

http.DefaultRequestHeaders.Add("X-API-Key", apiKey);
http.PostAsync(endpoint, JsonContent(jsonData)).Result;
http.PutAsync(endpoint, JsonContent(jsonData)).Result;
http.DefaultRequestHeaders.Remove("X-API-Key");
```

### Other Built-ins
- `Sleep(milliseconds)` - Pause execution
- `System.IO.Path.GetFileName(path)` - .NET path utilities
- `System.IO.Path.GetDirectoryName(path)`
- `LanguageHelper.GetIso1Code(languageName)` - Language code lookup
- `MissingVariable(name)` - Report missing required variable

## Repository Structure

```
Shared/           - Reusable script libraries (Radarr.js, Sonarr.js)
Video/            - Video analysis scripts (resolution, bitrate checks)
*.js (root)       - Flow scripts for Radarr/Sonarr integration
```

### Key Scripts
- `Radarr - Movie search.js` / `Sonarr - TV Show search.js` - Look up media metadata
- `Radarr - Refresh.js` / `Sonarr - Refresh.js` - Notify *arr apps after processing
- `Cleaning filters.js` - Apply denoising filters based on video age/genre
- `Video/*.js` - Bitrate and resolution detection utilities

## Integration Pattern

Scripts typically follow this workflow:
1. Search script (`*search.js`) looks up media in Radarr/Sonarr, stores metadata in `Variables`
2. Processing happens (video conversion, etc.)
3. Refresh script (`*Refresh.js`) notifies Radarr/Sonarr to rescan

Required variables are accessed via `Variables['Radarr.Url']`, `Variables['Radarr.ApiKey']`, etc.

## Documentation Links

- [FileFlows Scripting Overview](https://fileflows.com/docs/scripting/)
- [Flow Scripts Documentation](https://fileflows.com/docs/scripting/javascript/flow-scripts/)
- [Function Node Reference](https://docs.fileflows.com/plugins/basic-nodes/function)
- [Variables Guide](https://docs.fileflows.com/guides/variables)
- [Community Script Repository](https://github.com/fileflows/community-repository)
