document.addEventListener('DOMContentLoaded', () => {
    const startButton = document.getElementById('startButton');
    const pauseButton = document.getElementById('pauseButton');
    const resumeButton = document.getElementById('resumeButton');
    const maxTabsInput = document.getElementById('maxTabs');
    const downloadAnnouncementsCheckbox = document.getElementById('downloadAnnouncements');
    const closeTabsCheckbox = document.getElementById('closeTabs');
    const statusDiv = document.getElementById('status');

    // Load saved settings
    chrome.storage.local.get(['maxTabs', 'downloadAnnouncements', 'closeTabs'], (data) => {
        if (data.maxTabs) maxTabsInput.value = data.maxTabs;
        if (data.downloadAnnouncements !== undefined) downloadAnnouncementsCheckbox.checked = data.downloadAnnouncements;
        if (data.closeTabs !== undefined) closeTabsCheckbox.checked = data.closeTabs;
    });

    // Update button states based on scraping status
    function updateButtonStates(isRunning, isPaused) {
        startButton.disabled = isRunning;
        pauseButton.disabled = !isRunning || isPaused;
        resumeButton.disabled = !isRunning || !isPaused;
        statusDiv.textContent = isRunning ? (isPaused ? 'Paused' : 'Running') : 'Idle';
    }

    // Initial state check
    chrome.runtime.sendMessage({ action: 'get_status' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Error getting status:', chrome.runtime.lastError.message);
            updateButtonStates(false, false); // Default to idle on error
        } else {
            updateButtonStates(response.isRunning, response.isPaused);
        }
    });

    // Start scraping
    startButton.addEventListener('click', () => {
        const maxTabs = parseInt(maxTabsInput.value);
        const downloadAnnouncements = downloadAnnouncementsCheckbox.checked;
        const closeTabs = closeTabsCheckbox.checked;

        chrome.storage.local.set({ maxTabs, downloadAnnouncements, closeTabs }, () => {
            chrome.runtime.sendMessage({
                action: 'start_scraping',
                maxTabs,
                downloadAnnouncements,
                closeTabs
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error starting scraping:', chrome.runtime.lastError.message);
                }
                updateButtonStates(true, false);
            });
        });
    });

    // Pause scraping
    pauseButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'pause_scraping' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Error pausing scraping:', chrome.runtime.lastError.message);
            }
            updateButtonStates(true, true);
        });
    });

    // Resume scraping
    resumeButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'resume_scraping', delay: 1000 }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Error resuming scraping:', chrome.runtime.lastError.message);
            }
            updateButtonStates(true, false);
        });
    });

    // Listen for status updates from background.js
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'status_update') {
            updateButtonStates(message.isRunning, message.isPaused);
        }
    });
});