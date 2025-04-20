// popup.js
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

    function sendMessage(message, callback, timeout = 2000) {
        const id = messageId++;
        if (callback) {
            callbacks.set(id, callback);
            setTimeout(() => {
                if (callbacks.has(id)) {
                    console.error(`Timeout waiting for response to message ID ${id}:`, message);
                    callbacks.delete(id);
                    callback({ success: false, error: 'Response timeout' });
                }
            }, timeout);
        }
        console.log(`Popup sending message (ID: ${id}):`, JSON.stringify(message));
        port.postMessage({ ...message, id });
    }

    port.onMessage.addListener((msg) => {
        console.log('Popup received message:', JSON.stringify(msg));
        if (msg.id !== undefined && callbacks.has(msg.id)) {
            const cb = callbacks.get(msg.id);
            callbacks.delete(msg.id);
            console.log(`Executing callback for message ID ${msg.id}`);
            cb(msg);
        } else {
            switch (msg.action) {
                case 'status_update':
                    console.log('Processing status_update:', msg);
                    updateButtonStates(msg.isRunning, msg.isPaused);
                    break;
                case 'update_tab_states':
                    console.log('Processing update_tab_states:', JSON.stringify(msg.data));
                    updateTabStates(msg.data);
                    break;
                case 'tab_paused':
                    console.log(`Processing tab_paused for tab ${msg.tabId}`);
                    tabStates.set(msg.tabId, { ...tabStates.get(msg.tabId), isPaused: true });
                    updateTabEntry(msg.tabId);
                    break;
                case 'resume_tab':
                    console.log(`Processing resume_tab for tab ${msg.tabId}`);
                    tabStates.set(msg.tabId, { ...tabStates.get(msg.tabId), isPaused: false });
                    updateTabEntry(msg.tabId);
                    break;
                case 'tab_closed':
                    console.log(`Processing tab_closed for tab ${msg.tabId}`);
                    removeTabEntry(msg.tabId);
                    break;
                default:
                    console.log('Unhandled message action:', msg.action);
            }
        }
    });

    port.onDisconnect.addListener(() => {
        console.error('Popup port disconnected. Attempting to reconnect...');
        statusDiv.textContent = 'Error: Lost connection to background script';
    });

    chrome.storage.local.get(['maxTabs', 'apiFetchAnnouncements', 'webScrapeAnnouncements', 'downloadPdfs', 'closeTabs'], (data) => {
        maxTabsInput.value = data.maxTabs || 3;
        apiFetchAnnouncementsCheckbox.checked = data.apiFetchAnnouncements !== false;
        webScrapeAnnouncementsCheckbox.checked = data.webScrapeAnnouncements !== false;
        downloadPdfsCheckbox.checked = data.downloadPdfs !== false;
        closeTabsCheckbox.checked = data.closeTabs !== false;
        console.log('Loaded stored config:', data);
    });

    function updateButtonStates(isRunning, isPaused) {
        startButton.disabled = isRunning;
        pauseButton.disabled = !isRunning || isPaused;
        resumeButton.disabled = !isRunning || !isPaused;
        updateConfigButton.disabled = !isRunning;
        currentStatus = isRunning ? (isPaused ? 'Paused' : 'Running') : 'Idle';
        statusDiv.textContent = currentStatus;
        console.log(`Updated button states: isRunning=${isRunning}, isPaused=${isPaused}, status=${currentStatus}`);
    }

    function updateTabStates(tabStatesArray) {
        console.log('Updating tab states with:', JSON.stringify(tabStatesArray));
        tabTrackingDiv.innerHTML = ''; // Clear existing entries
        tabStates.clear();
        if (!tabStatesArray || tabStatesArray.length === 0) {
            console.log('No tab states to display');
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
                <button class="pause-tab" data-tabid="${state.tabId}" ${state.isPaused ? 'disabled' : ''}>${state.isPaused ? 'Paused' : 'Pause'}</button>
                <button class="resume-tab" data-tabid="${state.tabId}" ${state.isPaused ? '' : 'disabled'}>Resume</button>
            `;
            tabTrackingDiv.appendChild(entry);
            console.log(`Added tab entry for tab ${state.tabId}: Ticker=${state.ticker}, Status=${state.status}`);
        });
    }

    function updateTabEntry(tabId) {
        const state = tabStates.get(tabId);
        if (!state) {
            console.log(`No state found for tab ${tabId}, skipping update`);
            return;
        }
        const entry = document.getElementById(`tab-${tabId}`);
        if (entry) {
            entry.innerHTML = `
                <span>Ticker: ${state.ticker || '-'}</span>
                <span>Status: ${state.status || 'Initializing'}</span>
                <button class="pause-tab" data-tabid="${tabId}" ${state.isPaused ? 'disabled' : ''}>${state.isPaused ? 'Paused' : 'Pause'}</button>
                <button class="resume-tab" data-tabid="${tabId}" ${state.isPaused ? '' : 'disabled'}>Resume</button>
            `;
            console.log(`Updated tab entry for tab ${tabId}: Ticker=${state.ticker}, Status=${state.status}`);
        }
    }

    function removeTabEntry(tabId) {
        const entry = document.getElementById(`tab-${tabId}`);
        if (entry) {
            entry.remove();
            console.log(`Removed tab entry for tab ${tabId}`);
        }
        tabStates.delete(tabId);
    }

    async function getValidTabId() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        const tabId = tab?.url?.startsWith('https://www.marketindex.com.au/asx/') ? tab.id : null;
        console.log(`Valid tab ID: ${tabId}`);
        return tabId;
    }

    function requestTabStatesWithRetry(maxRetries = 3, retryDelay = 500) {
        let attempts = 0;

        function tryRequest() {
            attempts++;
            console.log(`Requesting tab states (attempt ${attempts})`);
            sendMessage({ action: 'get_tab_states' }, (res) => {
                console.log(`Received response for get_tab_states (attempt ${attempts}):`, JSON.stringify(res));
                if (res?.tabStates) {
                    console.log('Tab states received, updating UI:', JSON.stringify(res.tabStates));
                    updateTabStates(res.tabStates);
                } else if (attempts < maxRetries) {
                    console.log(`No tab states received, retrying in ${retryDelay}ms...`);
                    setTimeout(tryRequest, retryDelay);
                } else {
                    console.error('Failed to fetch tab states after retries');
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
            console.log('Sending start_scraping message:', msg);
            sendMessage(msg, (res) => {
                console.log('Received start_scraping response:', res);
                if (res?.success) {
                    updateButtonStates(true, false);
                } else {
                    statusDiv.textContent = `Error: ${res?.error || 'Unknown'}`;
                }
            });
        });
    });

    pauseButton.addEventListener('click', () => {
        sendMessage({ action: 'pause_scraping' }, (res) => {
            console.log('Received pause_scraping response:', res);
            if (res?.success) updateButtonStates(true, true);
        });
    });

    resumeButton.addEventListener('click', () => {
        sendMessage({ action: 'resume_scraping' }, (res) => {
            console.log('Received resume_scraping response:', res);
            if (res?.success) updateButtonStates(true, false);
        });
    });

    updateConfigButton.addEventListener('click', async () => {
        const config = getConfig();
        const tabId = await getValidTabId();
        chrome.storage.local.set(config, () => {
            const msg = { action: 'update_config', ...config };
            if (tabId) msg.tabId = tabId;
            console.log('Sending update_config message:', msg);
            sendMessage(msg, (res) => {
                console.log('Received update_config response:', res);
                if (res?.success) statusDiv.textContent = 'Config Updated';
                else statusDiv.textContent = `Error: ${res?.error || 'Unknown'}`;
            });
        });
    });

    tabTrackingDiv.addEventListener('click', (e) => {
        const tabId = parseInt(e.target.dataset.tabid);
        if (!tabId) return;
        if (e.target.classList.contains('pause-tab')) {
            console.log(`Sending pause_tab for tab ${tabId}`);
            sendMessage({ action: 'pause_tab', tabId }, (res) => {
                console.log('Received pause_tab response:', res);
                if (res?.success) updateTabEntry(tabId);
            });
        } else if (e.target.classList.contains('resume-tab')) {
            console.log(`Sending resume_tab for tab ${tabId}`);
            sendMessage({ action: 'resume_tab', tabId }, (res) => {
                console.log('Received resume_tab response:', res);
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
        console.log('Generated config:', config);
        return config;
    }

    // Request initial states with retry
    console.log('Popup initialized, requesting initial states');
    requestTabStatesWithRetry();
    sendMessage({ action: 'get_status' }, (res) => {
        console.log('Received get_status response:', res);
        updateButtonStates(res?.isRunning || false, res?.isPaused || false);
    });
});