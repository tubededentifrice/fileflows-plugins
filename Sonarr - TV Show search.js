import { Sonarr } from "Shared/Sonarr";

/**
 * @description This script looks up a TV Show from Sonarr and retrieves its metadata
 * @author Vincent Courcelle
 * @revision 1
 * @param {string} URL Sonarr root URL and port (e.g., http://sonarr:1234)
 * @param {string} ApiKey API Key for Sonarr
 * @param {bool} UseFolderName Whether to use the folder name instead of the file name for the search pattern.<br>If the folder starts with "Season", "Staffel", "Saison", or "Specials", the parent folder will be used.
 * @param {string} IgnoredFoldersRegex Ignore folders that match the regex pattern, takes the parent folder if matched; defaults to `^(Season|Staffel|Saison|Specials|S[0-9]+)` ; case insensitive
 * @output TV Show found
 * @output TV Show NOT found or error
 */
function Script(URL, ApiKey, UseFolderName, IgnoredFoldersRegex) {
    URL = URL || Variables["Sonarr.Url"] || Variables["Sonarr.URI"];
    ApiKey = ApiKey || Variables["Sonarr.ApiKey"];

    Variables["Sonarr.Url"] = URL;
    Variables["Sonarr.URI"] = URL;
    Variables["Sonarr.ApiKey"] = ApiKey;

    const sonarr = new Sonarr(URL, ApiKey);
    const folderPath = Variables.folder.Orig.FullName;
    const filePath = Variables.file.Orig.FullName;
    const searchPattern = UseFolderName
        ? getSeriesFolderName(folderPath, IgnoredFoldersRegex)
        : Variables.file.Orig.FileNameNoExtension;

    Logger.ILog(`Sonarr URL: ${URL}`);
    Logger.ILog(`Lookup TV Show: ${searchPattern}`);

    // Search for the series in Sonarr by path, queue, or download history
    let series =
        searchSeriesByPath(searchPattern, sonarr) ||
        searchInQueue(searchPattern, sonarr) ||
        searchInDownloadHistory(searchPattern, sonarr);

    if (!series) {
        Logger.ILog(`No result found for: ${searchPattern}`);
        return 2; // TV Show not found
    }

    updateSeriesMetadata(series);
    return 1; // TV Show found
}

/**
 * @description Updates the series metadata in the global variables based on the Sonarr series data
 * @param {Object} series - Series object returned from Sonarr API
 */
function updateSeriesMetadata(series) {
    const language = LanguageHelper.GetIso1Code(series.originalLanguage.name);

    Variables["movie.Title"] = series.title;
    Variables["movie.Year"] = series.year;
    Variables["movie.SonarrId"] = series.id;
    Variables.VideoMetadata = {
        Title: series.title,
        Description: series.overview,
        Year: series.year,
        ReleaseDate: series.firstAired,
        OriginalLanguage: language,
        Genres: series.genres,
    };

    Variables.TVShowInfo = series;
    Variables.OriginalLanguage = language;

    Logger.ILog(`Detected VideoMetadata: ${JSON.stringify(Variables.VideoMetadata, null, 2)}`);
    Logger.ILog(`Detected TVShowInfo: ${JSON.stringify(Variables.TVShowInfo, null, 2)}`);
    Logger.ILog(`Detected Original Language: ${language}`);
}

/**
 * @description Extracts the folder name from the provided folder path.
 * * If the folder name contains keywords like Season, Staffel, Saison, or Specials, it uses the parent folder.
 * @param {string} folderPath - The full path of the folder
 * @returns {string} The folder name
 */
function getSeriesFolderName(folderPath, ignoredFoldersRegex) {
    ignoredFoldersRegex = ignoredFoldersRegex || "^(Season|Staffel|Saison|Specials|S[0-9]+)";

    const regex = new RegExp(ignoredFoldersRegex, "i");

    let folder = System.IO.Path.GetFileName(folderPath);
    Logger.ILog(`If folder ${folder} matches regex ${ignoredFoldersRegex}, it will be ignored`);
    if (regex.test(folder)) {
        folderPath = System.IO.Path.GetDirectoryName(folderPath);
        folder = System.IO.Path.GetFileName(folderPath);
        Logger.ILog(`Using ${folder} instead, as parent matched ${ignoredFoldersRegex}`);
    }

    Logger.ILog(`getSeriesFolderName = ${folder}`);
    return folder;
}

/**
 * @description Searches for a series by file or folder path in Sonarr
 * @param {string} searchPattern - The search string to use (from the folder or file name)
 * @param {Object} sonarr - Sonarr API instance
 * @returns {Object|null} Series object if found, or null if not found
 */
function searchSeriesByPath(searchPattern, sonarr) {
    try {
        const series = sonarr.getShowByPath(searchPattern);
        return series || null;
    } catch (error) {
        Logger.ELog(`Error searching series by path: ${error.message}`);
        return null;
    }
}

/**
 * @description Searches the Sonarr queue for a series based on the search pattern
 * @param {string} searchPattern - The search string (file or folder name)
 * @param {Object} sonarr - Sonarr API instance
 * @returns {Object|null} Series object if found, or null if not found
 */
function searchInQueue(searchPattern, sonarr) {
    return searchSonarrAPI("queue", searchPattern, sonarr, (item, sp) => {
        return item.outputPath?.toLowerCase().includes(sp);
    });
}

/**
 * @description Searches the Sonarr download history for a series based on the search pattern
 * @param {string} searchPattern - The search string (file or folder name)
 * @param {Object} sonarr - Sonarr API instance
 * @returns {Object|null} Series object if found, or null if not found
 */
function searchInDownloadHistory(searchPattern, sonarr) {
    return searchSonarrAPI(
        "history",
        searchPattern,
        sonarr,
        (item, sp) => {
            return item.data.droppedPath?.toLowerCase().includes(sp);
        },
        { eventType: 3 }
    );
}

/**
 * @description Generic function to search Sonarr API (queue or history) based on a search pattern
 * @param {string} endpoint - The Sonarr API endpoint to search (queue or history)
 * @param {string} searchPattern - The search string (file or folder name)
 * @param {Object} sonarr - Sonarr API instance
 * @param {Function} matchFunction - A function that determines if an item matches the search pattern
 * @param {Object} [extraParams={}] - Additional query parameters for the API request
 * @returns {Object|null} Series object if found, or null if not found
 */
function searchSonarrAPI(
    endpoint,
    searchPattern,
    sonarr,
    matchFunction,
    extraParams = {}
) {
    let page = 1;
    const pageSize = 1000;
    const includeSeries = "true";
    let sp = null;

    if (!searchPattern) {
        Logger.WLog("No pattern passed in to find TV Show");
        return null;
    } else {
        sp = searchPattern.toLowerCase();
    }

    try {
        while (true) {
            const queryParams = buildQueryParams({
                page,
                pageSize,
                includeSeries,
                ...extraParams,
            });
            const json = sonarr.fetchJson(endpoint, queryParams);
            const items = json.records;

            if (items.length === 0) {
                Logger.WLog(`Reached the end of ${endpoint} with no match.`);
                break;
            }

            const matchingItem = items.find((item) => matchFunction(item, sp));
            if (matchingItem) {
                Logger.ILog(`Found TV Show: ${matchingItem.series.title}`);
                return matchingItem.series;
            }

            if (endpoint === "queue") {
                Logger.WLog(`Reached the end of ${endpoint} with no match.`);
                break;
            }

            page++;
        }
    } catch (error) {
        Logger.ELog(`Error fetching Sonarr ${endpoint}: ${error.message}`);
        return null;
    }
}

/**
 * @description Constructs a query string from the given parameters
 * @param {Object} params - Key-value pairs to be converted into a query string
 * @returns {string} The constructed query string
 */
function buildQueryParams(params) {
    return Object.keys(params)
        .map(
            (key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`
        )
        .join("&");
}
