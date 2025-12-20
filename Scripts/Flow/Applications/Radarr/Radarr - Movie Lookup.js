import { RadarrVc } from 'Shared/RadarrVc';

/**
 * @description This script looks up a Movie from Radarr and retrieves its metadata
 * @author Vincent Courcelle
 * @revision 2
 * @param {string} URL Radarr root URL and port (e.g., http://radarr:1234)
 * @param {string} ApiKey API Key for Radarr
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

    Logger.ILog(`Radarr URL: ${URL}`);
    Logger.ILog(`Lookup name: ${searchPattern}`);

    // Search for the movie in Radarr by path, queue, or download history
    // Logic moved to Shared/RadarrVc.js to enforce DRY
    let movie =
        radarr.searchMovieByPath(searchPattern) ||
        radarr.searchInQueue(searchPattern) ||
        radarr.searchInDownloadHistory(searchPattern);

    if (!movie) {
        Logger.ILog(`No result found for: ${searchPattern}`);
        return 2; // Movie not found
    }

    updateMovieMetadata(movie);
    return 1; // Movie found
}

/**
 * @description Updates the movie metadata in the global variables based on the Radarr movie data
 * @param {Object} movie - Movie object returned from Radarr API
 */
function updateMovieMetadata(movie) {
    const language = LanguageHelper.GetIso1Code(movie.originalLanguage.name);

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

    Logger.ILog(`Detected VideoMetadata: ${JSON.stringify(Variables.VideoMetadata, null, 2)}`);
    Logger.ILog(`Detected MovieInfo: ${JSON.stringify(Variables.MovieInfo, null, 2)}`);
    Logger.ILog(`Detected Original Language: ${language}`);
}

/**
 * @description Extracts the folder name from the provided folder path
 * @param {string} folderPath - The full path of the folder
 * @returns {string} The folder name
 */
function getMovieFolderName(folderPath) {
    return System.IO.Path.GetFileName(folderPath);
}
