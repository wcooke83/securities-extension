import { isPaused, currentState, tabId, tickerSymbol } from './constants.js';
import { sendRuntimeMessage } from './messages.js';

export async function checkPause() {
    if (isPaused && currentState !== 'paused') {
        currentState = 'paused';
        updateTabStatus("Paused");
        console.log(`⏸️ ${tickerSymbol} Paused, Waiting to resume`);
        chrome.runtime.sendMessage({ action: "tab_paused", tabId });
        await checkResume();
    } else if (!isPaused && currentState !== 'resumed') {
        currentState = 'resumed';
        updateTabStatus("Resuming");
        console.log(`▶️ ${tickerSymbol} Un-Paused, Resumed`);
        chrome.runtime.sendMessage({ action: "resume_tab", tabId });
    }
}

export async function checkResume() {
    if (currentState !== 'paused') return;

    return new Promise((resolve) => {
        const listener = (message, sender, sendResponse) => {
            if (message.action === 'resume_tab' && message.tabId === tabId) {
                isPaused = false;
                currentState = 'resumed';
                updateTabStatus("Resuming");
                console.log(`▶️ ${tickerSymbol} Resume signal received`);
                chrome.runtime.sendMessage({ action: "resume_tab", tabId });
                chrome.runtime.onMessage.removeListener(listener);
                sendResponse({ received: true });
                resolve();
            }
        };
        chrome.runtime.onMessage.addListener(listener);
    });
}

function updateTabStatus(status) {
    sendRuntimeMessage({ action: 'update_tab_status', status }, null);
}