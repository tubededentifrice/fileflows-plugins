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
        var url = '' + this.BaseUrl;
        if (url.endsWith('/') === false) url += '/';
        url = url + 'api/v3/' + endpoint + '?apikey=' + this.ApiKey;
        if (queryParameters) url += '&' + queryParameters;
        return url;
    }

    fetchString(url) {
        try {
            var response = http.GetAsync(url).Result;
            var body = response.Content.ReadAsStringAsync().Result;
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
        var url = this.getUrl(endpoint, queryParameters);
        var json = this.fetchString(url);
        if (!json) return null;
        try {
            return JSON.parse(json);
        } catch (err) {
            Logger.ELog('Failed to parse JSON from ' + this.ServiceName + ' API: ' + err);
            return null;
        }
    }

    sendCommand(commandName, commandBody) {
        var endpoint = this.BaseUrl + '/api/v3/command';
        if (this.BaseUrl.endsWith('/')) endpoint = this.BaseUrl + 'api/v3/command';
        commandBody['name'] = commandName;
        var jsonData = JSON.stringify(commandBody);
        try {
            http.DefaultRequestHeaders.Add('X-API-Key', this.ApiKey);
            var response = http.PostAsync(endpoint, JsonContent(jsonData)).Result;
            http.DefaultRequestHeaders.Remove('X-API-Key');
            if (response.IsSuccessStatusCode) {
                var responseData = JSON.parse(response.Content.ReadAsStringAsync().Result);
                Logger.ILog(commandName + ' command sent successfully to ' + this.ServiceName);
                return responseData;
            } else {
                var error = response.Content.ReadAsStringAsync().Result;
                Logger.WLog(this.ServiceName + ' API error: ' + error);
                return null;
            }
        } catch (err) {
            Logger.ELog('Exception sending command to ' + this.ServiceName + ': ' + err);
            return null;
        }
    }

    waitForCompletion(commandId, timeoutMs) {
        var startTime = new Date().getTime();
        var timeout = timeoutMs || 30000;
        var endpoint = 'command/' + commandId;
        while (new Date().getTime() - startTime <= timeout) {
            var response = this.fetchJson(endpoint, '');
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
        var parts = [];
        for (var key in params) {
            if (Object.prototype.hasOwnProperty.call(params, key)) {
                parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
            }
        }
        return parts.join('&');
    }

    getAllShows() {
        var shows = this.fetchJson('series');
        if (!shows || !shows.length) {
            Logger.WLog('No shows found');
            return [];
        }
        return shows;
    }

    getShowByPath(path) {
        if (!path) return null;
        var shows = this.getAllShows();
        if (!shows || !shows.length) return null;
        var cp = path.toString().toLowerCase();
        for (var i = 0; i < shows.length; i++) {
            var x = shows[i];
            if (x.path && x.path.toLowerCase().indexOf(cp) !== -1) {
                Logger.ILog('Found show: ' + x.id);
                return x;
            }
        }
        return null;
    }

    getFilesInShow(show) {
        var files = this.fetchJson('episodefile', 'seriesId=' + show.id);
        if (!files || !files.length) {
            Logger.WLog('No files in show: ' + show.title);
            return [];
        }
        return files;
    }

    getAllFiles() {
        var shows = this.getAllShows();
        var files = [];
        for (var i = 0; i < shows.length; i++) {
            var show = shows[i];
            var sfiles = this.getFilesInShow(show);
            if (sfiles && sfiles.length) {
                for (var j = 0; j < sfiles.length; j++) {
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
        var files = this.getAllFiles();
        if (!files || !files.length) return null;
        var cp = path.toString().toLowerCase();
        for (var i = 0; i < files.length; i++) {
            var x = files[i];
            if (x.path && x.path.toLowerCase().indexOf(cp) !== -1) {
                Logger.ILog('Found show file: ' + x.id);
                return x;
            }
        }
        return null;
    }

    getImdbIdFromPath(path) {
        if (!path) return null;
        var showfile = this.getShowFileByPath(path.toString());
        if (showfile && showfile.show) return showfile.show.imdbId;
        return null;
    }

    getTVDbIdFromPath(path) {
        if (!path) return null;
        var showfile = this.getShowFileByPath(path.toString());
        if (showfile && showfile.show) return showfile.show.tvdbId;
        return null;
    }

    getOriginalLanguageFromPath(path) {
        if (!path) return null;
        var showfile = this.getShowFileByPath(path.toString());
        if (!showfile || !showfile.show || !showfile.show.imdbId) return null;
        var imdbId = showfile.show.imdbId;
        var html = this.fetchString('https://www.imdb.com/title/' + imdbId + '/');
        if (!html) return null;
        var languages = html.match(/title-details-languages(.*?)<\/li>/);
        if (!languages) return null;
        var languageMatch = languages[1].match(/primary_language=([\w]+)&/);
        return languageMatch ? languageMatch[1] : null;
    }

    fetchRenamedFiles(seriesId) {
        return this.fetchJson('rename', 'seriesId=' + seriesId);
    }

    toggleMonitored(episodeIds, monitored) {
        var isMonitored = monitored === undefined ? true : monitored;
        var endpoint = this.BaseUrl + '/api/v3/episode/monitor';
        if (this.BaseUrl.endsWith('/')) endpoint = this.BaseUrl + 'api/v3/episode/monitor';
        var jsonData = JSON.stringify({ episodeIds: episodeIds, monitored: isMonitored });
        try {
            http.DefaultRequestHeaders.Add('X-API-Key', this.ApiKey);
            var response = http.PutAsync(endpoint, JsonContent(jsonData)).Result;
            http.DefaultRequestHeaders.Remove('X-API-Key');
            if (response.IsSuccessStatusCode) {
                Logger.ILog('Monitored toggled for ' + episodeIds);
                var responseData = JSON.parse(response.Content.ReadAsStringAsync().Result);
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
        var response = this.fetchJson('episode', 'episodeFileId=' + episodeFileId);
        return response && response.length ? response[0] : null;
    }

    searchSeriesByPath(searchPattern) {
        return this.getShowByPath(searchPattern);
    }

    searchInQueue(searchPattern) {
        var sp = (searchPattern || '').toLowerCase();
        if (!sp) return null;
        var queryParams = 'includeSeries=true';
        var json = this.fetchJson('queue', queryParams);
        if (!json || !json.records) return null;
        var items = json.records;
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.outputPath && item.outputPath.toLowerCase().indexOf(sp) !== -1) {
                Logger.ILog('Found TV Show in Queue: ' + item.series.title);
                return item.series;
            }
        }
        return null;
    }

    searchInDownloadHistory(searchPattern) {
        var sp = (searchPattern || '').toLowerCase();
        if (!sp) return null;
        var page = 1;
        while (true) {
            var queryParams = 'page=' + page + '&pageSize=1000&eventType=3&includeSeries=true';
            var json = this.fetchJson('history', queryParams);
            if (!json || !json.records || json.records.length === 0) break;
            var items = json.records;
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
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
        var body = {
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
        var queryParams = 'seriesId=' + seriesId + '&filterExistingFiles=true&seasonNumber=' + seasonNumber;
        var response = this.fetchJson('manualimport', queryParams);
        if (!response || !Array.isArray(response)) return null;
        for (var i = 0; i < response.length; i++) {
            var file = response[i];
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
        var allFiles = this.getFilesInShow(series);
        for (var i = 0; i < allFiles.length; i++) {
            var file = allFiles[i];
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
        var response = this.fetchJson('episode', 'episodeFileId=' + episodeFileId);
        return response && response.length ? response[0] : null;
    }

    fetchEpisode(currentFileName, series) {
        var episodeFile = this.fetchEpisodeFile(currentFileName, series);
        if (!episodeFile) return [null, null];
        return [episodeFile, this.fetchEpisodeFromId(episodeFile.id)];
    }
}
