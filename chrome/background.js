// background.js
console.log('background.js loaded');

let isRunning = false;
let isPaused = false;
let tickerQueue = [];
let currentMaxTabs = 3;
let activeTabs = new Set();
let tabStates = new Map();
let downloadPdfs = true;
let closeTabs = true;
let apiFetchAnnouncements = true;
let webScrapeAnnouncements = true;
let savedAPIAnnouncementsCount = {};
let savedScrapedAnnouncementsCount = {};
const ports = new Map();

chrome.runtime.onConnect.addListener((port) => {
    const name = port.name;
    let key;
    if (name === 'popup') key = 'popup';
    else if (name.startsWith('content-')) key = parseInt(name.split('-')[1]);
    if (key === undefined || isNaN(key) && key !== 'popup') return;
    ports.set(key, port);
    console.log(`Port connected: ${name}, key: ${key}`);
    port.onMessage.addListener((msg) => handleMessage(msg, port));
    port.onDisconnect.addListener(() => {
        console.log(`Port disconnected: ${key}`);
        ports.delete(key);
    });
});

function sendToTab(tabId, message, retryCount = 0, maxRetries = 5, retryDelay = 1000) {
    return new Promise((resolve, reject) => {
        const port = ports.get(tabId);
        if (port) {
            console.log(`Sending message to tab ${tabId}:`, message);
            port.postMessage(message);
            resolve();
        } else {
            console.log(`No port found for tab ${tabId}`);
            // Remove any stale port entry for this tabId
            ports.delete(tabId);
            console.log(`Removed stale port entry for tab ${tabId}`);
            // Reject immediately since we can't create a new port here; content script must reconnect
            reject(new Error('No port found; port entry removed'));
        }
    });
}

function sendToPopup(message, retryCount = 0, maxRetries = 3, retryDelay = 500) {
    const port = ports.get('popup');
    if (port) {
        console.log('Sending message to popup:', message);
        port.postMessage(message);
    } else {
        console.log('No popup port found');
        if (retryCount < maxRetries) {
            console.log(`Retrying send to popup in ${retryDelay}ms (attempt ${retryCount + 1}/${maxRetries})`);
            setTimeout(() => sendToPopup(message, retryCount + 1, maxRetries, retryDelay), retryDelay);
        } else {
            console.log('❌ Failed to send message to popup after retries:', message);
        }
    }
}

function getTabIdFromPort(port) {
    for (let [key, p] of ports) {
        if (typeof key === 'number' && p === port) return key;
    }
    return null;
}

function broadcastTabStates() {
    const tabStatesArray = Array.from(tabStates.entries()).map(([id, state]) => ({
        tabId: id,
        ticker: state.ticker || '',
        status: state.status || 'Initializing',
        isPaused: state.isPaused || false
    }));
    console.log('Broadcasting tab states:', tabStatesArray);
    sendToPopup({ action: 'update_tab_states', data: tabStatesArray });
}

function handleMessage(message, port) {
    const tabId = getTabIdFromPort(port);
    console.log(`Background received message from ${tabId ? `tab ${tabId}` : 'popup'} (ID: ${message.id}):`, message);
    if (!message.action) {
        if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: 'No action' });
        return;
    }

    switch (message.action) {
        case 'get_status':
            if (message.id !== undefined) {
                console.log(`Responding to get_status: isRunning=${isRunning}, isPaused=${isPaused}`);
                port.postMessage({ id: message.id, isRunning, isPaused });
            }
            break;
        case 'get_tab_states':
            for (const id of tabStates.keys()) {
                if (!activeTabs.has(id)) {
                    console.log(`Removing stale tab state for tab ${id}`);
                    tabStates.delete(id);
                }
            }
            const tabStatesResponse = {
                id: message.id,
                tabStates: Array.from(tabStates.entries()).map(([id, state]) => ({
                    tabId: id,
                    ticker: state.ticker || '',
                    status: state.status || 'Initializing',
                    isPaused: state.isPaused || false
                }))
            };
            console.log('Responding to get_tab_states with:', tabStatesResponse);
            if (message.id !== undefined) sendToPopup(tabStatesResponse);
            break;
        case 'pause_tab':
            if (message.tabId && activeTabs.has(message.tabId)) {
                const state = tabStates.get(message.tabId) || {};
                if (!state.isPaused) {
                    tabStates.set(message.tabId, { ...state, isPaused: true });
                    console.log(`Pausing tab ${message.tabId}`);
                    broadcastTabStates();
                    sendToTab(message.tabId, { action: 'pause_tab' });
                }
                if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
            }
            break;
        case 'resume_tab':
            if (message.tabId && activeTabs.has(message.tabId)) {
                const state = tabStates.get(message.tabId) || {};
                if (state.isPaused) {
                    tabStates.set(message.tabId, { ...state, isPaused: false });
                    console.log(`Resuming tab ${message.tabId}`);
                    broadcastTabStates();
                    sendToTab(message.tabId, { action: 'resume_tab' });
                }
                if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
            }
            break;
        case 'start_scraping':
            currentMaxTabs = message.maxTabs || 3;
            downloadPdfs = message.downloadPdfs ?? true;
            closeTabs = message.closeTabs ?? true;
            apiFetchAnnouncements = message.apiFetchAnnouncements ?? true;
            webScrapeAnnouncements = message.webScrapeAnnouncements ?? true;
            if (!isRunning) {
                isRunning = true;
                activeTabs.clear();
                tabStates.clear();
                console.log('Starting scraping with config:', { currentMaxTabs, downloadPdfs, closeTabs, apiFetchAnnouncements, webScrapeAnnouncements });
                fetchTickersAndStartScraping().then(() => {
                    sendToPopup({ action: 'status_update', isRunning: true, isPaused: false });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                });
            }
            break;
        case 'pause_scraping':
            if (!isPaused) {
                isPaused = true;
                tabStates.forEach((state, id) => {
                    tabStates.set(id, { ...state, isPaused: true });
                });
                activeTabs.forEach(tabId => {
                    sendToTab(tabId, { action: 'pause_tab' });
                });
                console.log('Pausing scraping');
                broadcastTabStates();
                sendToPopup({ action: 'status_update', isRunning: true, isPaused: true });
            }
            if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
            break;
        case 'resume_scraping':
            if (isPaused) {
                isPaused = false;
                tabStates.forEach((state, id) => {
                    tabStates.set(id, { ...state, isPaused: false });
                });
                activeTabs.forEach(tabId => {
                    sendToTab(tabId, { action: 'resume_tab' });
                });
                console.log('Resuming scraping');
                broadcastTabStates();
                processTickerQueue();
                sendToPopup({ action: 'status_update', isRunning: true, isPaused: false });
            }
            if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
            break;
        case 'update_config':
            currentMaxTabs = message.maxTabs || currentMaxTabs;
            console.log(`Updating config: maxTabs=${currentMaxTabs}`);
            adjustTabs();
            if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
            break;
        case 'update_tab_status':
            if (tabId) {
                tabStates.set(tabId, { ...tabStates.get(tabId) || { ticker: '', isPaused: false }, status: message.status });
                console.log(`Updated status for tab ${tabId}: ${message.status}`);
                broadcastTabStates();
                if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
            }
            break;
        case 'update_tab_ticker':
            if (tabId) {
                tabStates.set(tabId, { ...tabStates.get(tabId) || { status: 'Initializing', isPaused: false }, ticker: message.ticker.toUpperCase() });
                console.log(`Updated ticker for tab ${tabId}: ${message.ticker}`);
                broadcastTabStates();
                if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
            }
            break;
        case 'title_result':
            if (message.tabId && activeTabs.has(message.tabId)) {
                if (message.success) {
                    console.log(`Title matched for ${tabStates.get(message.tabId)?.ticker} on tab ${message.tabId}. Scraping already started in content.js.`);
                } else {
                    console.log(`Title did not match after 30 attempts for ${tabStates.get(message.tabId)?.ticker} on tab ${message.tabId}. Skipping.`);
                    processTab(message.tabId);
                }
            }
            break;
        case 'get_existing_files':
            fetch(`http://127.0.0.1:5000/api/files/${message.tickerSymbol}`)
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                    return response.json();
                })
                .then(data => {
                    console.log(`✅ Retrieved ${data.files.length} existing files for ${message.tickerSymbol}`);
                    port.postMessage({ id: message.id, files: data.files });
                })
                .catch(error => {
                    console.error(`❌ Error fetching existing files for ${message.tickerSymbol}:`, error.message);
                    port.postMessage({ id: message.id, files: [] });
                });
            break;
        case 'save_api_announcement_batch':
            fetch("http://127.0.0.1:5000/api/announcements_via_api", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ announcements: message.batch })
            })
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                    return response.json();
                })
                .then(data => {
                    console.log(`✅ Saved API announcement batch for ${message.tickerSymbol}`);
                    savedAPIAnnouncementsCount[message.tickerSymbol] = (savedAPIAnnouncementsCount[message.tickerSymbol] || 0) + message.batch.length;
                    port.postMessage({ id: message.id, success: true, data });
                })
                .catch(error => {
                    console.error(`❌ Error saving API announcement batch for ${message.tickerSymbol}:`, error.message);
                    port.postMessage({ id: message.id, success: false, error: error.message });
                });
            break;
        case 'save_scraped_announcement_batch':
            fetch("http://127.0.0.1:5000/api/announcements_via_dom", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ announcements: message.batch })
            })
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                    return response.json();
                })
                .then(data => {
                    console.log(`✅ Saved scraped announcement batch for ${message.tickerSymbol}`);
                    savedScrapedAnnouncementsCount[message.tickerSymbol] = (savedScrapedAnnouncementsCount[message.tickerSymbol] || 0) + message.batch.length;
                    port.postMessage({ id: message.id, success: true, data });
                })
                .catch(error => {
                    console.error(`❌ Error saving scraped announcement batch for ${message.tickerSymbol}:`, error.message);
                    port.postMessage({ id: message.id, success: false, error: error.message });
                });
            break;
        case 'scraping_complete':
            const payload = prepareScrapedDataPayload(message);
        
            fetch("http://127.0.0.1:5000/save_data", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            })
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                    return response.json();
                })
                .then(data => {
                    console.log(`✅ Saved final scraped data for ${message.tickerSymbol}`);
                    port.postMessage({ id: message.id, success: true, data });
                    if (closeTabs && tabId) {
                        activeTabs.delete(tabId);
                        tabStates.delete(tabId);
                        console.log(`Closing tab ${tabId} after scraping complete`);
                        chrome.tabs.remove(tabId);
                        sendToPopup({ action: 'tab_closed', tabId });
                    } else {
                        processTab(tabId);
                    }

                })
                .catch(error => {
                    console.error(`❌ Error saving final scraped data for ${message.tickerSymbol}:`, error.message);
                    port.postMessage({ id: message.id, success: false, error: error.message });
                });
            break;
        case 'web_scrap_announcements':
            if (message.id !== undefined) port.postMessage({ id: message.id, webScrapeAnnouncements });
            break;
        case 'ping':
            if (message.id !== undefined) port.postMessage({ id: message.id, success: true, action: 'pong' });
            break;
        case 'get_config':
            if (message.id !== undefined) {
                const config = {
                    currentMaxTabs,
                    downloadPdfs,
                    closeTabs,
                    apiFetchAnnouncements,
                    webScrapeAnnouncements
                };
                port.postMessage({ id: message.id, config });
            }
            break;
    }
}

function prepareScrapedDataPayload(message) {
    const payload = {
        tickerSymbol: message.tickerSymbol,
        update_timestamps: {},
        company_overview: message.data.company_overview || {},
        company_details: message.data.company_details || {},
        transactions: message.data.transactions || [],
        director_interests: message.data.director_interests || [],
        historical_download_url: message.data.historical_download_url || null
    };

    // Add announcement count checks from the old version
    const savedAPICount = savedAPIAnnouncementsCount[message.tickerSymbol] || 0;
    const savedScrapeCount = savedScrapedAnnouncementsCount[message.tickerSymbol] || 0;
    const totalApiFetchable = message.data.total_api_fetchable_announcements || 0;
    const totalScrapeable = message.data.total_scrapeable_announcements || 0;

    if (apiFetchAnnouncements && savedAPICount === totalApiFetchable && totalApiFetchable > 0) {
        payload.update_timestamps.announcements_api_fetched_last_updated = true;
        console.log(`🎉 ${message.tickerSymbol} Update 'announcements_api_fetched_last_updated', (API Fetched: ${totalApiFetchable} match API Saved: ${savedAPICount})`);
    } else {
        console.log(`❌ ${message.tickerSymbol} Skip Update 'announcements_api_fetched_last_updated', (API Fetched: ${totalApiFetchable} does not match API Saved: ${savedAPICount})`);
    }
    delete savedAPIAnnouncementsCount[message.tickerSymbol];

    if (webScrapeAnnouncements && savedScrapeCount === totalScrapeable && totalScrapeable > 0) {
        payload.update_timestamps.announcements_scraped_last_updated = true;
        console.log(`🎉 ${message.tickerSymbol} Update 'announcements_scraped_last_updated', (Scraped: ${totalScrapeable} match Scraped Saved: ${savedScrapeCount})`);
    } else {
        console.log(`❌ ${message.tickerSymbol} Skip Update 'announcements_scraped_last_updated', (Scraped: ${totalScrapeable} does not match Scraped Saved: ${savedScrapeCount})`);
    }
    delete savedScrapedAnnouncementsCount[message.tickerSymbol];

    return payload;
}

async function fetchTickersAndStartScraping() {
    try {
        console.log('Fetching tickers from server...');
        const response = await fetch("http://127.0.0.1:5000/get_tickers");
        tickerQueue = await response.json();
        console.log(`Fetched ${tickerQueue.length} tickers.`);
        await adjustTabs();
    } catch (error) {
        alert("Failed to fetch tickers. Please ensure that server.py is running.");
        console.log("Error fetching tickers:", error);
    }
}

async function adjustTabs() {
    const targetTabs = Math.max(1, Math.min(currentMaxTabs, 10));
    const currentActive = activeTabs.size;

    console.log(`Adjusting tabs: target=${targetTabs}, active=${currentActive}`);

    for (let tabId of tabStates.keys()) {
        if (!activeTabs.has(tabId)) {
            console.log(`Removing stale tab state for tab ${tabId}`);
            tabStates.delete(tabId);
            sendToPopup({ action: 'tab_closed', tabId });
        }
    }

    if (currentActive < targetTabs && tickerQueue.length > 0) {
        const tabsToCreate = Math.min(targetTabs - currentActive, tickerQueue.length);
        console.log(`Creating ${tabsToCreate} new tabs`);
        for (let i = 0; i < tabsToCreate; i++) {
            let tab = await chrome.tabs.create({ url: "about:blank", active: false });
            activeTabs.add(tab.id);
            tabStates.set(tab.id, { ticker: '', status: 'Initializing', isPaused: false });
            console.log(`Created tab ${tab.id}`);
            broadcastTabStates();
            processTab(tab.id);
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
}

async function processTab(tabId) {
    while (tickerQueue.length > 0 && activeTabs.has(tabId)) {
        const tickerSymbol = tickerQueue.shift();
        if (!tickerSymbol) break;

        tabStates.set(tabId, { ticker: tickerSymbol.toUpperCase(), status: 'Processing', isPaused: false });
        console.log(`Processing ticker ${tickerSymbol} on tab ${tabId}`);
        broadcastTabStates();

        await chrome.tabs.update(tabId, { url: `https://www.marketindex.com.au/asx/${tickerSymbol}` });
        await new Promise((resolve) => {
            chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
                if (updatedTabId === tabId && info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            });
        });

        console.log(`Page loaded for ${tickerSymbol} on tab ${tabId}. Injecting scripts...`);
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                func: (id) => {
                    window.tabId = id;
                },
                args: [tabId]
            });

            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            });

            console.log(`Injected content.js into tab ${tabId}`);
            await waitForPort(tabId);
            await sendToTab(tabId, { action: 'check_title', tickerSymbol });
        } catch (err) {
            console.error(`Failed to process tab ${tabId}:`, err);
            tabStates.set(tabId, { ...tabStates.get(tabId), status: 'Error' });
            broadcastTabStates();
            processTab(tabId);
        }
        break;
    }

    if (activeTabs.size === 0 && tickerQueue.length === 0) {
        isRunning = false;
        console.log('All tickers processed. Stopping.');
        sendToPopup({ action: 'status_update', isRunning: false, isPaused: false });
    }
}

function waitForPort(tabId, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const checkInterval = setInterval(() => {
            if (ports.has(tabId)) {
                clearInterval(checkInterval);
                resolve();
            } else if (Date.now() - startTime > timeout) {
                clearInterval(checkInterval);
                reject(new Error(`Timeout waiting for port for tab ${tabId}`));
            }
        }, 100);
    });
}

async function processTickerQueue() {
    if (!isRunning || tickerQueue.length === 0) return;
    if (activeTabs.size < currentMaxTabs) await adjustTabs();
}