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

    getMovieByFile(file) {
        if (!file) return null;
        const movies = this.fetchJson('movie');
        if (!movies || !movies.length) return null;
        const cp = file.toLowerCase();
        for (let i = 0; i < movies.length; i++) {
            const x = movies[i];
            const mp = x.movieFile && x.movieFile.relativePath;
            if (mp && mp.split('.')[0].toLowerCase().indexOf(cp.split('.')[0]) !== -1) {
                Logger.ILog('Found movie: ' + x.title);
                return x;
            }
        }
        return null;
    }

    getMovieByPath(path) {
        if (!path) return null;
        const movies = this.fetchJson('movie');
        if (!movies || !movies.length) return null;
        const cp = path.toLowerCase();
        for (let i = 0; i < movies.length; i++) {
            const x = movies[i];
            const mp = x.movieFile && x.movieFile.path;
            if (mp && mp.toLowerCase().indexOf(cp) !== -1) {
                Logger.ILog('Found movie: ' + x.title);
                return x;
            }
        }
        return null;
    }

    getImdbIdFromPath(path) {
        if (!path) return null;
        const movie = this.getMovieByPath(path.toString());
        if (movie) return movie.imdbId;
        return null;
    }

    getTMDbIdFromPath(path) {
        if (!path) return null;
        const movie = this.getMovieByPath(path.toString());
        if (movie) return movie.tmdbId;
        return null;
    }

    getOriginalLanguageFromPath(path) {
        if (!path) return null;
        const movie = this.getMovieByPath(path.toString());
        if (movie && movie.originalLanguage) return movie.originalLanguage.name;
        return null;
    }

    findMovieFiles(movieId) {
        const response = this.fetchJson('moviefile', 'movieId=' + movieId);
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
        const sp = (searchPattern || '').toLowerCase();
        if (!sp) return null;
        const queryParams = 'includeMovie=true';
        const json = this.fetchJson('queue', queryParams);
        if (!json || !json.records) return null;
        const items = json.records;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.outputPath && item.outputPath.toLowerCase().indexOf(sp) !== -1) {
                Logger.ILog('Found Movie in Queue: ' + item.movie.title);
                return item.movie;
            }
        }
        return null;
    }

    searchInDownloadHistory(searchPattern) {
        const sp = (searchPattern || '').toLowerCase();
        if (!sp) return null;
        let page = 1;
        while (true) {
            const queryParams = 'page=' + page + '&pageSize=1000&eventType=3&includeMovie=true';
            const json = this.fetchJson('history', queryParams);
            if (!json || !json.records || json.records.length === 0) break;
            const items = json.records;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.data && item.data.droppedPath && item.data.droppedPath.toLowerCase().indexOf(sp) !== -1) {
                    Logger.ILog('Found Movie in History: ' + item.movie.title);
                    return item.movie;
                }
            }
            page++;
        }
        return null;
    }

    /**
     * Updates the movie metadata in the global variables based on the Radarr movie data
     * @param {Object} movie - Movie object returned from Radarr API
     */
    updateMetadata(movie) {
        const language = movie.originalLanguage ? LanguageHelper.GetIso1Code(movie.originalLanguage.name) : 'en';

        Variables['movie.Title'] = movie.title;
        Variables['movie.Year'] = movie.year;
        Variables['movie.RadarrId'] = movie.id;
        Variables.VideoMetadata = {
            Title: movie.title,
            Description: movie.overview,
            Year: movie.year,
            ReleaseDate: movie.firstAired,
            OriginalLanguage: language,
            Genres: movie.genres
        };

        Variables.MovieInfo = movie;
        Variables.OriginalLanguage = language;

        Logger.ILog('Detected VideoMetadata: ' + JSON.stringify(Variables.VideoMetadata));
        Logger.ILog('Detected MovieInfo: ' + JSON.stringify(Variables.MovieInfo));
        Logger.ILog('Detected Original Language: ' + language);
    }
}
