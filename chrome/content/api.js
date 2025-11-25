import { tickerSymbol, apiFetchAnnouncementMaxRetries, apiFetchAnnouncementRetryTime, apiFetchAnnouncementFailPause, apiFetchAnnouncementTimeout, apiFetchAnnouncementTimeoutRetryTime, apiFetchAnnouncementTimeoutMaxRetries, apiFetchAnnouncementTimeoutFailPause, apiSaveFetchedAnnouncementSendBatchSize, totalAPIFetchedAnnouncements } from './constants.js';
import { checkPause } from './pauseResume.js';
import { sendRuntimeMessage } from './messages.js';
import { delay } from './utils.js';

export async function fetchAnnouncementsViaApi(tickerSymbol) {
    console.log('fetchAnnouncementsViaApi');
    updateTabStatus("API Fetch Announcements");
    const apiUrl = `https://data-api.marketindex.com.au/api/v1/announcements?codes=${tickerSymbol.toUpperCase()}%3AAUD%3AXASX&limit=1000000`;

    try {
        const announcements = await fetchApiData(apiUrl, tickerSymbol);
        console.log(`📡 Fetched ${announcements.length} announcements via API`);
        totalAPIFetchedAnnouncements = announcements.length;
        await processAnnouncements(announcements, tickerSymbol);
    } catch (error) {
        console.error(`❌ ${tickerSymbol} Failed to fetch or process announcements: ${error.message}`);
        if (apiFetchAnnouncementFailPause || apiFetchAnnouncementTimeoutFailPause) {
            isPaused = true;
            updateTabStatus("Paused: API Fetch Failed");
        }
    }
}

async function fetchApiData(url, tickerSymbol) {
    const maxErrorRetries = apiFetchAnnouncementMaxRetries;
    const errorRetryTime = apiFetchAnnouncementRetryTime;
    const maxTimeoutRetries = apiFetchAnnouncementTimeoutMaxRetries;
    const timeoutRetryTime = apiFetchAnnouncementTimeoutRetryTime;
    const timeoutMs = apiFetchAnnouncementTimeout;
    let errorAttempt = 1;
    let timeoutAttempt = 0;
    let totalAttempts = 0;
    const maxTotalAttempts = maxErrorRetries + maxTimeoutRetries;

    while (totalAttempts < maxTotalAttempts) {
        await checkPause();
        totalAttempts++;
        console.log(`[${tickerSymbol}] Fetch attempt ${totalAttempts}`);

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const response = await Promise.race([
                fetch(url, { signal: controller.signal }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), timeoutMs))
            ]);

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            const data = await response.json();
            if (data.statusCode !== 200) {
                throw new Error(data.message);
            }

            console.log(`📡 ${tickerSymbol} Fetched ${data.data.announcements.length} announcements via API`);
            return data.data.announcements;
        } catch (error) {
            if (error.name === 'AbortError' || error.message === 'Fetch timeout') {
                timeoutAttempt++;
                console.error(`❌ ${tickerSymbol} API fetch timeout: ${error.message}`);
                if (timeoutAttempt < maxTimeoutRetries) {
                    await delay(timeoutRetryTime);
                    continue;
                }
            } else {
                errorAttempt++;
                console.error(`❌ ${tickerSymbol} API fetch error: ${error.message}`);
                if (errorAttempt <= maxErrorRetries) {
                    await delay(errorRetryTime);
                    timeoutAttempt = 0;
                    continue;
                }
            }
            throw error;
        }
    }

    throw new Error(`Failed to fetch API data for ${tickerSymbol} after ${maxTotalAttempts} attempts`);
}

async function processAnnouncements(announcements, tickerSymbol) {
    const batchSize = apiSaveFetchedAnnouncementSendBatchSize;
    let batch_counter = 0;
    for (let i = 0; i < announcements.length; i += batchSize) {
        await checkPause();
        batch_counter++;
        const batch = announcements.slice(i, i + batchSize).map(ann => ({
            ...ann,
            tickerSymbol,
            pdfLink: `https://www.marketindex.com.au/${ann.fileKey}`
        }));
        await sendBatchToBackground(batch, tickerSymbol, batch_counter);
    }
}

async function sendBatchToBackground(batch, tickerSymbol, batch_counter) {
    const success = await new Promise((resolve) => {
        sendRuntimeMessage(
            { action: "save_api_announcement_batch", batch: batch, batch_counter: batch_counter },
            (response) => {
                if (response?.success) {
                    console.log(`✅ ${tickerSymbol} Saved API batch ${batch_counter}, containing ${batch.length} announcements`);
                    resolve(true);
                } else {
                    console.error(`❌ ${tickerSymbol} API batch ${batch_counter} failed`);
                    onsole.dir(response, { depth: null });
                    resolve(false);
                }
            }
        );
    });
    return success;
}

function updateTabStatus(status) {
    sendRuntimeMessage({ action: 'update_tab_status', status }, null);
}