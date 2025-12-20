import { SonarrVc } from 'Shared/SonarrVc';

/**
 * @description This script looks up a TV Show from Sonarr and retrieves its metadata
 * @author Vincent Courcelle
 * @revision 2
 * @param {string} URL Sonarr root URL and port (e.g., http://sonarr:1234)
 * @param {string} ApiKey API Key for Sonarr
 * @param {bool} UseFolderName Whether to use the folder name instead of the file name for the search pattern.<br>If the folder starts with "Season", "Staffel", "Saison", or "Specials", the parent folder will be used.
 * @param {string} IgnoredFoldersRegex Ignore folders that match the regex pattern, takes the parent folder if matched; defaults to `^(Season|Staffel|Saison|Specials|S[0-9]+)` ; case insensitive
 * @output TV Show found
 * @output TV Show NOT found or error
 */
function Script(URL, ApiKey, UseFolderName, IgnoredFoldersRegex) {
    URL = URL || Variables['Sonarr.Url'] || Variables['Sonarr.URI'];
    ApiKey = ApiKey || Variables['Sonarr.ApiKey'];

    Variables['Sonarr.Url'] = URL;
    Variables['Sonarr.URI'] = URL;
    Variables['Sonarr.ApiKey'] = ApiKey;

    const sonarr = new SonarrVc(URL, ApiKey);
    const folderPath = Variables.folder.Orig.FullName;
    const searchPattern = UseFolderName
        ? getSeriesFolderName(folderPath, IgnoredFoldersRegex)
        : Variables.file.Orig.FileNameNoExtension;

    Logger.ILog(`Sonarr URL: ${URL}`);
    Logger.ILog(`Lookup TV Show: ${searchPattern}`);

    // Search for the series in Sonarr by path, queue, or download history
    // Logic moved to Shared/SonarrVc.js to enforce DRY
    let series =
        sonarr.searchSeriesByPath(searchPattern) ||
        sonarr.searchInQueue(searchPattern) ||
        sonarr.searchInDownloadHistory(searchPattern);

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
    ignoredFoldersRegex = ignoredFoldersRegex || '^(Season|Staffel|Saison|Specials|S[0-9]+)';

    const regex = new RegExp(ignoredFoldersRegex, 'i');

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
