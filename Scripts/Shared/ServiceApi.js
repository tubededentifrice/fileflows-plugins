/**
 * @description Base class for API services (Radarr, Sonarr, etc)
 * @revision 1
 */
export class ServiceApi {
    constructor(BaseUrl, ApiKey, ServiceName) {
        this.ServiceName = ServiceName || 'Service';
        this.BaseUrl = BaseUrl;
        this.ApiKey = ApiKey;

        // Auto-resolve from variables if not passed
        if (!this.BaseUrl) {
            const keys = [`${this.ServiceName}.Url`, `${this.ServiceName}.URI`];
            for (let key of keys) {
                if (Variables[key]) {
                    this.BaseUrl = Variables[key];
                    break;
                }
            }
        }

        if (!this.ApiKey) {
            this.ApiKey = Variables[`${this.ServiceName}.ApiKey`];
        }

        if (!this.BaseUrl) MissingVariable(`${this.ServiceName}.Url`);
        if (!this.ApiKey) MissingVariable(`${this.ServiceName}.ApiKey`);
    }

    getUrl(endpoint, queryParameters) {
        let url = String(this.BaseUrl);
        if (!url.endsWith('/')) url += '/';
        url = `${url}api/v3/${endpoint}?apikey=${this.ApiKey}`;
        if (queryParameters) url += '&' + queryParameters;
        return url;
    }

    fetchString(url) {
        try {
            let response = http.GetAsync(url).Result;
            let body = response.Content.ReadAsStringAsync().Result;
            if (!response.IsSuccessStatusCode) {
                Logger.WLog(`Unable to fetch ${this.ServiceName} API: ${url}\nStatus: ${response.StatusCode}\n${body}`);
                return null;
            }
            return body;
        } catch (err) {
            Logger.ELog(`Exception fetching ${this.ServiceName} API: ${err}`);
            return null;
        }
    }

    fetchJson(endpoint, queryParameters) {
        let url = this.getUrl(endpoint, queryParameters);
        let json = this.fetchString(url);
        if (!json) return null;
        try {
            return JSON.parse(json);
        } catch (err) {
            Logger.ELog(`Failed to parse JSON from ${this.ServiceName} API: ${err}`);
            return null;
        }
    }

    sendCommand(commandName, commandBody) {
        let endpoint = `${this.BaseUrl}/api/v3/command`;
        if (this.BaseUrl.endsWith('/')) endpoint = `${this.BaseUrl}api/v3/command`; // avoid double slash if needed, or use robust join

        commandBody['name'] = commandName;
        let jsonData = JSON.stringify(commandBody);

        try {
            http.DefaultRequestHeaders.Add('X-API-Key', this.ApiKey);
            let response = http.PostAsync(endpoint, JsonContent(jsonData)).Result;
            http.DefaultRequestHeaders.Remove('X-API-Key');

            if (response.IsSuccessStatusCode) {
                let responseData = JSON.parse(response.Content.ReadAsStringAsync().Result);
                Logger.ILog(`${commandName} command sent successfully to ${this.ServiceName}`);
                return responseData;
            } else {
                let error = response.Content.ReadAsStringAsync().Result;
                Logger.WLog(`${this.ServiceName} API error: ${error}`);
                return null;
            }
        } catch (err) {
            Logger.ELog(`Exception sending command to ${this.ServiceName}: ${err}`);
            return null;
        }
    }

    waitForCompletion(commandId, timeoutMs) {
        const startTime = new Date().getTime();
        const timeout = timeoutMs || 30000;
        const endpoint = `command/${commandId}`;

        while (new Date().getTime() - startTime <= timeout) {
            let response = this.fetchJson(endpoint, '');
            if (response) {
                if (response.status === 'completed') {
                    Logger.ILog(`${this.ServiceName} command completed!`);
                    return true;
                } else if (response.status === 'failed') {
                    Logger.WLog(`${this.ServiceName} command ${commandId} failed`);
                    return false;
                }
                Logger.ILog(`Checking ${this.ServiceName} status: ${response.status}`);
            }
            Sleep(500);
        }
        Logger.WLog(`Timeout: ${this.ServiceName} command ${commandId} did not complete within ${timeout}ms.`);
        return false;
    }

    buildQueryParams(params) {
        return Object.keys(params)
            .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
            .join('&');
    }

    /**
     * Generic search method for Queue or History
     * @param {string} endpoint "queue" or "history"
     * @param {string} searchPattern Pattern to match
     * @param {Function} matchFunction (item, pattern) => bool
     * @param {Object} extraParams
     * @param {Function} resultMapper (item) => result object
     */
    searchApi(endpoint, searchPattern, matchFunction, extraParams, resultMapper) {
        let page = 1;
        const pageSize = 1000;
        let sp = (searchPattern || '').toLowerCase();

        if (!sp) {
            Logger.WLog(`No pattern passed in to find ${this.ServiceName} item`);
            return null;
        }

        try {
            while (true) {
                const queryParams = this.buildQueryParams({
                    page,
                    pageSize,
                    ...extraParams
                });

                const json = this.fetchJson(endpoint, queryParams);
                if (!json || !json.records) break;

                const items = json.records;
                if (items.length === 0) {
                    Logger.WLog(`Reached the end of ${endpoint} with no match.`);
                    break;
                }

                const matchingItem = items.find((item) => matchFunction(item, sp));
                if (matchingItem) {
                    return resultMapper(matchingItem);
                }

                if (endpoint === 'queue') {
                    Logger.WLog(`Reached the end of ${endpoint} with no match.`);
                    break;
                }

                page++;
            }
        } catch (error) {
            Logger.ELog(`Error fetching ${this.ServiceName} ${endpoint}: ${error.message}`);
        }
        return null;
    }
}
