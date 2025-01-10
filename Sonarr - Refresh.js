import { Sonarr } from 'Shared/Sonarr';

/**
 * @description This script will refresh the show through Sonarr
 * @author Vincent Courcelle
 * @revision 1
 * @param {string} URI Sonarr root URI and port (e.g. http://sonarr:8989)
 * @param {string} ApiKey API Key
 * @output Series refreshed successfully
 * @output Error or serie not found
 */
function Script(URI, ApiKey) {
    // Remove trailing / from URI
    URI = URI.replace(/\/$/, '');
    let sonarr = new Sonarr(URI, ApiKey);
    // const folderPath = Variables.folder.Orig.FullName;
    const ogFileName = Variables.file.Orig.FileName;
    const ogFullName = Variables.file.Orig.FullName;
    let currentFileName = Variables.file.FullName;
    // let newFilePath = null;

    const series = Variables["TVShowInfo"];
    let seriesId = Variables["movie.SonarrId"];
    if (!seriesId) {
        Logger.WLog(`This script requires the Radarr - Movie search script to be run first`);
        return 2;

        // // Find series name from sonarr
        // let [series, basePath] = findSeries(folderPath, sonarr);

        // if (series?.id === undefined) {
        //     Logger.WLog('Series not found for path: ' + folderPath);
        //     return 2;
        // } else {
        //     Logger.ILog(`Series found: ${series.title}`);
        // }

        // seriesId = series.id;
    }

    Logger.ILog(`Refreshing serie ${seriesId}`);

    // Fetch the episode of the serie before touching anything
    let [ogEpisodeFile, episode] = fetchEpisode(ogFullName, series, sonarr);
    if (episode?.id !== undefined) {
        Logger.ILog(`Original episode found: Season ${episode.seasonNumber} Episode: ${episode.episodeNumber}`)
    } else {
        Logger.WLog(`Episode could not be extracted from series`);
    }

    // Ensure series is refreshed before renaming
    let refreshData = refreshSeries(seriesId, sonarr);
    let refreshCompleted = sonarr.waitForCompletion(refreshData.id, sonarr);
    if (!refreshCompleted) {
        Logger.WLog('Refresh failed');
        return 2;
    }

    if (episode?.id) {
        // Sometimes sonarr doesn't autodetect the transcoded files so we need to manually import it for Sonarr to rename it
        let manualImport = fetchManualImportFile(ogFileName, seriesId, episode.seasonNumber, sonarr);
        if (manualImport) {
            Logger.ILog('Updated file not auto-detected by Sonarr. Manually importing')

            let importCommand = manuallyImportFile(manualImport, episode.id, sonarr)
            let importCompleted = sonarr.waitForCompletion(importCommand.id, sonarr);
            if (!importCompleted) {
                Logger.WLog('import not completed');
                return 2;
            }

            // Refresh for newly imported episode
            refreshData = refreshSeries(seriesId, sonarr);
            refreshCompleted = sonarr.waitForCompletion(refreshData.id, sonarr);
            if (!refreshCompleted) {
                Logger.WLog('Refresh failed');
                return 2;
            }
        } else {
            Logger.ILog(`Manual import not needed`);
        }
    }

    return 1;

}

// // Repeatedly try finding a show by shortening the path
// function findSeries(filePath, sonarr) {
//     let currentPath = filePath;
//     let show = null;

//     let allSeries = sonarr.getAllShows();
//     let seriesFolders = {};

//     // Map each folder back to its series
//     for (let series of allSeries) {
//         let folderName = System.IO.Path.GetFileName(series.path);
//         seriesFolders[folderName] = series;
//     }

//     while (currentPath) {
//         // Get childmost piece of path to work with different remote paths
//         let currentFolder = System.IO.Path.GetFileName(currentPath);

//         if (seriesFolders[currentFolder]) {
//             show = seriesFolders[currentFolder];
//             Logger.ILog('Show found: ' + show.id);
//             return [show, currentPath];
//         }

//         // If no show is found, go up 1 dir
//         Logger.ILog(`Show not found at ${currentPath}. Trying ${System.IO.Path.GetDirectoryName(currentPath)}`)
//         currentPath = System.IO.Path.GetDirectoryName(currentPath);
//         if (!currentPath) {
//             Logger.WLog('Unable to find show file at path ' + filePath);
//             return [null, null];
//         }
//     }
//     return [null, null];
// }

function fetchEpisode(currentFileName, series, sonarr) {
    let episodeFile = fetchEpisodeFile(currentFileName, series, sonarr);

    if (!episodeFile) {
        return [null, null];
    }

    let episodeFileId = episodeFile.id;
    let episode = fetchEpisodeFromId(episodeFileId, sonarr);

    return [episodeFile, episode];
}

function fetchEpisodeFile(path, series, sonarr) {
    Logger.ILog(`Searching for ${path}`);
    let allFiles = sonarr.getFilesInShow(series);

    for (let file of allFiles) {
        if (file.path.endsWith(path)) {
            return file;
        }
    }
    Logger.WLog(`Episode file not found in series ${series.title}`);
    return null
}

// function fetchRenamedFiles(seriesId, sonarr) {
//     let endpoint = 'rename';
//     let queryParams = `seriesId=${seriesId}`;
//     let response = sonarr.fetchJson(endpoint, queryParams);
//     return response;
// }

function fetchEpisodeFromId(episodeFileId, sonarr) {
    let endpoint = 'episode';
    let queryParams = `episodeFileId=${episodeFileId}`;
    let response = sonarr.fetchJson(endpoint, queryParams);

    return response[0];
}

function fetchManualImportFile(currentFileName, seriesId, seasonNumber, sonarr) {
    let endpoint = 'manualimport';
    let queryParams = `seriesId=${seriesId}&filterExistingFiles=true&seasonNumber=${seasonNumber}`;
    let response = sonarr.fetchJson(endpoint, queryParams);

    for (let file of response) {
        if (file.path.endsWith(currentFileName) && file.episodes.length === 0) {
            return file;
        }
    }

    return null;
}

function manuallyImportFile(fileToImport, episodeId, sonarr) {
    let body = {
        files: [
            {
                path: fileToImport.path,
                folderName: fileToImport.folderName,
                seriesId: fileToImport.series.id,
                episodeIds: [episodeId],
                quality: fileToImport.quality,
                languages: fileToImport.languages,
                indexerFlags: fileToImport.indexerFlags,
                releaseType: fileToImport.releaseType,
                releaseGroup: fileToImport.releaseGroup
            }
        ],
        importMode: 'auto',
    }

    return sonarr.sendCommand('manualImport', body)
}

function refreshSeries(seriesId, sonarr) {
    let refreshBody = {
            seriesIds: [seriesId],
            isNewSeries: false
        }
    return sonarr.sendCommand('RefreshSeries', refreshBody)
}

// function toggleMonitored(episodeIds, URI, ApiKey, monitored=true) {
//     let endpoint = `${URI}/api/v3/episode/monitor`;
//     let jsonData = JSON.stringify(
//         {
//             episodeIds: episodeIds,
//             monitored: monitored
//         }
//     );

//     http.DefaultRequestHeaders.Add("X-API-Key", ApiKey);
//     let response = http.PutAsync(endpoint, JsonContent(jsonData)).Result;

//     http.DefaultRequestHeaders.Remove("X-API-Key");

//     if (response.IsSuccessStatusCode) {
//         let responseData = JSON.parse(response.Content.ReadAsStringAsync().Result);
//         Logger.ILog(`Monitored toggled for ${episodeIds}`);
//         return responseData;
//     } else {
//         let error = response.Content.ReadAsStringAsync().Code;
//         Logger.WLog("API error when manually imoporting. code " + error);
//         return null;
//     }
// }

// function fetchEpisode(currentFileName, series, sonarr) {
//     let episodeFile = fetchEpisodeFile(currentFileName, series, sonarr);

//     if (!episodeFile) {
//         return [null, null];
//     }

//     let episodeFileId = episodeFile.id;
//     let episode = fetchEpisodeFromId(episodeFileId, sonarr);

//     return [episodeFile, episode];
// }
