/**
 * @name SonarrVc
 * @uid 7035484E-138F-4C2D-8D33-235744A27C35
 * @description Class that interacts with Sonarr
 * @author Vincent Courcelle
 * @revision 12
 * @minimumVersion 1.0.0.0
 */
export class SonarrVc {
    constructor(BaseUrl, ApiKey) {
        this.ServiceName = 'Sonarr';
        this.BaseUrl = BaseUrl || Variables['Sonarr.Url'];
        this.ApiKey = ApiKey || Variables['Sonarr.ApiKey'];
        if (!this.BaseUrl) MissingVariable('Sonarr.Url');
        if (!this.ApiKey) MissingVariable('Sonarr.ApiKey');
    }

    getUrl(endpoint, queryParameters) {
        let url = '' + this.BaseUrl;
        if (url.endsWith('/') === false) url += '/';
        url = url + 'api/v3/' + endpoint + '?apikey=' + this.ApiKey;
        if (queryParameters) url += '&' + queryParameters;
        return url;
    }

    fetchString(url) {
        try {
            const response = http.GetAsync(url).Result;
            const body = response.Content.ReadAsStringAsync().Result;
            if (!response.IsSuccessStatusCode) {
                Logger.WLog(
                    'Unable to fetch ' +
                        this.ServiceName +
                        ' API: ' +
                        url +
                        '\nStatus: ' +
                        response.StatusCode +
                        '\n' +
                        body
                );
                return null;
            }
            return body;
        } catch (err) {
            Logger.ELog('Exception fetching ' + this.ServiceName + ' API: ' + err);
            return null;
        }
    }

    fetchJson(endpoint, queryParameters) {
        const url = this.getUrl(endpoint, queryParameters);
        const json = this.fetchString(url);
        if (!json) return null;
        try {
            return JSON.parse(json);
        } catch (err) {
            Logger.ELog('Failed to parse JSON from ' + this.ServiceName + ' API: ' + err);
            return null;
        }
    }

    sendCommand(commandName, commandBody) {
        let endpoint = this.BaseUrl + '/api/v3/command';
        if (this.BaseUrl.endsWith('/')) endpoint = this.BaseUrl + 'api/v3/command';
        commandBody['name'] = commandName;
        const jsonData = JSON.stringify(commandBody);
        try {
            http.DefaultRequestHeaders.Add('X-API-Key', this.ApiKey);
            const response = http.PostAsync(endpoint, JsonContent(jsonData)).Result;
            http.DefaultRequestHeaders.Remove('X-API-Key');
            if (response.IsSuccessStatusCode) {
                const responseData = JSON.parse(response.Content.ReadAsStringAsync().Result);
                Logger.ILog(commandName + ' command sent successfully to ' + this.ServiceName);
                return responseData;
            } else {
                const error = response.Content.ReadAsStringAsync().Result;
                Logger.WLog(this.ServiceName + ' API error: ' + error);
                return null;
            }
        } catch (err) {
            Logger.ELog('Exception sending command to ' + this.ServiceName + ': ' + err);
            return null;
        }
    }

    waitForCompletion(commandId, timeoutMs) {
        const startTime = new Date().getTime();
        const timeout = timeoutMs || 30000;
        const endpoint = 'command/' + commandId;
        while (new Date().getTime() - startTime <= timeout) {
            const response = this.fetchJson(endpoint, '');
            if (response) {
                if (response.status === 'completed') {
                    Logger.ILog(this.ServiceName + ' command completed!');
                    return true;
                } else if (response.status === 'failed') {
                    Logger.WLog(this.ServiceName + ' command ' + commandId + ' failed');
                    return false;
                }
                Logger.ILog('Checking ' + this.ServiceName + ' status: ' + response.status);
            }
            Sleep(500);
        }
        Logger.WLog(
            'Timeout: ' + this.ServiceName + ' command ' + commandId + ' did not complete within ' + timeout + 'ms.'
        );
        return false;
    }

    buildQueryParams(params) {
        const parts = [];
        for (const key in params) {
            if (Object.prototype.hasOwnProperty.call(params, key)) {
                parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
            }
        }
        return parts.join('&');
    }

    getAllShows() {
        const shows = this.fetchJson('series');
        if (!shows || !shows.length) {
            Logger.WLog('No shows found');
            return [];
        }
        return shows;
    }

    getShowByPath(path) {
        if (!path) return null;
        const shows = this.getAllShows();
        if (!shows || !shows.length) return null;
        const cp = path.toString().toLowerCase();
        for (let i = 0; i < shows.length; i++) {
            const x = shows[i];
            if (x.path && x.path.toLowerCase().indexOf(cp) !== -1) {
                Logger.ILog('Found show: ' + x.id);
                return x;
            }
        }
        return null;
    }

    getFilesInShow(show) {
        const files = this.fetchJson('episodefile', 'seriesId=' + show.id);
        if (!files || !files.length) {
            Logger.WLog('No files in show: ' + show.title);
            return [];
        }
        return files;
    }

    getAllFiles() {
        const shows = this.getAllShows();
        const files = [];
        for (let i = 0; i < shows.length; i++) {
            const show = shows[i];
            const sfiles = this.getFilesInShow(show);
            if (sfiles && sfiles.length) {
                for (let j = 0; j < sfiles.length; j++) {
                    sfiles[j].show = show;
                    files.push(sfiles[j]);
                }
            }
        }
        Logger.ILog('Number of show files found: ' + files.length);
        return files;
    }

    getShowFileByPath(path) {
        if (!path) return null;
        const files = this.getAllFiles();
        if (!files || !files.length) return null;
        const cp = path.toString().toLowerCase();
        for (let i = 0; i < files.length; i++) {
            const x = files[i];
            if (x.path && x.path.toLowerCase().indexOf(cp) !== -1) {
                Logger.ILog('Found show file: ' + x.id);
                return x;
            }
        }
        return null;
    }

    getImdbIdFromPath(path) {
        if (!path) return null;
        const showfile = this.getShowFileByPath(path.toString());
        if (showfile && showfile.show) return showfile.show.imdbId;
        return null;
    }

    getTVDbIdFromPath(path) {
        if (!path) return null;
        const showfile = this.getShowFileByPath(path.toString());
        if (showfile && showfile.show) return showfile.show.tvdbId;
        return null;
    }

    getOriginalLanguageFromPath(path) {
        if (!path) return null;
        const showfile = this.getShowFileByPath(path.toString());
        if (!showfile || !showfile.show || !showfile.show.imdbId) return null;
        const imdbId = showfile.show.imdbId;
        const html = this.fetchString('https://www.imdb.com/title/' + imdbId + '/');
        if (!html) return null;
        const languages = html.match(/title-details-languages(.*?)<\/li>/);
        if (!languages) return null;
        const languageMatch = languages[1].match(/primary_language=([\w]+)&/);
        return languageMatch ? languageMatch[1] : null;
    }

    fetchRenamedFiles(seriesId) {
        return this.fetchJson('rename', 'seriesId=' + seriesId);
    }

    toggleMonitored(episodeIds, monitored) {
        const isMonitored = monitored === undefined ? true : monitored;
        let endpoint = this.BaseUrl + '/api/v3/episode/monitor';
        if (this.BaseUrl.endsWith('/')) endpoint = this.BaseUrl + 'api/v3/episode/monitor';
        const jsonData = JSON.stringify({ episodeIds: episodeIds, monitored: isMonitored });
        try {
            http.DefaultRequestHeaders.Add('X-API-Key', this.ApiKey);
            const response = http.PutAsync(endpoint, JsonContent(jsonData)).Result;
            http.DefaultRequestHeaders.Remove('X-API-Key');
            if (response.IsSuccessStatusCode) {
                Logger.ILog('Monitored toggled for ' + episodeIds);
                const responseData = JSON.parse(response.Content.ReadAsStringAsync().Result);
                return responseData;
            }
            return null;
        } catch (err) {
            Logger.ELog('Exception toggling monitor: ' + err);
            return null;
        }
    }

    rescanSeries(seriesId) {
        return this.sendCommand('RescanSeries', { seriesId: seriesId });
    }

    fetchEpisodeFromFileId(episodeFileId) {
        const response = this.fetchJson('episode', 'episodeFileId=' + episodeFileId);
        return response && response.length ? response[0] : null;
    }

    searchSeriesByPath(searchPattern) {
        return this.getShowByPath(searchPattern);
    }

    searchInQueue(searchPattern) {
        const sp = (searchPattern || '').toLowerCase();
        if (!sp) return null;
        const queryParams = 'includeSeries=true';
        const json = this.fetchJson('queue', queryParams);
        if (!json || !json.records) return null;
        const items = json.records;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.outputPath && item.outputPath.toLowerCase().indexOf(sp) !== -1) {
                Logger.ILog('Found TV Show in Queue: ' + item.series.title);
                return item.series;
            }
        }
        return null;
    }

    searchInDownloadHistory(searchPattern) {
        const sp = (searchPattern || '').toLowerCase();
        if (!sp) return null;
        let page = 1;
        while (true) {
            const queryParams = 'page=' + page + '&pageSize=1000&eventType=3&includeSeries=true';
            const json = this.fetchJson('history', queryParams);
            if (!json || !json.records || json.records.length === 0) break;
            const items = json.records;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.data && item.data.droppedPath && item.data.droppedPath.toLowerCase().indexOf(sp) !== -1) {
                    Logger.ILog('Found TV Show in History: ' + item.series.title);
                    return item.series;
                }
            }
            page++;
        }
        return null;
    }

    refreshSeries(seriesId) {
        return this.sendCommand('RefreshSeries', { seriesIds: [seriesId], isNewSeries: false });
    }

    manuallyImportFile(fileToImport, episodeId) {
        const body = {
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
            importMode: 'auto'
        };
        return this.sendCommand('manualImport', body);
    }

    fetchManualImportFile(currentFileName, seriesId, seasonNumber) {
        const queryParams = 'seriesId=' + seriesId + '&filterExistingFiles=true&seasonNumber=' + seasonNumber;
        const response = this.fetchJson('manualimport', queryParams);
        if (!response || !Array.isArray(response)) return null;
        for (let i = 0; i < response.length; i++) {
            const file = response[i];
            if (
                file.path &&
                (file.path.endsWith(currentFileName) ||
                    file.path.endsWith('\\' + currentFileName) ||
                    file.path.endsWith('/' + currentFileName)) &&
                file.episodes.length === 0
            ) {
                return file;
            }
        }
        return null;
    }

    fetchEpisodeFile(path, series) {
        const allFiles = this.getFilesInShow(series);
        for (let i = 0; i < allFiles.length; i++) {
            const file = allFiles[i];
            if (
                file.path &&
                (file.path.endsWith(path) || file.path.endsWith('\\' + path) || file.path.endsWith('/' + path))
            ) {
                return file;
            }
        }
        return null;
    }

    fetchEpisodeFromId(episodeFileId) {
        const response = this.fetchJson('episode', 'episodeFileId=' + episodeFileId);
        return response && response.length ? response[0] : null;
    }

    fetchEpisode(currentFileName, series) {
        const episodeFile = this.fetchEpisodeFile(currentFileName, series);
        if (!episodeFile) return [null, null];
        return [episodeFile, this.fetchEpisodeFromId(episodeFile.id)];
    }

    /**
     * Updates the series metadata in the global variables based on the Sonarr series data
     * @param {Object} series - Series object returned from Sonarr API
     */
    updateMetadata(series) {
        const language = series.originalLanguage ? LanguageHelper.GetIso1Code(series.originalLanguage.name) : 'en';

        Variables['movie.Title'] = series.title;
        Variables['movie.Year'] = series.year;
        Variables['movie.SonarrId'] = series.id;
        Variables.VideoMetadata = {
            Title: series.title,
            Description: series.overview,
            Year: series.year,
            ReleaseDate: series.firstAired,
            OriginalLanguage: language,
            Genres: series.genres
        };

        Variables.TVShowInfo = series;
        Variables.OriginalLanguage = language;

        Logger.ILog('Detected VideoMetadata: ' + JSON.stringify(Variables.VideoMetadata));
        Logger.ILog('Detected TVShowInfo: ' + JSON.stringify(Variables.TVShowInfo));
        Logger.ILog('Detected Original Language: ' + language);
    }
}
