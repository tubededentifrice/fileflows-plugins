import { Radarr } from 'Shared/Radarr';

/**
 * @description This script will send a refresh command to Radarr
 * @author Vincent Courcelle
 * @revision 1
 * @param {string} URI Radarr root URI and port (e.g. http://radarr:7878)
 * @param {string} ApiKey API Key
 * @output Movie refreshed successfully
 * @output Error or movie not found
 */
function Script(URI, ApiKey) {
    // Remove trailing / from URI
    URI = URI.replace(/\/$/, '');
    let radarr = new Radarr(URI, ApiKey);
    // let folderPath = Variables.folder.FullName;
    // let currentFileName = Variables.file.Name;
    // let newFilePath = null;

    // Find movie name from radarr
    let movieId = Variables["movie.RadarrId"];
    if (!movieId) {
        Logger.WLog(`This script requires the Radarr - Movie search script to be run first`);
        return 2;

        // let [movie, basePath] = findMovie(folderPath, radarr);

        // if (!movie) {
        //     Logger.WLog(`Movie not found for path: ${folderPath}`);
        //     return 2;
        // }

        // movieId = movie.id;
    }

    Logger.ILog(`Refreshing movie ${movieId}`);

    // Get Movie File info
    let movieFiles = radarr.findMovieFiles(movieId);
    if (!movieFiles) {
        Logger.ILog(`No files found for movie ${movieId}`);
        return 2;
    }

    try {
        let refreshBody = {
            movieIds: [movieId],
            isNewMovie: false
        }
        let refreshData = radarr.sendCommand('RefreshMovie', refreshBody)
        Logger.ILog(`Movie refreshed: ${JSON.stringify(refreshData)}`);

        return 1;

    } catch (error) {
        Logger.WLog('Error: ' + error.message);
    }

    return 2;
}

// // Repeatedly try finding a movie by shortening the path
// function findMovie(filePath, radarr) {
//     let currentPath = filePath;
//     let movie = null;

//     let allMovies = radarr.fetchJson('movie');
//     let movieFolders = {};

//     // Map each folder back to its movie
//     for (let movie of allMovies) {
//         let folderName = System.IO.Path.GetFileName(movie.path);
//         movieFolders[folderName] = movie;
//     }

//     while (currentPath) {
//         // Get the childmost piece of the path
//         let currentFolder = System.IO.Path.GetFileName(currentPath);

//         if (movieFolders[currentFolder]) {
//             movie = movieFolders[currentFolder];
//             Logger.ILog('Movie found: ' + movie.id);
//             return [movie, currentPath];
//         }

//         // Log the path where the movie was not found and move up one directory
//         Logger.ILog(`Movie not found at ${currentPath}. Trying ${System.IO.Path.GetDirectoryName(currentPath)}`);
//         currentPath = System.IO.Path.GetDirectoryName(currentPath);
//         if (!currentPath) {
//             Logger.WLog('Unable to find movie file at path ' + filePath);
//             return [null, null];
//         }
//     }

//     return [null, null];
// }
