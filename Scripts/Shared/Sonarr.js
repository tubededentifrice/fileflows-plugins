import { ServiceApi } from "Shared/ServiceApi";

/**
 * @description Class that interacts with Sonarr
 * @revision 10
 * @minimumVersion 1.0.0.0
 */
export class Sonarr extends ServiceApi
{
    constructor(URL, ApiKey)
    {
        super(URL, ApiKey, 'Sonarr');
    }

    /**
     * Gets all shows in Sonarr
     * @returns {object[]} a list of shows in the Sonarr
     */
    getAllShows(){
        let shows = this.fetchJson('series');
        if(!shows.length){
            Logger.WLog("No shows found");
            return [];
        }
        return shows;
    }

    /**
     * Gets a show from Sonarr by its full path
     * @param {string} path the full path of the movie to lookup
     * @returns {object} a show object if found, otherwise null
     */
    getShowByPath(path)
    {
        if (!path)
        {
            Logger.WLog('No path passed in to find show');
            return null;
        }
        let shows = this.getAllShows();
        if (!shows?.length)
            return null;

        let cp = path.toString().toLowerCase();
        let show = shows.filter(x =>
        {
            let sp = x.path.toLowerCase();
            if (!sp)
                return false;
            return sp.includes(cp);
        });
        if (show?.length === 1)
        {
            show = show[0];
            Logger.ILog('Found show: ' + show.id);
            return show;
        }
        Logger.WLog('Unable to find show file at path: ' + path);
        return null;
    }

    getFilesInShow(show){
        let files = this.fetchJson('episodefile', 'seriesId=' + show.id);
        if(!files.length){
            
            Logger.WLog("No files in show: " + show.title);
            return [];
        }
        return files;
    }

    /**
     * Gets all files in Sonarr
     * @returns {object[]} all files in the Sonarr
     */
    getAllFiles(){
        let shows = this.getAllShows();
        let files = [];
        for(let show of shows){
            let sfiles = this.getFilesInShow(show);
            if(sfiles.length){
                for(let sfile of sfiles)
                    sfile.show = show;
                files = files.concat(sfiles);
            }
        }
        Logger.ILog('Number of show files found: ' + files.length);
        return files;
    }

    /**
     * Gets a show file from Sonarr by its full path
     * @param {string} path the full path of the movie to lookup
     * @returns {object} a show file object if found, otherwise null
     */
    getShowFileByPath(path)
    {
        if (!path)
        {
            Logger.WLog('No path passed in to find show file');
            return null;
        }
        let files = this.getAllFiles();
        if (!files?.length)
            return null;

        let cp = path.toString().toLowerCase();
        let showfile = files.filter(x =>
        {
            let sp = x.path.toLowerCase();
            if (!sp)
                return false;
            return sp.includes(cp);
        });
        if (showfile?.length)
        {
            showfile = showfile[0];
            Logger.ILog('Found show file: ' + showfile.id);
            return showfile;
        }
        Logger.WLog('Unable to find show file at path: ' + path);
        return null;
    }

    /**
     * Gets the IMDb id of a show from its full file path
     * @param {string} path the full path of the show to lookup
     * @returns the IMDb id if found, otherwise null
     */
    getImdbIdFromPath(path)
    {
        if(!path)
            return null;
        let showfile = this.getShowFileByPath(path.toString());
        if (!showfile)
        {
            Logger.WLog('Unable to get IMDb ID for path: ' + path);
            return null;
        }
        return showfile.show.imdbId;
    }

    /**
     * Gets the TVDb id of a show from its full file path
     * @param {string} path the full path of the show to lookup
     * @returns the TVdb id if found, otherwise null
     */
    getTVDbIdFromPath(path)
    {
        if(!path)
            return null;
        let showfile = this.getShowFileByPath(path.toString());
        if (!showfile)
        {
            Logger.WLog('Unable to get TMDb ID for path: ' + path);
            return null;
        }
        return showfile.show.tvdbId;
    }

    /**
     * Gets the language of a show from its full file path
     * @param {string} path the full path of the show to lookup
     * @returns the language of the show if found, otherwise null
     */
    getOriginalLanguageFromPath(path)
    {
        if(!path)
            return null;
        let showfile = this.getShowFileByPath(path.toString());
        if (!showfile)
        {
            Logger.WLog('Unable to get language for path: ' + path);
            return null;
        }
        let imdbId = showfile.show.imdbId;

        let html = this.fetchString(`https://www.imdb.com/title/${imdbId}/`);
        let languages = html.match(/title-details-languages(.*?)<\/li>/);
        if(!languages)
        {
            Logger.WLog('Failed to lookup IMDb language for ' + imdbId);
            return null;
        }
        languages = languages[1];
        let language = languages.match(/primary_language=([\w]+)&/);
        if(!language)
        {
            Logger.WLog('Failed to lookup IMDb primary language for ' + imdbId);
            return null;
        }
        return language[1];
    }

    /**
     * Fetches files Sonarr marks as able to rename
     * @param {int} seriesId ID series to fetch files for
     * @returns List of Sonarr rename objects for each file
     */
    fetchRenamedFiles(seriesId) {
        let endpoint = 'rename';
        let queryParams = `seriesId=${seriesId}`;
        let response = this.fetchJson(endpoint, queryParams);
        return response;
    }

    /**
     * Toggles 'monitored' for episodes
     * @param {list} episodeIds IDs of episodes to toggle
     * @returns Response if ran successfully otherwise null
     */
    toggleMonitored(episodeIds, monitored=true) {
        let endpoint = `${this.BaseUrl}/api/v3/episode/monitor`;
        if (this.BaseUrl.endsWith('/')) endpoint = `${this.BaseUrl}api/v3/episode/monitor`;
        
        let jsonData = JSON.stringify(
            {
                episodeIds: episodeIds,
                monitored: monitored
            }
        );
    
        try {
            http.DefaultRequestHeaders.Add("X-API-Key", this.ApiKey);
            let response = http.PutAsync(endpoint, JsonContent(jsonData)).Result;
            http.DefaultRequestHeaders.Remove("X-API-Key");
        
            if (response.IsSuccessStatusCode) {
                let responseData = JSON.parse(response.Content.ReadAsStringAsync().Result);
                Logger.ILog(`Monitored toggled for ${episodeIds}`);
                return responseData;
            } else {
                let error = response.Content.ReadAsStringAsync().Result;
                Logger.WLog("API error: " + error);
                return null;
            }
        } catch(err) {
            Logger.ELog("Exception toggling monitor: " + err);
            return null;
        }
    }

    /**
     * Rescans all files for a series
     * @param {int} seriesId ID series to rescan
     * @returns Response of the rescan or null if unsuccessful
     */
    rescanSeries(seriesId) {
        let refreshBody = {
                seriesId: seriesId
            }
        return this.sendCommand('RescanSeries', refreshBody)
    }

    /**
     * Fetches an episode object from its file ID
     * @param {int} fileId ID of file
     * @returns Sonarr episode object
     */
    fetchEpisodeFromFileId(episodeFileId) {
        let endpoint = 'episode';
        let queryParams = `episodeFileId=${episodeFileId}`;
        let response = this.fetchJson(endpoint, queryParams);
    
        return response && response.length ? response[0] : null;
    }

    /**
     * Searches for a series by file or folder path in Sonarr
     * @param {string} searchPattern - The search string to use (from the folder or file name)
     * @returns {Object|null} Series object if found, or null if not found
     */
    searchSeriesByPath(searchPattern) {
        try {
            const series = this.getShowByPath(searchPattern);
            return series || null;
        } catch (error) {
            Logger.ELog(`Error searching series by path: ${error.message}`);
            return null;
        }
    }

    /**
     * Searches the Sonarr queue for a series based on the search pattern
     * @param {string} searchPattern - The search string (file or folder name)
     * @returns {Object|null} Series object if found, or null if not found
     */
    searchInQueue(searchPattern) {
        return this.searchApi(
            "queue",
            searchPattern,
            (item, sp) => item.outputPath && item.outputPath.toLowerCase().includes(sp),
            { includeSeries: "true" },
            (item) => {
                Logger.ILog(`Found TV Show in Queue: ${item.series.title}`);
                return item.series;
            }
        );
    }

    /**
     * Searches the Sonarr download history for a series based on the search pattern
     * @param {string} searchPattern - The search string (file or folder name)
     * @returns {Object|null} Series object if found, or null if not found
     */
    searchInDownloadHistory(searchPattern) {
        return this.searchApi(
            "history",
            searchPattern,
            (item, sp) => item.data && item.data.droppedPath && item.data.droppedPath.toLowerCase().includes(sp),
            { eventType: 3, includeSeries: "true" },
            (item) => {
                Logger.ILog(`Found TV Show in History: ${item.series.title}`);
                return item.series;
            }
        );
    }

    /**
     * Refresh a series
     * @param {int} seriesId The ID of the series to refresh
     * @returns {object} The command response
     */
    refreshSeries(seriesId) {
        let refreshBody = {
            seriesIds: [seriesId],
            isNewSeries: false
        };
        return this.sendCommand('RefreshSeries', refreshBody);
    }

    /**
     * Manually imports a file into Sonarr
     * @param {object} fileToImport The file object to import (from manualimport endpoint)
     * @param {int} episodeId The ID of the episode to map to
     * @returns {object} The command response
     */
    manuallyImportFile(fileToImport, episodeId) {
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
        };

        return this.sendCommand('manualImport', body);
    }

    /**
     * Fetches files available for manual import
     * @param {string} currentFileName The name of the file to look for
     * @param {int} seriesId The series ID
     * @param {int} seasonNumber The season number
     * @returns {object} The file object if found, otherwise null
     */
    fetchManualImportFile(currentFileName, seriesId, seasonNumber) {
        let endpoint = 'manualimport';
        let queryParams = `seriesId=${seriesId}&filterExistingFiles=true&seasonNumber=${seasonNumber}`;
        let response = this.fetchJson(endpoint, queryParams);

        if (!response || !Array.isArray(response)) return null;

        for (let file of response) {
            // Check if path ends with filename (handling potential path separators)
            if (file.path && (file.path.endsWith(currentFileName) || file.path.endsWith('\\' + currentFileName) || file.path.endsWith('/' + currentFileName)) && file.episodes.length === 0) {
                return file;
            }
        }

        return null;
    }

    /**
     * Fetches an episode file object by path
     * @param {string} path The path of the episode file
     * @param {object} series The series object
     * @returns {object} The episode file object or null
     */
    fetchEpisodeFile(path, series) {
        Logger.ILog(`Searching for ${path}`);
        let allFiles = this.getFilesInShow(series);

        for (let file of allFiles) {
            if (file.path && (file.path.endsWith(path) || file.path.endsWith('\\' + path) || file.path.endsWith('/' + path))) {
                return file;
            }
        }
        Logger.WLog(`Episode file not found in series ${series.title}`);
        return null;
    }

    /**
     * Fetches an episode object by its ID
     * @param {int} episodeFileId The episode file ID
     * @returns {object} The episode object
     */
    fetchEpisodeFromId(episodeFileId) {
        let endpoint = 'episode';
        let queryParams = `episodeFileId=${episodeFileId}`;
        let response = this.fetchJson(endpoint, queryParams);

        return (response && response.length) ? response[0] : null;
    }

    /**
     * Helper to fetch both episode file and episode details
     * @param {string} currentFileName The current file name/path
     * @param {object} series The series object
     * @returns {Array} [episodeFile, episode]
     */
    fetchEpisode(currentFileName, series) {
        let episodeFile = this.fetchEpisodeFile(currentFileName, series);

        if (!episodeFile) {
            return [null, null];
        }

        let episodeFileId = episodeFile.id;
        let episode = this.fetchEpisodeFromId(episodeFileId);

        return [episodeFile, episode];
    }
}
