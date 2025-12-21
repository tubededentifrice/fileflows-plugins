/**
 * @name RadarrVc
 * @uid CA7865F9-894B-2788-5E6E-34004FC2847A
 * @description Class that interacts with Radarr
 * @author Vincent Courcelle
 * @revision 21
 * @minimumVersion 1.0.0.0
 */
export class RadarrVc {
    constructor(BaseUrl, ApiKey) {
        this.ServiceName = 'Radarr';
        this.BaseUrl = BaseUrl || Variables['Radarr.Url'];
        this.ApiKey = ApiKey || Variables['Radarr.ApiKey'];
        if (!this.BaseUrl) MissingVariable('Radarr.Url');
        if (!this.ApiKey) MissingVariable('Radarr.ApiKey');
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

    getMovieByFile(file) {
        if (!file) return null;
        var movies = this.fetchJson('movie');
        if (!movies || !movies.length) return null;
        var cp = file.toLowerCase();
        for (var i = 0; i < movies.length; i++) {
            var x = movies[i];
            var mp = x.movieFile && x.movieFile.relativePath;
            if (mp && mp.split('.')[0].toLowerCase().indexOf(cp.split('.')[0]) !== -1) {
                Logger.ILog('Found movie: ' + x.title);
                return x;
            }
        }
        return null;
    }

    getMovieByPath(path) {
        if (!path) return null;
        var movies = this.fetchJson('movie');
        if (!movies || !movies.length) return null;
        var cp = path.toLowerCase();
        for (var i = 0; i < movies.length; i++) {
            var x = movies[i];
            var mp = x.movieFile && x.movieFile.path;
            if (mp && mp.toLowerCase().indexOf(cp) !== -1) {
                Logger.ILog('Found movie: ' + x.title);
                return x;
            }
        }
        return null;
    }

    getImdbIdFromPath(path) {
        if (!path) return null;
        var movie = this.getMovieByPath(path.toString());
        if (movie) return movie.imdbId;
        return null;
    }

    getTMDbIdFromPath(path) {
        if (!path) return null;
        var movie = this.getMovieByPath(path.toString());
        if (movie) return movie.tmdbId;
        return null;
    }

    getOriginalLanguageFromPath(path) {
        if (!path) return null;
        var movie = this.getMovieByPath(path.toString());
        if (movie && movie.originalLanguage) return movie.originalLanguage.name;
        return null;
    }

    findMovieFiles(movieId) {
        var response = this.fetchJson('moviefile', 'movieId=' + movieId);
        Logger.ILog('Movie found: ' + movieId);
        return response;
    }

    fetchRenamedMovies(movieId) {
        return this.fetchJson('rename', 'movieId=' + movieId);
    }

    searchMovieByPath(searchPattern) {
        return this.getMovieByPath(searchPattern);
    }

    searchInQueue(searchPattern) {
        var sp = (searchPattern || '').toLowerCase();
        if (!sp) return null;
        var queryParams = 'includeMovie=true';
        var json = this.fetchJson('queue', queryParams);
        if (!json || !json.records) return null;
        var items = json.records;
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.outputPath && item.outputPath.toLowerCase().indexOf(sp) !== -1) {
                Logger.ILog('Found Movie in Queue: ' + item.movie.title);
                return item.movie;
            }
        }
        return null;
    }

    searchInDownloadHistory(searchPattern) {
        var sp = (searchPattern || '').toLowerCase();
        if (!sp) return null;
        var page = 1;
        while (true) {
            var queryParams = 'page=' + page + '&pageSize=1000&eventType=3&includeMovie=true';
            var json = this.fetchJson('history', queryParams);
            if (!json || !json.records || json.records.length === 0) break;
            var items = json.records;
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (item.data && item.data.droppedPath && item.data.droppedPath.toLowerCase().indexOf(sp) !== -1) {
                    Logger.ILog('Found Movie in History: ' + item.movie.title);
                    return item.movie;
                }
            }
            page++;
        }
        return null;
    }
}
