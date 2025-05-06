// Background script for Chrome extension
// This script manages the communication between the popup, content scripts, and the server.
// It handles the scraping process, manages tabs, and communicates with the server for data storage.

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
const retryInjectionSetupTime = 30000;
const ports = new Map();
const baseURL = `https://www.marketindex.com.au/asx/`;
const allCategories = [
    'ErrorLogs', 'WarningLogs', 'GeneralLogs', 'DebugLogs', 'ScrapeLogs', 'ServerLogs',
    'TickerCompletionLogs', 'DataLogs', 'ErrorHandlingLogs', 'AnnouncementLogs', 'TabLogs',
    'PortLogs', 'ConfigLogs', 'RetryLogs', 'ActionLogs', 'PerfLogs', 'prefixDateTime',
    'DownloadLogs', 'NotificationLogs', 'prefixTickerSymbol', 'prefixTabId', 'prefixPortName'
];
let loggingPrefs = {};
let isPopupOpen = false;
let popupMessageQueue = [];

class HttpError extends Error {
    constructor(message, status, statusText, responseBody) {
        super(message);
        this.status = status;
        this.statusText = statusText;
        this.responseBody = responseBody;
    }
}

function loadLoggingPrefs() {
    chrome.storage.local.get('loggingPreferences', (data) => {
        loggingPrefs = (data && data.loggingPreferences) || {};
        allCategories.forEach(cat => {
            if (!(cat in loggingPrefs)) loggingPrefs[cat] = true;
        });
    });
}

loadLoggingPrefs();

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'loggingPreferences' in changes) {
        loggingPrefs = changes.loggingPreferences.newValue;
    }
});

function log(categories, message, context = {}) {
    if (categories.some(cat => loggingPrefs[cat])) {
        let pre_message = '';
        if (loggingPrefs['prefixDateTime']) pre_message += `[${new Date().toISOString()}]`;
        if (loggingPrefs['prefixTickerSymbol'] && context.tickerSymbol) pre_message += `[${context.tickerSymbol}]`;
        if (loggingPrefs['prefixTabId'] && context.tabId) pre_message += `[${context.tabId}]`;
        if (loggingPrefs['prefixPortName'] && context.portName) pre_message += `[${context.portName}]`;
        pre_message += pre_message ? ' - ' : '';

        if (typeof message === 'object' && message[0]) {
            message[0] = `${pre_message}${message[0]}`;
            if (categories.includes('ErrorLogs')) console.error(...message);
            else if (categories.includes('WarningLogs')) console.warn(...message);
            else console.log(...message);
        } else {
            message = `${pre_message}${message}`;
            if (categories.includes('ErrorLogs')) console.error(message);
            else if (categories.includes('WarningLogs')) console.warn(message);
            else console.log(message);
        }
    }
}

async function checkTabClosedByUser(tabId) {
    try {
        await chrome.tabs.get(tabId);
        return false; // Tab exists, not closed
    } catch (error) {
        return true; // Tab not found, likely closed by user
    }
}

chrome.runtime.onConnect.addListener((port) => {
    try {
        const name = port.name;
        let key;
        if (name === 'popup') key = 'popup';
        else if (name.startsWith('content-')) key = parseInt(name.split('-')[1], 10);
        if (key === undefined || (isNaN(key) && key !== 'popup')) return;

        const disconnectHandler = () => {
            const portData = ports.get(key) || {};
            const { tabId, tickerSymbol = 'unknown' } = portData;
            log(['PortLogs'], `Port disconnected: ${key}, tabId: ${tabId || 'none'}, tickerSymbol: ${tickerSymbol}`, { portName: name });

            if (key === 'popup') {
                isPopupOpen = false;
                log(['PortLogs'], 'Popup disconnected, queuing future messages', {});
            } else if (tabId && activeTabs.has(tabId) && tickerSymbol !== 'unknown') {
                log(['ActionLogs', 'TabLogs'], `Restarting tab ${tabId}`, { tabId, tickerSymbol });
                chrome.tabs.reload(tabId, {}, async () => {
                    if (chrome.runtime.lastError) {
                        const isClosedByUser = await checkTabClosedByUser(tabId);
                        if (!isClosedByUser) {
                            log(['ErrorLogs', 'TabLogs'], `Failed to reload tab ${tabId}: ${chrome.runtime.lastError.message}`, { tabId, tickerSymbol });
                        } else {
                            log(['DebugLogs', 'TabLogs'], `Tab ${tabId} closed by user, skipping reload`, { tabId, tickerSymbol });
                        }
                    } else {
                        log(['TabLogs'], `Tab ${tabId} reloaded`, { tabId, tickerSymbol });
                        injectionSetup(tabId, tickerSymbol);
                    }
                });
            } else if (key !== 'popup') {
                log(['WarningLogs', 'TabLogs'], `Cannot restart tab ${tabId || 'unknown'}: not active or no tickerSymbol`, { tabId, tickerSymbol });
                if (tabId) {
                    activeTabs.delete(tabId);
                    tabStates.delete(tabId);
                    sendToPopup({ action: 'tab_closed', tabId });
                }
            }
            ports.delete(key);
        };

        ports.set(key, { port, tabId: key !== 'popup' ? key : null, tickerSymbol: null, disconnectHandler });
        log(['PortLogs'], `Port connected: ${name}, key: ${key}`, { portName: name });

        if (key === 'popup') {
            isPopupOpen = true;
            log(['PortLogs'], 'Popup connected, sending latest state', {});
            port.postMessage({ action: 'status_update', isRunning, isPaused });
            const tabStatesArray = Array.from(tabStates.entries()).map(([id, state]) => ({
                tabId: id,
                ticker: state.ticker || '',
                status: state.status || 'Initializing',
                isPaused: state.isPaused || false
            }));
            port.postMessage({ action: 'update_tab_states', data: tabStatesArray });
            while (popupMessageQueue.length > 0) {
                const queuedMessage = popupMessageQueue.shift();
                log(['PortLogs'], `Sending queued message to popup: ${JSON.stringify(queuedMessage)}`, {});
                port.postMessage(queuedMessage);
            }
        }

        port.onMessage.addListener((message) => handleMessage(message, port, key));
        port.onDisconnect.addListener(disconnectHandler);
    } catch (error) {
        log(['ErrorLogs'], `Error in onConnect listener: ${error.message}`, {});
    }
});

function enableDisconnectListener(tabId, tickerSymbol = null) {
    const portData = ports.get(tabId);
    if (portData?.port && portData?.disconnectHandler) {
        portData.port.onDisconnect.addListener(portData.disconnectHandler);
        log(['PortLogs'], `Enabled disconnect listener for tabId: ${tabId}`, { portName: portData.port.name, tickerSymbol, tabId });
    } else {
        log(['WarningLogs', 'PortLogs'], `Cannot enable disconnect listener for tabId: ${tabId} - port or handler missing`, { tickerSymbol, tabId });
    }
}

function disableDisconnectListener(tabId, tickerSymbol = null) {
    const portData = ports.get(tabId);
    if (portData?.port && portData?.disconnectHandler) {
        portData.port.onDisconnect.removeListener(portData.disconnectHandler);
        log(['PortLogs'], `Disabled disconnect listener for tabId: ${tabId}`, { portName: portData.port.name, tickerSymbol, tabId });
    } else {
        log(['WarningLogs', 'PortLogs'], `Cannot disable disconnect listener for tabId: ${tabId} - port or handler missing`, { tickerSymbol, tabId });
    }
}

async function handleMessage(message, port, key) {
    const tabId = key !== 'popup' ? key : null;
    const tickerSymbol = message.tickerSymbol || null;
    const action = message.action || '';

    try {
        log(['DebugLogs', 'PortLogs'], `Received message from ${tabId ? `tab ${tabId}` : 'popup'} (ID: ${message.id || 'none'}) ${action}`, { tabId, tickerSymbol });

        if (!message.action) {
            if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: 'No action' });
            return;
        }

        if (message.tabId || message.tickerSymbol) {
            const portData = ports.get(key) || {};
            
            ports.set(key, {
                ...portData,
                port,
                tabId: message.tabId || portData.tabId || (key !== 'popup' ? key : null),
                tickerSymbol: tickerSymbol
            });
            log(['PortLogs'], `Updated for key ${key}: tabId=${message.tabId || portData.tabId || key}, tickerSymbol=${message.tickerSymbol || portData.tickerSymbol || 'none'}`, { portName: port.name, tickerSymbol: message.tickerSymbol || portData.tickerSymbol || null });
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        switch (message.action) {
            case 'content_ready':
                if (tabId && message.id !== undefined) {
                    log(['GeneralLogs', 'TabLogs'], `Tab ${tabId} is ready`, { tabId, tickerSymbol });
                    await sendToTab(tabId, { action: 'check_page', tickerSymbol });
                    port.postMessage({ id: message.id, success: true });
                }
                break;
            case 'get_status':
                if (message.id !== undefined) {
                    port.postMessage({ id: message.id, success: true, isRunning, isPaused });
                }
                break;
            case 'get_tab_states':
                for (const id of tabStates.keys()) {
                    if (!activeTabs.has(id)) tabStates.delete(id);
                }
                const tabStatesResponse = {
                    id: message.id,
                    success: true,
                    tabStates: Array.from(tabStates.entries()).map(([id, state]) => ({
                        tabId: id,
                        ticker: state.ticker || '',
                        status: state.status || 'Initializing',
                        isPaused: state.isPaused || false
                    }))
                };
                sendToPopup(tabStatesResponse);
                break;
            case 'pause_tab':
                if (message.tabId && activeTabs.has(message.tabId)) {
                    updateTabStatus(message.tabId, { isPaused: true });
                    await sendToTab(message.tabId, { action: 'pause_tab' });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                }
                break;
            case 'resume_tab':
                if (message.tabId && activeTabs.has(message.tabId)) {
                    try {
                        const tab = await chrome.tabs.get(message.tabId);
                        log(['DebugLogs'], `Tab ${message.tabId} status: ${tab.status}, url: ${tab.url}`, { tabId: message.tabId, tickerSymbol });
                        updateTabStatus(message.tabId, { isPaused: false });
                        const sent = await sendToTab(message.tabId, { action: 'resume_tab' });
                        log(['DebugLogs'], `Sent resume_tab to tab ${message.tabId}: ${sent ? 'success' : 'failed'}`);
                        if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                    } catch (error) {
                        log(['ErrorLogs'], `Tab ${message.tabId} not found: ${error.message}`, { tabId: message.tabId, tickerSymbol });
                        activeTabs.delete(message.tabId);
                        tabStates.delete(message.tabId);
                        sendToPopup({ action: 'tab_closed', tabId: message.tabId });
                        if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: error.message });
                    }
                }
                break;
            case 'start_scraping':
                currentMaxTabs = message.maxTabs || currentMaxTabs;
                downloadPdfs = message.downloadPdfs ?? downloadPdfs;
                closeTabs = message.closeTabs ?? closeTabs;
                apiFetchAnnouncements = message.apiFetchAnnouncements ?? apiFetchAnnouncements;
                webScrapeAnnouncements = message.webScrapeAnnouncements ?? webScrapeAnnouncements;
                if (!isRunning) {
                    isRunning = true;
                    activeTabs.clear();
                    tabStates.clear();
                    await fetchTickersAndStartScraping();
                    sendToPopup({ action: 'status_update', isRunning: true, isPaused: false });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                }
                break;
            case 'pause_scraping':
                if (!isPaused) {
                    isPaused = true;
                    tabStates.forEach((state, id) => tabStates.set(id, { ...state, isPaused: true }));
                    for (const tabId of activeTabs) {
                        await sendToTab(tabId, { action: 'pause_tab' });
                    }
                    broadcastTabStates();
                    sendToPopup({ action: 'status_update', isRunning: true, isPaused: true });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                }
                break;
            case 'resume_scraping':
                if (isPaused) {
                    isPaused = false;
                    tabStates.forEach((state, id) => tabStates.set(id, { ...state, isPaused: false }));
                    for (const tabId of activeTabs) {
                        await sendToTab(tabId, { action: 'resume_tab' });
                    }
                    broadcastTabStates();
                    processTickerQueue();
                    sendToPopup({ action: 'status_update', isRunning: true, isPaused: false });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                }
                break;
            case 'update_config':
                currentMaxTabs = message.maxTabs || currentMaxTabs;
                await adjustTabs();
                if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                break;
            case 'update_tab_status':
                if (tabId && message.status) {
                    updateTabStatus(tabId, { status: message.status });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                }
                break;
            case 'update_tab_ticker':
                if (tabId && message.ticker) {
                    updateTabStatus(tabId, { ticker: message.ticker.toUpperCase(), status: 'Initializing' });
                }
                break;
            case 'page_result':
                if (message.tabId && activeTabs.has(message.tabId)) {
                    if (message.success) {
                        log(['ScrapeLogs', 'TabLogs'], `Page matched for ${tabStates.get(message.tabId)?.ticker} on tab ${message.tabId}`, { tabId, tickerSymbol });
                    } else {
                        log(['WarningLogs', 'TabLogs'], `Page did not match for ${tabStates.get(message.tabId)?.ticker} on tab ${message.tabId}`, { tabId, tickerSymbol });
                        await processTab(message.tabId);
                    }
                }
                break;
            case 'get_existing_files':
                try {
                    const response = await fetch(`http://127.0.0.1:5000/api/files/${message.tickerSymbol}`);
                    if (!response.ok) throw new HttpError(`HTTP error! Status: ${response.status}`, response.status, response.statusText);
                    const data = await response.json();
                    port.postMessage({ id: message.id, success: true, files: data.files });
                } catch (error) {
                    log(['ErrorLogs', 'ServerLogs'], `Error fetching files for ${message.tickerSymbol}: ${error.message}`, { tabId, tickerSymbol });
                    port.postMessage({ id: message.id, success: false, files: [], error: error.message });
                }
                break;
            case 'save_scraped_announcement_batch':
                try {
                    const response = await fetch("http://127.0.0.1:5000/api/announcements_via_dom", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ announcements: message.batch })
                    });
                    if (!response.ok) throw new HttpError(`HTTP error! Status: ${response.status}`, response.status, response.statusText);
                    const data = await response.json();
                    savedScrapedAnnouncementsCount[tickerSymbol] = (savedScrapedAnnouncementsCount[tickerSymbol] || 0) + message.batch.length;
                    port.postMessage({ id: message.id, success: true, data });
                } catch (error) {
                    log(['ErrorLogs', 'ServerLogs'], `Error saving scraped batch for ${tickerSymbol}: ${error.message}`, { tabId, tickerSymbol });
                    port.postMessage({ id: message.id, success: false, error: error.message });
                }
                break;
            case 'save_api_announcement_batch':
                try {
                    const response = await fetch("http://127.0.0.1:5000/api/announcements_via_api", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ announcements: message.batch })
                    });
                    if (!response.ok) throw new HttpError(`HTTP error! Status: ${response.status}`, response.status, response.statusText);
                    const data = await response.json();
                    savedAPIAnnouncementsCount[tickerSymbol] = (savedAPIAnnouncementsCount[tickerSymbol] || 0) + message.batch.length;
                    port.postMessage({ id: message.id, success: true, data });
                } catch (error) {
                    log(['ErrorLogs', 'ServerLogs'], `Error saving API batch for ${tickerSymbol}: ${error.message}`, { tabId, tickerSymbol });
                    port.postMessage({ id: message.id, success: false, error: error.message });
                }
                break;
            case 'scraping_complete':
                try {
                    const payload = await prepareScrapedDataPayload(message);
                    log(['DataLogs', 'AnnouncementLogs'], `Announcements Saved: API Fetched: ${payload.update_timestamps.announcements_api_fetched_last_updated}, Scraped: ${payload.update_timestamps.announcements_scraped_last_updated}`, { tabId, tickerSymbol });
                    const response = await fetch("http://127.0.0.1:5000/save_data", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });
            
                    if (payload.historical_download_id) {
                        await deleteFile(payload.historical_download_id, tabId, tickerSymbol);
                    }
            
                    if (!response.ok) {
                        let responseBody;
                        try {
                            responseBody = await response.json();
                        } catch {
                            responseBody = await response.text();
                        }
                        throw new HttpError(
                            `HTTP error! Status: ${response.status}`,
                            response.status,
                            response.statusText,
                            responseBody
                        );
                    }
            
                    const data = await response.json();
                    
                    // Log all fields from timestamp_updates with their ✅/❌ status
                    if (data.status === 'success' && data.timestamp_updates) {
                        const fieldStatuses = Object.entries(data.timestamp_updates)
                            .map(([key, value]) => {
                                // Remove '_last_updated', replace underscores with spaces, and capitalize words
                                const baseName = key.replace('_last_updated', '');
                                const formattedName = baseName
                                    .split('_')
                                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                                    .join(' ');
                                return `${formattedName}: ${value ? '✅' : '❌'}`;
                            });
                        const updatedCount = Object.values(data.timestamp_updates).filter(value => value === true).length;
                        const totalCount = Object.keys(data.timestamp_updates).length;
                        let logMessage;
                        let statusIcon;
            
                        if (updatedCount === totalCount && updatedCount > 0) {
                            // Full success: all fields updated
                            statusIcon = '✅';
                            logMessage = `${statusIcon} Scraped data saved! ${tickerSymbol} (${updatedCount}/${totalCount} Updated)\n${fieldStatuses.join(', ')}`;
                        } else if (updatedCount > 0) {
                            // Half successful: some fields updated
                            statusIcon = '✔️';
                            logMessage = `${statusIcon} Scraped data saved! ${tickerSymbol} (${updatedCount}/${totalCount} Updated)\n${fieldStatuses.join(', ')}`;
                        } else {
                            // Failure: no fields updated
                            statusIcon = '❌';
                            logMessage = `${statusIcon} Scraped data saved! ${tickerSymbol} (0/${totalCount} Updated)\n${fieldStatuses.join(', ')}`;
                        }
            
                        log(['DataLogs', 'ServerLogs', 'TickerCompletionLogs'], logMessage, { tabId, tickerSymbol });
                    } else if (data.status === 'success' ) {
                        // Failure: no timestamp updates received
                        log(['DataLogs', 'ServerLogs', 'TickerCompletionLogs'], `❌ Scraped data saved! No updates received for ${tickerSymbol}`, { tabId, tickerSymbol });
                    } else {
                        log(['DataLogs', 'ServerLogs', 'TickerCompletionLogs'], `❌ Scraped data did not save! ${tickerSymbol}`, { tabId, tickerSymbol });
                    }

            
                    updateTabStatus(tabId, { ticker: tickerSymbol, status: 'Complete' });
                    port.postMessage({ id: message.id, success: true, response });
                    if (closeTabs && tabId) {
                        activeTabs.delete(tabId);
                        tabStates.delete(tabId);
                        log(['TabLogs'], `Closing tab ${tabId} after scraping complete`, { tabId, tickerSymbol });
                        chrome.tabs.remove(tabId);
                        sendToPopup({ action: 'tab_closed', tabId });
                    }
                } catch (error) {
                    // Determine log categories based on error.responseBody
                    const logCategories = (error.responseBody && typeof error.responseBody === 'string' && error.responseBody.includes('Permission denied'))
                        ? ['ServerLogs']
                        : ['ErrorLogs', 'ServerLogs'];
                    
                    log(logCategories, `Error saving final scraped data for ${message.tickerSymbol}: ${error.message}`, { tabId, tickerSymbol });
                    log(logCategories, {
                        message: error.message,
                        status: error.status || 'N/A',
                        statusText: error.statusText || 'N/A',
                        responseBody: error.responseBody || 'No response body',
                        stack: error.stack
                    }, { tabId, tickerSymbol });
                    port.postMessage({ id: message.id, success: false, error: error.message });
                }
                break;
            case 'next_ticker':
                await processTab(tabId);
                port.postMessage({ id: message.id, success: true });
                break;
            case 'ping':
                port.postMessage({ id: message.id, success: true, action: 'pong' });
                break;
            case 'get_config':
                const config = { currentMaxTabs, downloadPdfs, closeTabs, apiFetchAnnouncements, webScrapeAnnouncements };
                port.postMessage({ id: message.id, success: true, config });
                break;
            case 'restart_tab':
                if (message.tabId && activeTabs.has(message.tabId)) {
                    try {
                        ports.delete(message.tabId);
                        await new Promise((resolve, reject) => {
                            chrome.tabs.reload(message.tabId, {}, () => {
                                if (chrome.runtime.lastError) {
                                    log(['ErrorLogs', 'TabLogs'], `Failed to reload tab ${message.tabId}: ${chrome.runtime.lastError.message}`, { tabId: message.tabId, tickerSymbol });
                                    reject(chrome.runtime.lastError.message);
                                } else {
                                    log(['TabLogs'], `Tab ${message.tabId} reloaded`, { tabId: message.tabId, tickerSymbol });
                                    resolve();
                                }
                            });
                        });

                        await injectionSetup(message.tabId, message.tickerSymbol);
                        // await sendToTab(message.tabId, { action: 'check_page', tickerSymbol: message.tickerSymbol });
                        port.postMessage({ id: message.id, success: true });
                    } catch (error) {
                        log(['ErrorLogs', 'TabLogs'], `Restart failed for tab ${message.tabId}: ${error.message}`, { tabId: message.tabId, tickerSymbol });
                        try {
                            
                            log(['TabLogs'], `Remove tab ${tab.id}`, { tabId: tab.id, tickerSymbol });
                            activeTabs.delete(tab.id);
                            tabStates.delete(tab.id);
                            chrome.tabs.remove(tab.id);
                            sendToPopup({ action: 'tab_closed', tabId: tab.id });

                            const tab = await chrome.tabs.create({ url: `${baseURL}${message.tickerSymbol.toLowerCase()}`, active: false });
                            activeTabs.add(tab.id);
                            tabStates.set(tab.id, { ticker: message.tickerSymbol.toUpperCase(), status: 'Initializing', isPaused: false });
                            log(['TabLogs'], `Created new tab ${tab.id}`, { tabId: tab.id, tickerSymbol });
                            await injectionSetup(tab.id, message.tickerSymbol);
                            // await sendToTab(tab.id, { action: 'check_page', tickerSymbol: message.tickerSymbol });
                            port.postMessage({ id: message.id, success: true });
                        } catch (createError) {
                            log(['ErrorLogs', 'TabLogs'], `Failed to create new tab: ${createError.message}`, { tabId: message.tabId, tickerSymbol });
                            port.postMessage({ id: message.id, success: false, error: createError.message });
                        }
                    }
                } else {
                    port.postMessage({ id: message.id, success: false, error: 'Tab not active' });
                }
                break;
            case 'enable_disconnect_listener':
                enableDisconnectListener(key);
                port.postMessage({ id: message.id, success: true });
                break;
            case 'disable_disconnect_listener':
                disableDisconnectListener(key);
                port.postMessage({ id: message.id, success: true });
                break;
            default:
                log(['WarningLogs'], `Unhandled action: ${message.action}`, { tabId, tickerSymbol });
                if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: `Unknown action: ${message.action}` });
                break;
        }

        clearTimeout(timeoutId);
        return true;
    } catch (error) {
        log(['ErrorLogs'], `Error handling message: ${error.message}`, { tabId, tickerSymbol });
        if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: error.message });
    }
}

// function waitForContentReady(tabId, tickerSymbol, timeoutMs) {
//     return new Promise((resolve, reject) => {
//         const timeout = setTimeout(() => {
//             log(['ErrorLogs', 'TabLogs'], `Timeout waiting for content_ready from tab ${tabId}`, { tabId, tickerSymbol });
//             reject(new Error('Timeout waiting for content_ready'));
//         }, timeoutMs);

//         const handler = (message, port, key) => {
//             if (key === tabId && message.action === 'content_ready') {
//                 clearTimeout(timeout);
//                 chrome.runtime.onMessage.removeListener(handler);
//                 log(['TabLogs'], `Received content_ready for tab ${tabId}`, { tabId, tickerSymbol });
//                 resolve();
//             }
//         };

//         chrome.runtime.onMessage.addListener(handler);
//     });
// }

function sendToTab(tabId, message) {
    return new Promise((resolve, reject) => {
        const tickerSymbol = message.tickerSymbol || null;
        const portData = ports.get(tabId);
        if (portData?.port) {
            try {
                log(['DebugLogs', 'PortLogs'], `Sending message to tab ${tabId}: ${JSON.stringify(message)}`, { tabId, tickerSymbol });
                portData.port.postMessage(message);
                resolve(true);
            } catch (error) {
                log(['ErrorLogs', 'PortLogs'], `Failed to send message to tab ${tabId}: ${error.message}`, { tabId, tickerSymbol });
                ports.delete(tabId);
                resolve(false);
            }
        } else {
            log(['WarningLogs', 'PortLogs'], `No port found for tab ${tabId}`, { tabId, tickerSymbol });
            ports.delete(tabId);
            resolve(false);
        }
    });
}

function sendToPopup(message, retryCount = 0, maxRetries = 3, retryDelay = 500) {
    if (isPopupOpen) {
        const portData = ports.get('popup');
        if (portData?.port) {
            log(['DebugLogs', 'PortLogs'], [`Sending message to popup: `, message], {});
            portData.port.postMessage(message);
        } else if (retryCount < maxRetries) {
            log(['RetryLogs', 'PortLogs'], `Popup port not found, retrying in ${retryDelay}ms`, {});
            setTimeout(() => sendToPopup(message, retryCount + 1, maxRetries, retryDelay), retryDelay);
        } else {
            log(['ErrorLogs', 'PortLogs'], [`Failed to send message to popup after retries: `, message], {});
            popupMessageQueue.push(message);
        }
    } else {
        log(['PortLogs'], [`Popup is closed, queuing message: `, message], {});
        popupMessageQueue.push(message);
    }
}

function broadcastTabStates() {
    const tabStatesArray = Array.from(tabStates.entries()).map(([id, state]) => ({
        tabId: id,
        ticker: state.ticker || '',
        status: state.status || 'Initializing',
        isPaused: state.isPaused || false
    }));
    sendToPopup({ action: 'update_tab_states', data: tabStatesArray });
}

async function fetchTickersAndStartScraping() {
    try {
        const response = await fetch("http://127.0.0.1:5000/get_tickers");
        if (!response.ok) throw new HttpError(`HTTP error! Status: ${response.status}`, response.status, response.statusText);
        tickerQueue = await response.json();
        log(['ServerLogs'], `Fetched ${tickerQueue.length} tickers`, {});
        await adjustTabs();
    } catch (error) {
        log(['ErrorLogs', 'ServerLogs'], `Error fetching tickers: ${error.message}`, {});
    }
}

async function adjustTabs() {
    const targetTabs = Math.max(1, Math.min(currentMaxTabs, 10));
    const currentActive = activeTabs.size;

    for (const tabId of tabStates.keys()) {
        if (!activeTabs.has(tabId)) {
            tabStates.delete(tabId);
            sendToPopup({ action: 'tab_closed', tabId });
        }
    }

    if (currentActive < targetTabs && tickerQueue.length > 0) {
        const tabsToCreate = Math.min(targetTabs - currentActive, tickerQueue.length);
        for (let i = 0; i < tabsToCreate; i++) {
            const tab = await chrome.tabs.create({ url: "", active: false });
            activeTabs.add(tab.id);
            tabStates.set(tab.id, { ticker: '', status: 'Initializing', isPaused: false });
            log(['TabLogs'], `Created tab ${tab.id}`, { tabId: tab.id });
            broadcastTabStates();
            await processTab(tab.id);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}

function updateTabStatus(tabId, { ticker, status, isPaused } = {}) {
    if (tabId) {
        tabStates.set(tabId, {
            ...tabStates.get(tabId) || { ticker: '', status: 'Initializing', isPaused: false },
            ...(ticker != null ? { ticker } : {}),
            ...(status != null ? { status } : {}),
            ...(isPaused != null ? { isPaused } : {})
        });
        broadcastTabStates();
    }
}

async function processTickerQueue() {
    if (!isRunning || tickerQueue.length === 0) return;
    if (activeTabs.size < currentMaxTabs) await adjustTabs();
}

async function processTab(tabId) {
    if (!activeTabs.has(tabId) || tickerQueue.length === 0) {
        if (activeTabs.has(tabId)) {
            activeTabs.delete(tabId);
            tabStates.delete(tabId);
            chrome.tabs.remove(tabId);
            sendToPopup({ action: 'tab_closed', tabId });
        }
        return;
    }

    const tickerSymbol = tickerQueue.shift();
    if (!tickerSymbol) return;

    updateTabStatus(tabId, { ticker: tickerSymbol.toUpperCase(), status: 'Processing', isPaused: false });
    log(['TabLogs', 'ActionLogs'], `Processing ticker ${tickerSymbol} on tab ${tabId}`, { tabId, tickerSymbol });
    injectionSetup(tabId, tickerSymbol);
}

async function getbUrlFromTabId(tabId = null) {
    return new Promise((resolve) => {
        chrome.tabs.get(tabId, (tab) => {
            const url = tab?.url || 'No URL found';
            resolve(url);
        });
    });
}

async function injectionSetup(tabId, tickerSymbol) {
    try {
        const portData = ports.get(tabId);
        if (portData?.port && portData?.disconnectHandler) {
            disableDisconnectListener(tabId, tickerSymbol);
        }

        const url = `${baseURL}${tickerSymbol.toLowerCase()}`;
        await chrome.tabs.update(tabId, { url });
        await new Promise((resolve, reject) => {
            const listener = (updatedTabId, info) => {
                if (updatedTabId === tabId && info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error(`Timeout waiting for tab: ${tabId}, ticker: ${tickerSymbol} to load`));
            }, 45000);
        });

        await chrome.scripting.executeScript({
            target: { tabId },
            func: (id) => { window.tabId = id; },
            args: [tabId]
        });

        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
        });

        enableDisconnectListener(tabId, tickerSymbol);
        log(['ScrapeLogs', 'TabLogs'], `Page setup complete for ${tickerSymbol} on tab ${tabId}`, { tabId, tickerSymbol });
    } catch (error) {
        log(['ErrorLogs', 'TabLogs'], `Failed to setup tab ${tabId}: ${error.message}`, { tabId, tickerSymbol });
        // activeTabs.delete(tabId);
        // tabStates.delete(tabId);
        // chrome.tabs.remove(tabId);
        // sendToPopup({ action: 'tab_closed', tabId });
        
        log(['TabLogs'], `will attempt to reload into tabId: ${tabId} and injectionSetup again in ${retryInjectionSetupTime}ms`, { tabId, tickerSymbol });
        setTimeout(() => {
            injectionSetup(tabId, tickerSymbol);
        }, retryInjectionSetupTime);
    }
}

function fixDownloadURL(str) {
    return str;

    const lastSlashIndex = str.lastIndexOf('/');
    if (lastSlashIndex === -1) {
        return str.slice(0, 3); // No slash, take first 3 chars of string
    }
    const prefix = str.slice(0, lastSlashIndex + 1); // Everything up to and including last /
    const lastSegment = str.slice(lastSlashIndex + 1); // Part after last /
    const shortenedSegment = lastSegment.slice(0, 3); // First 3 chars of last segment
    return prefix + shortenedSegment;
}

async function prepareScrapedDataPayload(message) {

    let historical_filepath = null;
    let historical_download_id = null;
    let download_result = null;
    if (message.data?.historical_download_url) {
        const historical_download_url = fixDownloadURL(message.data.historical_download_url);
        download_result = await downloadAndSendToServer(historical_download_url, message.tabId, message.tickerSymbol);
        historical_filepath = download_result.filePath;
        historical_download_id = download_result.downloadId;
    }

    const payload = {
        tickerSymbol: message.tickerSymbol,
        update_timestamps: {
            announcements_api_fetched_last_updated: false,
            announcements_scraped_last_updated: false
        },
        company_overview: message.data.company_overview || {},
        company_details: message.data.company_details || {},
        transactions: message.data.transactions || [],
        director_interests: message.data.director_interests || [],
        historical_filepath,
        historical_download_id
    };

    const savedAPICount = savedAPIAnnouncementsCount[message.tickerSymbol] || 0;
    const savedScrapeCount = savedScrapedAnnouncementsCount[message.tickerSymbol] || 0;
    const totalApiFetchable = message.data.api_fetch_announcements || 0;
    const totalScrapeable = message.data.dom_scrape_announcements || 0;

    if (apiFetchAnnouncements && savedAPICount === totalApiFetchable && totalApiFetchable > 0) {
        payload.update_timestamps.announcements_api_fetched_last_updated = true;
    }
    if (webScrapeAnnouncements && savedScrapeCount === totalScrapeable && totalScrapeable > 0) {
        payload.update_timestamps.announcements_scraped_last_updated = true;
    }

    delete savedAPIAnnouncementsCount[message.tickerSymbol];
    delete savedScrapedAnnouncementsCount[message.tickerSymbol];

    log(['ServerLogs', 'DataLogs'], [`Final payload for ${message.tickerSymbol}`, download_result], { tabId: message.tabId, tickerSymbol: message.tickerSymbol });
    return payload;
}

async function downloadAndSendToServer(historicalDownloadUrl, tabId, tickerSymbol) {
    log(['DownloadLogs'], `downloadAndSendToServer URL: ${historicalDownloadUrl}`, { tabId, tickerSymbol });

    if (!chrome.downloads) {
        log(['ErrorLogs', 'DownloadLogs'], `chrome.downloads API unavailable`, { tabId, tickerSymbol });
        return { filePath: null, downloadId: null };
    }

    const filename = `historical_data_${tickerSymbol}.csv`;
    return new Promise((resolve) => {
        chrome.downloads.download({
            url: historicalDownloadUrl,
            filename,
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                log(['ErrorLogs', 'DownloadLogs'], `Download failed: ${chrome.runtime.lastError.message}`, { tabId, tickerSymbol });
                resolve({ filePath: null, downloadId: null });
                return;
            }

            chrome.downloads.onChanged.addListener(function onChanged(delta) {
                if (delta.id === downloadId && delta.state && delta.state.current === 'complete') {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    chrome.downloads.search({ id: downloadId }, (results) => {
                        const filePath = results?.[0]?.filename || null;
                        log(['DownloadLogs'], `File Downloaded, filePath: ${filePath}, downloadId: ${downloadId}`, { tabId, tickerSymbol });
                        resolve({ filePath, downloadId });
                    });
                }
            });
        });
    });
}

async function deleteFile(fileId, tabId, tickerSymbol) {
    if (!fileId) return;
    return new Promise((resolve) => {
        chrome.downloads.removeFile(fileId, () => {
            if (chrome.runtime.lastError) {
                log(['ErrorLogs', 'DownloadLogs'], `Failed to delete file ${fileId}: ${chrome.runtime.lastError.message}`, { tabId, tickerSymbol });
                resolve(false);
            } else {
                log(['DownloadLogs'], `File deleted: ${fileId}`, { tabId, tickerSymbol });
                resolve(true);
            }
        });
    });
}


log(['GeneralLogs'], 'background.js loaded', {});