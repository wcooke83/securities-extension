// Popup UI for Chrome Extension
// This script handles the popup UI for the Chrome extension.
// It includes functionality for logging preferences, tab management, and communication with the background script.
const allCategories = [
    'ErrorLogs', 'WarningLogs', 'GeneralLogs', 'DebugLogs', 'ScrapeLogs', 'ServerLogs', 
    'TickerCompletionLogs', 'DataLogs', 'ErrorHandlingLogs', 'AnnouncementLogs', 'TabLogs', 
    'PortLogs', 'ConfigLogs', 'RetryLogs', 'ActionLogs', 'PerfLogs', 'prefixDateTime', 
    'DownloadLogs', 'NotificationLogs',
    'prefixTickerSymbol', 'prefixTabId', 'prefixPortId', 'prefixPortName'
];
let loggingPrefs = {};

// Define category mappings
const categoryMapping = {
    'Diagnostic': ['ErrorHandlingLogs', 'ErrorLogs', 'WarningLogs', 'GeneralLogs', 'DebugLogs', 'NotificationLogs'],
    'Operation': ['ScrapeLogs', 'ServerLogs', 'TickerCompletionLogs', 'DataLogs', 'AnnouncementLogs'],
    'System': ['TabLogs', 'PortLogs', 'ConfigLogs', 'RetryLogs', 'ActionLogs', 'PerfLogs', 'DownloadLogs'],
    'Prefix': ['prefixDateTime', 'prefixTickerSymbol', 'prefixTabId', 'prefixPortId', 'prefixPortName']
};

// Reverse mapping for individual checkbox to category
const idToCategory = {};
for (const [category, ids] of Object.entries(categoryMapping)) {
    ids.forEach(id => idToCategory[id] = category);
}

function loadLoggingPrefs() {
    chrome.storage.local.get('loggingPreferences', (data) => {
        loggingPrefs = data.loggingPreferences || {};
        allCategories.forEach(cat => {
            if (!(cat in loggingPrefs)) loggingPrefs[cat] = true;
        });
        updateCheckboxes();
        setInitialCategoryStates();
    });
}

function updateCheckboxes() {
    allCategories.forEach(cat => {
        const checkbox = document.getElementById(cat);
        if (checkbox) checkbox.checked = loggingPrefs[cat];
    });
}

function setInitialCategoryStates() {
    Object.keys(categoryMapping).forEach(category => {
        updateCategoryCheckbox(category);
    });
}

function updateCategoryCheckbox(category) {
    const categoryCheckbox = document.querySelector(`.category-checkbox[data-category="${category}"]`);
    if (!categoryCheckbox) return;
    const categoryIds = categoryMapping[category];
    const allChecked = categoryIds.every(id => loggingPrefs[id]);
    const someChecked = categoryIds.some(id => loggingPrefs[id]);
    categoryCheckbox.checked = allChecked;
    categoryCheckbox.indeterminate = someChecked && !allChecked;
}

loadLoggingPrefs();

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'loggingPreferences' in changes) {
        loggingPrefs = changes.loggingPreferences.newValue;
        updateCheckboxes();
        Object.keys(categoryMapping).forEach(category => updateCategoryCheckbox(category));
    }
});

function log(categories, message) {
    if (categories.some(cat => loggingPrefs[cat])) {
        const catStr = categories.join(',');
        if (categories.includes('ErrorLogs') || categories.includes('ErrorHandlingLogs')) {
            console.error(`[${catStr}] ${message}`);
        } else if (categories.includes('WarningLogs')) {
            console.warn(`[${catStr}] ${message}`);
        } else {
            console.log(`[${catStr}] ${message}`);
        }
    }
}

// Event listeners for individual checkboxes
allCategories.forEach(cat => {
    const checkbox = document.getElementById(cat);
    if (checkbox) {
        checkbox.addEventListener('change', () => {
            loggingPrefs[cat] = checkbox.checked;
            chrome.storage.local.set({ loggingPreferences: loggingPrefs });
            const category = idToCategory[cat];
            if (category) updateCategoryCheckbox(category);
        });
    }
});

// Event listeners for category checkboxes
document.querySelectorAll('.category-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', (event) => {
        const category = event.target.dataset.category;
        const isChecked = event.target.checked;
        categoryMapping[category].forEach(id => {
            const cb = document.getElementById(id);
            if (cb) {
                cb.checked = isChecked;
                loggingPrefs[id] = isChecked;
            }
        });
        chrome.storage.local.set({ loggingPreferences: loggingPrefs });
    });
});

// Existing code below remains unchanged
document.addEventListener('DOMContentLoaded', () => {
    const startButton = document.getElementById('startButton');
    const pauseButton = document.getElementById('pauseButton');
    const resumeButton = document.getElementById('resumeButton');
    const updateConfigButton = document.getElementById('updateConfigButton');
    const maxTabsInput = document.getElementById('maxTabs');
    const apiFetchAnnouncementsCheckbox = document.getElementById('apiFetchAnnouncements');
    const webScrapeAnnouncementsCheckbox = document.getElementById('webScrapeAnnouncements');
    const downloadPdfsCheckbox = document.getElementById('downloadPdfs');
    const closeTabsCheckbox = document.getElementById('closeTabs');
    const statusDiv = document.getElementById('status');
    const tabTrackingDiv = document.getElementById('tabTracking');

    let currentStatus = 'Idle';
    const tabStates = new Map();

    const port = chrome.runtime.connect({ name: 'popup' });
    let messageId = 0;
    const callbacks = new Map();

    function sendMessage(message, callback, timeout = 5000) {
        const id = messageId++;
        if (callback) {
            callbacks.set(id, callback);
            setTimeout(() => {
                if (callbacks.has(id)) {
                    log(['ErrorLogs', 'PortLogs'], `Timeout waiting for response to message ID ${id}: ${JSON.stringify(message)}`);
                    callbacks.delete(id);
                    callback({ success: false, error: 'Response timeout' });
                }
            }, timeout);
        }
        log(['DebugLogs', 'PortLogs'], `Popup sending message (ID: ${id}): ${JSON.stringify(message)}`);
        port.postMessage({ ...message, id });
    }

    port.onMessage.addListener((msg) => {
        log(['DebugLogs', 'PortLogs'], `Popup received message: ${JSON.stringify(msg)}`);
        if (msg.id !== undefined && callbacks.has(msg.id)) {
            const cb = callbacks.get(msg.id);
            callbacks.delete(msg.id);
            log(['DebugLogs'], `Executing callback for message ID ${msg.id}`);
            cb(msg);
        } else {
            switch (msg.action) {
                case 'status_update':
                    log(['GeneralLogs'], `Processing status_update: ${JSON.stringify(msg)}`);
                    updateButtonStates(msg.isRunning, msg.isPaused);
                    break;
                case 'update_tab_states':
                    log(['TabLogs'], `Processing update_tab_states: ${JSON.stringify(msg.data)}`);
                    updateTabStates(msg.data);
                    break;
                case 'tab_paused':
                    log(['ActionLogs', 'TabLogs'], `Processing tab_paused for tab ${msg.tabId}`);
                    tabStates.set(msg.tabId, { ...tabStates.get(msg.tabId), isPaused: true });
                    updateTabEntry(msg.tabId);
                    break;
                case 'resume_tab':
                    log(['ActionLogs', 'TabLogs'], `Processing resume_tab for tab ${msg.tabId}`);
                    tabStates.set(msg.tabId, { ...tabStates.get(msg.tabId), isPaused: false });
                    updateTabEntry(msg.tabId);
                    break;
                case 'tab_closed':
                    log(['TabLogs'], `Processing tab_closed for tab ${msg.tabId}`);
                    removeTabEntry(msg.tabId);
                    break;
                default:
                    log(['WarningLogs'], `Unhandled message action: ${msg.action}`);
            }
        }
    });

    port.onDisconnect.addListener(() => {
        log(['ErrorLogs', 'PortLogs'], 'Popup port disconnected. Attempting to reconnect...');
        statusDiv.textContent = 'Error: Lost connection to background script';
    });

    chrome.storage.local.get(['maxTabs', 'apiFetchAnnouncements', 'webScrapeAnnouncements', 'downloadPdfs', 'closeTabs'], (data) => {
        maxTabsInput.value = data.maxTabs || 3;
        apiFetchAnnouncementsCheckbox.checked = data.apiFetchAnnouncements !== false;
        webScrapeAnnouncementsCheckbox.checked = data.webScrapeAnnouncements !== false;
        downloadPdfsCheckbox.checked = data.downloadPdfs !== false;
        closeTabsCheckbox.checked = data.closeTabs !== false;
        log(['ConfigLogs'], `Loaded stored config: ${JSON.stringify(data)}`);
    });

    function updateButtonStates(isRunning, isPaused) {
        startButton.disabled = isRunning;
        pauseButton.disabled = !isRunning || isPaused;
        resumeButton.disabled = !isRunning || !isPaused;
        updateConfigButton.disabled = !isRunning;
        currentStatus = isRunning ? (isPaused ? 'Paused' : 'Running') : 'Idle';
        statusDiv.textContent = currentStatus;
        log(['GeneralLogs'], `Updated button states: isRunning=${isRunning}, isPaused=${isPaused}, status=${currentStatus}`);
    }

    function updateTabStates(tabStatesArray) {
        log(['DebugLogs', 'TabLogs'], `Updating tab states with: ${JSON.stringify(tabStatesArray)}`);
        tabTrackingDiv.innerHTML = '';
        tabStates.clear();
        if (!tabStatesArray || tabStatesArray.length === 0) {
            log(['GeneralLogs'], 'No tab states to display');
            tabTrackingDiv.innerHTML = '<div>No active tabs</div>';
            return;
        }
        tabStatesArray.forEach(state => {
            tabStates.set(state.tabId, state);
            const entry = document.createElement('div');
            entry.id = `tab-${state.tabId}`;
            entry.className = 'tab-entry';
            entry.innerHTML = `
                <span>Ticker: ${state.ticker || '-'}</span>
                <span>Status: ${state.status || 'Initializing'}</span>
                <button class="pause-tab" data-tabid="${state.tabId}" data-ticker="${state.ticker || ''}" ${state.isPaused ? 'disabled' : ''}>${state.isPaused ? 'Paused' : 'Pause'}</button>
                <button class="resume-tab" data-tabid="${state.tabId}" data-ticker="${state.ticker || ''}" ${state.isPaused ? '' : 'disabled'}>Resume</button>
                <button class="restart-tab" data-tabid="${state.tabId}" data-ticker="${state.ticker || ''}">Restart</button>
            `;
            tabTrackingDiv.appendChild(entry);
            log(['TabLogs'], `Added tab entry for tab ${state.tabId}: Ticker=${state.ticker}, Status=${state.status}`);
        });
    }

    function updateTabEntry(tabId) {
        const state = tabStates.get(tabId);
        if (!state) {
            log(['WarningLogs', 'TabLogs'], `No state found for tab ${tabId}, skipping update`);
            return;
        }
        const entry = document.getElementById(`tab-${tabId}`);
        if (entry) {
            entry.innerHTML = `
                <span>Ticker: ${state.ticker || '-'}</span>
                <span>Status: ${state.status || 'Initializing'}</span>
                <button class="pause-tab" data-tabid="${tabId}" data-ticker="${state.ticker || ''}" ${state.isPaused ? 'disabled' : ''}>${state.isPaused ? 'Paused' : 'Pause'}</button>
                <button class="resume-tab" data-tabid="${tabId}" data-ticker="${state.ticker || ''}" ${state.isPaused ? '' : 'disabled'}>Resume</button>
                <button class="restart-tab" data-tabid="${state.tabId}" data-ticker="${state.ticker || ''}">Restart</button>
            `;
            log(['TabLogs'], `Updated tab entry for tab ${tabId}: Ticker=${state.ticker}, Status=${state.status}`);
        }
    }

    function removeTabEntry(tabId) {
        const entry = document.getElementById(`tab-${tabId}`);
        if (entry) {
            entry.remove();
            log(['TabLogs'], `Removed tab entry for tab ${tabId}`);
        }
        tabStates.delete(tabId);
    }

    async function getValidTabId() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        const tabId = tab?.url?.startsWith('https://www.marketindex.com.au/asx/') ? tab.id : null;
        log(['DebugLogs', 'TabLogs'], `Valid tab ID: ${tabId}`);
        return tabId;
    }

    function requestTabStatesWithRetry(maxRetries = 3, retryDelay = 500) {
        let attempts = 0;

        function tryRequest() {
            attempts++;
            log(['DebugLogs'], `Requesting tab states (attempt ${attempts})`);
            sendMessage({ action: 'get_tab_states' }, (res) => {
                log(['DebugLogs', 'TabLogs'], `Received response for get_tab_states (attempt ${attempts}): ${JSON.stringify(res)}`);
                if (res?.tabStates) {
                    log(['GeneralLogs'], `Tab states received, updating UI: ${JSON.stringify(res.tabStates)}`);
                    updateTabStates(res.tabStates);
                } else if (attempts < maxRetries) {
                    log(['RetryLogs'], `No tab states received, retrying in ${retryDelay}ms...`);
                    setTimeout(tryRequest, retryDelay);
                } else {
                    log(['ErrorLogs'], 'Failed to fetch tab states after retries');
                    statusDiv.textContent = 'Error: Could not fetch tab states';
                }
            });
        }

        tryRequest();
    }

    startButton.addEventListener('click', async () => {
        const config = getConfig();
        const tabId = await getValidTabId();
        chrome.storage.local.set(config, () => {
            const msg = { action: 'start_scraping', ...config };
            if (tabId) msg.tabId = tabId;
            log(['ActionLogs', 'ConfigLogs'], `Sending start_scraping message: ${JSON.stringify(msg)}`);
            sendMessage(msg, (res) => {
                log(['DebugLogs'], `Received start_scraping response: ${JSON.stringify(res)}`);
                if (res?.success) {
                    updateButtonStates(true, false);
                } else {
                    statusDiv.textContent = `Error: ${res?.error || 'Unknown'}`;
                }
            });
        });
    });

    pauseButton.addEventListener('click', () => {
        log(['ActionLogs'], 'Sending pause_scraping message');
        sendMessage({ action: 'pause_scraping' }, (res) => {
            log(['DebugLogs'], `Received pause_scraping response: ${JSON.stringify(res)}`);
            if (res?.success) updateButtonStates(true, true);
        });
    });

    resumeButton.addEventListener('click', () => {
        log(['ActionLogs'], 'Sending resume_scraping message');
        sendMessage({ action: 'resume_scraping' }, (res) => {
            log(['DebugLogs'], `Received resume_scraping response: ${JSON.stringify(res)}`);
            if (res?.success) updateButtonStates(true, false);
        });
    });

    updateConfigButton.addEventListener('click', async () => {
        const config = getConfig();
        const tabId = await getValidTabId();
        chrome.storage.local.set(config, () => {
            const msg = { action: 'update_config', ...config };
            if (tabId) msg.tabId = tabId;
            log(['ActionLogs', 'ConfigLogs'], `Sending update_config message: ${JSON.stringify(msg)}`);
            sendMessage(msg, (res) => {
                log(['DebugLogs'], `Received update_config response: ${JSON.stringify(res)}`);
                if (res?.success) statusDiv.textContent = 'Config Updated';
                else statusDiv.textContent = `Error: ${res?.error || 'Unknown'}`;
            });
        });
    });

    tabTrackingDiv.addEventListener('click', (e) => {
        const tabId = parseInt(e.target.dataset.tabid);
        const tickerSymbol = e.target.dataset.ticker;
        if (!tabId) return;
        if (e.target.classList.contains('pause-tab')) {
            log(['ActionLogs', 'TabLogs'], `Sending pause_tab for tab ${tabId}`);
            sendMessage({ action: 'pause_tab', tabId }, (res) => {
                log(['DebugLogs'], `Received pause_tab response: ${JSON.stringify(res)}`);
                if (res?.success) updateTabEntry(tabId);
            });
        } else if (e.target.classList.contains('resume-tab')) {
            log(['ActionLogs', 'TabLogs'], `Sending resume_tab for tab ${tabId}`);
            sendMessage({ action: 'resume_tab', tabId }, (res) => {
                log(['DebugLogs'], `Received resume_tab response: ${JSON.stringify(res)}`);
                if (res?.success) updateTabEntry(tabId);
            });
        } else if (e.target.classList.contains('restart-tab')) {
            log(['ActionLogs', 'TabLogs'], `Sending restart_tab for tab ${tabId}`);
            sendMessage({ action: 'restart_tab', tabId, tickerSymbol }, (res) => {
                log(['DebugLogs'], `Received restart_tab response: ${JSON.stringify(res)}`);
                if (res?.success) updateTabEntry(tabId);
            });
        }
    });

    function getConfig() {
        const config = {
            maxTabs: parseInt(maxTabsInput.value) || 1,
            apiFetchAnnouncements: apiFetchAnnouncementsCheckbox.checked,
            webScrapeAnnouncements: webScrapeAnnouncementsCheckbox.checked,
            downloadPdfs: downloadPdfsCheckbox.checked,
            closeTabs: closeTabsCheckbox.checked
        };
        log(['ConfigLogs'], `Generated config: ${JSON.stringify(config)}`);
        return config;
    }

    log(['GeneralLogs'], 'Popup initialized, requesting initial states');
    requestTabStatesWithRetry();
    sendMessage({ action: 'get_status' }, (res) => {
        log(['DebugLogs'], `Received get_status response: ${JSON.stringify(res)}`);
        updateButtonStates(res?.isRunning || false, res?.isPaused || false);
    });
});