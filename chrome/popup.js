document.addEventListener('DOMContentLoaded', () => {
    const startButton = document.getElementById('startButton');
    const pauseButton = document.getElementById('pauseButton');
    const resumeButton = document.getElementById('resumeButton');
    const updateConfigButton = document.getElementById('updateConfigButton');
    const maxTabsInput = document.getElementById('maxTabs');
    const fetchViaApiCheckbox = document.getElementById('fetchViaApi');
    const scrapeFromWebCheckbox = document.getElementById('scrapeFromWeb');
    const downloadPdfsCheckbox = document.getElementById('downloadPdfs');
    const closeTabsCheckbox = document.getElementById('closeTabs');
    const statusDiv = document.getElementById('status');

    let currentStatus = 'Idle'; // Track the current scraping status

    // Load saved settings
    chrome.storage.local.get(['maxTabs', 'fetchViaApi', 'scrapeFromWeb', 'downloadPdfs', 'closeTabs'], (data) => {
        if (data.maxTabs) maxTabsInput.value = data.maxTabs;
        if (data.fetchViaApi !== undefined) fetchViaApiCheckbox.checked = data.fetchViaApi;
        if (data.scrapeFromWeb !== undefined) scrapeFromWebCheckbox.checked = data.scrapeFromWeb;
        if (data.downloadPdfs !== undefined) downloadPdfsCheckbox.checked = data.downloadPdfs;
        if (data.closeTabs !== undefined) closeTabsCheckbox.checked = data.closeTabs;
    });

    // Update button states and status
    function updateButtonStates(isRunning, isPaused) {
        startButton.disabled = isRunning;
        pauseButton.disabled = !isRunning || isPaused;
        resumeButton.disabled = !isRunning || !isPaused;
        updateConfigButton.disabled = !isRunning;
        currentStatus = isRunning ? (isPaused ? 'Paused' : 'Running') : 'Idle';
        statusDiv.textContent = currentStatus;
    }

    // Initial state check
    chrome.runtime.sendMessage({ action: 'get_status' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Error getting status:', chrome.runtime.lastError.message);
            updateButtonStates(false, false);
        } else {
            updateButtonStates(response.isRunning, response.isPaused);
        }
    });

    // Function to get current config
    function getConfig() {
        return {
            maxTabs: parseInt(maxTabsInput.value),
            fetchViaApi: fetchViaApiCheckbox.checked,
            scrapeFromWeb: scrapeFromWebCheckbox.checked,
            downloadPdfs: downloadPdfsCheckbox.checked,
            closeTabs: closeTabsCheckbox.checked
        };
    }

    // Start scraping
    startButton.addEventListener('click', () => {
        const config = getConfig();
        chrome.storage.local.set(config, () => {
            chrome.runtime.sendMessage({
                action: 'start_scraping',
                ...config
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error starting scraping:', chrome.runtime.lastError.message);
                } else if (response?.success) {
                    updateButtonStates(true, false);
                }
            });
        });
    });

    // Pause scraping
    pauseButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'pause_scraping' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Error pausing scraping:', chrome.runtime.lastError.message);
            } else {
                updateButtonStates(true, true);
            }
        });
    });

    // Resume scraping
    resumeButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'resume_scraping' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Error resuming scraping:', chrome.runtime.lastError.message);
            } else {
                updateButtonStates(true, false);
            }
        });
    });

    // Update config with temporary status update
    updateConfigButton.addEventListener('click', () => {
        const config = getConfig();
        chrome.storage.local.set(config, () => {
            chrome.runtime.sendMessage({
                action: 'update_config',
                ...config
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error updating config:', chrome.runtime.lastError.message);
                } else if (response?.success) {
                    console.log('Config updated:', config);
                    statusDiv.textContent = 'Config Updated';
                    setTimeout(() => {
                        statusDiv.textContent = currentStatus;
                    }, 10000); // 10 seconds
                }
            });
        });
    });

    // Listen for status updates from background.js
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'status_update') {
            updateButtonStates(message.isRunning, message.isPaused);
        }
    });
});