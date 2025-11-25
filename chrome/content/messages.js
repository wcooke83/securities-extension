import { tabId, tickerSymbol, isPaused, currentState } from './constants.js';

export function sendRuntimeMessage(message, callback, retries = 3, delayMs = 3000) {
    const messageWithMeta = {
        ...message,
        target: 'background',
        timestamp: Date.now(),
        source: 'content'
    };

    let attempt = 1;

    function trySend() {
        chrome.runtime.sendMessage(messageWithMeta, (response) => {
            if (chrome.runtime.lastError) {
                console.error(`[${tickerSymbol}] Error sending ${message.action} (attempt ${attempt}/${retries}): ${chrome.runtime.lastError.message}`);
                if (attempt < retries) {
                    attempt++;
                    setTimeout(trySend, delayMs);
                } else {
                    console.error(`[${tickerSymbol}] Failed to send ${message.action} after ${retries} attempts`);
                    callback?.({ success: false, error: chrome.runtime.lastError.message });
                }
                return;
            }
            console.log(`[${tickerSymbol}] Sent ${message.action}, response:`, response);
            callback?.(response);
        });
    }

    console.log(`[${tickerSymbol}] Sending ${message.action} to background`);
    trySend();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.tabId !== tabId) {
        sendResponse({ received: true, ignored: true });
        return true;
    }

    switch (message.action) {
        case 'pause_tab':
            if (!isPaused) {
                isPaused = true;
                currentState = 'paused';
                updateTabStatus("Paused");
                console.log(`⏸️ ${tickerSymbol} Pause command received`);
                chrome.runtime.sendMessage({ action: "tab_paused", tabId });
            }
            sendResponse({ success: true });
            break;
        case 'resume_tab':
            if (isPaused) {
                isPaused = false;
                currentState = 'resumed';
                updateTabStatus("Resuming");
                console.log(`▶️ ${tickerSymbol} Resume command received`);
                chrome.runtime.sendMessage({ action: "resume_tab", tabId });
            }
            sendResponse({ success: true });
            break;
        case 'ping':
            sendResponse({ status: 'pong' });
            break;
        default:
            sendResponse({ received: true, ignored: true });
    }
    return true;
});

function updateTabStatus(status) {
    sendRuntimeMessage({ action: 'update_tab_status', status }, null);
}