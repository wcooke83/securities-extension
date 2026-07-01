// Background script for Chrome extension
// This script manages the communication between the popup, content scripts, and the server.
// It handles the scraping process, manages tabs, and communicates with the server for data storage.

importScripts('config.js');

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
let heartbeatInterval = null;
let activeDownloads = new Map(); // Track active downloads for recovery
let transferStats = {
    total: 0,
    pdf: 0,
    csv: 0,
    json: 0,
    other: 0,
    totalBytes: 0,
    totalTimeMs: 0,
    lastSpeedBytesPerSec: 0,
    currentDownloadSpeed: 0
};
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

async function loadTransferStats() {
    try {
        const { transferStats: saved } = await chrome.storage.local.get('transferStats');
        if (saved) {
            transferStats = saved;
            log(['DebugLogs'], `Loaded transfer stats: ${JSON.stringify(transferStats)}`, {});
        }
    } catch (error) {
        log(['ErrorLogs'], `Failed to load transfer stats: ${error.message}`, {});
    }
}

async function saveTransferStats() {
    try {
        await chrome.storage.local.set({ transferStats });
        log(['DebugLogs'], `Saved transfer stats: ${JSON.stringify(transferStats)}`, {});
    } catch (error) {
        log(['ErrorLogs'], `Failed to save transfer stats: ${error.message}`, {});
    }
}

function getFileTypeFromFilename(filename) {
    if (!filename) return 'other';
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'pdf';
    if (ext === 'csv') return 'csv';
    if (ext === 'json') return 'json';
    return 'other';
}

async function incrementTransferCount(fileType, fileSize, downloadTimeMs) {
    transferStats.total++;
    transferStats[fileType] = (transferStats[fileType] || 0) + 1;

    // Update speed statistics
    if (fileSize && downloadTimeMs > 0) {
        transferStats.totalBytes += fileSize;
        transferStats.totalTimeMs += downloadTimeMs;
        transferStats.lastSpeedBytesPerSec = (fileSize / downloadTimeMs) * 1000;
    }

    await saveTransferStats();
    broadcastTransferStats();
    log(['DebugLogs'], `Transfer count incremented: ${fileType}, size: ${fileSize} bytes, time: ${downloadTimeMs}ms, speed: ${transferStats.lastSpeedBytesPerSec.toFixed(2)} bytes/sec`, {});
}

function formatSpeed(bytesPerSec) {
    if (bytesPerSec === 0) return '0 B/s';
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSec;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function broadcastTransferStats() {
    sendToPopup({ action: 'transfer_stats_update', stats: transferStats });
}

async function resetTransferStats() {
    transferStats = {
        total: 0,
        pdf: 0,
        csv: 0,
        json: 0,
        other: 0,
        totalBytes: 0,
        totalTimeMs: 0,
        lastSpeedBytesPerSec: 0,
        currentDownloadSpeed: 0
    };
    await saveTransferStats();
    broadcastTransferStats();
    log(['GeneralLogs'], 'Transfer stats reset', {});
}

loadLoggingPrefs();
loadTransferStats();

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'loggingPreferences' in changes) {
        loggingPrefs = changes.loggingPreferences.newValue;
    }
});

function log(categories, message, context = {}) {
    if (categories.some(cat => loggingPrefs[cat])) {
        let pre_message = 'B';
        if (loggingPrefs['prefixDateTime']) pre_message += `[${getClientLocalDateTime()}]`;
        if (loggingPrefs['prefixTickerSymbol'] && context.tickerSymbol) pre_message += `[${context.tickerSymbol}]`;
        if (loggingPrefs['prefixTabId'] && context.tabId) pre_message += `[${context.tabId}]`;
        if (loggingPrefs['prefixPortName'] && context.portName) pre_message += `[${context.portName}]`;
        pre_message += pre_message ? ' ' : '';

        const logMethod = categories.includes('ErrorLogs') ? console.error :
                         categories.includes('WarningLogs') ? console.warn :
                         console.log;

        if (typeof message === 'object' && message !== null) {
            let firstElement = '';
            let remainingElements;

            if (Array.isArray(message)) {
                if (message.length > 0 && typeof message[0] === 'string') {
                    firstElement = message[0].trim();
                    remainingElements = message.slice(1);
                } else {
                    remainingElements = message;
                }
            } else {
                const keys = Object.keys(message);
                if (keys.length > 0 && typeof message[keys[0]] === 'string') {
                    firstElement = message[keys[0]].trim();
                    remainingElements = { ...message };
                    delete remainingElements[keys[0]];
                } else {
                    remainingElements = message;
                }
            }

            const combinedMessage = pre_message + firstElement;
            
            if (firstElement) {
                logMethod(combinedMessage, ...(Array.isArray(remainingElements) ? remainingElements : [remainingElements]));
            } else {
                logMethod(pre_message, ...(Array.isArray(remainingElements) ? remainingElements : [remainingElements]));
            }
        } else {
            logMethod(`${pre_message}${message}`);
        }
    }
}

function getClientLocalDateTime() {
    const now = new Date();
    return now.toLocaleString();
}

// ============================================================================
// STATE PERSISTENCE & RECOVERY
// ============================================================================

async function persistState() {
    try {
        const state = {
            tickerQueue,
            activeTabs: Array.from(activeTabs),
            tabStates: Array.from(tabStates.entries()),
            isRunning,
            isPaused,
            currentMaxTabs,
            downloadPdfs,
            closeTabs,
            apiFetchAnnouncements,
            webScrapeAnnouncements,
            savedAPIAnnouncementsCount,
            savedScrapedAnnouncementsCount,
            activeDownloads: Array.from(activeDownloads.entries()),
            lastPersisted: Date.now()
        };
        await chrome.storage.local.set({ extensionState: state });
        log(['DebugLogs'], `State persisted: ${tickerQueue.length} tickers, ${activeTabs.size} tabs`, {});
    } catch (error) {
        log(['ErrorLogs'], `Failed to persist state: ${error.message}`, {});
    }
}

async function restoreState() {
    try {
        const { extensionState } = await chrome.storage.local.get('extensionState');
        if (!extensionState) {
            log(['GeneralLogs'], 'No saved state found', {});
            return;
        }

        const age = Date.now() - (extensionState.lastPersisted || 0);
        log(['GeneralLogs'], `Restoring state from ${Math.round(age / 1000)}s ago`, {});

        tickerQueue = extensionState.tickerQueue || [];
        activeTabs = new Set(extensionState.activeTabs || []);
        tabStates = new Map(extensionState.tabStates || []);
        isRunning = extensionState.isRunning || false;
        isPaused = extensionState.isPaused || false;
        currentMaxTabs = extensionState.currentMaxTabs || 3;
        downloadPdfs = extensionState.downloadPdfs ?? true;
        closeTabs = extensionState.closeTabs ?? true;
        apiFetchAnnouncements = extensionState.apiFetchAnnouncements ?? true;
        webScrapeAnnouncements = extensionState.webScrapeAnnouncements ?? true;
        savedAPIAnnouncementsCount = extensionState.savedAPIAnnouncementsCount || {};
        savedScrapedAnnouncementsCount = extensionState.savedScrapedAnnouncementsCount || {};
        activeDownloads = new Map(extensionState.activeDownloads || []);

        log(['GeneralLogs'], `State restored: ${tickerQueue.length} tickers, ${activeTabs.size} tabs`, {});

        // Validate restored tabs still exist
        const validTabs = new Set();
        for (const tabId of activeTabs) {
            try {
                await chrome.tabs.get(tabId);
                validTabs.add(tabId);
            } catch {
                log(['WarningLogs'], `Tab ${tabId} no longer exists, removing from state`, { tabId });
                tabStates.delete(tabId);
            }
        }
        activeTabs = validTabs;

        // Resume scraping if it was running
        if (isRunning && !isPaused && tickerQueue.length > 0) {
            log(['GeneralLogs'], 'Resuming scraping from restored state', {});
            await adjustTabs();
        }

        // Recover downloads
        await recoverDownloads();

        return true;
    } catch (error) {
        log(['ErrorLogs'], `Failed to restore state: ${error.message}`, {});
        return false;
    }
}

// Auto-save state on changes
function scheduleStatePersistence() {
    if (scheduleStatePersistence.timeoutId) {
        clearTimeout(scheduleStatePersistence.timeoutId);
    }
    scheduleStatePersistence.timeoutId = setTimeout(() => {
        persistState();
    }, 2000); // Debounce for 2 seconds
}

// ============================================================================
// KEEP-ALIVE MECHANISM
// ============================================================================

function startHeartbeat() {
    if (heartbeatInterval) return;

    log(['DebugLogs'], 'Starting service worker heartbeat', {});
    heartbeatInterval = setInterval(() => {
        // Keep service worker alive with a simple API call
        chrome.runtime.getPlatformInfo(() => {
            if (chrome.runtime.lastError) {
                log(['WarningLogs'], `Heartbeat error: ${chrome.runtime.lastError.message}`, {});
            }
        });
    }, 20000); // Every 20 seconds (well under 30s limit)
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        log(['DebugLogs'], 'Stopping service worker heartbeat', {});
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// ============================================================================
// DOWNLOAD STATE RECOVERY
// ============================================================================

async function trackDownload(downloadId, tickerSymbol, url) {
    activeDownloads.set(downloadId, { tickerSymbol, url, startTime: Date.now() });
    await chrome.storage.local.set({
        [`download_${downloadId}`]: { tickerSymbol, url, timestamp: Date.now() }
    });
    scheduleStatePersistence();
}

async function untrackDownload(downloadId) {
    activeDownloads.delete(downloadId);
    await chrome.storage.local.remove(`download_${downloadId}`);
    scheduleStatePersistence();
}

async function recoverDownloads() {
    try {
        const storage = await chrome.storage.local.get();
        const downloadKeys = Object.keys(storage).filter(key => key.startsWith('download_'));

        if (downloadKeys.length === 0) return;

        log(['GeneralLogs'], `Recovering ${downloadKeys.length} downloads`, {});

        for (const key of downloadKeys) {
            const downloadId = parseInt(key.split('_')[1]);
            const downloadInfo = storage[key];

            try {
                const results = await chrome.downloads.search({ id: downloadId });
                if (results.length > 0) {
                    const download = results[0];
                    if (download.state === 'complete') {
                        log(['DownloadLogs'], `Recovered completed download ${downloadId}`, {
                            tickerSymbol: downloadInfo.tickerSymbol
                        });
                        await untrackDownload(downloadId);
                    } else if (download.state === 'interrupted') {
                        log(['WarningLogs'], `Download ${downloadId} was interrupted`, {
                            tickerSymbol: downloadInfo.tickerSymbol
                        });
                        await untrackDownload(downloadId);
                    } else {
                        // Download still in progress
                        activeDownloads.set(downloadId, downloadInfo);
                    }
                } else {
                    // Download not found, clean up
                    await untrackDownload(downloadId);
                }
            } catch (error) {
                log(['ErrorLogs'], `Error recovering download ${downloadId}: ${error.message}`, {});
                await untrackDownload(downloadId);
            }
        }
    } catch (error) {
        log(['ErrorLogs'], `Failed to recover downloads: ${error.message}`, {});
    }
}

// ============================================================================
// ALARM HANDLERS FOR LONG DELAYS
// ============================================================================

chrome.alarms.onAlarm.addListener((alarm) => {
    log(['DebugLogs'], `Alarm triggered: ${alarm.name}`, {});

    if (alarm.name.startsWith('retry_injection_')) {
        const [, , tabId, tickerSymbol] = alarm.name.split('_');
        injectionSetup(parseInt(tabId), tickerSymbol);
    } else if (alarm.name === 'persist_state') {
        persistState();
    }
});

// Create periodic state persistence alarm
chrome.alarms.create('persist_state', { periodInMinutes: 1 });

// ============================================================================
// SERVICE WORKER LIFECYCLE
// ============================================================================

chrome.runtime.onStartup.addListener(async () => {
    log(['GeneralLogs'], 'Extension startup - restoring state', {});
    await restoreState();
});

chrome.runtime.onInstalled.addListener(async (details) => {
    log(['GeneralLogs'], `Extension installed: ${details.reason}`, {});
    if (details.reason === 'install') {
        // First install
        await persistState();
    } else if (details.reason === 'update') {
        // Extension updated, try to restore state
        await restoreState();
    }
});

// Restore state when service worker wakes up
(async () => {
    log(['GeneralLogs'], 'Service worker initialized', {});
    await restoreState();
})();

async function checkTabClosedByUser(tabId) {
    try {
        await chrome.tabs.get(tabId);
        return false;
    } catch (error) {
        return true;
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
                isPaused: state.isPaused || false,
                rowStartTime: state.rowStartTime
            }));
            port.postMessage({ action: 'update_tab_states', data: tabStatesArray });
            port.postMessage({ action: 'transfer_stats_update', stats: transferStats });
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

/**
 * Checks all open tabs for a window.tabId variable and returns values not present in tabStates.
 * @param {Map<number, Object>} tabStates - Map of tab IDs to their state objects.
 * @returns {Promise<Array<{tabId: number, windowTabId: any}>>} Array of objects containing the tab ID and window.tabId value for tabs where window.tabId is defined and not a key in tabStates.
 */
async function checkWindowTabIds(tabStates) {
    log(['DebugLogs', 'TabLogs'], [`checkWindowTabIds(tabStates):`, tabStates]);

    try {
        const tabs = await chrome.tabs.query({});
        const results = [];

        for (const tab of tabs) {
            if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about://')) {
                log(['DebugLogs', 'TabLogs'], `Skipping tab ${tab.id}: URL (${tab.url}) does not support scripting`);
                continue;
            }

            try {
                const [result] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        return typeof window.tabId !== 'undefined' ? window.tabId : null;
                    }
                });

                if (result && result.result !== null && !tabStates.has(result.result)) {
                    results.push({
                        tabId: tab.id,
                        windowTabId: result.result
                    });
                }
            } catch (error) {
                log(['DebugLogs'], `Error checking window.tabId in tab ${tab.id}: ${error.message}`);
            }
        }

        log(['DebugLogs', 'TabLogs'], [`checkWindowTabIds() Return:`, results]);
        return results;
    } catch (error) {
        log(['DebugLogs', 'TabLogs'], `Failed to query tabs: ${error.message}`);
        return [];
    }
}

async function handleMessage(message, port, key) {
    const tabId = key !== 'popup' ? key : null;
    const tickerSymbol = message.tickerSymbol || '';
    const action = message.action || '';
    
    const timestampFieldNames = {
        'basic_fundamentals_last_updated': 'Fundamentals',
        'director_transactions_last_updated': 'Director Transactions',
        'director_interests_last_updated': 'Director Interests',
        'historical_as_traded_last_updated': 'Trade Data',
        'announcements_api_last_updated': 'API Announcements',
        'announcements_dom_last_updated': 'DOM Announcements'
    };
    
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
                tickerSymbol: message.tickerSymbol || portData.tickerSymbol
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
                        isPaused: state.isPaused || false,
                        rowStartTime: state.rowStartTime
                    }))
                };
                sendToPopup(tabStatesResponse);
                break;
            case 'pause_tab':
                if (message.tabId && activeTabs.has(message.tabId)) {
                    updateTabStatus(message.tabId, { isPaused: true, ticker: message.tickerSymbol || tabStates.get(message.tabId)?.ticker, status: 'Paused' });
                    await sendToTab(message.tabId, { action: 'pause_tab' });
                    broadcastTabStates();
                    sendToPopup({ action: 'tab_status_updated', tabId: message.tabId, isPaused: true });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                } else {
                    log(['WarningLogs'], `Pause failed: Tab ${message.tabId} not active`, { tabId: message.tabId, tickerSymbol });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: 'Tab not active' });
                }
                break;
            case 'resume_tab':
                if (message.tabId && activeTabs.has(message.tabId)) {
                    try {
                        const tab = await chrome.tabs.get(message.tabId);
                        log(['DebugLogs'], `Tab ${message.tabId} status: ${tab.status}, url: ${tab.url}`, { tabId: message.tabId, tickerSymbol });
                        updateTabStatus(message.tabId, { isPaused: false, ticker: message.tickerSymbol || tabStates.get(message.tabId)?.ticker, status: 'Resumed'  });
                        const sent = await sendToTab(message.tabId, { action: 'resume_tab' });
                        log(['DebugLogs'], `Sent resume_tab to tab ${message.tabId}: ${sent ? 'success' : 'failed'}`, { tabId: message.tabId, tickerSymbol });
                        broadcastTabStates();
                        sendToPopup({ action: 'tab_status_updated', tabId: message.tabId, isPaused: false });
                        if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                    } catch (error) {
                        log(['ErrorLogs'], `Tab ${message.tabId} not found: ${error.message}`, { tabId: message.tabId, tickerSymbol });
                        activeTabs.delete(message.tabId);
                        tabStates.delete(message.tabId);
                        sendToPopup({ action: 'tab_closed', tabId: message.tabId });
                        if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: error.message });
                    }
                } else {
                    log(['WarningLogs'], `Resume failed: Tab ${message.tabId} not active`, { tabId: message.tabId, tickerSymbol });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: 'Tab not active' });
                }
                break;
            case 'restart_tab':
                if (message.tabId && activeTabs.has(message.tabId)) {
                    try {
                        const ticker = message.tickerSymbol || tabStates.get(message.tabId)?.ticker;
                        ports.delete(message.tabId);
                        await new Promise((resolve, reject) => {
                            chrome.tabs.reload(message.tabId, {}, () => {
                                if (chrome.runtime.lastError) {
                                    log(['ErrorLogs', 'TabLogs'], `Failed to reload tab ${message.tabId}: ${chrome.runtime.lastError.message}`, { tabId: message.tabId, tickerSymbol: ticker });
                                    reject(chrome.runtime.lastError.message);
                                } else {
                                    log(['TabLogs'], `Tab ${tabId} reloaded`, { tabId: message.tabId, tickerSymbol: ticker });
                                    resolve();
                                }
                            });
                        });
                        updateTabStatus(message.tabId, { status: 'Initializing', ticker, isPaused: false });
                        await injectionSetup(message.tabId, ticker);
                        await sendToTab(message.tabId, { action: 'check_page', tickerSymbol: ticker });
                        broadcastTabStates();
                        sendToPopup({ action: 'tab_status_updated', tabId: message.tabId, status: 'Initializing', isPaused: false });
                        if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                    } catch (error) {
                        log(['ErrorLogs', 'TabLogs'], `Restart failed for tab ${message.tabId}: ${error.message}`, { tabId: message.tabId, tickerSymbol });
                        try {
                            activeTabs.delete(message.tabId);
                            tabStates.delete(message.tabId);
                            chrome.tabs.remove(message.tabId);
                            sendToPopup({ action: 'tab_closed', tabId: message.tabId });
                            const tab = await chrome.tabs.create({ url: `${baseURL}${message.tickerSymbol.toLowerCase()}`, active: false });
                            activeTabs.add(tab.id);
                            tabStates.set(tab.id, { ticker: message.tickerSymbol.toUpperCase(), status: 'Initializing', isPaused: false, isAdHoc: false, rowStartTime: Date.now() });
                            log(['TabLogs'], `Created new tab ${tab.id}`, { tabId: tab.id, tickerSymbol: message.tickerSymbol });
                            await injectionSetup(tab.id, message.tickerSymbol);
                            await sendToTab(tab.id, { action: 'check_page', tickerSymbol: message.tickerSymbol });
                            broadcastTabStates();
                            if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                        } catch (createError) {
                            log(['ErrorLogs', 'TabLogs'], `Failed to create new tab: ${createError.message}`, { tabId: message.tabId, tickerSymbol });
                            if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: createError.message });
                        }
                    }
                } else {
                    log(['WarningLogs'], `Restart failed: Tab ${message.tabId} not active`, { tabId: message.tabId, tickerSymbol });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: 'Tab not active' });
                }
                break;
            case 'close_tab':
                if (message.tabId && activeTabs.has(message.tabId)) {
                    try {
                        const ticker = message.tickerSymbol || tabStates.get(message.tabId)?.ticker;
                        activeTabs.delete(message.tabId);
                        tabStates.delete(message.tabId);
                        ports.delete(message.tabId);
                        await chrome.tabs.remove(message.tabId);
                        log(['TabLogs'], `Closed tab ${message.tabId}`, { tabId: message.tabId, tickerSymbol: ticker });
                        sendToPopup({ action: 'tab_closed', tabId: message.tabId });
                        broadcastTabStates();
                        scheduleStatePersistence();
                        if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                    } catch (error) {
                        log(['ErrorLogs', 'TabLogs'], `Failed to close tab ${message.tabId}: ${error.message}`, { tabId: message.tabId, tickerSymbol });
                        if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: error.message });
                    }
                } else {
                    log(['WarningLogs'], `Close failed: Tab ${message.tabId} not active`, { tabId: message.tabId, tickerSymbol });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: false, error: 'Tab not active' });
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
                    startHeartbeat(); // Start keep-alive
                    await fetchTickersAndStartScraping();
                    sendToPopup({ action: 'status_update', isRunning: true, isPaused: false });
                    scheduleStatePersistence();
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
                    scheduleStatePersistence();
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
                    scheduleStatePersistence();
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
                    updateTabStatus(tabId, { ticker: message.tickerSymbol.toUpperCase(), status: message.status });
                    if (message.id !== undefined) port.postMessage({ id: message.id, success: true });
                }
                break;
            case 'update_tab_ticker':
                if (tabId && message.tickerSymbol) {
                    updateTabStatus(tabId, { ticker: message.tickerSymbol.toUpperCase(), status: 'Initializing' });
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
                    const response = await fetch(`${CONFIG.BACKEND_URL}/api/files/${message.tickerSymbol}`);
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
                    const response = await fetch(`${CONFIG.BACKEND_URL}/api/announcements_via_dom`, {
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
                    const response = await fetch(`${CONFIG.BACKEND_URL}/api/announcements_via_api`, {
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
                    log(['DataLogs', 'AnnouncementLogs'], `Announcements Saved: API Fetched: ${payload.update_timestamps.announcements_api_last_updated}, Scraped: ${payload.update_timestamps.announcements_dom_last_updated}`, { tabId, tickerSymbol });
                    const response = await fetch(`${CONFIG.BACKEND_URL}/save_data`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });
            
                    if (payload.historical_download_id) {
                        // await deleteFile(payload.historical_download_id, tabId, tickerSymbol);
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
                    
                    if (data.status === 'success' && data.timestamp_updates) {
                        const fieldStatuses = Object.entries(data.timestamp_updates)
                            .map(([key, value]) => {
                                const displayName = timestampFieldNames[key] || key;
                                if (!timestampFieldNames[key]) {
                                    log(['WarningLogs'], `Unknown timestamp field: ${key}`, { tabId, tickerSymbol });
                                }
                                return `${displayName}: ${value ? '✅' : '❌'}`;
                            });
                        const updatedCount = Object.values(data.timestamp_updates).filter(value => value === true).length;
                        const totalCount = Object.keys(data.timestamp_updates).length;
                        let logMessage;
                        let statusIcon;
            
                        if (updatedCount === totalCount && updatedCount > 0) {
                            statusIcon = '✅';
                            logMessage = `${statusIcon} Scraped data saved! ${tickerSymbol} (${updatedCount}/${totalCount} Updated)\n${fieldStatuses.join(', ')}`;
                        } else if (updatedCount > 0) {
                            statusIcon = '✔️';
                            logMessage = `${statusIcon} Scraped data saved! ${tickerSymbol} (${updatedCount}/${totalCount} Updated)\n${fieldStatuses.join(', ')}`;
                        } else {
                            statusIcon = '❌';
                            logMessage = `${statusIcon} Scraped data saved! ${tickerSymbol} (0/${totalCount} Updated)\n${fieldStatuses.join(', ')}`;
                        }
            
                        log(['DataLogs', 'ServerLogs', 'TickerCompletionLogs'], logMessage, { tabId, tickerSymbol });
                    } else if (data.status === 'success') {
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

                    // Stop heartbeat if no more active tabs
                    if (activeTabs.size === 0 && tickerQueue.length === 0) {
                        stopHeartbeat();
                        isRunning = false;
                        sendToPopup({ action: 'status_update', isRunning: false, isPaused: false });
                    }

                    scheduleStatePersistence();
                } catch (error) {
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
            case 'increment_404_count':
                try {
                    const response = await fetch(`${CONFIG.BACKEND_URL}/increment_404_count`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ tickerSymbol: message.tickerSymbol })
                    });
                    if (!response.ok) throw new HttpError(`HTTP error! Status: ${response.status}`, response.status, response.statusText);
                    const data = await response.json();
                    port.postMessage({ id: message.id, success: true, data });
                } catch (error) {
                    log(['ErrorLogs', 'ServerLogs'], `Error incrementing 404 count for ${message.tickerSymbol}: ${error.message}`, { tabId, tickerSymbol });
                    port.postMessage({ id: message.id, success: false, error: error.message });
                }
                break;
            case 'next_ticker':
                if (tabStates.get(tabId)?.isAdHoc) {
                    log(['TabLogs'], `Ad hoc tab ${tabId} completed scraping, not assigning next ticker`, { tabId, tickerSymbol });
                    if (closeTabs) {
                        activeTabs.delete(tabId);
                        tabStates.delete(tabId);
                        chrome.tabs.remove(tabId);
                        sendToPopup({ action: 'tab_closed', tabId });
                        scheduleStatePersistence();
                    }
                    port.postMessage({ id: message.id, success: true });
                } else {
                    await processTab(tabId);
                    port.postMessage({ id: message.id, success: true });
                }
                break;
            case 'ping':
                port.postMessage({ id: message.id, success: true, action: 'pong' });
                break;
            case 'get_config':
                const config = { currentMaxTabs, downloadPdfs, closeTabs, apiFetchAnnouncements, webScrapeAnnouncements };
                port.postMessage({ id: message.id, success: true, config });
                break;
            case 'reset_transfer_stats':
                await resetTransferStats();
                port.postMessage({ id: message.id, success: true });
                break;
            case 'enable_disconnect_listener':
                enableDisconnectListener(key);
                port.postMessage({ id: message.id, success: true });
                break;
            case 'disable_disconnect_listener':
                disableDisconnectListener(key);
                port.postMessage({ id: message.id, success: true });
                break;
            case 'scrape_single_ticker':
                const ticker = message.tickerSymbol;
                if (!ticker) {
                    port.postMessage({ id: message.id, success: false, error: 'No ticker provided' });
                    return;
                }
                let tab;
                const untrackedTabs = await checkWindowTabIds(tabStates);
                const reusableTab = untrackedTabs.find(t => t.windowTabId === t.tabId);
                if (reusableTab) {
                    tab = { id: reusableTab.tabId };
                    await chrome.tabs.update(tab.id, { url: `${baseURL}${ticker.toLowerCase()}`, active: false });
                    log(['TabLogs'], `Reusing tab ${tab.id} for single ticker scrape: ${ticker}`, { tabId: tab.id, tickerSymbol: ticker });
                } else {
                    tab = await chrome.tabs.create({ url: `${baseURL}${ticker.toLowerCase()}`, active: false });
                    log(['TabLogs'], `Created new tab ${tab.id} for single ticker scrape: ${ticker}`, { tabId: tab.id, tickerSymbol: ticker });
                }
                activeTabs.add(tab.id);
                tabStates.set(tab.id, { 
                    ticker: ticker,
                    status: 'Initializing', 
                    isPaused: false,
                    isAdHoc: true,
                    rowStartTime: Date.now()
                });
                broadcastTabStates();
                await injectionSetup(tab.id, ticker);
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
            log(['DebugLogs', 'PortLogs'], ['Sending message to popup: ', message], {});
            portData.port.postMessage(message);
        } else if (retryCount < maxRetries) {
            log(['RetryLogs', 'PortLogs'], 'Popup port not found, retrying in ${retryDelay}ms', {});
            setTimeout(() => sendToPopup(message, retryCount + 1, maxRetries, retryDelay), retryDelay);
        } else {
            log(['ErrorLogs', 'PortLogs'], ['Failed to send message to popup after retries: ', message], {});
            popupMessageQueue.push(message);
        }
    } else {
        log(['PortLogs'], ['Popup is closed, queuing message: ', message], {});
        popupMessageQueue.push(message);
    }
}

function broadcastTabStates() {
    const tabStatesArray = Array.from(tabStates.entries()).map(([id, state]) => ({
        tabId: id,
        ticker: state.ticker || '',
        status: state.status || 'Initializing',
        isPaused: state.isPaused || false,
        rowStartTime: state.rowStartTime
    }));
    sendToPopup({ action: 'update_tab_states', data: tabStatesArray });
}

async function fetchTickersAndStartScraping() {
    try {
        const response = await fetch(`${CONFIG.BACKEND_URL}/get_tickers`);
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
            let tab;
            const untrackedTabs = await checkWindowTabIds(tabStates);
            const reusableTab = untrackedTabs.find(t => t.windowTabId === t.tabId);
            if (reusableTab) {
                tab = { id: reusableTab.tabId };
                await chrome.tabs.update(tab.id, { url: "", active: false });
                log(['TabLogs'], `Reusing tab ${tab.id} for scraping`, { tabId: tab.id });
            } else {
                tab = await chrome.tabs.create({ url: "", active: false });
                log(['TabLogs'], `Created new tab ${tab.id}`, { tabId: tab.id });
            }
            activeTabs.add(tab.id);
            tabStates.set(tab.id, { ticker: '', status: 'Initializing', isPaused: false, isAdHoc: false, rowStartTime: Date.now() });
            broadcastTabStates();
            await processTab(tab.id);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}

function updateTabStatus(tabId, { ticker, status, isPaused } = {}) {
    if (!ticker) {
        console.trace('no ticker in updateTabStatus()');
        if (tabId) {
            ticker = getTickerByTabId(tabId);
        }
    }

    if (!tabId) {
        console.trace('no tabId in updateTabStatus()');
    }

    if (tabId) {
        const existingState = tabStates.get(tabId);
        tabStates.set(tabId, {
            ...existingState || { ticker: '', status: 'Initializing', isPaused: false, isAdHoc: false, rowStartTime: Date.now() },
            ...(ticker != null ? { ticker } : {}),
            ...(status != null ? { status } : {}),
            ...(isPaused != null ? { isPaused } : {}),
            rowStartTime: existingState ? existingState.rowStartTime : Date.now()
        });
        broadcastTabStates();
        scheduleStatePersistence();
    }
}

function getTickerByTabId(tabId) {
    const tabState = tabStates.get(tabId);
    return tabState?.ticker || null;
}

function isPausedByTabId(tabId) {
    const tabState = tabStates.get(tabId);
    return tabState?.isPaused || null;
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
            scheduleStatePersistence();
        }
        return;
    }

    const tickerSymbol = tickerQueue.shift();
    if (!tickerSymbol) return;

    updateTabStatus(tabId, { ticker: tickerSymbol.toUpperCase(), status: 'Processing', isPaused: false });
    log(['TabLogs', 'ActionLogs'], `Processing ticker ${tickerSymbol} on tab ${tabId}`, { tabId, tickerSymbol });
    scheduleStatePersistence();
    injectionSetup(tabId, tickerSymbol);
}

async function injectionSetup(tabId, tickerSymbol) {
    try {
        const portData = ports.get(tabId);
        if (portData?.port && portData?.disconnectHandler) {
            disableDisconnectListener(tabId, tickerSymbol);
        }
        
        let tab;
        try {
            tab = await chrome.tabs.get(tabId);
        } catch (error) {
            throw new Error(`Tab ${tabId} doesn't exist or cannot be accessed: ${error.message}`);
        }

        const url = `${baseURL}${tickerSymbol.toLowerCase()}`;
        
        try {
            await chrome.tabs.update(tabId, { url });
        } catch (error) {
            throw new Error(`Failed to update tab URL: ${error.message}`);
        }

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
                reject(new Error(`Tab load timeout (45s)`));
            }, 45000);
        });

        const isAdHoc = tabStates.get(tabId)?.isAdHoc || false;
        
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                func: (id, isAdHoc) => { 
                    if (!id) throw new Error('No tabId injected');
                    window.tabId = id; 
                    window.isAdHoc = isAdHoc;
                },
                args: [tabId, isAdHoc]
            });

            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            });
        } catch (error) {
            throw new Error(`Script injection failed: ${error.message}`);
        }

        enableDisconnectListener(tabId, tickerSymbol);
        return true;

    } catch (error) {
        log(['ErrorLogs', 'TabLogs'], `Setup failed for tab ${tabId}: ${error.message}`, {
            tabId,
            tickerSymbol,
            error: {
                message: error.message,
                stack: error.stack
            }
        });
        
        if (error.message.includes('timeout') || error.message.includes('temporary')) {
            const retryDelayMinutes = 0.1; // 6 seconds (minimum chrome.alarms allows)
            log(['RetryLogs', 'TabLogs'], `Retrying setup for tab ${tabId} in ${retryDelayMinutes * 60}s`, { tabId, tickerSymbol });
            const alarmName = `retry_injection_${tabId}_${tickerSymbol}`;
            chrome.alarms.create(alarmName, { delayInMinutes: retryDelayMinutes });
        } else {
            activeTabs.delete(tabId);
            tabStates.delete(tabId);
            sendToPopup({ action: 'tab_closed', tabId });
            try {
                await chrome.tabs.remove(tabId);
            } catch (removeError) {
                log(['ErrorLogs', 'TabLogs'], `Failed to remove tab ${tabId}: ${removeError.message}`, { tabId });
            }
        }
        
        throw error;
    }
}

async function tabExists(tabId) {
    try {
        await chrome.tabs.get(tabId);
        return true;
    } catch {
        return false;
    }
}

function fixDownloadURL(str) {
    return str;
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
            announcements_api_last_updated: false,
            announcements_dom_last_updated: false
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
        payload.update_timestamps.announcements_api_last_updated = true;
    }
    if (webScrapeAnnouncements && savedScrapeCount === totalScrapeable && totalScrapeable > 0) {
        payload.update_timestamps.announcements_dom_last_updated = true;
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
        }, async (downloadId) => {
            if (chrome.runtime.lastError) {
                log(['ErrorLogs', 'DownloadLogs'], `Download failed: ${chrome.runtime.lastError.message}`, { tabId, tickerSymbol });
                resolve({ filePath: null, downloadId: null });
                return;
            }

            // Track download for recovery
            await trackDownload(downloadId, tickerSymbol, historicalDownloadUrl);

            chrome.downloads.onChanged.addListener(function onChanged(delta) {
                if (delta.id === downloadId && delta.state && delta.state.current === 'complete') {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    chrome.downloads.search({ id: downloadId }, async (results) => {
                        const downloadItem = results?.[0];
                        const filePath = downloadItem?.filename || null;
                        const fileSize = downloadItem?.fileSize || 0;

                        // Calculate download time
                        const downloadInfo = activeDownloads.get(downloadId);
                        const downloadTimeMs = downloadInfo?.startTime ? Date.now() - downloadInfo.startTime : 0;

                        log(['DownloadLogs'], `File Downloaded, filePath: ${filePath}, size: ${fileSize} bytes, time: ${downloadTimeMs}ms, downloadId: ${downloadId}`, { tabId, tickerSymbol });

                        // Increment transfer counter by file type with speed info
                        const fileType = getFileTypeFromFilename(filePath);
                        await incrementTransferCount(fileType, fileSize, downloadTimeMs);

                        await untrackDownload(downloadId);
                        resolve({ filePath, downloadId });
                    });
                } else if (delta.id === downloadId && delta.state && delta.state.current === 'interrupted') {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    log(['ErrorLogs', 'DownloadLogs'], `Download interrupted: ${downloadId}`, { tabId, tickerSymbol });
                    untrackDownload(downloadId);
                    resolve({ filePath: null, downloadId: null });
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