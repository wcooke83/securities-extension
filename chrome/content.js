// Content script for Chrome extension
// This script is injected into the page and interacts with the DOM and background script
// It handles scraping announcements, sending messages to the background script, and managing the state of the scraping process

const allCategories = [
    'ErrorLogs', 'WarningLogs', 'GeneralLogs', 'DebugLogs', 'ScrapeLogs', 'ServerLogs', 
    'TickerCompletionLogs', 'DataLogs', 'ErrorHandlingLogs', 'AnnouncementLogs', 'TabLogs', 
    'PortLogs', 'ConfigLogs', 'RetryLogs', 'ActionLogs', 'PerfLogs', 'prefixDateTime', 
    'DownloadLogs', 'NotificationLogs',
    'prefixTickerSymbol', 'prefixTabId', 'prefixPortId', 'prefixPortName'
];

let loggingPrefs = {};
let currentState = 'resumed';
let messageId = 0;
let port;
const callbacks = new Map();

const tabId = window.tabId;
const tickerSymbol = window.location.pathname.split('/').pop().split('.').shift().toUpperCase();

if (typeof window.tabId === 'undefined') {
    console.log('tabId not set in window object', { tickerSymbol });
}

class PauseManager {
    constructor(tabId) {
        this.isPaused = false;
        this.currentState = 'resumed';
        this.tabId = tabId;
        this.pausePromise = null;
        this.pauseResolve = null;
    }

    async setPaused(newPausedState) {
        if (this.isPaused === newPausedState) return;

        this.isPaused = newPausedState;
        log(['DebugLogs'], `setPaused: isPaused set to ${this.isPaused}`);

        if (this.isPaused && this.currentState === 'resumed') {
            this.currentState = 'paused';
            log(['DebugLogs'], 'Transitioning to paused state');
            await updateTabStatus('Paused');
            sendMessage({ action: 'pause_tab', tabId: this.tabId });
            this.pausePromise = new Promise((resolve) => {
                this.pauseResolve = resolve;
            });
            log(['DebugLogs'], 'Created new pausePromise');
        } else if (!this.isPaused && this.currentState === 'paused') {
            this.currentState = 'resumed';
            log(['DebugLogs'], 'Transitioning to resumed state');
            await updateTabStatus('Resuming');
            sendMessage({ action: 'resume_tab', tabId: this.tabId });
            if (this.pauseResolve) {
                this.pauseResolve();
                this.pausePromise = null;
                this.pauseResolve = null;
                log(['DebugLogs'], 'Resolved pausePromise');
            }
        }
    }

    async checkPause() {
        log(['DebugLogs'], `checkPause called, isPaused: ${this.isPaused}`);
        return this.isPaused ? this.pausePromise : Promise.resolve();
    }

    async pause() {
        log(['DebugLogs'], 'pause called');
        await this.setPaused(true);
        return this.checkPause();
    }

    async unPause() {
        log(['DebugLogs'], 'unPause called');
        await this.setPaused(false);
        return this.checkPause();
    }
}

// Usage example in content.js
const pauseManager = new PauseManager(tabId);

// Log function that checks logging preferences

function log(categories, message, context = {}) {
    if (categories.some(cat => loggingPrefs[cat])) {
        let pre_message = 'C';
        if (loggingPrefs['prefixDateTime']) pre_message += `[${getClientLocalDateTime()}]`;
        if (loggingPrefs['prefixTickerSymbol'] && context.tickerSymbol) pre_message += `[${context.tickerSymbol}]`;
        if (loggingPrefs['prefixTabId'] && context.tabId) pre_message += `[${context.tabId}]`;
        if (loggingPrefs['prefixPortName'] && context.portName) pre_message += `[${context.portName}]`;
        pre_message += pre_message ? ' ' : '';

        // Determine log method (default: console.log)
        const logMethod = categories.includes('ErrorLogs') ? console.error :
                         categories.includes('WarningLogs') ? console.warn :
                         console.log;

        // Handle objects & arrays
        if (typeof message === 'object' && message !== null) {
            let firstElement = '';
            let remainingElements;

            // Arrays: Extract & trim first string element
            if (Array.isArray(message)) {
                if (message.length > 0 && typeof message[0] === 'string') {
                    firstElement = message[0].trim();
                    remainingElements = message.slice(1);
                } else {
                    remainingElements = message;
                }
            }
            // Objects: Extract & trim first string property
            else {
                const keys = Object.keys(message);
                if (keys.length > 0 && typeof message[keys[0]] === 'string') {
                    firstElement = message[keys[0]].trim();
                    remainingElements = { ...message };
                    delete remainingElements[keys[0]];
                } else {
                    remainingElements = message;
                }
            }

            // Combine pre_message + first trimmed element (if any)
            const combinedMessage = pre_message + firstElement;
            
            // Log with remaining elements as separate args
            if (firstElement) {
                logMethod(combinedMessage, ...(Array.isArray(remainingElements) ? remainingElements : [remainingElements]));
            } else {
                logMethod(pre_message, ...(Array.isArray(remainingElements) ? remainingElements : [remainingElements]));
            }
        }
        // Handle primitives (strings, numbers, etc.)
        else {
            logMethod(`${pre_message}${message}`);
        }
    }
}

function getClientLocalDateTime() {
    const now = new Date();
    return now.toLocaleString(); // returns in local format based on client's browser settings
}

async function checkTabClosedByUser(tabId) {
    try {
        await chrome.tabs.get(tabId);
        return false; // Tab exists, not closed
    } catch (error) {
        return true; // Tab not found, likely closed by user
    }
}

// function sendMessage(message, callback, timeout = 30000) {
//     const id = messageId++;
//     const fullMessage = { ...message, id, tickerSymbol };
//     log(['DebugLogs', 'PortLogs'], [`Content script sending message (tab ${tabId}, ID: ${id}):`, fullMessage], { tabId, tickerSymbol });

//     return new Promise((resolve, reject) => {
//         let timeoutId;
//         if (callback) {
//             callbacks.set(id, (response) => {
//                 clearTimeout(timeoutId);
//                 log(['DebugLogs', 'PortLogs'], `Received response for message ID ${id}: ${JSON.stringify(response)}`, { tabId, tickerSymbol });
//                 resolve(response);
//             });
//         } else {
//             resolve();
//         }

//         try {
//             if (!port) throw new Error('Port not initialized');
//             port.postMessage(fullMessage);
//         } catch (error) {
//             clearTimeout(timeoutId);
//             callbacks.delete(id);
//             log(['ErrorLogs', 'PortLogs'], `Failed to send message (ID: ${id}): ${error.message}`, { tabId, tickerSymbol });
//             reject(error);
//         }

//         if (callback) {
//             timeoutId = setTimeout(() => {
//                 callbacks.delete(id);
//                 log(['ErrorLogs', 'PortLogs'], `Message (ID: ${id}) timed out after ${timeout}ms`, { tabId, tickerSymbol });
//                 reject(new Error(`Message (ID: ${id}) timed out after ${timeout}ms`));
//             }, timeout);
//         }
//     });
// }

async function sendMessage(message, callback) {
    const id = messageId++;
    if (callback) callbacks.set(id, callback);
    const fullMessage = { ...message, id, tickerSymbol };
    log(['DebugLogs'], [`${tickerSymbol} - Content script sending message (tab ${tabId}, ID: ${id}):`, fullMessage]);
    port.postMessage(fullMessage);
}

async function updateTabStatus(status) {
    await sendMessage({ action: 'update_tab_status', status });
}

async function updateTabTicker(ticker) {
    await sendMessage({ action: 'update_tab_ticker', ticker });
    await updateTabStatus('Starting');
}

function checkPage(tickerSymbol, callback) {
    const MAX_ATTEMPTS = 30;
    let attempts = 0;

    log(['DebugLogs'], `${tickerSymbol} - Checking page for tab ${tabId}`);

    const title = document.title;
    const h1Element = document.querySelector('h1');
    const h1 = h1Element ? h1Element.textContent : '';

    log(['DebugLogs'], `${tickerSymbol} - Title: ${title}`);
    log(['DebugLogs'], `${tickerSymbol} - H1: ${h1}`);

    // Check for 404 in H1 and skip if found
    if (h1.includes('404')) {
        log(['DebugLogs'], `${tickerSymbol} - H1 contains '404'. Calling skip404().`);
        callback('404');
        return;
    }

    function verifyTitle() {
        const res = title.includes(`ASX:${tickerSymbol.toUpperCase()}`);
        if (res) {
            log(['DebugLogs'], `${tickerSymbol} - Title verified`);
        }
        log(['DebugLogs'], `${tickerSymbol} - Title verification result: ${res}`);
        return res;
    }

    function verifyH1() {
        const res = h1.includes(`(${tickerSymbol.toUpperCase()})`);
        if (res) {
            log(['DebugLogs'], `${tickerSymbol} - H1 verified`);
        }
        log(['DebugLogs'], `${tickerSymbol} - H1 verification result: ${res}`);
        return res;
    }

    if (verifyTitle() || verifyH1()) {
        callback('ticker');
        return;
    }

    const titleElement = document.querySelector('title');
    if (!titleElement) {
        callback(false);
        return;
    }

    const observer = new MutationObserver(() => {
        attempts++;
        setTimeout(() => {
            const h1Updated = document.querySelector('h1');
            const newH1 = h1Updated ? h1Updated.textContent : '';

            // Re-check for 404 on mutations
            if (newH1.includes('404')) {
                log(['DebugLogs'], `${tickerSymbol} - H1 now contains '404'. Calling skip404().`);
                observer.disconnect();
                callback('404');
                return;
            }

            if (verifyTitle() || verifyH1()) {
                observer.disconnect();
                callback('ticker');
            } else if (attempts >= MAX_ATTEMPTS) {
                observer.disconnect();
                callback(false);
            }
        }, 1000);
    });

    observer.observe(titleElement, { childList: true, characterData: true, subtree: true });
}

// Define getConfigAsync with retries
async function getConfigAsync(maxRetries = 3, retryDelay = 5000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await new Promise((resolve, reject) => {
                sendMessage({ action: 'get_config' }, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(response);
                    }
                });
            });

            if (response && response.config) {
                popupConfig = response.config;
                return popupConfig;
            } else {
                throw new Error('Invalid response: config not found');
            }
        } catch (error) {
            log(['WarningLogs'], `Attempt ${attempt} failed: ${error.message}`, { tabId, tickerSymbol });
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            } else {
                log(['ErrorLogs'], `Failed to get config after ${maxRetries} attempts`, { tabId, tickerSymbol });
                return {};
            }
        }
    }
}

function loadLoggingPrefs() {
    chrome.storage.local.get('loggingPreferences', (data) => {
        loggingPrefs = data.loggingPreferences || {};
        allCategories.forEach(cat => {
            if (!(cat in loggingPrefs)) loggingPrefs[cat] = true;
        });
    });
}

loadLoggingPrefs();

// Listen for changes in logging preferences
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'loggingPreferences' in changes) {
        console.log('chrome.storage.onChanged.addListener changes', changes);
        loggingPrefs = changes.loggingPreferences.newValue;
    }
});

// Main execution block
try {
    // Define constants and variables after logging is ready
    const usedFilenames = [];
    const successfulPages = new Set();
    let failedPages = [];
    let allAnnouncements = [];
    const apiSaveFetchedAnnouncementMaxRetries = 5;
    const apiSaveFetchedAnnouncementSendBatchSize = 500;
    const apiSaveFetchedAnnouncementSendRetryTime = 30000;
    const apiSaveFetchedAnnouncementFailPause = false;
    const apiFetchAnnouncementMaxRetries = 6;
    const apiFetchAnnouncementRetryTime = 60000;
    const apiFetchAnnouncementFailPause = false;
    const apiFetchAnnouncementTimeout = 30000;
    const apiFetchAnnouncementTimeoutRetryTime = 20000;
    const apiFetchAnnouncementTimeoutMaxRetries = 6;
    const apiFetchAnnouncementTimeoutFailPause = false;
    const scrapedAnnouncementScrapeMaxRetries = 5;
    const scrapedAnnouncementSendBatchMaxRetries = 5;
    const scrapedAnnouncementSendBatchRetryTime = 5000;
    const scrapedAnnouncementSendBatchSize = 100;
    let pageCounter = { value: 1 };
    let isFinished = false;
    let isScraping = false;
    let totalScrapeableAnnouncements = 0;
    let totalAPIFetchedAnnouncements = 0;
    let popupConfig = {};

    const announcementsContainer = document.querySelector('[id$="-all-announcements"]');
    const tableContainer = announcementsContainer?.querySelector('#app-table');

    // Define onDOMReady as an async function
    async function onDOMReady() {
        log(['GeneralLogs', 'TabLogs'], 'Content script loaded for tab', { tabId, tickerSymbol });

        // Connect to the background script
        port = chrome.runtime.connect({ name: `content-${tabId}` });
        log(['PortLogs', 'TabLogs'], 'Port connected for tab', { tabId, tickerSymbol });

        // Set up the message listener before fetching config
        port.onMessage.addListener(async (msg) => {
            log(['DebugLogs', 'PortLogs'], `Content script received message (tab ${tabId}): ${JSON.stringify(msg)}`, { tabId, tickerSymbol });
            if (msg.id !== undefined && callbacks.has(msg.id)) {
                const cb = callbacks.get(msg.id);
                callbacks.delete(msg.id);
                log(['DebugLogs'], `Executing callback for message ID ${msg.id} (tab ${tabId})`, { tabId, tickerSymbol });
                cb(msg);
            } else if (msg.action) {
                switch (msg.action) {
                    case 'pause_tab':
                        await pauseManager.pause();
                        break;
                    case 'resume_tab':
                        await pauseManager.unPause();
                        break;
                    case 'ping':
                        sendMessage({ action: 'pong' });
                        break;
                    case 'check_page':
                        checkPage(msg.tickerSymbol, (success) => {

                            if (success === 'ticker') {
                                    
                                sendMessage({ action: 'page_result', tabId, success: true });
                                startScraping();
                            } else if (success === '404' && !window.isAdHoc) {

                                sendMessage({ action: 'next_ticker' });
                            } else if (!success) {

                                sendMessage({ action: 'next_ticker' });
                            }
                        });
                        break;
                    case 'pong':
                        break;
                    default:
                        log(['WarningLogs'], `Unhandled message action (tab ${tabId}): ${msg.action}`, { tabId, tickerSymbol });
                }
            }
            return true;
        });

        // Fetch configuration and wait for it
        popupConfig = await getConfigAsync();
        sendMessage({ action: 'content_ready', tabId });

        async function wait(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        async function waitForBackground() {
            try {
                const response = await sendMessage({ action: 'ping' }, (response) => response);
                return response && response.action === 'pong';
            } catch (error) {
                log(['ErrorLogs'], `Background ping failed: ${error.message}`, { tabId, tickerSymbol });
                return false;
            }
        }

        async function getExistingFiles(tickerSymbol) {
            try {
                const response = await sendMessage({ action: 'get_existing_files', tickerSymbol }, (res) => res);
                return response?.files || [];
            } catch (error) {
                log(['ErrorLogs'], `Failed to get existing files: ${error.message}`, { tabId, tickerSymbol });
                return [];
            }
        }

        async function fetchFileSize(pdfLink) {
            try {
                const response = await fetch(pdfLink, { method: 'HEAD' });
                const fileSize = parseInt(response.headers.get('content-length'), 10) || 0;
                log(['TabLogs', 'DataLogs'], `Fetched file size for ${pdfLink}: ${fileSize} bytes`, { tabId, tickerSymbol });
                return fileSize;
            } catch (error) {
                log(['ErrorLogs'], `Error fetching file size for ${pdfLink}: ${error}`, { tabId, tickerSymbol });
                return 0;
            }
        }

        async function fetchFileSizeWithTimeout(pdfLink, timeout = 5000) {
            return Promise.race([
                fetchFileSize(pdfLink),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
            ]).catch(error => {
                log(['WarningLogs'], `Failed to fetch file size for ${pdfLink}: ${error.message}`, { tabId, tickerSymbol });
                return 0;
            });
        }

        async function retryOperation(operation, maxRetries, retryDelay, failPause) {
            let attempt = 1;
            while (attempt <= maxRetries) {
                try {
                    const success = await operation();
                    if (success) log(['TabLogs', 'DataLogs'], `Operation Result Success: ${attempt}/${maxRetries},`, { tabId, tickerSymbol });
                    if (success) return true;
                    if (attempt < maxRetries) {
                        await wait(retryDelay);
                    } else {
                        log(['ErrorLogs'], `Max retries reached, failPause: ${failPause}`, { tabId, tickerSymbol });
                        if (failPause) await pauseManager.pause();
                        return false;
                    }
                    attempt++;
                } catch (err) {
                    log(['ErrorLogs'], `Error in operation attempt: ${attempt}/${maxRetries}, ${err.message}`, { tabId, tickerSymbol });
                    if (attempt < maxRetries) {
                        await wait(retryDelay);
                    } else {
                        log(['ErrorLogs'], `max retries reached, failPause: ${failPause}`, { tabId, tickerSymbol });
                        if (failPause) await pauseManager.pause();
                        return false;
                    }
                    attempt++;
                }
            }
            return false;
        }

        async function sendToBackground(action, dataObjectKey, data) {
            const operation = () => new Promise((resolve) => {
                sendMessage({ action, [dataObjectKey]: data }, (res) => {
                    
                    log(['TabLogs', 'DataLogs'], `this is here.. ${res?.success}`, { tabId, tickerSymbol });
                    resolve(res?.success || false);
                });
            });
            return retryOperation(operation, apiSaveFetchedAnnouncementMaxRetries, apiSaveFetchedAnnouncementSendRetryTime, apiSaveFetchedAnnouncementFailPause);
        }

        function dedupeAnnouncements(announcements, tickerSymbol) {
            if (!Array.isArray(announcements)) {
                log(['WarningLogs'], `Invalid announcements input: expected array, got ${typeof announcements}`, { tabId, tickerSymbol });
                return [];
            }
            const seen = new Set();
            return announcements.filter(announcement => {
                const key = announcement.pdfLink || announcement.filename || JSON.stringify(announcement);
                if (seen.has(key)) {
                    log(['GeneralLogs', 'TabLogs', 'ScrapeLogs'], `Skipping duplicate announcement: ${key}`, { tabId, tickerSymbol });
                    return false;
                }
                seen.add(key);
                return true;
            });
        }

        function generateUniqueFilename(tickerSymbol, rawDate, sanitizedHeading, usedFilenames) {
            const [day, month, year] = rawDate.split('/');
            const formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
            const baseName = `${tickerSymbol}-${formattedDate}-${sanitizedHeading}`;
            let filename = `${baseName}.pdf`;
            let counter = 0;

            while (usedFilenames.includes(filename)) {
                counter++;
                filename = `${baseName}-${counter}.pdf`;
            }
            usedFilenames.push(filename);
            return filename;
        }

        function scrapeTransactions() {
            log(['ScrapeLogs', 'TabLogs'], `Starting to scrape transactions, tab: ${tabId}, tickerSymbol: ${tickerSymbol}`, { tabId, tickerSymbol });
            const transactionsRoot = document.querySelector('#directors-transactions-root');
            if (!transactionsRoot) return [];
            const rows = transactionsRoot.querySelectorAll('table tbody tr');
            const transactions = Array.from(rows).map(row => {
                const cols = row.querySelectorAll('td');
                return {
                    date: cols[0]?.textContent.trim(),
                    director: cols[1]?.textContent.trim(),
                    type: cols[2]?.textContent.trim(),
                    quantity: cols[3]?.textContent.trim(),
                    price: cols[4]?.textContent.trim(),
                    value: cols[5]?.textContent.trim()
                };
            });
            log(['ScrapeLogs', 'TabLogs'], `Scraped ${transactions.length} transactions, tab: ${tabId}, tickerSymbol: ${tickerSymbol}`, { tabId, tickerSymbol });
            return transactions;
        }

        function scrapeDirectorInterests() {
            log(['ScrapeLogs', 'TabLogs'], 'Starting to scrape director interests, tab:', { tabId, tickerSymbol });
            const interestsRoot = document.querySelector('#directors-interests-root');
            if (!interestsRoot) return [];
            const rows = interestsRoot.querySelectorAll('table tbody tr');
            const directorInterests = Array.from(rows).map(row => {
                const cols = row.querySelectorAll('td');
                return {
                    director: cols[0].textContent.trim(),
                    lastNotice: cols[1].textContent.trim(),
                    directShares: cols[2].textContent.trim().replace(/[^0-9]/g, '') || '0',
                    indirectShares: cols[3].textContent.trim().replace(/[^0-9]/g, '') || '0',
                    options: cols[4].textContent.trim().replace(/[^0-9]/g, '') || '0',
                    convertibles: cols[5].textContent.trim().replace(/[^0-9]/g, '') || '0'
                };
            });
            log(['ScrapeLogs', 'TabLogs'], `Scraped ${directorInterests.length} director interests, tab: ${tabId}, tickerSymbol: ${tickerSymbol}`, { tabId, tickerSymbol });
            return directorInterests;
        }

        function scrapeHistoricalDownloadUrl() {
            const link = document.querySelector('a.btn[href*="download-historical-data"]');
            const url = link ? link.href : null;
            log(['ScrapeLogs', 'TabLogs'], `Scraping historical download URL, tab: ${tabId}, URL: ${url}`, { tabId, tickerSymbol });
            return url;
        }

        function scrapeCompanyOverview() {
            log(['ScrapeLogs', 'TabLogs'], 'Scraping company overview', { tabId, tickerSymbol });
            const overview = {
                marketCap: null,
                sector: null,
                eps: null,
                dps: null,
                bookValuePerShare: null,
                sharesIssued: null
            };

            const labelMappings = {
                'market cap': { key: 'marketCap', cleaner: (v) => v.replace(/[^0-9]/g, '') },
                'sector': { key: 'sector', cleaner: (v) => v },
                'eps': { key: 'eps', cleaner: (v) => v.replace(/[^0-9.-]/g, '') },
                'dps': { key: 'dps', cleaner: (v) => v.replace(/[^0-9.]/g, '') },
                'book value per share': { key: 'bookValuePerShare', cleaner: (v) => v.replace(/[^0-9.]/g, '') },
                'shares issued': { key: 'sharesIssued', cleaner: (v) => v.replace(/[^0-9]/g, '') }
            };

            const processRows = (rows) => {
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 2) continue;
                    let label = cells[0].querySelector('span.inline-block')?.textContent.trim().toLowerCase() ||
                                cells[0].textContent.trim().toLowerCase();
                    const value = cells[1].textContent.trim();
                    const mapping = labelMappings[label];
                    if (mapping) {
                        overview[mapping.key] = mapping.cleaner(value);
                    }
                }
            };

            processRows(document.querySelectorAll('table.mi-table[data-company-market-rank-target="table"] tbody tr'));
            processRows(document.querySelectorAll('div.sm\\:flex.flex-wrap table.mi-table tbody tr'));

            log(['ScrapeLogs', 'TabLogs'], `Scraped company overview: ${JSON.stringify(overview)}`, { tabId, tickerSymbol });
            return overview;
        }

        function scrapeCompanyDetails() {
            log(['ScrapeLogs', 'TabLogs'], 'Scraping company details (tab', { tabId, tickerSymbol });
            const details = {
                website: null,
                auditor: null,
                dateListed: null
            };

            const labelMappings = {
                'website': {
                    key: 'website',
                    cleaner: (cells) => {
                        const link = cells[1].querySelector('a');
                        const raw = link ? link.href : cells[1].textContent.trim();
                        return raw ? raw.split('?')[0] : null;
                    }
                },
                'auditor': { 
                    key: 'auditor', 
                    cleaner: (cells) => cells[1].textContent.trim() 
                },
                'date listed': { 
                    key: 'dateListed', 
                    cleaner: (cells) => cells[1].textContent.trim() 
                }
            };

            const rows = document.querySelectorAll('.content-box table.mi-table tr');
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length < 2) continue;
                const label = cells[0].textContent.trim().toLowerCase();
                const mapping = labelMappings[label];
                if (mapping) details[mapping.key] = mapping.cleaner(cells);
            }

            log(['ScrapeLogs', 'TabLogs'], `Scraped company details (tab ${JSON.stringify(details)}`, { tabId, tickerSymbol });
            return details;
        }

        async function scrapeAnnouncementsFromCurrentPage() {
            try {
                updateTabStatus("Scrape Announcements");
                let table = tableContainer.querySelector('table');
                if (!table) {
                    log(['ScrapeLogs'], `No table found on page ${pageCounter.value}, observing tableContainer`, { tabId, tickerSymbol });
                    updateTabStatus("Observe Announcements Table");
                    table = await new Promise((resolve) => {
                        const observer = new MutationObserver(() => {
                            const foundTable = tableContainer.querySelector('table');
                            if (foundTable) {
                                observer.disconnect();
                                resolve(foundTable);
                            }
                        });
                        observer.observe(tableContainer, { childList: true, subtree: true });
                        setTimeout(() => {
                            observer.disconnect();
                            resolve(null);
                        }, 10000);
                    });
                    if (!table) {
                        log(['WarningLogs'], `Timeout waiting for table on page ${pageCounter.value}`, { tabId, tickerSymbol });
                        return [];
                    }
                }

                await wait(500);
                const rows = table.querySelectorAll('tbody tr');
                if (!rows.length) {
                    log(['WarningLogs', 'ScrapeLogs'], `No rows found on page ${pageCounter.value}`, { tabId, tickerSymbol });
                    return [];
                }

                const parentContainer = tableContainer.parentElement;
                const activeButton = parentContainer.querySelector('button.btn.ghost.active');
                const activeTabNumber = activeButton ? parseInt(activeButton.getAttribute('data-pagination'), 10) : pageCounter.value;
                updateTabStatus(`Scrape Announcements Page: ${activeTabNumber}`);
                log(['ScrapeLogs'], `Active page ${activeTabNumber}`, { tabId, tickerSymbol });

                const downloadAnnouncements = popupConfig.downloadPdfs;
                const existingFiles = await getExistingFiles(tickerSymbol);
                let announcements = [];

                const fileSizePromises = [];
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 5) continue;

                    const rawDate = cells[0].textContent.trim();
                    const rawTime = cells[3].textContent.trim();
                    let rawHeading = cells[1].textContent.trim();
                    const priceSensitive = rawHeading.endsWith(' $');
                    const cleanedHeading = priceSensitive ? rawHeading.slice(0, -2) : rawHeading;
                    const sanitizedHeading = cleanedHeading.replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, 50);
                    const pdfLink = cells[4].querySelector('a.announcement-pdf-link')?.href || null;

                    const filename = generateUniqueFilename(tickerSymbol, rawDate, sanitizedHeading, usedFilenames);
                    let fileSize = 0;
                    if (downloadAnnouncements && pdfLink) {
                        const promise = fetchFileSizeWithTimeout(pdfLink).then(size => {
                            fileSize = size;
                        });
                        fileSizePromises.push(promise);
                    }

                    if (existingFiles.some(f => f.filename === filename && f.fileSize === fileSize)) {
                        log(['GeneralLogs'], `Skipping ${filename} (${fileSize} bytes)`, { tabId, tickerSymbol });
                        continue;
                    }

                    announcements.push({
                        filename,
                        date: rawDate,
                        heading: rawHeading,
                        pages: parseInt(cells[2].textContent.trim()) || 0,
                        priceSensitive,
                        time: rawTime,
                        pdfLink,
                        fileSize,
                        downloaded: downloadAnnouncements
                    });
                }

                await Promise.all(fileSizePromises);
                announcements = dedupeAnnouncements(announcements, tickerSymbol);

                if (announcements.length > 0) {
                    const buttons = parentContainer.querySelectorAll('button.btn.ghost');
                    const highestVisiblePage = buttons.length ? parseInt(buttons[buttons.length - 1].getAttribute('data-pagination'), 10) : pageCounter.value;
                    if (highestVisiblePage > pageCounter.value && announcements.length === 10) {
                        log(['ScrapeLogs'], `Page ${pageCounter.value} not last, marking successful`, { tabId, tickerSymbol });
                        successfulPages.add(activeTabNumber);
                    } else if (highestVisiblePage === pageCounter.value && announcements.length === rows.length) {
                        log(['ScrapeLogs'], `Last page ${pageCounter.value}, marking successful`, { tabId, tickerSymbol });
                        successfulPages.add(activeTabNumber);
                    }
                }
                log(['ScrapeLogs'], `Scraped ${announcements.length} announcements from page ${pageCounter.value}`, { tabId, tickerSymbol });

                await sendToBackground('save_scraped_announcement_batch', 'batch', announcements);

            } catch (error) {
                log(['ErrorLogs', 'ScrapeLogs'], `Error scraping announcements on page ${pageCounter.value}: ${error}`, { tabId, tickerSymbol });
                return [];
            }
        }

        async function proceedToScrapeNextPage() {
            const nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
            if (!nextButton || isFinished) {
                log(['ScrapeLogs'], 'No more pages to scrape', { tabId, tickerSymbol });
                await proceedWithFailedScrapedPages();
                return;
            }

            const currentPage = getActivePage();
            log(['ScrapeLogs'], `Current page: ${currentPage}, clicking next`, { tabId, tickerSymbol });
            nextButton.click();

            try {
                const newPage = await waitForPageChange(currentPage);
                log(['ScrapeLogs'], `Page changed to ${newPage}`, { tabId, tickerSymbol });
                pageCounter.value = newPage;
                updateTabStatus(`Scrape Page: ${newPage}`);
                const announcements = await scrapeAnnouncementsFromCurrentPage();
                allAnnouncements.push(...announcements);
                if (allAnnouncements.length >= scrapedAnnouncementSendBatchSize) {
                    await sendToBackground('save_scraped_announcement_batch', 'batch', allAnnouncements.splice(0, scrapedAnnouncementSendBatchSize));
                }
                await proceedToScrapeNextPage();
            } catch (error) {
                log(['ErrorLogs', 'ScrapeLogs'], `Failed to load next page: ${error.message}`, { tabId, tickerSymbol });
                failedPages.push(currentPage + 1);
                await proceedToScrapeNextPage();
            }
        }

        async function proceedWithFailedScrapedPages() {
            if (isFinished) return;

            const buttons = Array.from(tableContainer.querySelectorAll('button.btn.ghost[data-position]:not([style*="display: none"]):not(#dynamic-button)'));
            let totalPages = 1;
            if (buttons.length > 0) {
                totalPages = parseInt(buttons[buttons.length - 1].getAttribute('data-position'), 10) || 1;
            }
            log(['ScrapeLogs'], `Total pages: ${totalPages}`, { tabId, tickerSymbol });

            const allPages = Array.from({ length: totalPages }, (_, i) => i + 1);
            failedPages = allPages.filter(page => !successfulPages.has(page));
            log(['ScrapeLogs'], `Failed pages: ${failedPages.join(', ')}`, { tabId, tickerSymbol });

            if (failedPages.length > 0) {
                await retryFailedScrapedPages();
            }

            if (!isFinished && allAnnouncements.length > 0) {
                await sendToBackground('save_scraped_announcement_batch', 'batch', allAnnouncements.splice(0, allAnnouncements.length));
            }
        }

        async function retryFailedScrapedPages() {
            const MAX_RETRIES = 3;
            const retryCounts = new Map();

            while (failedPages.length > 0 && !isFinished) {
                const failedPage = failedPages.shift();
                log(['RetryLogs', 'ScrapeLogs'], `Retrying failed page ${failedPage}`, { tabId, tickerSymbol });

                const retries = (retryCounts.get(failedPage) || 0) + 1;
                if (retries > MAX_RETRIES) {
                    log(['ErrorLogs', 'ScrapeLogs'], `Page ${failedPage} exceeded retry limit (${MAX_RETRIES})`, { tabId, tickerSymbol });
                    continue;
                }
                retryCounts.set(failedPage, retries);

                try {
                    await retryPage(failedPage);
                } catch (error) {
                    log(['ErrorLogs', 'ScrapeLogs'], `Failed to retry page ${failedPage} (attempt ${retries}): ${error}`, { tabId, tickerSymbol });
                    failedPages.push(failedPage);
                } finally {
                    document.querySelector('#dynamic-button')?.remove();
                }
            }

            async function retryPage(targetPage) {
                const currentPage = getActivePage();
                if (currentPage === targetPage) {
                    log(['ScrapeLogs'], `Already on page ${targetPage}, scraping...`, { tabId, tickerSymbol });
                    return scrapeAnnouncementsFromCurrentPage();
                }

                const button = announcementsContainer.querySelector(`button.btn.ghost[data-pagination="${targetPage}"]`);
                if (!button) {
                    throw new Error(`Button for page ${targetPage} not found`);
                }

                button.click();
                await waitForPageChange(currentPage);
                log(['ScrapeLogs'], `Page changed to ${targetPage}`, { tabId, tickerSymbol });
                return scrapeAnnouncementsFromCurrentPage();
            }
        }

        async function waitForPageChange(currentPage, timeout = 15000) {
            return new Promise((resolve, reject) => {
                let timer;
                const observer = new MutationObserver(() => {
                    const newPage = getActivePage();
                    if (newPage !== currentPage) {
                        clearTimeout(timer);
                        observer.disconnect();
                        resolve(newPage);
                    }
                });
                observer.observe(tableContainer, { childList: true, subtree: true });
                timer = setTimeout(() => {
                    observer.disconnect();
                    reject(new Error(`Timeout waiting for page change from ${currentPage}`));
                }, timeout);
            });
        }

        function getActivePage() {
            const btn = announcementsContainer.querySelector('button.btn.ghost.active');
            return Number(btn?.dataset.pagination);
        }

        async function calculateTotalScrapeableAnnouncements() {
            const lastButton = announcementsContainer.querySelector('button.btn.ghost[data-pagination="last"]');
            if (!lastButton) return 0;

            const currentPage = getActivePage();
            lastButton.click();
            await waitForPageChange(currentPage);
            const lastPage = getActivePage();
            const itemsOnLastPage = tableContainer.querySelectorAll('tbody tr').length;
            const total = ((lastPage - 1) * 10) + itemsOnLastPage;
            const firstButton = announcementsContainer.querySelector('button.btn.ghost[data-pagination="first"]');
            firstButton.click();
            await waitForPageChange(lastPage);
            return total;
        }

        async function scrapeAnnouncementsViaDom() {
            if (!tableContainer) {
                log(['WarningLogs', 'ScrapeLogs'], 'No announcements table found', { tabId, tickerSymbol });
                return;
            }

            allAnnouncements = await scrapeAnnouncementsFromCurrentPage();
            log(['ScrapeLogs'], `Page ${pageCounter.value} scraped, found ${allAnnouncements.length} announcements`, { tabId, tickerSymbol });

            if (allAnnouncements.length > 0) {
                const nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
                if (!nextButton) {
                    await proceedWithFailedScrapedPages();
                } else {
                    await proceedToScrapeNextPage();
                }
            }
        }

        async function fetchAnnouncementsViaApi(tickerSymbol) {
            updateTabStatus("API Fetch Announcements");
            // const apiUrl = `https://data-api.marketindex.com.au/api/v1/announcements?codes=${tickerSymbol.slice(0, 3).toUpperCase()}%3AAUD%3AXASX&limit=1000000`;
            const apiUrl = `https://data-api.marketindex.com.au/api/v1/announcements?codes=${tickerSymbol.toUpperCase()}%3AAUD%3AXASX&limit=1000000`;
            log(['DebugLogs', 'ServerLogs', 'ScrapeLogs', 'AnnouncementLogs'], `Prepare to fetch announcements: ${apiUrl}`, { tabId, tickerSymbol });

            try {
                const announcements = await fetchApiData(apiUrl, tickerSymbol);
                log(['ServerLogs', 'DataLogs'], `Fetched ${announcements.length} announcements via API`, { tabId, tickerSymbol });
                return announcements;
            } catch (error) {
                log(['ErrorLogs', 'ServerLogs', 'AnnouncementLogs'], `Failed to fetch announcements: ${error.message}`, { tabId, tickerSymbol });
                if (apiFetchAnnouncementFailPause) {
                    updateTabStatus("Paused: API Fetch Failed");
                    await pauseManager.pause();
                }
            }
        }

        async function fetchApiData(url, tickerSymbol) {
            if (!apiFetchAnnouncementTimeout || !apiFetchAnnouncementTimeoutMaxRetries || 
                !apiFetchAnnouncementTimeoutRetryTime || !apiFetchAnnouncementMaxRetries || 
                !apiFetchAnnouncementRetryTime || apiFetchAnnouncementFailPause === undefined) {
                log(['ErrorLogs', 'ServerLogs'], 'Configuration variables missing or undefined', { tabId, tickerSymbol });
                throw new Error('Invalid configuration for API fetch');
            }

            let errorAttempt = 0;
            let timeoutAttempt = 0;
            const maxTotalAttempts = apiFetchAnnouncementMaxRetries + apiFetchAnnouncementTimeoutMaxRetries;

            for (let attempt = 1; attempt <= maxTotalAttempts; attempt++) {
                try {
                    log(['DebugLogs', 'ServerLogs', 'AnnouncementLogs'], `Fetching API data from ${url} (attempt ${attempt})`, { tabId, tickerSymbol });
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), apiFetchAnnouncementTimeout);

                    const response = await fetch(url, { signal: controller.signal });
                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        const isRetryable = response.status >= 500 || response.status === 429;
                        throw new Error(`HTTP error! Status: ${response.status}${isRetryable ? '' : ' (non-retryable)'}`);
                    }

                    const data = await response.json();
                    log(['DebugLogs', 'ServerLogs', 'AnnouncementLogs'], `Received API response: statusCode=${data.statusCode}`, { tabId, tickerSymbol });

                    if (data.statusCode !== 200) {
                        throw new Error(data.message || `API error: statusCode ${data.statusCode}`);
                    }

                    if (!data.data || !Array.isArray(data.data.announcements)) {
                        throw new Error('Invalid API response: missing or invalid announcements');
                    }

                    log(['ServerLogs', 'DataLogs', 'AnnouncementLogs'], `Successfully fetched ${data.data.announcements.length} announcements`, { tabId, tickerSymbol });
                    return data.data.announcements;
                } catch (error) {
                    if (error.name === 'AbortError') {
                        timeoutAttempt++;
                        log(['ErrorLogs', 'ServerLogs', 'AnnouncementLogs'], `API fetch timeout (timeout attempt ${timeoutAttempt}/${apiFetchAnnouncementTimeoutMaxRetries}): ${error.message}`, { tabId, tickerSymbol });
                        if (timeoutAttempt >= apiFetchAnnouncementTimeoutMaxRetries) {
                            if (apiFetchAnnouncementTimeoutFailPause) await pauseManager.pause();
                            throw new Error(`API fetch failed after ${timeoutAttempt} timeout attempts`);
                        }
                        await wait(apiFetchAnnouncementTimeoutRetryTime);
                    } else {
                        errorAttempt++;
                        const isRetryable = !error.message.includes('non-retryable');
                        log(['ErrorLogs', 'ServerLogs'], `API fetch error (error attempt ${errorAttempt}/${apiFetchAnnouncementMaxRetries}): ${error.message}`, { tabId, tickerSymbol });
                        if (errorAttempt >= apiFetchAnnouncementMaxRetries || !isRetryable) {
                            if (apiFetchAnnouncementFailPause) await pauseManager.pause();
                            throw new Error(`API fetch failed after ${errorAttempt} error attempts: ${error.message}`);
                        }
                        await wait(apiFetchAnnouncementRetryTime);
                    }
                }
            }
            throw new Error(`Failed to fetch API data after ${maxTotalAttempts} attempts`);
        }

        async function processAPIAnnouncements(announcements, tickerSymbol) {
            const batchSize = 500;
            let totalSent = 0;
            log(['ScrapeLogs', 'ServerLogs'], `Starting to process ${announcements.length} announcements in batches of ${batchSize}`, { tabId, tickerSymbol });
        
            for (let i = 0; i < announcements.length; i += batchSize) {
                console.log(`Processing batch starting at index ${i}`);
                const batch = announcements.slice(i, i + batchSize).map(ann => ({
                    ...ann,
                    tickerSymbol,
                    pdfLink: `https://www.marketindex.com.au/${ann.fileKey}`
                }));
                log(['ScrapeLogs', 'ServerLogs'], `Prepared batch ${Math.floor(i / batchSize) + 1} with ${batch.length} items`, { tabId, tickerSymbol });
                const success = await sendToBackground('save_api_announcement_batch', 'batch', batch);
                log(['ScrapeLogs', 'ServerLogs'], `Batch ${Math.floor(i / batchSize) + 1} sent, success: ${success}`, { tabId, tickerSymbol });
                if (success) {
                    totalSent += batch.length;
                    log(['ScrapeLogs', 'ServerLogs'], `Total sent so far: ${totalSent}`, { tabId, tickerSymbol });
                } else {
                    log(['WarningLogs'], `Failed to send batch starting at index ${i}`, { tabId, tickerSymbol });
                    break; // Exit on failure
                }
            }
            log(['ScrapeLogs', 'ServerLogs'], `Finished processing all batches, total sent: ${totalSent}`, { tabId, tickerSymbol });
            return totalSent;
        }

        async function sendFinalScrapedData(finalData, maxRetries = 3, retryDelay = 30000) {
            if (!finalData) return { success: false, error: 'No data to send' };
        
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const res = await new Promise((resolve, reject) => {
                        sendMessage({ action: 'scraping_complete', data: finalData }, (response) => {
                            resolve(response);
                        }, retryDelay);
                        setTimeout(() => {
                            reject(new Error(`Message timed out after ${retryDelay}ms`));
                        }, retryDelay);
                    });
                    if (!res?.success) {
                        throw new Error(`Send message failed: ${JSON.stringify(res)}`);
                    }
                    return res;
                } catch (error) {
                    log(['WarningLogs', 'ScrapeLogs'], `Attempt ${attempt} failed: ${error.message}. ${attempt < maxRetries ? `Retrying in ${retryDelay}ms...` : 'No more retries.'}`, { tabId, tickerSymbol });
                    if (attempt === maxRetries) {
                        log(['ErrorLogs', 'ScrapeLogs'], `Failed to send scraped data after ${maxRetries} attempts: ${error.message}`, { tabId, tickerSymbol });
                        return { success: false, error: `Failed after ${maxRetries} attempts: ${error.message}` };
                    }
                    await new Promise((resolve) => setTimeout(resolve, retryDelay));
                }
            }
        }

        async function sendScrapedDataWithUserRetry(finalData) {

            let res = await sendFinalScrapedData(finalData);
            while (!res?.success) {
                const shouldRetry = confirm('Failed to send scraped data. Would you like to retry?');
                if (!shouldRetry) break;
                res = await sendFinalScrapedData(finalData);
            }
            return res;
        }

        async function startScraping() {
            if (isScraping || !tickerSymbol) return;
            isScraping = true;

            updateTabTicker(tickerSymbol);
                
            popupConfig = await getConfigAsync();
            log(['TabLogs'], [`popupConfig`, popupConfig], { tabId, tickerSymbol });

            let APIFetched = null;
            if (popupConfig.apiFetchAnnouncements) {
                log(['ScrapeLogs', 'ServerLogs'], 'Fetching announcements via API', { tabId, tickerSymbol });
                const announcements = await fetchAnnouncementsViaApi(tickerSymbol);

                let  totalAPISentAnnouncements = 0;
                if (announcements?.length && announcements?.length > 0) {
                    log(['ScrapeLogs'], `API announcements fetched: ${announcements.length}, attempting to process...`, { tabId, tickerSymbol });
                    totalAPISentAnnouncements = await processAPIAnnouncements(announcements, tickerSymbol);
                }

                APIFetched = (announcements?.length === totalAPISentAnnouncements) && totalAPISentAnnouncements || 0; 
            }

            let DOMScraped = null;
            if (popupConfig.webScrapeAnnouncements) {
                log(['ScrapeLogs'], 'Scraping announcements from DOM', { tabId, tickerSymbol });
                await scrapeAnnouncementsViaDom();
                DOMScraped = await calculateTotalScrapeableAnnouncements();
            }

            const finalData = {
               transactions: scrapeTransactions(),
               director_interests: scrapeDirectorInterests(),
               historical_download_url: scrapeHistoricalDownloadUrl(),
               company_overview: scrapeCompanyOverview(),
               company_details: scrapeCompanyDetails(),
               dom_scrape_announcements: DOMScraped,
               api_fetch_announcements: APIFetched
            };

            log(['TabLogs'], [`finalData`, finalData], { tabId, tickerSymbol });
            
            if (isFinished) return;
            isFinished = true;

            console.log('+++finalData+++');
            console.log(finalData);
            const res = await sendScrapedDataWithUserRetry(finalData);
            log(['TabLogs'], `Completed, Success: ${res.success}`, { tabId, tickerSymbol });
            updateTabStatus(`Completed: ${res.success ? 'Success' : 'Fail'}`);
            isScraping = false;

            if (!window.isAdHoc) {
                sendMessage({ action: 'next_ticker' });
            }
        }

        // Uncomment to start scraping immediately
        // await startScraping();
    }

    if (document.readyState === 'interactive' || document.readyState === 'complete') {
        console.log(`${tickerSymbol} - DOM already loaded for tab ${tabId}`);
        onDOMReady();
    } else {
        document.addEventListener('DOMContentLoaded', onDOMReady);
    }

} catch (e) {
    log(['ErrorLogs', 'TabLogs'], `Content script crashed for tab ${window.tabId}: ${e.message}`, { tabId, tickerSymbol });
}