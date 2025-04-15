// Global state variables
let isRunning = false;
let isPaused = false;
let currentMaxTabs = 0;
let downloadPdfs = true;
let closeTabs = true; // Default to true
let fetchViaApi = true; // New setting
let scrapeFromWeb = true; // New setting
let activeTabs = new Set();
let tickerQueue = [];
let tabsToCloseGracefully = new Set();
let batchCounters = {};
let savedAPIAnnouncementsCount = {};
let savedScrapedAnnouncementsCount = {};

console.log("Background script initializing...");

// Utility function to normalize ticker symbols
function normalizeTicker(ticker) {
    if (!ticker) return null;
    ticker = ticker.toUpperCase();
    return ticker.endsWith('.AX') ? ticker : `${ticker}.AX`;
}

// Load settings from storage
chrome.storage.local.get(["maxTabs", "downloadPdfs", "closeTabs", "fetchViaApi", "scrapeFromWeb"], (data) => {
    if (data.maxTabs) currentMaxTabs = data.maxTabs;
    if (data.downloadPdfs !== undefined) downloadPdfs = data.downloadPdfs;
    if (data.closeTabs !== undefined) closeTabs = data.closeTabs;
    if (data.fetchViaApi !== undefined) fetchViaApi = data.fetchViaApi;
    if (data.scrapeFromWeb !== undefined) scrapeFromWeb = data.scrapeFromWeb;
    console.log(`Loaded settings: maxTabs=${currentMaxTabs}, downloadPdfs=${downloadPdfs}, closeTabs=${closeTabs}, fetchViaApi=${fetchViaApi}, scrapeFromWeb=${scrapeFromWeb}`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Received message:", message);

    // Handle ping for connection check
    if (message.action === "ping") {
        console.log("Ping received, responding with pong");
        sendResponse({ status: "pong" });
        return false; // Synchronous response
    } else if (message.action === "initialize_system_active" && sender.tab?.id) {
        console.log(`Initializing system active listener for tab ${sender.tab.id}`);
        
        sendResponse({ status: "initialized" });
    } else if (message.action === "get_status") {
        console.log("Sending status: isRunning=", isRunning, "isPaused=", isPaused);
        sendResponse({ isRunning, isPaused });
        return false; // Synchronous
    } else if (message.action === "start_scraping") {
        const newMaxTabs = message.maxTabs;
        downloadPdfs = message.downloadPdfs !== undefined ? message.downloadPdfs : true;
        closeTabs = message.closeTabs !== undefined ? message.closeTabs : true;
        fetchViaApi = message.fetchViaApi !== undefined ? message.fetchViaApi : fetchViaApi; // Added
        scrapeFromWeb = message.scrapeFromWeb !== undefined ? message.scrapeFromWeb : scrapeFromWeb; // Added

        if (!isRunning) {
            isRunning = true;
            currentMaxTabs = newMaxTabs;
            savedAPIAnnouncementsCount = {}; // Reset counters on new scrape session
            savedScrapedAnnouncementsCount = {}; // Reset counters on new scrape session
            fetchTickersAndStartScraping()
                .then(() => {
                    console.log(`✅ Scraping started with ${currentMaxTabs} tabs, downloadPdfs: ${downloadPdfs}, closeTabs: ${closeTabs}, fetchViaApi: ${fetchViaApi}, scrapeFromWeb: ${scrapeFromWeb}`);
                    chrome.runtime.sendMessage({ action: "status_update", isRunning: true, isPaused: false });
                    sendResponse({ success: true });
                })
                .catch((error) => {
                    console.error("Error starting scraping:", error);
                    isRunning = false;
                    sendResponse({ success: false, error: error.message });
                });
        } else {
            currentMaxTabs = newMaxTabs;
            adjustTabs()
                .then(() => {
                    console.log(`🔄 Adjusted to ${currentMaxTabs} tabs, downloadPdfs: ${downloadPdfs}, closeTabs: ${closeTabs}, fetchViaApi: ${fetchViaApi}, scrapeFromWeb: ${scrapeFromWeb}`);
                    chrome.runtime.sendMessage({ action: "status_update", isRunning: true, isPaused: false });
                    sendResponse({ success: true });
                })
                .catch((error) => {
                    console.error("Error adjusting tabs:", error);
                    sendResponse({ success: false, error: error.message });
                });
        }
        return true; // Async response
    } else if (message.action === "pause_scraping") {
        isPaused = true;
        console.log("Scraping paused.");
        chrome.runtime.sendMessage({ action: "status_update", isRunning: true, isPaused: true });
        sendResponse({ success: true });
        return false; // Synchronous
    } else if (message.action === "resume_scraping") {
        isPaused = false;
        console.log("Scraping resumed.");
        processTickerQueue(message.delay);
        chrome.runtime.sendMessage({ action: "status_update", isRunning: true, isPaused: false });
        sendResponse({ success: true });
        return false; // Synchronous
    } else if (message.action === "update_config") {
        const { maxTabs, downloadPdfs: dlAnns, closeTabs: clsTabs, fetchViaApi: fViaApi, scrapeFromWeb: sFromWeb } = message;
        currentMaxTabs = maxTabs;
        downloadPdfs = dlAnns !== undefined ? dlAnns : downloadPdfs;
        closeTabs = clsTabs !== undefined ? clsTabs : closeTabs;
        fetchViaApi = fViaApi !== undefined ? fViaApi : fetchViaApi; // Added
        scrapeFromWeb = sFromWeb !== undefined ? sFromWeb : scrapeFromWeb; // Added
        console.log(`🔄 Config updated: maxTabs=${currentMaxTabs}, downloadPdfs=${downloadPdfs}, closeTabs=${closeTabs}, fetchViaApi=${fetchViaApi}, scrapeFromWeb=${scrapeFromWeb}`);
        adjustTabs()
            .then(() => {
                sendResponse({ success: true });
            })
            .catch((error) => {
                console.error("Error adjusting tabs after config update:", error);
                sendResponse({ success: false, error: error.message });
            });
        return true; // Async response
    } else if (message.action === "get_existing_files") {
        const tickerSymbol = message.tickerSymbol;
        fetch(`http://127.0.0.1:5000/api/files/${tickerSymbol}`)
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                return response.json();
            })
            .then((data) => {
                console.log(`✅ ${tickerSymbol} Retrieved ${data.files.length} existing files`);
                sendResponse({ files: data.files });
            })
            .catch((error) => {
                console.error(`❌ ${tickerSymbol} Error fetching existing files: ${error.message}`);
                sendResponse({ files: [] });
            });
        return true; // Async response
    } else if (message.action === "get_download_announcements") {
        console.log("Sending downloadPdfs:", downloadPdfs);
        sendResponse({ downloadPdfs });
        return false; // Synchronous
    } else if (message.action === "get_fetch_via_api") {
        console.log("Sending fetchViaApi:", fetchViaApi);
        sendResponse({ fetchViaApi });
        return false; // Synchronous
    } else if (message.action === "get_scrape_from_web") {
        console.log("Sending scrapeFromWeb:", scrapeFromWeb);
        sendResponse({ scrapeFromWeb });
        return false; // Synchronous
    } else if (message.action === "save_api_announcement_batch") {
        const { batch } = message;
        const tickerSymbol = sender.tab.url.split("/").pop();
        console.log(`${tickerSymbol} Received API announcement batch of ${batch.length} announcements`);
        (async () => {
            try {
                savedAPIAnnouncementsCount[tickerSymbol] ??= 0;
                // Send to server
                const response = await fetch("http://127.0.0.1:5000/api/announcements_via_api", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ announcements: batch })
                });
                if (!response.ok) throw new Error(`Server error: ${response.status}`);
                const result = await response.json();
                if (result.status !== "success") throw new Error(result.error);

                // Download PDFs if enabled
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

                savedAPIAnnouncementsCount[tickerSymbol] += batch.length;
                sendResponse({ success: true });
            } catch (error) {
                console.error(`${tickerSymbol} Error saving API announcements:`, error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true; // Indicate async response
    } else if (message.action === "save_scraped_announcement_batch") {
        const { batch } = message;
        const tickerSymbol = sender.tab.url.split("/").pop();
        console.log(`${tickerSymbol} Received batch of ${batch.length} announcements`);
    
        (async () => {
            try {
                const tickerSymbol = sender.tab.url.split("/").pop();
                const announcementsWithTicker = batch.map(a => ({ ...a, tickerSymbol }));
    
                if (downloadPdfs) {
                    for (let announcement of announcementsWithTicker) {
                        if (announcement.pdfLink && !announcement.downloaded) {
                            const relativeFilename = `announcements/${tickerSymbol}/${announcement.filename}`;
                            console.log(`📥 ${tickerSymbol} Downloading PDF for ${announcement.filename}`);
                            try {
                                const headResponse = await Promise.race([
                                    fetch(announcement.pdfLink, { method: "HEAD" }),
                                    new Promise((_, reject) => setTimeout(() => reject(new Error("Validation timeout")), 5000))
                                ]);
                                if (!headResponse.ok || !headResponse.headers.get("Content-Type")?.includes("application/pdf")) {
                                    throw new Error(`Invalid PDF (Status: ${headResponse.status})`);
                                }
                                console.log(`✅ ${tickerSymbol} PDF URL is valid`);
                                const downloadId = await new Promise(resolve => chrome.downloads.download({
                                    url: announcement.pdfLink,
                                    filename: relativeFilename,
                                    saveAs: false,
                                    conflictAction: "overwrite"
                                }, resolve));
                                const downloadItem = await waitForDownload(downloadId);
                                if (!downloadItem?.filename) throw new Error("Download failed");
                                console.log(`✅ ${tickerSymbol} Downloaded PDF to ${downloadItem.filename}`);
                                announcement.pdfLocalPath = downloadItem.filename;
                                announcement.downloaded = true;
                            } catch (e) {
                                console.error(`❌ ${tickerSymbol} Error with PDF for ${announcement.filename}:`, e.message);
                                announcement.pdfLocalPath = null;
                            }
                        }
                    }
                } else {
                    console.log(`⏩ ${tickerSymbol} Skipping PDF downloads (disabled)`);
                    announcementsWithTicker.forEach(a => a.pdfLocalPath = null);
                }
    
                savedScrapedAnnouncementsCount[tickerSymbol] ??= 0;
    
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
                        savedScrapedAnnouncementsCount[tickerSymbol] += announcementsWithTicker.length;
                        console.log(`✅ ${tickerSymbol} Saved ${announcementsWithTicker.length} announcements, total: ${savedScrapedAnnouncementsCount[tickerSymbol]}`);
                        return { success: true };
                    } catch (error) {
                        if (["fetch failed", "timeout", "connection", "Status: 500"].some(str => error.message.includes(str))) {
                            console.log(`⏸️ ${tickerSymbol} Suspecting standby, awaiting wake`);
                            await new Promise(resolve => {
                                const listener = () => {
                                    console.log(`▶️ ${tickerSymbol} System woke, retrying`);
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
                if (!result.success) {
                    console.log(`❌ ${tickerSymbol} Notifying popup of save failure`);
                    chrome.runtime.sendMessage({
                        action: "save_failed",
                        batch: announcementsWithTicker,
                        error: result.error,
                        tabId: sender.tab?.id
                    });
                }
                sendResponse(result);
            } catch (error) {
                console.error(`❌ ${tickerSymbol} Batch error:`, error.message);
                sendResponse({ success: false, error: error.message });
            }
        })();
    
        return true; // Async response
    } else if (message.action === "scraping_complete") {
        (async () => {
            const tickerSymbol = sender.tab.url.split("/").pop();
            try {

                await saveScrapedData(tickerSymbol, message.data);
                sendResponse({ success: true });
            } catch (error) {
                console.error(`❌ ${tickerSymbol} Error in scraping_complete:`, error);
                sendResponse({ success: false, error: error.message });
            }
        })();

        return true; // Async response
    }

    // Handle unhandled actions
    console.warn(`Unhandled message action: ${message.action}`);
    sendResponse({ success: false, error: `Unknown action: ${message.action}` });
    return false; // Synchronous
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

async function saveScrapedData(tickerSymbol, data) {
    try {
        console.log(`Starting saveScrapedData for ${tickerSymbol} with data:`, data);

        const payload = {
            tickerSymbol: tickerSymbol,
            updated_timestamps: {},
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

        if(fetchViaApi && savedAPICount === data.total_api_fetchable_announcements && data.total_api_fetchable_announcements > 0) {
            payload.updated_timestamps.announcements_api_fetched_last_updated = true;
            console.log(`🎉 ${tickerSymbol} Update 'announcements_api_fetched_last_updated', (${savedAPICount} API Fetched Announcements)`);
            delete savedScrapedAnnouncementsCount[tickerSymbol];
        }
        if(scrapeFromWeb && savedScrapeCount === data.total_scrapeable_announcements && data.total_scrapeable_announcements > 0) {
            payload.updated_timestamps.announcements_scraped_last_updated = true;
            console.log(`🎉 ${tickerSymbol} Update 'announcements_scraped_last_updated', (${savedScrapeCount} Scraped Announcements)`);
            delete savedAPIAnnouncementsCount[tickerSymbol];
        }

        if (
            payload.historical_data_filepath ||
            Object.keys(payload.company_overview).length ||
            Object.keys(payload.company_details).length ||
            payload.transactions.length ||
            payload.director_interests.length ||
            payload.updated_timestamps.length
        ) {
            console.log(`Sending combined data for ${tickerSymbol}:`, payload);
            const response = await fetch("http://127.0.0.1:5000/save_data", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
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
        chrome.runtime.sendMessage({ action: "status_update", isRunning: false, isPaused: false });
    }
}

async function processTab(tabId) {
    const processedTickers = new Set();
    while (tickerQueue.length > 0) {
        let tickerSymbol;
        try {
            if (isPaused) {
                await new Promise((resolve) => {
                    const listener = (message) => {
                        if (message.action === "resume_scraping") {
                            chrome.runtime.onMessage.removeListener(listener);
                            resolve();
                        }
                    };
                    chrome.runtime.onMessage.addListener(listener);
                });
            }

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

            let url = `https://www.marketindex.com.au/asx/${tickerSymbol}`;
            console.log(`🚀 Updating tab ${tabId} for ${tickerSymbol}`);

            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab) {
                console.log(`Tab ${tabId} no longer exists. Stopping...`);
                activeTabs.delete(tabId);
                tabsToCloseGracefully.delete(tabId);
                return;
            }

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
                const scrapedData = await executeScraping(tabId, tickerSymbol);
                // await saveScrapedData(tickerSymbol, scrapedData);
            } else {
                console.log(`Expected content not found for ${tickerSymbol}. Skipping...`);
            }

            if (tabsToCloseGracefully.has(tabId)) {
                console.log(`🛑 Tab ${tabId} finished current scrape, closing gracefully`);
                activeTabs.delete(tabId);
                tabsToCloseGracefully.delete(tabId);
                if (closeTabs) chrome.tabs.remove(tabId);
                return;
            }
        } catch (error) {
            console.error(`Error in tab ${tabId} for ticker ${tickerSymbol}:`, error);
            if (tabsToCloseGracefully.has(tabId)) {
                console.log(`🛑 Tab ${tabId} errored, closing gracefully`);
                activeTabs.delete(tabId);
                tabsToCloseGracefully.delete(tabId);
                if (closeTabs) chrome.tabs.remove(tabId);
                return;
            }
        }

        console.log(`🏁 Completed ${tickerSymbol} in tab ${tabId}, checking next ticker`);
    }

    console.log(`✅ Tab ${tabId} finished processing queue`);
    activeTabs.delete(tabId);
    if (closeTabs) {
        console.log(`🛑 Closing tab ${tabId} as scraping is complete`);
        chrome.tabs.remove(tabId);
    } else {
        console.log(`⏹️ Keeping tab ${tabId} open (closeTabs disabled)`);
    }

    if (activeTabs.size === 0 && tickerQueue.length === 0) {
        console.log("✅ All tabs finished and queue empty. Scraping complete.");
        isRunning = false;
        try {
            chrome.runtime.sendMessage(
                { action: "status_update", isRunning: false, isPaused: false },
                (response) => {
                    if (chrome.runtime.lastError) {
                        console.log("No listener for status_update (e.g., popup closed), continuing anyway:", chrome.runtime.lastError.message);
                    }
                }
            );
        } catch (error) {
            console.error("Error sending status_update message:", error.message);
        }
    } else if (tickerQueue.length > 0) {
        console.log(`More tickers remain (${tickerQueue.length}), spawning new tab`);
        await adjustTabs();
    }
}

async function adjustTabs() {
    const targetTabs = Math.max(1, Math.min(currentMaxTabs, 10));
    const currentActive = activeTabs.size;

    if (currentActive < targetTabs && tickerQueue.length > 0) {
        const tabsToCreate = Math.min(targetTabs - currentActive, tickerQueue.length);
        for (let i = 0; i < tabsToCreate; i++) {
            try {
                let tab = await chrome.tabs.create({ url: "about:blank", active: false });
                activeTabs.add(tab.id);
                console.log(`🌟 Created tab ${tab.id} for processing`);
                processTab(tab.id);
                await new Promise((resolve) => setTimeout(resolve, 500));
            } catch (error) {
                console.error(`Failed to create tab:`, error);
            }
        }
    } else if (currentActive > targetTabs) {
        const tabsToClose = Array.from(activeTabs).slice(targetTabs);
        for (let tabId of tabsToClose) {
            tabsToCloseGracefully.add(tabId);
            console.log(`⏳ Tab ${tabId} marked to close gracefully after current scrape`);
        }
    }
}

async function executeScraping(tabId, tickerSymbol) {
    console.log(`🔍 Executing scraping for ${tickerSymbol} (Tab ID: ${tabId})`);
    try {
        // Inject content.js and wait for scraping_complete
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"]
        });
        console.log(`🔹 content.js injected into tab ${tabId}`);
        
    } catch (error) {
        console.error(`🚨 Error during scraping for ${tickerSymbol}:`, error);
        return { tickerSymbol, error: error.message };
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