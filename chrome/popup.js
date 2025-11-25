const allCategories = [
    'ErrorLogs', 'WarningLogs', 'GeneralLogs', 'DebugLogs', 'ScrapeLogs', 'ServerLogs', 
    'TickerCompletionLogs', 'DataLogs', 'ErrorHandlingLogs', 'AnnouncementLogs', 'TabLogs', 
    'PortLogs', 'ConfigLogs', 'RetryLogs', 'ActionLogs', 'PerfLogs', 'prefixDateTime', 
    'DownloadLogs', 'NotificationLogs',
    'prefixTickerSymbol', 'prefixTabId', 'prefixPortId', 'prefixPortName'
];
let loggingPrefs = {};

const categoryMapping = {
    'Diagnostic': ['ErrorHandlingLogs', 'ErrorLogs', 'WarningLogs', 'GeneralLogs', 'DebugLogs', 'NotificationLogs'],
    'Operation': ['ScrapeLogs', 'ServerLogs', 'TickerCompletionLogs', 'DataLogs', 'AnnouncementLogs'],
    'System': ['TabLogs', 'TabLogs', 'PortLogs', 'ConfigLogs', 'RetryLogs', 'ActionLogs', 'PerfLogs', 'DownloadLogs'],
    'Prefix': ['prefixDateTime', 'prefixTickerSymbol', 'prefixTabId', 'prefixPortId', 'prefixPortName']
};

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

function log(categories, message, context = {}) {
    if (categories.some(cat => loggingPrefs[cat])) {
        let pre_message = 'P';
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

async function checkTabClosedByUser(tabId) {
    try {
        await chrome.tabs.get(tabId);
        return false;
    } catch (error) {
        return true;
    }
}

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
    const singleTickerInput = document.getElementById('singleTicker');
    const scrapeSingleButton = document.getElementById('scrapeSingleButton');
    const statusDiv = document.getElementById('status');
    const tabTrackingDiv = document.getElementById('tabTracking');

    let currentStatus = 'Idle';
    const tabStates = new Map();
    let timerInterval = null;

    const port = chrome.runtime.connect({ name: 'popup' });
    let messageId = 0;
    const callbacks = new Map();

    function sendMessage(message, callback, timeout = 5000) {
        const id = messageId++;
        if (callback) {
            callbacks.set(id, callback);
            setTimeout(() => {
                if (callbacks.has(id)) {
                    log(['ErrorLogs', 'PortLogs'], ['Timeout waiting for response to message ID ', id, ': ', message]);
                    callbacks.delete(id);
                    callback({ success: false, error: 'Response timeout' });
                }
            }, timeout);
        }
        log(['DebugLogs', 'PortLogs'], ['Popup sending message (ID: ', id, '): ', message]);
        port.postMessage({ ...message, id });
    }

    port.onMessage.addListener((msg) => {
        log(['DebugLogs', 'PortLogs'], ['Popup received message: ', msg]);
        if (msg.id !== undefined && callbacks.has(msg.id)) {
            const cb = callbacks.get(msg.id);
            callbacks.delete(msg.id);
            log(['DebugLogs'], `Executing callback for message ID ${msg.id}`);
            cb(msg);
        } else {
            switch (msg.action) {
                case 'status_update':
                    log(['GeneralLogs'], ['Processing status_update: ', msg]);
                    updateButtonStates(msg.isRunning, msg.isPaused);
                    break;
                case 'update_tab_states':
                    log(['TabLogs'], ['Processing update_tab_states: ', msg.data]);
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
                case 'tab_status_updated':
                    log(['ActionLogs', 'TabLogs'], `Processing tab_status_updated for tab ${msg.tabId}`);
                    tabStates.set(msg.tabId, { 
                        ...tabStates.get(msg.tabId), 
                        isPaused: msg.isPaused ?? tabStates.get(msg.tabId)?.isPaused,
                        status: msg.status ?? tabStates.get(msg.tabId)?.status
                    });
                    updateTabEntry(msg.tabId);
                    break;
                case 'tab_states':
                    log(['TabLogs'], ['Processing tab_states: ', msg.tabStates]);
                    msg.tabStates.forEach((state) => {
                        tabStates.set(state.tabId, {
                            ticker: state.ticker,
                            status: state.status,
                            isPaused: state.isPaused,
                            rowStartTime: state.rowStartTime
                        });
                        updateTabEntry(state.tabId);
                    });
                    break;
                default:
                    log(['WarningLogs'], `Unhandled message action: ${msg.action}`);
            }
        }
    });

    port.onDisconnect.addListener(() => {
        log(['ErrorLogs', 'PortLogs'], 'Popup port disconnected. Attempting to reconnect...');
        statusDiv.textContent = 'Error: Lost connection to background script';
        if (timerInterval) clearInterval(timerInterval);
    });

    chrome.storage.local.get(['maxTabs', 'apiFetchAnnouncements', 'webScrapeAnnouncements', 'downloadPdfs', 'closeTabs'], (data) => {
        maxTabsInput.value = data.maxTabs || 3;
        apiFetchAnnouncementsCheckbox.checked = data.apiFetchAnnouncements !== false;
        webScrapeAnnouncementsCheckbox.checked = data.webScrapeAnnouncements !== false;
        downloadPdfsCheckbox.checked = data.downloadPdfs !== false;
        closeTabsCheckbox.checked = data.closeTabs !== false;
        log(['ConfigLogs'], ['Loaded stored config: ', data]);
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

    function formatTime(elapsedSeconds) {
        if (elapsedSeconds < 60) {
            return `${elapsedSeconds}s`;
        } else {
            const minutes = Math.floor(elapsedSeconds / 60);
            const seconds = elapsedSeconds % 60;
            return `${minutes}m ${seconds}s`;
        }
    }

    function startTimerUpdates() {
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            tabStates.forEach((state, tabId) => {
                const entry = document.getElementById(`tab-${tabId}`);
                if (entry) {
                    const timerSpan = entry.querySelector('.timer');
                    if (timerSpan && state.rowStartTime) {
                        const elapsedSeconds = Math.floor((Date.now() - state.rowStartTime) / 1000);
                        timerSpan.textContent = formatTime(elapsedSeconds);
                    }
                }
            });
        }, 1000);
    }

    function updateTabStates(states) {
        tabTrackingDiv.innerHTML = '';
        log(['TabLogs'], [`updateTabStates states: `, states]);
        for (const [id, state] of Object.entries(states)) {
            tabStates.set(parseInt(state.tabId), {
                ticker: state.ticker,
                status: state.status,
                isPaused: state.isPaused,
                rowStartTime: state.rowStartTime
            });
            const entry = document.createElement('div');
            entry.className = 'tab-entry';
            entry.id = `tab-${state.tabId}`;
            entry.dataset.tabId = state.tabId;
            const elapsedSeconds = state.rowStartTime ? Math.floor((Date.now() - state.rowStartTime) / 1000) : 0;
            entry.innerHTML = `
                <span class="timer">${formatTime(elapsedSeconds)}</span>
                <span>Ticker: ${state.ticker || '-'}</span>
                <span>Status: ${state.status || 'Initializing'}</span>
                <button class="pause-tab" data-tabid="${state.tabId}" data-ticker="${state.ticker || ''}" ${state.isPaused ? 'disabled' : ''}>${state.isPaused ? '❚❚' : '❚❚'}</button>
                <button class="resume-tab" data-tabid="${state.tabId}" data-ticker="${state.ticker || ''}" ${state.isPaused ? '' : 'disabled'}>➤</button>
                <button class="restart-tab" data-tabid="${state.tabId}" data-ticker="${state.ticker || ''}">↻</button>
                <button class="close-tab" data-tabid="${state.tabId}" data-ticker="${state.ticker || ''}">🗙</button>
            `;
            tabTrackingDiv.appendChild(entry);
        }
        startTimerUpdates();
    }

    function updateTabEntry(tabId) {
        const state = tabStates.get(tabId);
        if (!state) {
            log(['WarningLogs', 'TabLogs'], `No state found for tab ${tabId}, skipping update`);
            return;
        }
        const entry = document.getElementById(`tab-${tabId}`);
        if (entry) {
            const elapsedSeconds = state.rowStartTime ? Math.floor((Date.now() - state.rowStartTime) / 1000) : 0;
            entry.innerHTML = `
                <span class="timer">${formatTime(elapsedSeconds)}</span>
                <span>Ticker: ${state.ticker || '-'}</span>
                <span>Status: ${state.status || 'Initializing'}</span>
                <button class="pause-tab" data-tabid="${tabId}" data-ticker="${state.ticker || 'Unknown'}" ${state.isPaused ? 'disabled' : ''}>${state.isPaused ? '❚❚' : '❚❚'}</button>
                <button class="resume-tab" data-tabid="${tabId}" data-ticker="${state.ticker || 'Unknown'}" ${state.isPaused ? '' : 'disabled'}>➤</button>
                <button class="restart-tab" data-tabid="${tabId}" data-ticker="${state.ticker || 'Unknown'}">↻</button>
                <button class="close-tab" data-tabid="${tabId}" data-ticker="${state.ticker || 'Unknown'}">🗙</button>
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
        if (tabStates.size === 0 && timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
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
                log(['DebugLogs', 'TabLogs'], ['Received response for get_tab_states (attempt ', attempts, '): ', res]);
                if (res?.tabStates) {
                    log(['GeneralLogs'], ['Tab states received, updating UI: ', res.tabStates]);
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
            log(['ActionLogs', 'ConfigLogs'], ['Sending start_scraping message: ', msg]);
            sendMessage(msg, (res) => {
                log(['DebugLogs'], ['Received start_scraping response: ', res]);
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
            log(['DebugLogs'], ['Received pause_scraping response: ', res]);
            if (res?.success) updateButtonStates(true, true);
        });
    });

    resumeButton.addEventListener('click', () => {
        log(['ActionLogs'], 'Sending resume_scraping message');
        sendMessage({ action: 'resume_scraping' }, (res) => {
            log(['DebugLogs'], ['Received resume_scraping response: ', res]);
            if (res?.success) updateButtonStates(true, false);
        });
    });

    updateConfigButton.addEventListener('click', async () => {
        const config = getConfig();
        const tabId = await getValidTabId();
        chrome.storage.local.set(config, () => {
            const msg = { action: 'update_config', ...config };
            if (tabId) msg.tabId = tabId;
            log(['ActionLogs', 'ConfigLogs'], ['Sending update_config message: ', msg]);
            sendMessage(msg, (res) => {
                log(['DebugLogs'], ['Received update_config response: ', res]);
                if (res?.success) statusDiv.textContent = 'Config Updated';
                else statusDiv.textContent = `Error: ${res?.error || 'Unknown'}`;
            });
        });
    });

    scrapeSingleButton.addEventListener('click', () => {
        const tickerSymbol = singleTickerInput.value.trim().toUpperCase();
        if (!tickerSymbol) {
            alert('Please enter a ticker symbol.');
            return;
        }
        sendMessage({ action: 'scrape_single_ticker', tickerSymbol }, (res) => {
            if (res?.success) {
                statusDiv.textContent = `Started scraping for ${tickerSymbol}`;
            } else {
                statusDiv.textContent = `Error: ${res?.error || 'Unknown'}`;
            }
        });
    });

    tabTrackingDiv.addEventListener('click', (e) => {
        const target = e.target;
        if (target.tagName !== 'BUTTON') return;

        const tabId = parseInt(target.dataset.tabid, 10);
        const tickerSymbol = target.dataset.ticker;
        if (isNaN(tabId) || tabId <= 0 || !tickerSymbol || tickerSymbol === 'Unknown') {
            log(['ErrorLogs', 'TabLogs'], `Invalid tabId or tickerSymbol: tabId=${tabId}, tickerSymbol=${tickerSymbol}`);
            return;
        }
        if (target.classList.contains('pause-tab')) {
            log(['ActionLogs', 'TabLogs'], `Sending pause_tab for tab ${tabId}, ticker ${tickerSymbol}`);
            sendMessage({ action: 'pause_tab', tabId, tickerSymbol }, (res) => {
                if (res?.success) {
                    updateTabEntry(tabId);
                } else {
                    log(['ErrorLogs', 'TabLogs'], `Pause failed for tab ${tabId}: ${res?.error || 'Unknown'}`);
                }
            });
        } else if (target.classList.contains('resume-tab')) {
            log(['ActionLogs', 'TabLogs'], `Sending resume_tab for tab ${tabId}, ticker ${tickerSymbol}`);
            sendMessage({ action: 'resume_tab', tabId, tickerSymbol }, (res) => {
                if (res?.success) {
                    updateTabEntry(tabId);
                } else {
                    log(['ErrorLogs', 'TabLogs'], `Resume failed for tab ${tabId}: ${res?.error || 'Unknown'}`);
                }
            });
        } else if (target.classList.contains('restart-tab')) {
            log(['ActionLogs', 'TabLogs'], `Sending restart_tab for tab ${tabId}, ticker ${tickerSymbol}`);
            sendMessage({ action: 'restart_tab', tabId, tickerSymbol }, (res) => {
                if (res?.success) {
                    updateTabEntry(tabId);
                } else {
                    log(['ErrorLogs', 'TabLogs'], `Restart failed for tab ${tabId}: ${res?.error || 'Unknown'}`);
                }
            });
        } else if (target.classList.contains('close-tab')) {
            log(['ActionLogs', 'TabLogs'], `Sending close_tab for tab ${tabId}, ticker ${tickerSymbol}`);
            sendMessage({ action: 'close_tab', tabId, tickerSymbol }, (res) => {
                if (res?.success) {
                    removeTabEntry(tabId);
                } else {
                    log(['ErrorLogs', 'TabLogs'], `Close failed for tab ${tabId}: ${res?.error || 'Unknown'}`);
                }
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
        log(['ConfigLogs'], ['Generated config: ', config]);
        return config;
    }

    log(['GeneralLogs'], 'Popup initialized, requesting initial states');
    requestTabStatesWithRetry();
    sendMessage({ action: 'get_status' }, (res) => {
        log(['DebugLogs'], ['Received get_status response: ', res]);
        updateButtonStates(res?.isRunning || false, res?.isPaused || false);
    });
});