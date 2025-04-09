// background.js

// Global state variables
let isRunning = false;
let isPaused = false;
let currentMaxTabs = 0;
let downloadAnnouncements = true;
let closeTabs = true; // Default to true
let activeTabs = new Set();
let tickerQueue = [];
let tabsToCloseGracefully = new Set();

console.log("Background script initializing...");

// Load settings from storage
chrome.storage.local.get(["maxTabs", "downloadAnnouncements", "closeTabs"], (data) => {
    if (data.maxTabs) currentMaxTabs = data.maxTabs;
    if (data.downloadAnnouncements !== undefined) downloadAnnouncements = data.downloadAnnouncements;
    if (data.closeTabs !== undefined) closeTabs = data.closeTabs;
    console.log(`Loaded settings: maxTabs=${currentMaxTabs}, downloadAnnouncements=${downloadAnnouncements}, closeTabs=${closeTabs}`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Received message:", message);

    // Handle ping for connection check
    if (message.action === "ping") {
        console.log("Ping received, responding with pong");
        sendResponse({ status: "pong" });
        return true; // Async response
    }

    if (message.action === "get_status") {
        sendResponse({ isRunning, isPaused });
        return true;
    } else if (message.action === "start_scraping") {
        const newMaxTabs = message.maxTabs;
        downloadAnnouncements = message.downloadAnnouncements !== undefined ? message.downloadAnnouncements : true;
        closeTabs = message.closeTabs !== undefined ? message.closeTabs : true;

        if (!isRunning) {
            isRunning = true;
            currentMaxTabs = newMaxTabs;
            fetchTickersAndStartScraping().then(() => {
                console.log(`✅ Scraping started with ${currentMaxTabs} tabs, downloadAnnouncements: ${downloadAnnouncements}, closeTabs: ${closeTabs}`);
                chrome.runtime.sendMessage({ action: "status_update", isRunning: true, isPaused: false });
                sendResponse({ success: true });
            }).catch((error) => {
                console.error('Error starting scraping:', error);
                isRunning = false;
                sendResponse({ success: false, error: error.message });
            });
        } else {
            currentMaxTabs = newMaxTabs;
            adjustTabs().then(() => {
                console.log(`🔄 Adjusted to ${currentMaxTabs} tabs, downloadAnnouncements: ${downloadAnnouncements}, closeTabs: ${closeTabs}`);
                chrome.runtime.sendMessage({ action: "status_update", isRunning: true, isPaused: false });
                sendResponse({ success: true });
            }).catch((error) => {
                console.error('Error adjusting tabs:', error);
                sendResponse({ success: false, error: error.message });
            });
        }
        return true;
    } else if (message.action === "pause_scraping") {
        isPaused = true;
        console.log("Scraping paused.");
        chrome.runtime.sendMessage({ action: "status_update", isRunning: true, isPaused: true });
    } else if (message.action === "resume_scraping") {
        isPaused = false;
        console.log("Scraping resumed.");
        processTickerQueue(message.delay);
        chrome.runtime.sendMessage({ action: "status_update", isRunning: true, isPaused: false });
    } else if (message.action === "get_existing_files") {
        const tickerSymbol = message.tickerSymbol;
        fetch(`http://127.0.0.1:5000/api/files/${tickerSymbol}`)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                return response.json();
            })
            .then(data => {
                console.log(`Retrieved ${data.files.length} existing files for ${tickerSymbol}`);
                sendResponse({ files: data.files });
            })
            .catch(error => {
                console.error(`Error fetching existing files for ${tickerSymbol}: ${error.message}`, error);
                sendResponse({ files: [] });
            });
        return true;
    } else if (message.action === "get_download_announcements") {
        sendResponse({ downloadAnnouncements });
        return true;
    } else if (message.action === "save_announcement_batch") {
        const batch = message.batch;
        console.log(`Received batch of ${batch.length} announcements`);

        async function handleBatch() {
            const tickerSymbol = sender.tab ? sender.tab.url.split('/').pop().toUpperCase() : "UNKNOWN";
            const announcementsWithTicker = batch.map(a => ({
                ...a,
                tickerSymbol: `${tickerSymbol}.AX`
            }));

            if (downloadAnnouncements) {
                for (let announcement of announcementsWithTicker) {
                    if (announcement.pdfLink && !announcement.downloaded) {
                        const relativeFilename = `announcements/${tickerSymbol}/${announcement.filename}`;
                        console.log(`📥 Downloading PDF for ${announcement.filename}`);

                        let isValidPdf = false;
                        try {
                            const headResponse = await Promise.race([
                                fetch(announcement.pdfLink, { method: "HEAD" }),
                                new Promise((_, reject) => setTimeout(() => reject(new Error("Validation timeout")), 5000))
                            ]);
                            if (headResponse.ok && headResponse.headers.get("Content-Type")?.includes("application/pdf")) {
                                isValidPdf = true;
                                console.log(`✅ PDF URL is valid`);
                            } else {
                                console.log(`❌ PDF URL invalid (Status: ${headResponse.status} or not a PDF)`);
                                announcement.pdfLocalPath = null;
                                continue;
                            }
                        } catch (e) {
                            console.error(`❌ Error validating PDF URL ${announcement.pdfLink}:`, e.message);
                            announcement.pdfLocalPath = null;
                            continue;
                        }

                        if (isValidPdf) {
                            const downloadId = await new Promise((resolve) => {
                                chrome.downloads.download({
                                    url: announcement.pdfLink,
                                    filename: relativeFilename,
                                    saveAs: false,
                                    conflictAction: "overwrite"
                                }, resolve);
                            });

                            const downloadItem = await waitForDownloadComplete(downloadId);
                            if (downloadItem && downloadItem.filename) {
                                console.log(`✅ Downloaded announcement PDF to ${downloadItem.filename}`);
                                announcement.pdfLocalPath = downloadItem.filename;
                                announcement.downloaded = true;
                            } else {
                                console.error(`❌ Failed to download announcement PDF for ${announcement.filename}`);
                                announcement.pdfLocalPath = null;
                            }
                        }
                    }
                }
            } else {
                console.log(`⏩ Skipping PDF downloads for batch (downloadAnnouncements disabled)`);
                announcementsWithTicker.forEach(a => a.pdfLocalPath = null);
            }

            try {
                const response = await fetch('http://127.0.0.1:5000/api/announcements', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ announcements: announcementsWithTicker })
                });
                if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                const result = await response.json();
                if (result.status === "success") {
                    console.log(`Saved batch of ${batch.length} announcements to DB`);
                    return { success: true };
                } else {
                    console.error("Failed to save batch:", result.error);
                    return { success: false, error: result.error };
                }
            } catch (error) {
                console.error('Error saving batch to DB:', error);
                return { success: false, error: error.message };
            }
        }

        handleBatch().then(result => sendResponse(result));
        return true;
    } else if (message.action === "scraping_complete") {
        const data = message.data;
        console.log("Received scraping_complete:", data);
        const tickerSymbol = sender.tab ? sender.tab.url.split('/').pop().toUpperCase() : "UNKNOWN";
        saveScrapedData(tickerSymbol, data).then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            console.error('Error in scraping_complete:', error);
            sendResponse({ success: false, error: error.message });
        });
        return true; // Changed to true for async response
    }

    return false;
});

async function saveScrapedData(tickerSymbol, data) {
    try {
        const savePromises = [];
        console.log(`Starting saveScrapedData for ${tickerSymbol} with data:`, data);

        if (data.transactions?.length > 0) {
            console.log(`Pushing transactions save promise for ${tickerSymbol}`);
            savePromises.push(
                fetch("http://127.0.0.1:5000/save_data", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tickerSymbol, transactions: data.transactions })
                })
                .then(res => res.json())
                .then(result => console.log(`✅ ${tickerSymbol} Transactions saved:`, result))
            );
        }

        if (data.director_interests?.length > 0) {
            console.log(`Pushing director interests save promise for ${tickerSymbol}`);
            savePromises.push(
                fetch("http://127.0.0.1:5000/save_data", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tickerSymbol, director_interests: data.director_interests })
                })
                .then(res => res.json())
                .then(result => console.log(`✅ ${tickerSymbol} Director Interests saved:`, result))
            );
        }

        if (data.historical_download_url) {
            savePromises.push(
                (async () => {
                    const filename = `${tickerSymbol}_historical.csv`;
                    const existingDownloads = await chrome.downloads.search({ filename });
                    const alreadyDownloaded = existingDownloads.some(d => d.state === "complete" && d.url === data.historical_download_url);
                    if (alreadyDownloaded) {
                        console.log(`⏩ Skipping historical download for ${tickerSymbol} - already exists`);
                        const response = await fetch("http://127.0.0.1:5000/save_data", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ tickerSymbol, historical_download_url: filename })
                        });
                        const result = await response.json();
                        console.log(`✅ ${tickerSymbol} Historical Data reused:`, result);
                        return;
                    }

                    console.log(`Initiating historical download for ${tickerSymbol}: ${data.historical_download_url}`);
                    const downloadId = await new Promise(resolve =>
                        chrome.downloads.download({
                            url: data.historical_download_url,
                            filename,
                            saveAs: false,
                            conflictAction: "overwrite"
                        }, resolve)
                    );
                    const downloadItem = await waitForDownloadComplete(downloadId);
                    if (downloadItem?.filename) {
                        const historicalResponse = await fetch("http://127.0.0.1:5000/save_data", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ tickerSymbol, historical_download_url: downloadItem.filename })
                        });
                        const result = await historicalResponse.json();
                        console.log(`✅ ${tickerSymbol} Historical Data saved:`, result);
                        chrome.downloads.removeFile(downloadId);
                    } else {
                        console.error(`❌ Failed to download historical data for ${tickerSymbol}`);
                    }
                })()
            );
        }

        // Save company overview and details
        if (data.company_overview || data.company_details) {
            console.log(`Pushing company overview and details save promise for ${tickerSymbol}`);
            savePromises.push(
                fetch("http://127.0.0.1:5000/save_data", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        tickerSymbol,
                        company_overview: data.company_overview || {},
                        company_details: data.company_details || {}
                    })
                })
                .then(res => res.json())
                .then(result => console.log(`✅ ${tickerSymbol} Company Overview and Details saved:`, result))
            );
        }

        console.log(`Awaiting ${savePromises.length} save promises for ${tickerSymbol}`);
        await Promise.all(savePromises);
        console.log(`Completed saveScrapedData for ${tickerSymbol}`);
    } catch (error) {
        console.error(`❌ Error saving data for ${tickerSymbol}:`, error);
        throw error;
    }
}

async function waitForDownloadComplete(downloadId) {
    return new Promise(resolve => {
        chrome.downloads.onChanged.addListener(function listener(delta) {
            if (delta.id === downloadId && delta.state?.current === "complete") {
                chrome.downloads.onChanged.removeListener(listener);
                chrome.downloads.search({ id: downloadId }, results => resolve(results[0]));
            }
        });
    });
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
        let ticker;
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

            ticker = tickerQueue.shift();
            if (processedTickers.has(ticker)) {
                console.log(`⏩ Ticker ${ticker} already processed in tab ${tabId}, skipping`);
                continue;
            }
            processedTickers.add(ticker);

            let url = `https://www.marketindex.com.au/asx/${ticker}`;
            console.log(`🚀 Updating tab ${tabId} for ${ticker}`);

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
                const scrapedData = await executeScraping(tabId, ticker);
                console.log(`Scraped data for ${ticker}:`, scrapedData);
            } else {
                console.log(`Expected content not found for ${ticker}. Skipping...`);
            }

            if (tabsToCloseGracefully.has(tabId)) {
                console.log(`🛑 Tab ${tabId} finished current scrape, closing gracefully`);
                activeTabs.delete(tabId);
                tabsToCloseGracefully.delete(tabId);
                if (closeTabs) chrome.tabs.remove(tabId);
                return;
            }
        } catch (error) {
            console.error(`Error in tab ${tabId} for ticker ${ticker || "unknown"}:`, error);
            if (tabsToCloseGracefully.has(tabId)) {
                console.log(`🛑 Tab ${tabId} errored, closing gracefully`);
                activeTabs.delete(tabId);
                tabsToCloseGracefully.delete(tabId);
                if (closeTabs) chrome.tabs.remove(tabId);
                return;
            }
        }
    }
    console.log(`✅ Tab ${tabId} finished processing queue`);
    activeTabs.delete(tabId);
    if (closeTabs) {
        console.log(`🛑 Closing tab ${tabId} as scraping is complete`);
        chrome.tabs.remove(tabId);
    } else {
        console.log(`⏹️ Keeping tab ${tabId} open (closeTabs disabled)`);
    }

    if (activeTabs.size === 0) {
        console.log("✅ All tabs finished. Scraping complete.");
        isRunning = false;
        chrome.runtime.sendMessage({ action: "status_update", isRunning: false, isPaused: false });
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
                await new Promise(resolve => setTimeout(resolve, 500));
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
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (ticker) => { window.tickerSymbol = ticker; },
            args: [tickerSymbol]
        });
        console.log(`🔹 Injected ticker symbol ${tickerSymbol} into tab ${tabId}`);

        let listenerActive = true;
        let handler;
        const scrapedData = await Promise.race([
            new Promise((resolve) => {
                handler = (message, sender) => {
                    if (message.action === "scraping_complete" && sender.tab.id === tabId) {
                        chrome.runtime.onMessage.removeListener(handler);
                        listenerActive = false;
                        console.log(`🔹 Received scraping_complete for ${tickerSymbol} with data:`, message.data);
                        resolve(message.data);
                    }
                };
                chrome.runtime.onMessage.addListener(handler);
                chrome.scripting.executeScript({
                    target: { tabId },
                    files: ["content.js"]
                }).then(() => console.log(`🔹 content.js injected into tab ${tabId}`))
                  .catch(err => console.error(`❌ Failed to inject content.js for ${tickerSymbol}:`, err));
            }),
            new Promise((_, reject) => setTimeout(() => {
                if (listenerActive) {
                    console.warn(`⏰ Scraping timeout for ${tickerSymbol} after 600 seconds`);
                    chrome.runtime.onMessage.removeListener(handler);
                    reject(new Error("Scraping timeout"));
                }
            }, 600000))
        ]);

        return scrapedData;
    } catch (error) {
        console.error(`🚨 Error during scraping for ${tickerSymbol}:`, error);
        return {};
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
                    hasExpectedContent: !!document.querySelector("#directors-transactions-root") || 
                                       !!document.querySelector("#directors-interests-root") || 
                                       !!document.querySelector('a.btn[href*="download-historical-data"]') || 
                                       !!document.querySelector('#app-table table.mi-data-table')
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
    const CHECK_INTERVAL = 2000;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
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
    console.log(`Processing ticker queue with delay ${delay}ms - Function not fully implemented yet.`);
    // Add implementation if needed
}

console.log("Background script fully loaded");