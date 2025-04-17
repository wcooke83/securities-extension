let isRunning = false;
let isPaused = false;
let tickerQueue = [];
let currentMaxTabs = 3;
let activeTabs = new Set();
let tabsToCloseGracefully = new Set();
let tabStates = new Map();
let savedAPIAnnouncementsCount = {};
let savedScrapedAnnouncementsCount = {};
let downloadPdfs = true;
let closeTabs = true;
let apiFetchAnnouncements = true;
let webScrapeAnnouncements = true;

// Global resume signal for pause/resume state changes
let resumeSignal = null;
let resumeSignalResolver = null;

// Function to reset resume signal when pause state changes
function resetResumeSignal() {
    resumeSignal = new Promise((resolve) => {
        resumeSignalResolver = resolve;
    });
}

// Initialize resume signal
resetResumeSignal();

(function() {
    // Utility to wait for a delay
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    // Override chrome.runtime.sendMessage for critical messages with retries
    const originalRuntimeSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async function(message, callback, isCritical = false, ticker = '') {
        if (!isCritical) {
            originalRuntimeSendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    // console.log(`${ticker} No listener (e.g., popup not open):`, chrome.runtime.lastError.message);
                } else if (callback) {
                    callback(response);
                }
            });
            return;
        }

        let attempts = 0;
        const maxAttempts = 3;
        const delayMs = 3000;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                await new Promise((resolve, reject) => {
                    originalRuntimeSendMessage({ action: 'ping' }, response => {
                        if (chrome.runtime.lastError) {
                            reject(chrome.runtime.lastError);
                        } else {
                            resolve(response);
                        }
                    });
                });

                originalRuntimeSendMessage(message, response => {
                    if (chrome.runtime.lastError) {
                        console.warn(`[${ticker}] chrome.runtime.sendMessage failed: ${chrome.runtime.lastError.message}`);
                        if (callback) callback(null);
                    } else {
                        if (callback) callback(response);
                    }
                });
                return;
            } catch (error) {
                console.warn(`[${ticker}] Attempt ${attempts} failed for chrome.runtime.sendMessage: ${error.message}`);
                if (attempts < maxAttempts) {
                    await wait(delayMs);
                } else {
                    console.error(`[${ticker}] Giving up after ${maxAttempts} attempts for chrome.runtime.sendMessage`);
                    if (callback) callback(null);
                }
            }
        }
    };

    // Override chrome.tabs.sendMessage
    const originalTabsSendMessage = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = async function(tabId, message, callback) {
        let attempts = 0;
        const maxAttempts = 3;
        const delayMs = 3000;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                await new Promise((resolve, reject) => {
                    chrome.tabs.get(tabId, tab => {
                        if (chrome.runtime.lastError || !tab) {
                            reject(new Error(`Tab ${tabId} does not exist`));
                        } else {
                            resolve();
                        }
                    });
                });

                await new Promise((resolve, reject) => {
                    originalTabsSendMessage(tabId, { action: 'ping' }, response => {
                        if (chrome.runtime.lastError) {
                            reject(chrome.runtime.lastError);
                        } else {
                            resolve(response);
                        }
                    });
                });

                originalTabsSendMessage(tabId, message, response => {
                    if (chrome.runtime.lastError) {
                        console.warn(`chrome.tabs.sendMessage failed for tab ${tabId}: ${chrome.runtime.lastError.message}`);
                        if (callback) callback(null);
                    } else {
                        if (callback) callback(response);
                    }
                });
                return;
            } catch (error) {
                console.warn(`Attempt ${attempts} failed for chrome.tabs.sendMessage to tab ${tabId}: ${error.message}`);
                if (attempts < maxAttempts) {
                    await wait(delayMs);
                } else {
                    console.error(`Giving up after ${maxAttempts} attempts for chrome.tabs.sendMessage to tab ${tabId}`);
                    if (callback) callback(null);
                }
            }
        }
    };
})();

console.log("Background script initializing...");

// Utility function to normalize ticker symbols
function normalizeTicker(ticker) {
    if (!ticker) return null;
    ticker = ticker.toUpperCase();
    return ticker.endsWith('.AX') ? ticker : `${ticker}.AX`;
}

// Check global pause state and wait if paused
async function checkPause(tabId = null, ticker = '') {
    if (!isPaused) return; // No action if not paused

    console.log(`⏸️ ${ticker || 'Background'} Paused, waiting to resume...`);
    if (tabId && activeTabs.has(tabId)) {
        const currentTabState = tabStates.get(tabId) || {};
        if (!currentTabState.isPaused) {
            tabStates.set(tabId, { ...currentTabState, isPaused: true });
            sendUiUpdateMessage({ action: 'tab_paused', tabId }, false, ticker);
            chrome.tabs.sendMessage(tabId, { action: 'pause_tab' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error(`Error sending pause_tab to tab ${tabId}: ${chrome.runtime.lastError.message}`);
                }
            });
        }
    }

    await resumeSignal; // Wait for resume signal

    console.log(`▶️ ${ticker || 'Background'} Resumed`);
    if (tabId && activeTabs.has(tabId)) {
        const currentTabState = tabStates.get(tabId) || {};
        if (currentTabState.isPaused) {
            tabStates.set(tabId, { ...currentTabState, isPaused: false });
            sendUiUpdateMessage({ action: 'resume_tab', tabId }, false, ticker);
            chrome.tabs.sendMessage(tabId, { action: 'resume_tab' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error(`Error sending resume_tab to tab ${tabId}: ${chrome.runtime.lastError.message}`);
                }
            });
        }
    }
}

// Function to send UI update messages without retries
function sendUiUpdateMessage(message, critical = false, ticker = '') {
    chrome.runtime.sendMessage(message, null, critical, ticker);
}

// Define allowed actions for background
const backgroundActions = [
    'ping',
    'get_current_tab_id',
    'get_status',
    'get_tab_states',
    'pause_tab',
    'resume_tab',
    'start_scraping',
    'pause_scraping',
    'resume_scraping',
    'update_config',
    'get_existing_files',
    'get_download_announcements',
    'api_fetch_announcements',
    'web_scrap_announcements',
    'save_api_announcement_batch',
    'save_scraped_announcement_batch',
    'scraping_complete',
    'update_tab_status',
    'update_tab_ticker',
    'tab_paused'
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    const senders_ticker = sender.tab?.url?.split("/")?.pop() || 'unknown';

    if (!message || !message.action) {
        console.warn(`[${senders_ticker}] Invalid message received:`, message);
        sendResponse({ success: false, error: "No action specified" });
        return true;
    }

    if (!backgroundActions.includes(message.action)) {
        console.warn(`[${senders_ticker}] Unhandled message action: ${message.action}`);
        sendResponse({ success: false, error: `BKG Unknown action: ${message.action}` });
        return true;
    }

    switch (message.action) {
        case 'ping':
            sendResponse({ status: 'pong' });
            break;
        case 'get_current_tab_id':
            sendResponse(tabId ? { tabId } : { error: 'No tab ID available' });
            break;
        case 'get_status':
            sendResponse({ isRunning, isPaused });
            break;
        case 'get_tab_states':
            sendResponse({ tabStates: Array.from(tabStates.entries()).map(([tabId, state]) => ({ tabId, ...state })) });
            break;
        case 'pause_tab':
            if (message.tabId && activeTabs.has(message.tabId)) {
                const currentTabState = tabStates.get(message.tabId) || {};
                if (!currentTabState.isPaused) {
                    tabStates.set(message.tabId, { ...currentTabState, isPaused: true });
                    sendUiUpdateMessage({ action: 'tab_paused', tabId: message.tabId }, false, senders_ticker);
                    chrome.tabs.sendMessage(message.tabId, { action: 'pause_tab' }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error(`[${senders_ticker}] Error pausing tab ${message.tabId}: ${chrome.runtime.lastError.message}`);
                            sendResponse({ success: false, error: chrome.runtime.lastError.message });
                        } else {
                            sendResponse({ success: true });
                        }
                    });
                } else {
                    sendResponse({ success: true });
                }
            } else {
                console.warn(`[${senders_ticker}] Cannot pause tab ${message.tabId}: not active`);
                sendResponse({ success: false, error: 'Tab not active' });
            }
            break;
        case 'resume_tab':
            if (message.tabId && activeTabs.has(message.tabId)) {
                const currentTabState = tabStates.get(message.tabId) || {};
                if (currentTabState.isPaused) {
                    tabStates.set(message.tabId, { ...currentTabState, isPaused: false });
                    sendUiUpdateMessage({ action: 'resume_tab', tabId: message.tabId }, false, senders_ticker);
                    chrome.tabs.sendMessage(message.tabId, { action: 'resume_tab' }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error(`[${senders_ticker}] Error resuming tab ${message.tabId}: ${chrome.runtime.lastError.message}`);
                            sendResponse({ success: false, error: chrome.runtime.lastError.message });
                        } else {
                            sendResponse({ success: true });
                        }
                    });
                } else {
                    sendResponse({ success: true });
                }
            } else {
                sendResponse({ success: false, error: 'Tab not active' });
            }
            break;
        case 'start_scraping':
            if (!message || typeof message.maxTabs !== "number") {
                console.error("Invalid start_scraping message:", message);
                sendResponse({ success: false, error: "Missing or invalid maxTabs" });
                return true;
            }
            const newMaxTabs = message.maxTabs;
            downloadPdfs = message.downloadPdfs !== undefined ? message.downloadPdfs : true;
            closeTabs = message.closeTabs !== undefined ? message.closeTabs : true;
            apiFetchAnnouncements = message.apiFetchAnnouncements !== undefined ? message.apiFetchAnnouncements : apiFetchAnnouncements;
            webScrapeAnnouncements = message.webScrapeAnnouncements !== undefined ? message.webScrapeAnnouncements : webScrapeAnnouncements;

            if (!isRunning) {
                isRunning = true;
                currentMaxTabs = newMaxTabs;
                activeTabs.clear();
                tabStates.clear();
                tabsToCloseGracefully.clear();
                savedAPIAnnouncementsCount = {};
                savedScrapedAnnouncementsCount = {};
                console.log(`Starting scraping with maxTabs=${currentMaxTabs}`);
                fetchTickersAndStartScraping()
                    .then(() => {
                        console.log(`✅ Scraping started with ${currentMaxTabs} tabs`);
                        sendUiUpdateMessage({ action: "status_update", isRunning: true, isPaused: false }, false, senders_ticker);
                        sendResponse({ success: true });
                    })
                    .catch((error) => {
                        console.error("Error starting scraping:", error);
                        isRunning = false;
                        sendUiUpdateMessage({ action: "status_update", isRunning: false, isPaused: false }, false, senders_ticker);
                        sendResponse({ success: false, error: error.message });
                    });
            } else {
                currentMaxTabs = newMaxTabs;
                adjustTabs()
                    .then(() => {
                        console.log(`🔄 Adjusted to ${currentMaxTabs} tabs`);
                        sendUiUpdateMessage({ action: "status_update", isRunning: true, isPaused: false }, false, senders_ticker);
                        sendResponse({ success: true });
                    })
                    .catch((error) => {
                        console.error("Error adjusting tabs:", error);
                        sendUiUpdateMessage({ action: "status_update", isRunning: true, isPaused: false }, false, senders_ticker);
                        sendResponse({ success: false, error: error.message });
                    });
            }
            break;
        case 'pause_scraping':
            if (!isPaused) {
                isPaused = true;
                resetResumeSignal(); // Reset signal for new pause
                console.log("Scraping paused.");
                tabStates.forEach((state, id) => {
                    tabStates.set(id, { ...state, isPaused: true });
                    sendUiUpdateMessage({ action: "tab_paused", tabId: id }, false, senders_ticker);
                });
                sendUiUpdateMessage({ action: "status_update", isRunning: true, isPaused: true }, false, senders_ticker);
            }
            sendResponse({ success: true });
            break;
        case 'resume_scraping':
            if (isPaused) {
                isPaused = false;
                console.log("Scraping resumed.");
                tabStates.forEach((state, id) => {
                    tabStates.set(id, { ...state, isPaused: false });
                    sendUiUpdateMessage({ action: "resume_tab", tabId: id }, false, senders_ticker);
                });
                processTickerQueue(message.delay);
                sendUiUpdateMessage({ action: "status_update", isRunning: true, isPaused: false }, false, senders_ticker);
                resumeSignalResolver(); // Resolve waiting checkPause calls
                resetResumeSignal(); // Prepare for next pause
            }
            sendResponse({ success: true });
            break;
        case 'update_config':
            const { maxTabs, downloadPdfs: dlAnns, closeTabs: clsTabs, apiFetchAnnouncements: fViaApi, webScrapeAnnouncements: sFromWeb } = message;
            currentMaxTabs = maxTabs;
            downloadPdfs = dlAnns !== undefined ? dlAnns : downloadPdfs;
            closeTabs = clsTabs !== undefined ? clsTabs : closeTabs;
            apiFetchAnnouncements = fViaApi !== undefined ? fViaApi : apiFetchAnnouncements;
            webScrapeAnnouncements = sFromWeb !== undefined ? sFromWeb : webScrapeAnnouncements;
            
            console.log(`🔄 Config updated: maxTabs=${currentMaxTabs}`);
            adjustTabs()
                .then(() => {
                    sendResponse({ success: true });
                })
                .catch((error) => {
                    console.error("Error adjusting tabs after config update:", error);
                    sendResponse({ success: false, error: error.message });
                });
            break;
        case 'get_existing_files':
            fetch(`http://127.0.0.1:5000/api/files/${message.tickerSymbol}`)
                .then((response) => {
                    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                    return response.json();
                })
                .then((data) => {
                    console.log(`✅ ${message.tickerSymbol} Retrieved ${data.files.length} existing files`);
                    sendResponse({ files: data.files });
                })
                .catch((error) => {
                    console.error(`❌ ${message.tickerSymbol} Error fetching existing files: ${error.message}`);
                    sendResponse({ files: [] });
                });
            break;
        case 'get_download_announcements':
            sendResponse({ downloadPdfs });
            break;
        case 'api_fetch_announcements':
            sendResponse({ apiFetchAnnouncements });
            break;
        case 'web_scrap_announcements':
            sendResponse({ webScrapeAnnouncements });
            break;
        case 'save_api_announcement_batch':
            (async () => {
                try {
                    const { batch, batch_counter } = message;
                    const ticker = batch[0]?.tickerSymbol || senders_ticker;
                    console.log(`[${ticker}] Saving API announcement batch: ${batch_counter}, contains: ${batch.length} announcements`);
                    savedAPIAnnouncementsCount[ticker] ??= 0;
                    const response = await fetch("http://127.0.0.1:5000/api/announcements_via_api", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ announcements: batch })
                    });
                    if (!response.ok) throw new Error(`Server error: ${response.status}`);
                    const result = await response.json();
                    if (result.status !== "success") throw new Error(result.error);

                    if (downloadPdfs) {
                        for (const ann of batch) {
                            if (ann.pdfLink) {
                                await chrome.downloads.download({
                                    url: ann.pdfLink,
                                    filename: `announcements/${ann.tickerSymbol}/${ann.fileKey.split('/').pop()}`,
                                    conflictAction: "overwrite"
                                });
                            }
                        }
                    }
                    console.log(`[${ticker}] Announcement  batch: ${batch_counter} saved successfully`);
                    savedAPIAnnouncementsCount[ticker] += batch.length;
                    sendResponse({ success: true });
                } catch (error) {
                    console.error(`[${senders_ticker}] Error saving API announcements:`, error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            break;
        case 'save_scraped_announcement_batch':
            const { batch } = message;
            const ticker = batch[0]?.tickerSymbol || senders_ticker;
            sendUiUpdateMessage({ action: 'update_tab_status', tabId, status: 'Save Scraped Announcement Batch' }, false, ticker);
            console.log(`[${ticker}] Received batch of ${batch.length} announcements`);
            (async () => {
                try {
                    const announcementsWithTicker = batch.map((a) => ({ ...a, tickerSymbol: ticker }));
                    if (downloadPdfs) {
                        for (let announcement of announcementsWithTicker) {
                            if (announcement.pdfLink && !announcement.downloaded) {
                                const relativeFilename = `announcements/${ticker}/${announcement.filename}`;
                                console.log(`📥 ${ticker} Downloading PDF for ${announcement.filename}`);
                                try {
                                    const headResponse = await Promise.race([
                                        fetch(announcement.pdfLink, { method: "HEAD" }),
                                        new Promise((_, reject) => setTimeout(() => reject(new Error("Validation timeout")), 5000))
                                    ]);
                                    if (!headResponse.ok || !headResponse.headers.get("Content-Type")?.includes("application/pdf")) {
                                        throw new Error(`Invalid PDF (Status: ${headResponse.status})`);
                                    }
                                    const downloadId = await new Promise((resolve) =>
                                        chrome.downloads.download(
                                            {
                                                url: announcement.pdfLink,
                                                filename: relativeFilename,
                                                saveAs: false,
                                                conflictAction: "overwrite"
                                            },
                                            resolve
                                        )
                                    );
                                    const downloadItem = await waitForDownload(downloadId);
                                    if (!downloadItem?.filename) throw new Error("Download failed");
                                    announcement.pdfLocalPath = downloadItem.filename;
                                    announcement.downloaded = true;
                                } catch (e) {
                                    console.error(`❌ ${ticker} Error with PDF for ${announcement.filename}:`, e.message);
                                    announcement.pdfLocalPath = null;
                                }
                            }
                        }
                    }

                    savedScrapedAnnouncementsCount[ticker] ??= 0;

                    async function saveBatch() {
                        try {
                            const response = await fetch("http://127.0.0.1:5000/api/announcements", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ announcements: announcementsWithTicker })
                            });
                            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                            const result = await response.json();
                            if (result.status !== "success") throw new Error(result.error);
                            savedScrapedAnnouncementsCount[ticker] += announcementsWithTicker.length;
                            console.log(`✅ ${ticker} Saved ${announcementsWithTicker.length} announcements`);
                            return { success: true };
                        } catch (error) {
                            if (["fetch failed", "timeout", "connection", "Status: 500"].some((str) => error.message.includes(str))) {
                                console.log(`⏸️ ${ticker} Suspecting standby, awaiting wake`);
                                await new Promise((resolve) => {
                                    const listener = () => {
                                        console.log(`▶️ ${ticker} System woke, retrying`);
                                        chrome.runtime.onSuspendCanceled.removeListener(listener);
                                        resolve();
                                    };
                                    chrome.runtime.onSuspendCanceled.addListener(listener);
                                });
                                return await saveBatch();
                            }
                            throw error;
                        }
                    }

                    const result = await saveBatch();
                    sendResponse(result);
                } catch (error) {
                    console.error(`❌ ${ticker} Batch error:`, error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            break;
        case 'scraping_complete':
            (async () => {
                try {
                    const ticker = sender.tab?.url?.split("/")?.pop() || 'unknown';
                    sendUiUpdateMessage({
                        action: 'update_tab_status',
                        tabId,
                        status: 'Scraping Complete, Saving Data'
                    }, false, ticker);
                    await saveScrapedData(ticker, message.data, tabId);
                    sendResponse({ success: true });
                } catch (error) {
                    console.error(`❌ ${senders_ticker} Error in scraping_complete:`, error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            break;
        case 'update_tab_status':
            if (tabId) {
                tabStates.set(tabId, { ...tabStates.get(tabId) || { ticker: '', isPaused: false }, status: message.status });
                sendUiUpdateMessage({ ...message, tabId }, false, senders_ticker);
                sendResponse({ success: true });
            }
            break;
        case 'update_tab_ticker':
            if (tabId) {
                tabStates.set(tabId, { ...tabStates.get(tabId) || { status: 'Initializing', isPaused: false }, ticker: message.ticker.toUpperCase() });
                sendUiUpdateMessage({ ...message, tabId }, false, senders_ticker);
                sendResponse({ success: true });
            }
            break;
        case 'tab_paused':
            if (tabId) {
                tabStates.set(tabId, { ...tabStates.get(tabId) || {}, isPaused: true });
                sendUiUpdateMessage({ ...message, tabId }, false, senders_ticker);
                sendResponse({ success: true });
            }
            break;
        default:
            sendResponse({ success: false, error: `BKG Unknown action: ${message.action}` });
    }

    return true;
});

chrome.runtime.onSuspendCanceled.addListener(() => {
    console.log("System resumed from standby, notifying tabs");
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
            chrome.tabs.sendMessage(
                tab.id,
                { action: "resume_after_standby" },
                (response) => {
                    if (chrome.runtime.lastError) {
                        console.log(`No listener in tab ${tab.id}: ${chrome.runtime.lastError.message}`);
                    }
                }
            );
        });
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (activeTabs.has(tabId)) {
        activeTabs.delete(tabId);
        tabStates.delete(tabId);
        tabsToCloseGracefully.delete(tabId);
        console.log(`🛑 Tab ${tabId} removed unexpectedly, cleaned up`);
        sendUiUpdateMessage({ action: 'tab_closed', tabId });
        if (tickerQueue.length > 0) {
            adjustTabs();
        }
    }
});

async function downloadHistoricalData(tickerSymbol, data) {
    let historical_data_filepath = null;

    try {
        if (!data.historical_download_url) {
            console.log(`❌ ${tickerSymbol} No historical_download_url for ${tickerSymbol}`);
            return null;
        }

        const filename = `${tickerSymbol}_historical.csv`;
        const existingDownloads = await chrome.downloads.search({ filename });
        const alreadyDownloaded = existingDownloads.some(
            d => d.state === "complete" && d.url === data.historical_download_url
        );

        if (alreadyDownloaded) {
            console.log(`⏩ ${tickerSymbol} Skipping historical download - already exists`);
            historical_data_filepath = `Downloads/${filename}`; // Adjust path as needed
        } else {
            console.log(`✅ ${tickerSymbol} Initiating historical download: ${data.historical_download_url}`);
            const downloadId = await new Promise(resolve =>
                chrome.downloads.download(
                    {
                        url: data.historical_download_url,
                        filename,
                        saveAs: false,
                        conflictAction: "overwrite"
                    },
                    resolve
                )
            );
            const downloadItem = await waitForDownloadComplete(downloadId);
            if (downloadItem?.filename) {
                historical_data_filepath = downloadItem.filename.replace(/\\/g, '/');
                console.log(`✅ ${tickerSymbol} Downloaded historical data to ${historical_data_filepath}`);
            } else {
                console.error(`❌ Failed to download historical data for ${tickerSymbol}`);
            }
        }
    } catch (error) {
        console.error(`❌ ${tickerSymbol} Error downloading data:`, error);
    }

    return historical_data_filepath;
}

async function waitForDownloadComplete(downloadId) {
    return new Promise((resolve) => {
        chrome.downloads.onChanged.addListener(function listener(delta) {
            if (delta.id === downloadId && delta.state?.current === "complete") {
                chrome.downloads.onChanged.removeListener(listener);
                chrome.downloads.search({ id: downloadId }, (results) => resolve(results[0]));
            }
        });
    });
}

async function saveScrapedData(tickerSymbol, data, tabId) {
    try {
        console.log(`Starting saveScrapedData for ${tickerSymbol} with data:`, data);

        const payload = {
            tickerSymbol: tickerSymbol,
            update_timestamps: {},
            company_overview: data.company_overview || {},
            company_details: data.company_details || {},
            transactions: data.transactions || {},
            director_interests: data.director_interests || {}
        };

        if (data.historical_download_url) {
            payload.historical_data_filepath = await downloadHistoricalData(tickerSymbol, data);
        }

        const savedAPICount = savedAPIAnnouncementsCount[tickerSymbol] || 0;
        const savedScrapeCount = savedScrapedAnnouncementsCount[tickerSymbol] || 0;

        if(apiFetchAnnouncements && savedAPICount === data.total_api_fetchable_announcements && data.total_api_fetchable_announcements > 0) {
            payload.update_timestamps.announcements_api_fetched_last_updated = true;
            console.log(`🎉 ${tickerSymbol} Update 'announcements_api_fetched_last_updated', (API Fetched: ${data.total_api_fetchable_announcements} match API Saved: ${savedAPICount})`);
        }
        else {
            console.log(`❌ ${tickerSymbol} Skip Update 'announcements_api_fetched_last_updated', (API Fetched: ${data.total_api_fetchable_announcements} does not match API Saved: ${savedAPICount})`);
        }
        delete savedAPIAnnouncementsCount[tickerSymbol];
        
        if(webScrapeAnnouncements && savedScrapeCount === data.total_scrapeable_announcements && data.total_scrapeable_announcements > 0) {
            payload.update_timestamps.announcements_scraped_last_updated = true;
            console.log(`🎉 ${tickerSymbol} Update 'announcements_scraped_last_updated', (Scraped: ${data.total_scrapeable_announcements} match Scraped Saved: ${savedScrapeCount})`);
        }
        else {
            console.log(`❌ ${tickerSymbol} Skip Update 'announcements_scraped_last_updated', (Scraped: ${data.total_scrapeable_announcements} does not match Scraped Saved: ${savedScrapeCount})`);
        }
        delete savedScrapedAnnouncementsCount[tickerSymbol];

        if (
            payload.historical_data_filepath ||
            Object.keys(payload.company_overview).length ||
            Object.keys(payload.company_details).length ||
            payload.transactions.length ||
            payload.director_interests.length ||
            payload.update_timestamps.length
        ) {
            console.log(`Sending combined data for ${tickerSymbol}:`, payload);
            const response = await fetch("http://127.0.0.1:5000/save_data", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            
            sendUiUpdateMessage({
                action: 'update_tab_status',
                tabId: tabId,
                status: 'Scraping Complete, Data Saved'
            });
            console.log(`✅ ${tickerSymbol} Saved combined data:`, result);
        } else {
            console.log(`⏩ ${tickerSymbol} No data to save (empty payload)`);
        }

        console.log(`✅ ${tickerSymbol} Completed saveScrapedData`);
    } catch (error) {
        console.error(`❌ ${tickerSymbol} Error saving data:`, error);
        throw error;
    }
}

async function fetchTickersAndStartScraping() {
    try {
        let response = await fetch("http://127.0.0.1:5000/get_tickers");
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        tickerQueue = await response.json();
        console.log("Initial ticker queue:", tickerQueue);
        await adjustTabs();
    } catch (error) {
        console.error("Error fetching tickers:", error.message);
        isRunning = false;
        sendUiUpdateMessage({ action: "status_update", isRunning: false, isPaused: false }, false, 'unknown');
        throw error;
    }
}

async function processTab(tabId) {
    const processedTickers = new Set();
    while (tickerQueue.length > 0 && activeTabs.has(tabId)) {
        let tickerSymbol;
        try {
            // Check global pause state before processing ticker
            await checkPause(tabId, 'Global');
            tickerSymbol = tickerQueue.shift();

            console.log(`🔄 Processing ticker ${tickerSymbol} in tab ${tabId}`);

            if (!tickerSymbol) {
                console.log(`No more tickers in queue for tab ${tabId}`);
                break;
            }
            if (processedTickers.has(tickerSymbol)) {
                console.log(`⏩ Ticker ${tickerSymbol} already processed in tab ${tabId}, skipping`);
                continue;
            }
            processedTickers.add(tickerSymbol);

            tabStates.set(tabId, { ticker: tickerSymbol.toUpperCase(), status: 'Initializing', isPaused: false });

            let url = `https://www.marketindex.com.au/asx/${tickerSymbol}`;
            console.log(`🚀 Updating tab ${tabId} for ${tickerSymbol}`);

            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab) {
                console.log(`Tab ${tabId} no longer exists. Stopping...`);
                activeTabs.delete(tabId);
                tabStates.delete(tabId);
                sendUiUpdateMessage({ action: 'tab_closed', tabId }, false, tickerSymbol);
                return;
            }

            const delay = Math.floor(Math.random() * (2500 - 500 + 1)) + 500; // Random between 500 and 2500ms
            await new Promise(resolve => setTimeout(resolve, delay + 3000));
            
            await chrome.tabs.update(tabId, { url });
            await waitForTabLoad(tabId);

            let { isCloudflare, hasExpectedContent } = await checkTabContent(tabId);
            if (isCloudflare) {
                console.log("Cloudflare detected. Waiting for content...");
                let success = await waitForExpectedContent(tabId);
                if (!success) {
                    console.log("Cloudflare didn’t resolve. Skipping...");
                    continue;
                }
                ({ hasExpectedContent } = await checkTabContent(tabId));
            }

            if (hasExpectedContent) {
                await executeScraping(tabId, tickerSymbol);
            } else {
                console.log(`Expected content not found for ${tickerSymbol}. Skipping...`);
            }

            // Clean up tab state after processing
            if (tabsToCloseGracefully.has(tabId) || tickerQueue.length === 0) {
                console.log(`🛑 Tab ${tabId} finished, closing`);
                activeTabs.delete(tabId);
                tabsToCloseGracefully.delete(tabId);
                tabStates.delete(tabId);
                if (closeTabs) {
                    await chrome.tabs.remove(tabId);
                    sendUiUpdateMessage({ action: 'tab_closed', tabId }, false, tickerSymbol);
                }
                return;
            }
        } catch (error) {
            console.error(`Error in tab ${tabId} for ticker ${tickerSymbol}:`, error);
            activeTabs.delete(tabId);
            tabStates.delete(tabId);
            tabsToCloseGracefully.delete(tabId);
            if (closeTabs) {
                console.log(`🛑 Closing tab ${tabId} due to error`);
                await chrome.tabs.remove(tabId);
                sendUiUpdateMessage({ action: 'tab_closed', tabId }, false, tickerSymbol);
            }
            return;
        }

        console.log(`🏁 Completed ${tickerSymbol} in tab ${tabId}`);
    }

    console.log(`✅ Tab ${tabId} finished processing queue`);
    activeTabs.delete(tabId);
    tabStates.delete(tabId);
    if (closeTabs) {
        console.log(`🛑 Closing tab ${tabId}`);
        await chrome.tabs.remove(tabId);
        sendUiUpdateMessage({ action: 'tab_closed', tabId });
    }

    if (activeTabs.size === 0 && tickerQueue.length === 0) {
        console.log("✅ All tabs finished and queue empty. Scraping complete.");
        isRunning = false;
        sendUiUpdateMessage({ action: "status_update", isRunning: false, isPaused: false });
    } else if (tickerQueue.length > 0) {
        console.log(`More tickers remain (${tickerQueue.length}), spawning new tab`);
        await adjustTabs();
    }
}

async function adjustTabs() {
    await checkPause(null, 'Global'); // Check global pause before adjusting tabs
    const targetTabs = Math.max(1, Math.min(currentMaxTabs, 10));
    const currentActive = activeTabs.size;

    // Log current state for debugging
    console.log(`Adjusting tabs: target=${targetTabs}, active=${currentActive}, tabStates=${tabStates.size}`);

    // Remove stale tab states
    for (let tabId of tabStates.keys()) {
        if (!activeTabs.has(tabId)) {
            console.log(`Cleaning stale tab state for tab ${tabId}`);
            tabStates.delete(tabId);
            sendUiUpdateMessage({ action: 'tab_closed', tabId });
        }
    }

    if (currentActive < targetTabs && tickerQueue.length > 0) {
        const tabsToCreate = Math.min(targetTabs - currentActive, tickerQueue.length);
        console.log(`Creating ${tabsToCreate} new tabs`);
        for (let i = 0; i < tabsToCreate; i++) {
            try {
                let tab = await chrome.tabs.create({ url: "about:blank", active: false });
                activeTabs.add(tab.id);
                tabStates.set(tab.id, { ticker: '', status: 'Initializing', isPaused: false });
                console.log(`🌟 Created tab ${tab.id} for processing`);
                sendUiUpdateMessage({
                    action: 'update_tab_status',
                    tabId: tab.id,
                    status: 'Initializing'
                });
                processTab(tab.id);
                await new Promise((resolve) => setTimeout(resolve, 500));
            } catch (error) {
                console.error(`Failed to create tab:`, error);
            }
        }
    } else if (currentActive > targetTabs) {
        const tabsToClose = Array.from(activeTabs).slice(targetTabs);
        console.log(`Closing ${tabsToClose.length} excess tabs`);
        for (let tabId of tabsToClose) {
            activeTabs.delete(tabId);
            tabStates.delete(tabId);
            tabsToCloseGracefully.add(tabId);
            console.log(`⏳ Tab ${tabId} marked to close gracefully`);
            try {
                await chrome.tabs.remove(tabId);
                sendUiUpdateMessage({ action: 'tab_closed', tabId });
            } catch (error) {
                console.error(`Failed to close tab ${tabId}:`, error);
            }
        }
    }
}

async function executeScraping(tabId, tickerSymbol) {
    console.log(`🔍 Executing scraping for ${tickerSymbol} (Tab ID: ${tabId})`);
    try {
        // Set window.tabid in the tab's context
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (tabId) => {
                window.tabid = tabId;
            },
            args: [tabId]
        });
        console.log(`🔹 Set window.tabid to ${tabId} in tab ${tabId}`);

        // Check if content.js is already injected
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => typeof startScraping === 'function'
        });
        if (!result.result) {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ["content.js"]
            });
            console.log(`🔹 content.js injected into tab ${tabId}`);
        } else {
            console.log(`🔹 content.js already present in tab ${tabId}`);
        }
    } catch (error) {
        console.error(`🚨 Error during scraping for ${tickerSymbol}:`, error);
        throw error;
    }
}

async function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.onUpdated.addListener(function listener(tabIdUpdated, info) {
            if (tabIdUpdated === tabId && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        });
    });
}

async function checkTabContent(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                return {
                    isCloudflare: document.title.includes("Just a moment"),
                    hasExpectedContent:
                        !!document.querySelector("#directors-transactions-root") ||
                        !!document.querySelector("#directors-interests-root") ||
                        !!document.querySelector('a.btn[href*="download-historical-data"]') ||
                        !!document.querySelector("#app-table table.mi-data-table")
                };
            }
        });
        return results[0].result;
    } catch (error) {
        console.error(`Error checking tab ${tabId} content:`, error);
        return { isCloudflare: false, hasExpectedContent: false };
    }
}

async function waitForExpectedContent(tabId) {
    const MAX_ATTEMPTS = 20;
    const CHECK_INTERVAL = 3000;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL));
        const { hasExpectedContent } = await checkTabContent(tabId);
        if (hasExpectedContent) {
            console.log(`Cloudflare resolved after ${attempts} attempts`);
            return true;
        }
    }
    console.log(`Cloudflare timeout after ${MAX_ATTEMPTS} attempts`);
    return false;
}

async function processTickerQueue(delay = 1000) {
    console.log(`▶️ Resuming ticker queue processing with delay ${delay}ms`);
    if (!isRunning || tickerQueue.length === 0) {
        console.log(`⏹️ No active scraping or empty queue, nothing to process`);
        return;
    }

    if (activeTabs.size < currentMaxTabs && tickerQueue.length > 0) {
        console.log(`🌟 ${tickerQueue.length} tickers remain, adjusting tabs`);
        await adjustTabs();
    } else {
        console.log(`✅ ${activeTabs.size} tabs already active, continuing with current setup`);
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
}

async function waitForDownload(downloadId) {
    return new Promise((resolve) => {
        chrome.downloads.onChanged.addListener(function listener(delta) {
            if (delta.id === downloadId && delta.state) {
                if (delta.state.current === "complete") {
                    chrome.downloads.onChanged.removeListener(listener);
                    chrome.downloads.search({ id: downloadId }, (results) => resolve(results[0]));
                } else if (delta.state.current === "interrupted") {
                    chrome.downloads.onChanged.removeListener(listener);
                    resolve(null);
                }
            }
        });
    });
}

console.log("Background script fully loaded");