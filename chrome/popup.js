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

    chrome.storage.local.get(['maxTabs', 'apiFetchAnnouncements', 'webScrapeAnnouncements', 'downloadPdfs', 'closeTabs'], (data) => {
        if (data.maxTabs) maxTabsInput.value = data.maxTabs;
        apiFetchAnnouncementsCheckbox.checked = data.apiFetchAnnouncements !== false;
        webScrapeAnnouncementsCheckbox.checked = data.webScrapeAnnouncements !== false;
        downloadPdfsCheckbox.checked = data.downloadPdfs !== false;
        closeTabsCheckbox.checked = data.closeTabs !== false;
    });

    function updateButtonStates(isRunning, isPaused) {
        startButton.disabled = isRunning;
        pauseButton.disabled = !isRunning || isPaused;
        resumeButton.disabled = !isRunning || !isPaused;
        updateConfigButton.disabled = !isRunning;
        currentStatus = isRunning ? (isPaused ? 'Paused' : 'Running') : 'Idle';
        statusDiv.textContent = currentStatus;
        if (isRunning && isPaused) {
            tabStates.forEach((state, id) => {
                state.isPaused = true;
                updateTabEntry(id);
            });
        } else if (isRunning && !isPaused) {
            tabStates.forEach((state, id) => {
                if (state.isPaused) {
                    state.isPaused = false;
                    updateTabEntry(id);
                }
            });
        }
    }

    function getConfig() {
        return {
            maxTabs: parseInt(maxTabsInput.value) || 1,
            apiFetchAnnouncements: apiFetchAnnouncementsCheckbox.checked,
            webScrapeAnnouncements: webScrapeAnnouncementsCheckbox.checked,
            downloadPdfs: downloadPdfsCheckbox.checked,
            closeTabs: closeTabsCheckbox.checked
        };
    }

    function updateTabEntry(tabId) {
        if (tabId === undefined) return;
        const state = tabStates.get(tabId);
        if (!state) return;
        let entry = document.getElementById(`tab-${tabId}`);
        if (!entry) {
            entry = document.createElement('div');
            entry.id = `tab-${tabId}`;
            entry.className = 'tab-entry';
            tabTrackingDiv.appendChild(entry);
        }
        entry.innerHTML = `
            <span id="ticker-${tabId}" data-ticker="${state?.ticker}">Ticker: ${state.ticker ? state.ticker.toUpperCase() : '-'}</span>
            <span>Status: ${state.status || 'Initializing'}</span>
            <button class="pause-tab" data-tabid="${tabId}" ${state.isPaused ? 'disabled' : ''}>${state.isPaused ? 'Paused' : 'Pause'}</button>
            <button class="resume-tab" data-tabid="${tabId}" ${state.isPaused ? '' : 'disabled'}>Resume</button>
        `;
    }

    function removeTabEntry(tabId) {
        if (tabId === undefined) return;
        const entry = document.getElementById(`tab-${tabId}`);
        if (entry) entry.remove();
        tabStates.delete(tabId);
    }

    async function getValidTabId() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (tab?.id && tab.url?.startsWith('https://www.marketindex.com.au/asx/')) {
            console.log(`Valid ASX tab found: tabId=${tab.id}, url=${tab.url}`);
            return tab.id;
        }
        console.log('No valid ASX tab found for active tab');
        return null;
    }

    startButton.addEventListener('click', async () => {
        const config = getConfig();
        const tabId = await getValidTabId();
        chrome.storage.local.set(config, () => {
            console.log('Starting scraping with config:', JSON.stringify({ tabId, ...config }, null, 2));
            const message = { action: 'start_scraping', ...config };
            if (tabId) message.tabId = tabId;
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error starting scraping:', chrome.runtime.lastError.message);
                    statusDiv.textContent = 'Error starting scraping';
                } else if (response?.success) {
                    updateButtonStates(true, false);
                } else {
                    statusDiv.textContent = `Error: ${response.error || 'Unknown error'}`;
                }
            });
        });
    });

    pauseButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'pause_scraping' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Error pausing scraping:', chrome.runtime.lastError.message);
            } else {
                updateButtonStates(true, true);
            }
        });
    });

    resumeButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'resume_scraping' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Error resuming scraping:', chrome.runtime.lastError.message);
            } else {
                updateButtonStates(true, false);
            }
        });
    });

    updateConfigButton.addEventListener('click', async () => {
        const config = getConfig();
        const tabId = await getValidTabId();
        chrome.storage.local.set(config, () => {
            console.log('Updating config:', JSON.stringify({ tabId, ...config }, null, 2));
            const message = { action: 'update_config', ...config };
            if (tabId) message.tabId = tabId;
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error updating config:', chrome.runtime.lastError.message);
                    statusDiv.textContent = 'Error updating config';
                } else if (response?.success) {
                    statusDiv.textContent = 'Config Updated';
                    setTimeout(() => {
                        statusDiv.textContent = currentStatus;
                    }, 10000);
                } else {
                    statusDiv.textContent = `Error: ${response.error || 'Unknown error'}`;
                }
            });
        });
    });

    tabTrackingDiv.addEventListener('click', (event) => {
        const targetTabId = parseInt(event.target.dataset.tabid);
        if (!targetTabId) return;
        if (event.target.classList.contains('pause-tab')) {
            console.log(`Sending pause_tab for tab ${targetTabId}`);
            chrome.runtime.sendMessage({ action: 'pause_tab', tabId: targetTabId }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error pausing tab:', chrome.runtime.lastError.message);
                } else if (response?.success) {
                    tabStates.set(targetTabId, { ...tabStates.get(targetTabId), isPaused: true });
                    updateTabEntry(targetTabId);
                }
            });
        } else if (event.target.classList.contains('resume-tab')) {
            console.log(`Sending resume_tab for tab ${targetTabId}`);
            chrome.runtime.sendMessage({ action: 'resume_tab', tabId: targetTabId }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error resuming tab:', chrome.runtime.lastError.message);
                } else if (response?.success) {
                    tabStates.set(targetTabId, { ...tabStates.get(targetTabId), isPaused: false });
                    updateTabEntry(targetTabId);
                }
            });
        }
    });

    chrome.runtime.sendMessage({ action: 'get_tab_states' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Error getting tab states:', chrome.runtime.lastError.message);
        } else if (response?.tabStates) {
            tabTrackingDiv.innerHTML = '';
            tabStates.clear();
            response.tabStates.forEach(({ tabId, ticker, status, isPaused }) => {
                tabStates.set(tabId, { ticker: ticker.toUpperCase(), status, isPaused });
                updateTabEntry(tabId);
            });
        }
    });

    const allowedActions = [
        'status_update',
        'update_tab_status',
        'update_tab_ticker',
        'tab_paused',
        'resume_tab',
        'tab_closed',
        'get_status',
        'get_tab_states'
    ];

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message?.action || !allowedActions.includes(message.action)) {
            sendResponse({ received: true, ignored: true });
            return true;
        }
        const messageTabId = message.tabId;
        switch (message.action) {
            case 'status_update':
                updateButtonStates(message.isRunning, message.isPaused);
                sendResponse({ received: true });
                break;
            case 'update_tab_status':
                if (!tabStates.has(messageTabId)) {
                    tabStates.set(messageTabId, { ticker: '', status: message.status || 'Initializing', isPaused: false });
                } else {
                    tabStates.set(messageTabId, { ...tabStates.get(messageTabId), status: message.status });
                }
                updateTabEntry(messageTabId);
                sendResponse({ received: true });
                break;
            case 'update_tab_ticker':
                if (!tabStates.has(messageTabId)) {
                    tabStates.set(messageTabId, { ticker: message.ticker.toUpperCase(), status: 'Initializing', isPaused: false });
                } else {
                    tabStates.set(messageTabId, { ...tabStates.get(messageTabId), ticker: message.ticker.toUpperCase() });
                }
                updateTabEntry(messageTabId);
                sendResponse({ received: true });
                break;
            case 'tab_paused':
                if (tabStates.has(messageTabId)) {
                    tabStates.set(messageTabId, { ...tabStates.get(messageTabId), isPaused: true });
                    updateTabEntry(messageTabId);
                }
                sendResponse({ received: true });
                break;
            case 'resume_tab':
                if (tabStates.has(messageTabId)) {
                    tabStates.set(messageTabId, { ...tabStates.get(messageTabId), isPaused: false });
                    updateTabEntry(messageTabId);
                }
                sendResponse({ received: true });
                break;
            case 'tab_closed':
                removeTabEntry(messageTabId);
                sendResponse({ received: true });
                break;
            case 'get_status':
                sendResponse({ isRunning: currentStatus === 'Running' || currentStatus === 'Paused', isPaused: currentStatus === 'Paused' });
                break;
            case 'get_tab_states':
                sendResponse({ tabStates: Array.from(tabStates.entries()).map(([id, state]) => ({ tabId: id, ...state })) });
                break;
            default:
                sendResponse({ received: true, ignored: true });
        }
        return true;
    });

    chrome.runtime.sendMessage({ action: 'get_status' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Error getting status:', chrome.runtime.lastError.message);
            updateButtonStates(false, false);
        } else {
            updateButtonStates(response.isRunning, response.isPaused);
        }
    });
});