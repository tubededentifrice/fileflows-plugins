import { RadarrVc } from 'Shared/RadarrVc';

/**
 * @description This script looks up a Movie from Radarr and retrieves its metadata
 * @author Vincent Courcelle
 * @revision 2
 * @param {string} URL Radarr root URL and port (e.g., http://radarr:1234). If blank/unset, uses variable key(s): `Radarr.Url`, `Radarr.URI`.
 * @param {string} ApiKey API Key for Radarr. If blank/unset, uses variable key: `Radarr.ApiKey`.
 * @param {bool} UseFolderName Whether to use the folder name instead of the file name for search
 * @output Movie found
 * @output Movie NOT found or error
 */
function Script(URL, ApiKey, UseFolderName) {
    URL = URL || Variables['Radarr.Url'] || Variables['Radarr.URI'];
    ApiKey = ApiKey || Variables['Radarr.ApiKey'];

    Variables['Radarr.Url'] = URL;
    Variables['Radarr.URI'] = URL;
    Variables['Radarr.ApiKey'] = ApiKey;

    const radarr = new RadarrVc(URL, ApiKey);
    const folderPath = Variables.folder.Orig.FullName;
    const searchPattern = UseFolderName ? getMovieFolderName(folderPath) : Variables.file.Orig.FileNameNoExtension;

    Logger.ILog('Radarr URL: ' + URL);
    Logger.ILog('Lookup name: ' + searchPattern);

    // Search for the movie in Radarr by path, queue, or download history
    // Logic moved to Shared/RadarrVc.js to enforce DRY
    const movie =
        radarr.searchMovieByPath(searchPattern) ||
        radarr.searchInQueue(searchPattern) ||
        radarr.searchInDownloadHistory(searchPattern);

    if (!movie) {
        Logger.ILog('No result found for: ' + searchPattern);
        return 2; // Movie not found
    }

    radarr.updateMetadata(movie);
    return 1; // Movie found
}

/**
 * @description Extracts the folder name from the provided folder path
 * @param {string} folderPath - The full path of the folder
 * @returns {string} The folder name
 */
function getMovieFolderName(folderPath) {
    return System.IO.Path.GetFileName(folderPath);
}
