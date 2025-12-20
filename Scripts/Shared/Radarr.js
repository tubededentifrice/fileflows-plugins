import { ServiceApi } from "Shared/ServiceApi";

/**
 * @description Class that interacts with Radarr
 * @revision 8
 * @minimumVersion 1.0.0.0
 */
export class Radarr extends ServiceApi
{
    constructor(URL, ApiKey)
    {
        super(URL, ApiKey, 'Radarr');
    }

    /**
     * Gets a movie from Radarr by its file name
     * @param {string} file the file name of the movie to lookup
     * @returns {object} a movie object if found, otherwise null
     */
    getMovieByFile(file)
    {
        if (!file)
        {
            Logger.WLog('No file name passed in to find movie');
            return null;
        }
        let movies = this.fetchJson('movie');
        if (!movies?.length)
            return null;

        let cp = file.toLowerCase();
        let movie = movies.filter(x =>
        {
            let mp = x.movieFile?.relativePath;
            if (!mp)
                return false;
            return mp.split('.')[0].toLowerCase().includes(cp.split('.')[0]);
        });
        if (movie?.length)
        {
            movie = movie[0];
            Logger.ILog('Found movie: ' + movie.title);
            return movie;
        }
        Logger.WLog('Unable to find movie file name: ' + file);
        return null;
    }

    /**
     * Gets a movie from Radarr by its path
     * @param {string} path the path of the movie to lookup
     * @returns {object} a movie object if found, otherwise null
     */
    getMovieByPath(path)
    {
        if (!path)
        {
            Logger.WLog('No path passed in to find movie');
            return null;
        }
        let movies = this.fetchJson('movie');
        if (!movies?.length)
            return null;

        let cp = path.toLowerCase();
        let movie = movies.filter(x =>
        {
            let mp = x.movieFile?.path;
            if (!mp)
                return false;
            return mp.toLowerCase().includes(cp);
        });
        if (movie?.length)
        {
            movie = movie[0];
            Logger.ILog('Found movie: ' + movie.title);
            return movie;
        }
        Logger.WLog('Unable to find movie at path: ' + path);
        return null;
    }

    /**
     * Gets the IMDb id of a movie from its full file path
     * @param {string} path the full path of the movie to lookup
     * @returns the IMDb id if found, otherwise null
     */
    getImdbIdFromPath(path)
    {
        if(!path)
            return null;
        let movie = this.getMovieByPath(path.toString());
        if (!movie)
        {
            Logger.WLog('Unable to get IMDb ID for path: ' + path);
            return null;
        }
        return movie.imdbId;
    }

    /**
     * Gets the TMDb (TheMovieDb) id of a movie from its full file path
     * @param {string} path the full path of the movie to lookup
     * @returns the TMDb id if found, otherwise null
     */
    getTMDbIdFromPath(path)
    {
        if(!path)
            return null;
        let movie = this.getMovieByPath(path.toString());
        if (!movie)
        {
            Logger.WLog('Unable to get TMDb ID for path: ' + path);
            return null;
        }
        return movie.tmdbId;
    }

    /**
     * Gets the original language of a movie from its full file path
     * @param {string} path the full path of the movie to lookup
     * @returns the original language of the movie if found, otherwise null
     */
    getOriginalLanguageFromPath(path)
    {
        if(!path)
            return null;
        let movie = this.getMovieByPath(path.toString());
        if (!movie)
        {
            Logger.WLog('Unable to get original language for path: ' + path);
            return null;
        }
        return movie.originalLanguage?.name;
    }

    /**
     * Returns movie files info for an already identified movie
     * @param {int} movieId ID of previously identified movie
     * @returns list of radarr movieFile objects
     */
    findMovieFiles(movieId) {
        let endpoint = 'moviefile';
        let queryParams = `movieId=${movieId}`;
        let response = this.fetchJson(endpoint, queryParams);
    
        Logger.ILog(`Movie found: ${movieId}`);
        return response;
    }

    /**
     * Returns files under a movie that need to be renamed
     * @param {int} movieId Previously determined ID of the movie
     * @returns list of radarr rename movie objects
     */
    fetchRenamedMovies(movieId) 
    {
        let endpoint = 'rename';
        let queryParams = `movieId=${movieId}`;
        let response = this.fetchJson(endpoint, queryParams);
        return response;
    }

    /**
     * Searches for a movie by file or folder path in Radarr
     * @param {string} searchPattern - The search string to use (from the folder or file name)
     * @returns {Object|null} Movie object if found, or null if not found
     */
    searchMovieByPath(searchPattern) {
        try {
            const movie = this.getMovieByPath(searchPattern);
            return movie || null;
        } catch (error) {
            Logger.ELog(`Error searching movie by path: ${error.message}`);
            return null;
        }
    }

    /**
     * Searches the Radarr queue for a movie based on the search pattern
     * @param {string} searchPattern - The search string (file or folder name)
     * @returns {Object|null} Movie object if found, or null if not found
     */
    searchInQueue(searchPattern) {
        return this.searchApi(
            "queue", 
            searchPattern, 
            (item, sp) => item.outputPath && item.outputPath.toLowerCase().includes(sp),
            { includeMovie: "true" },
            (item) => {
                Logger.ILog(`Found Movie in Queue: ${item.movie.title}`);
                return item.movie;
            }
        );
    }

    /**
     * Searches the Radarr download history for a movie based on the search pattern
     * @param {string} searchPattern - The search string (file or folder name)
     * @returns {Object|null} Movie object if found, or null if not found
     */
    searchInDownloadHistory(searchPattern) {
        return this.searchApi(
            "history",
            searchPattern,
            (item, sp) => item.data && item.data.droppedPath && item.data.droppedPath.toLowerCase().includes(sp),
            { eventType: 3, includeMovie: "true" },
            (item) => {
                Logger.ILog(`Found Movie in History: ${item.movie.title}`);
                return item.movie;
            }
        );
    }
}
