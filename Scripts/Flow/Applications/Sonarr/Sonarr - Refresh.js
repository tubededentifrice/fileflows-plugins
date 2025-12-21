import { SonarrVc } from 'Shared/SonarrVc';

/**
 * @description This script will refresh the show through Sonarr
 * @author Vincent Courcelle
 * @revision 2
 * @param {string} URI Sonarr root URI and port (e.g. http://sonarr:8989)
 * @param {string} ApiKey API Key
 * @output Series refreshed successfully
 * @output Error or serie not found
 */
function Script(URI, ApiKey) {
    // Remove trailing / from URI
    URI = URI.replace(/\/$/, '');
    const sonarr = new SonarrVc(URI, ApiKey);
    // const folderPath = Variables.folder.Orig.FullName;
    const ogFileName = Variables.file.Orig.FileName;
    const ogFullName = Variables.file.Orig.FullName;
    // let currentFileName = Variables.file.FullName;
    // let newFilePath = null;

    const series = Variables['TVShowInfo'];
    const seriesId = Variables['movie.SonarrId'];
    if (!seriesId) {
        Logger.WLog('This script requires the Radarr - Movie search script to be run first');
        return 2;
    }

    Logger.ILog('Refreshing serie ' + seriesId);

    // Fetch the episode of the serie before touching anything
    // Logic moved to Shared/SonarrVc.js
    const episodeResult = sonarr.fetchEpisode(ogFullName, series);
    const episode = episodeResult && episodeResult[1];
    if (episode && episode.id !== undefined) {
        Logger.ILog('Original episode found: Season ' + episode.seasonNumber + ' Episode: ' + episode.episodeNumber);
    } else {
        Logger.WLog('Episode could not be extracted from series');
    }

    // Ensure series is refreshed before renaming
    let refreshData = sonarr.refreshSeries(seriesId);
    let refreshCompleted = sonarr.waitForCompletion(refreshData.id, 30000); // 30s timeout default
    if (!refreshCompleted) {
        Logger.WLog('Refresh failed');
        return 2;
    }

    if (episode && episode.id) {
        // Sometimes sonarr doesn't autodetect the transcoded files so we need to manually import it for Sonarr to rename it
        const manualImport = sonarr.fetchManualImportFile(ogFileName, seriesId, episode.seasonNumber);
        if (manualImport) {
            Logger.ILog('Updated file not auto-detected by Sonarr. Manually importing');

            const importCommand = sonarr.manuallyImportFile(manualImport, episode.id);
            const importCompleted = sonarr.waitForCompletion(importCommand.id, 30000);
            if (!importCompleted) {
                Logger.WLog('import not completed');
                return 2;
            }

            // Refresh for newly imported episode
            refreshData = sonarr.refreshSeries(seriesId);
            refreshCompleted = sonarr.waitForCompletion(refreshData.id, 30000);
            if (!refreshCompleted) {
                Logger.WLog('Refresh failed');
                return 2;
            }
        } else {
            Logger.ILog('Manual import not needed');
        }
    }

    return 1;
}
