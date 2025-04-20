// content.js
// Variables that don't depend on DOM
const usedFilenames = [];
const successfulPages = new Set();
let failedPages = [];
let allAnnouncements = [];
const apiSaveFetchedAnnouncementMaxRetries = 5;
const apiSaveFetchedAnnouncementSendBatchSize = 500;
const apiSaveFetchedAnnouncementSendRetryTime = 30000;
const apiSaveFetchedAnnouncementFailPause = true;
const apiFetchAnnouncementMaxRetries = 5;
const apiFetchAnnouncementRetryTime = 30000;
const apiFetchAnnouncementFailPause = true;
const apiFetchAnnouncementTimeout = 30000;
const apiFetchAnnouncementTimeoutRetryTime = 10000;
const apiFetchAnnouncementTimeoutMaxRetries = 3;
const apiFetchAnnouncementTimeoutFailPause = true;
const scrapedAnnouncementScrapeMaxRetries = 5;
const scrapedAnnouncementSendBatchMaxRetries = 5;
const scrapedAnnouncementSendBatchRetryTime = 5000;
const scrapedAnnouncementSendBatchSize = 100;
let pageCounter = { value: 1 };
let isFinished = false;
let isPaused = false;
let isScraping = false;
let totalScrapeableAnnouncements = 0;
let totalAPIFetchedAnnouncements = 0;
let currentState = 'resumed';
const allPdfLinks = new Set();

const tabId = window.tabId;
const tickerSymbol = window.location.pathname.split('/').pop().split('.').shift().toLowerCase();
console.log(`${tickerSymbol} - Ticker symbol extracted for tab ${tabId}`);

const announcementsContainer = document.querySelector(`${toValidSelector(tickerSymbol.toLowerCase())}-all-announcements`);
const tableContainer = announcementsContainer?.querySelector('#app-table');

if (typeof window.tabId === 'undefined') {
    console.error('tabId not set in window object');
    throw new Error('tabId not set');
}

const port = chrome.runtime.connect({ name: `content-${tabId}` });
console.log(`${tickerSymbol} - Port connected for tab ${tabId}`);

let messageId = 0;
const callbacks = new Map();

function toValidSelector(str) {
    return str.replace(/[^a-zA-Z0-9-_]/g, '-');
}

async function checkPause() {
    return new Promise((resolve) => {
        function check() {
            if (!isPaused) resolve();
            else setTimeout(check, 100);
        }
        check();
    });
}

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForBackground() {
    return new Promise((resolve) => {
        sendMessage({ action: 'ping' }, (response) => {
            if (response && response.action === 'pong') resolve(true);
        });
    });
}

function sendMessage(message, callback) {
    const id = messageId++;
    if (callback) callbacks.set(id, callback);
    const fullMessage = { ...message, id, tickerSymbol };
    console.log(`${tickerSymbol} - Content script sending message (tab ${tabId}, ID: ${id}):`, fullMessage);
    port.postMessage(fullMessage);
}

async function getExistingFiles(tickerSymbol) {
    return new Promise((resolve) => {
        sendMessage({ action: 'get_existing_files', tickerSymbol }, (res) => {
            resolve(res?.files || []);
        });
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

async function fetchFileSize(pdfLink) {
    try {
        const response = await fetch(pdfLink, { method: 'HEAD' });
        const fileSize = parseInt(response.headers.get('content-length'), 10) || 0;
        console.log(`${tickerSymbol} - 📏 Fetched file size for ${pdfLink}: ${fileSize} bytes`);
        return fileSize;
    } catch (error) {
        console.error(`❌ Error fetching file size for ${pdfLink}:`, error);
        return 0;
    }
}

async function fetchFileSizeWithTimeout(pdfLink, timeout = 5000) {
    return Promise.race([
        fetchFileSize(pdfLink),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    ]).catch(error => {
        console.warn(`Failed to fetch file size for ${pdfLink}: ${error.message}`);
        return 0;
    });
}

function dedupeAnnouncements(announcements, tickerSymbol) {
    if (!Array.isArray(announcements)) {
        console.warn(`${tickerSymbol} - Invalid announcements input: expected array, got ${typeof announcements}`);
        return [];
    }
    const seen = new Set();
    return announcements.filter(announcement => {
        const key = announcement.pdfLink || announcement.filename || JSON.stringify(announcement);
        if (seen.has(key)) {
            console.log(`${tickerSymbol} - Skipping duplicate announcement: ${key}`);
            return false;
        }
        seen.add(key);
        return true;
    });
}

async function retryOperation(operation, maxRetries, retryDelay, failPause) {
    let attempt = 1;
    while (attempt <= maxRetries) {
        await checkPause();
        try {
            const success = await operation();
            if (success) return true;
            if (attempt < maxRetries) {
                await wait(retryDelay);
            } else {
                if (failPause) isPaused = true;
                return false;
            }
            attempt++;
        } catch (err) {
            console.error(`Error in operation (attempt ${attempt}): ${err.message}`);
            if (attempt < maxRetries) {
                await wait(retryDelay);
            } else {
                if (failPause) isPaused = true;
                return false;
            }
            attempt++;
        }
    }
    return false;
}

async function sendScrapedBatch(batch) {
    const operation = () => new Promise((resolve) => {
        sendMessage({ action: 'save_scraped_announcement_batch', batch }, (res) => {
            resolve(res?.success || false);
        });
    });
    return retryOperation(operation, scrapedAnnouncementSendBatchMaxRetries, scrapedAnnouncementSendBatchRetryTime, apiSaveFetchedAnnouncementFailPause);
}

try {
    function onDOMReady() {
        console.log(`${tickerSymbol} - Content script loaded for tab ${tabId}`);
        sendMessage({ action: 'content_ready', tabId });

        port.onDisconnect.addListener(() => {
            console.error(`Port disconnected for tab ${tabId}`);
        });

        port.onMessage.addListener((msg) => {
            console.log(`${tickerSymbol} - Content script received message (tab ${tabId}):`, msg);
            if (msg.id !== undefined && callbacks.has(msg.id)) {
                const cb = callbacks.get(msg.id);
                callbacks.delete(msg.id);
                console.log(`${tickerSymbol} - Executing callback for message ID ${msg.id} (tab ${tabId})`);
                cb(msg);
            } else if (msg.action) {
                switch (msg.action) {
                    case 'pause_tab':
                        if (!isPaused) {
                            isPaused = true;
                            currentState = 'paused';
                            updateTabStatus('Paused');
                            sendMessage({ action: 'tab_paused' });
                        }
                        break;
                    case 'resume_tab':
                        if (isPaused) {
                            isPaused = false;
                            currentState = 'resumed';
                            updateTabStatus('Resuming');
                            sendMessage({ action: 'resume_tab' });
                        }
                        break;
                    case 'ping':
                        sendMessage({ action: 'pong' });
                        break;
                    case 'check_title':
                        checkTitle(msg.tickerSymbol, (success) => {
                            sendMessage({ action: 'title_result', tabId, success });
                            if (success) startScraping();
                        });
                        break;
                    default:
                        console.log(`${tickerSymbol} - Unhandled message action (tab ${tabId}):`, msg.action);
                }
            }
        });

        // **Scraping Functions**
        function scrapeTransactions() {
            console.log(`${tickerSymbol} - Starting to scrape transactions (tab ${tabId})`);
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
            console.log(`${tickerSymbol} - Scraped ${transactions.length} transactions (tab ${tabId})`);
            return transactions;
        }

        function scrapeDirectorInterests() {
            console.log(`${tickerSymbol} - Starting to scrape director interests (tab ${tabId})`);
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
            console.log(`${tickerSymbol} - Scraped ${directorInterests.length} director interests (tab ${tabId})`);
            return directorInterests;
        }

        function scrapeHistoricalDownloadUrl() {
            console.log(`${tickerSymbol} - Scraping historical download URL for (tab ${tabId})`);
            const link = document.querySelector('a.btn[href*="download-historical-data"]');
            const url = link ? link.href : null;
            console.log(`${tickerSymbol} - Historical download URL (tab ${tabId}): ${url}`);
            return url;
        }

        function scrapeCompanyOverview() {
            console.log(`${tickerSymbol} - Scraping company overview`);
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
        
            console.log(`${tickerSymbol} - Scraped company overview:`, overview);
            return overview;
        }

        function scrapeCompanyDetails() {
            console.log(`${tickerSymbol} - Scraping company details (tab ${tabId})`);
            
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
        
            console.log(`${tickerSymbol} - Scraped company details (tab ${tabId}):`, details);
            return details;
        }

        // **Announcement Scraping Functions**
        async function scrapeAnnouncementsFromCurrentPage() {
            await checkPause();
            try {
                updateTabStatus("Scrape Announcements");
                let table = tableContainer.querySelector('table');
                if (!table) {
                    console.log(`${tickerSymbol} - No table found on page ${pageCounter.value}, observing tableContainer`);
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
                        console.log(`${tickerSymbol} - Timeout waiting for table on page ${pageCounter.value}`);
                        return [];
                    }
                }

                await wait(500);
                const rows = table.querySelectorAll('tbody tr');
                if (!rows.length) {
                    console.log(`${tickerSymbol} - No rows found on page ${pageCounter.value}`);
                    return [];
                }

                const parentContainer = tableContainer.parentElement;
                const activeButton = parentContainer.querySelector('button.btn.ghost.active');
                const activeTabNumber = activeButton ? parseInt(activeButton.getAttribute('data-pagination'), 10) : pageCounter.value;
                updateTabStatus(`Scrape Announcements Page: ${activeTabNumber}`);
                console.log(`${tickerSymbol} - Active page ${activeTabNumber}`);

                const downloadAnnouncements = await new Promise(resolve => sendMessage({ action: 'get_config' }, (response) => resolve(response?.config?.downloadPdfs ?? false)));
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
                        console.log(`${tickerSymbol} - Skipping ${filename} (${fileSize} bytes)`);
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
                        console.log(`${tickerSymbol} - Page ${pageCounter.value} not last, marking successful`);
                        successfulPages.add(activeTabNumber);
                    } else if (highestVisiblePage === pageCounter.value && announcements.length === rows.length) {
                        console.log(`${tickerSymbol} - Last page ${pageCounter.value}, marking successful`);
                        successfulPages.add(activeTabNumber);
                    }
                }
                console.log(`${tickerSymbol} - Scraped ${announcements.length} announcements from page ${pageCounter.value}`);

                
                await sendScrapedBatch(announcements);

            } catch (error) {
                console.error(`Error scraping announcements on page ${pageCounter.value}:`, error);
                return [];
            }
        }

        async function proceedToScrapeNextPage() {
            await checkPause();
            const nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
            if (!nextButton || isFinished) {
                console.log(`${tickerSymbol} - No more pages to scrape`);
                await proceedWithFailedScrapedPages();
                return;
            }

            const currentPage = getActivePage();
            console.log(`${tickerSymbol} - Current page: ${currentPage}, clicking next`);
            nextButton.click();

            try {
                const newPage = await waitForPageChange(currentPage);
                console.log(`${tickerSymbol} - Page changed to ${newPage}`);
                pageCounter.value = newPage;
                updateTabStatus(`Scrape Page: ${newPage}`);
                const announcements = await scrapeAnnouncementsFromCurrentPage();
                allAnnouncements.push(...announcements);
                if (allAnnouncements.length >= scrapedAnnouncementSendBatchSize) {
                    await sendScrapedBatch(allAnnouncements.splice(0, scrapedAnnouncementSendBatchSize));
                }
                await proceedToScrapeNextPage();
            } catch (error) {
                console.error(`Failed to load next page: ${error.message}`);
                failedPages.push(currentPage + 1);
                await proceedToScrapeNextPage();
            }
        }

        async function proceedWithFailedScrapedPages() {
            await checkPause();
            if (isFinished) return;

            const buttons = Array.from(tableContainer.querySelectorAll('button.btn.ghost[data-position]:not([style*="display: none"]):not(#dynamic-button)'));
            let totalPages = 1;
            if (buttons.length > 0) {
                totalPages = parseInt(buttons[buttons.length - 1].getAttribute('data-position'), 10) || 1;
            }
            console.log(`${tickerSymbol} - Total pages: ${totalPages}`);

            const allPages = Array.from({ length: totalPages }, (_, i) => i + 1);
            failedPages = allPages.filter(page => !successfulPages.has(page));
            console.log(`${tickerSymbol} - Failed pages: ${failedPages.join(', ')}`);

            if (failedPages.length > 0) {
                await retryFailedScrapedPages();
            }

            if (!isFinished && allAnnouncements.length > 0) {
                await sendScrapedBatch(allAnnouncements.splice(0, allAnnouncements.length));
            }
        }

        async function retryFailedScrapedPages() {
            const MAX_RETRIES = 3;
            const retryCounts = new Map();

            while (failedPages.length > 0 && !isFinished) {
                const failedPage = failedPages.shift();
                console.log(`${tickerSymbol} - Retrying failed page ${failedPage}`);

                const retries = (retryCounts.get(failedPage) || 0) + 1;
                if (retries > MAX_RETRIES) {
                    console.error(`Page ${failedPage} exceeded retry limit (${MAX_RETRIES})`);
                    continue;
                }
                retryCounts.set(failedPage, retries);

                try {
                    await retryPage(failedPage);
                } catch (error) {
                    console.error(`Failed to retry page ${failedPage} (attempt ${retries}):`, error);
                    failedPages.push(failedPage);
                } finally {
                    document.querySelector('#dynamic-button')?.remove();
                }
            }

            async function retryPage(targetPage) {
                await checkPause();
                const currentPage = getActivePage();
                if (currentPage === targetPage) {
                    console.log(`${tickerSymbol} - Already on page ${targetPage}, scraping...`);
                    return scrapeAnnouncementsFromCurrentPage();
                }

                const button = announcementsContainer.querySelector(`button.btn.ghost[data-pagination="${targetPage}"]`);
                if (!button) {
                    throw new Error(`Button for page ${targetPage} not found`);
                }

                button.click();
                await waitForPageChange(currentPage);
                console.log(`${tickerSymbol} - Page changed to ${targetPage}`);
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
            await checkPause();
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
            await checkPause();
            if (!tableContainer) {
                console.log(`${tickerSymbol} - No announcements table found`);
                return;
            }

            allAnnouncements = await scrapeAnnouncementsFromCurrentPage();
            console.log(`${tickerSymbol} - Page ${pageCounter.value} scraped, found ${allAnnouncements.length} announcements`);

            if (allAnnouncements.length > 0) {
                const nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
                if (!nextButton) {
                    await proceedWithFailedScrapedPages();
                } else {
                    await proceedToScrapeNextPage();
                }
            }
        }

        // **API Fetching Functions**
        async function fetchAnnouncementsViaApi(tickerSymbol) {
            const apiFetchEnabled = await new Promise(resolve => sendMessage({ action: 'get_config' }, (response) => resolve(response?.config?.apiFetchAnnouncements ?? true)));
            if (!apiFetchEnabled) return;

            updateTabStatus("API Fetch Announcements");
            const apiUrl = `https://data-api.marketindex.com.au/api/v1/announcements?codes=${tickerSymbol.toUpperCase()}%3AAUD%3AXASX&limit=1000000`;

            try {
                const announcements = await fetchApiData(apiUrl, tickerSymbol);
                console.log(`${tickerSymbol} - Fetched ${announcements.length} announcements via API`);
                totalAPIFetchedAnnouncements = announcements.length;
                await processAnnouncements(announcements, tickerSymbol);
            } catch (error) {
                console.error(`Failed to fetch announcements: ${error.message}`);
                if (apiFetchAnnouncementFailPause) {
                    isPaused = true;
                    updateTabStatus("Paused: API Fetch Failed");
                }
            }
        }

        async function fetchApiData(url, tickerSymbol) {
            let errorAttempt = 1;
            let timeoutAttempt = 0;
            const maxTotalAttempts = apiFetchAnnouncementMaxRetries + apiFetchAnnouncementTimeoutMaxRetries;

            while (errorAttempt <= apiFetchAnnouncementMaxRetries || timeoutAttempt < apiFetchAnnouncementTimeoutMaxRetries) {
                await checkPause();
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), apiFetchAnnouncementTimeout);

                    const response = await fetch(url, { signal: controller.signal });
                    clearTimeout(timeoutId);

                    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

                    const data = await response.json();
                    if (data.statusCode !== 200) throw new Error(data.message);

                    return data.data.announcements;
                } catch (error) {
                    if (error.name === 'AbortError') {
                        timeoutAttempt++;
                        console.error(`API fetch timeout (attempt ${timeoutAttempt}/${apiFetchAnnouncementTimeoutMaxRetries}): ${error.message}`);
                        if (timeoutAttempt < apiFetchAnnouncementTimeoutMaxRetries) {
                            await wait(apiFetchAnnouncementTimeoutRetryTime);
                            continue;
                        }
                        if (apiFetchAnnouncementTimeoutFailPause) isPaused = true;
                        throw error;
                    } else {
                        console.error(`API fetch error (attempt ${errorAttempt}/${apiFetchAnnouncementMaxRetries}): ${error.message}`);
                        if (errorAttempt < apiFetchAnnouncementMaxRetries) {
                            await wait(apiFetchAnnouncementRetryTime);
                            errorAttempt++;
                            continue;
                        }
                        if (apiFetchAnnouncementFailPause) isPaused = true;
                        throw error;
                    }
                }
            }
            throw new Error(`Failed to fetch API data after max attempts`);
        }

        async function processAnnouncements(announcements, tickerSymbol) {
            const batchSize = apiSaveFetchedAnnouncementSendBatchSize;
            for (let i = 0; i < announcements.length; i += batchSize) {
                await checkPause();
                const batch = announcements.slice(i, i + batchSize).map(ann => ({
                    ...ann,
                    tickerSymbol,
                    pdfLink: `https://www.marketindex.com.au/${ann.fileKey}`
                }));
                const success = await sendBatchToBackground(batch, tickerSymbol);
                if (!success && apiSaveFetchedAnnouncementFailPause) {
                    isPaused = true;
                    updateTabStatus("Paused: Batch Send Failed");
                }
            }
        }

        async function sendBatchToBackground(batch, tickerSymbol) {
            const operation = () => new Promise((resolve) => {
                sendMessage({ action: 'save_api_announcement_batch', batch }, (res) => {
                    resolve(res?.success || false);
                });
            });
            return retryOperation(operation, apiSaveFetchedAnnouncementMaxRetries, apiSaveFetchedAnnouncementSendRetryTime, apiSaveFetchedAnnouncementFailPause);
        }

        async function sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, scrapedAnnouncements = []) {
            await checkPause();
            updateTabStatus('Saving Final Scraped Data');
            if (isFinished) return;
            isFinished = true;

            if (scrapedAnnouncements.length) {
                const success = await sendScrapedBatch(scrapedAnnouncements);
                if (!success && isPaused) {
                    isFinished = false;
                    return;
                }
            }

            const webScrapeAnnouncements = await new Promise(resolve => sendMessage({ action: 'get_config' }, (response) => resolve(response?.config?.webScrapeAnnouncements ?? false)));
            if (webScrapeAnnouncements) {
                updateTabStatus('Calculate Total Scrapeable Announcements');
                totalScrapeableAnnouncements = await calculateTotalScrapeableAnnouncements();
                updateTabStatus('Finalizing Scrape');
            }

            const data = {
                transactions: transactions,
                director_interests: directorInterests,
                historical_download_url: historicalDownloadUrl,
                company_overview: companyOverview,
                company_details: companyDetails,
                total_scrapeable_announcements: totalScrapeableAnnouncements,
                total_api_fetchable_announcements: totalAPIFetchedAnnouncements
            };

            console.log(`${tickerSymbol} - Sending final scraped data for tab ${tabId}`);
            await new Promise((resolve) => {
                sendMessage({ action: 'scraping_complete', data }, (res) => {
                    if (!res?.success) isPaused = true;
                    isFinished = !isPaused;
                    resolve();
                });
            });
        }

        function checkTitle(tickerSymbol, callback) {
            const MAX_ATTEMPTS = 30;
            let attempts = 0;

            function verifyTitle() {
                return document.title.includes(`ASX:${tickerSymbol.toUpperCase()}`);
            }

            if (verifyTitle()) {
                callback(true);
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
                    if (verifyTitle()) {
                        observer.disconnect();
                        callback(true);
                    } else if (attempts >= MAX_ATTEMPTS) {
                        observer.disconnect();
                        callback(false);
                    }
                }, 1000);
            });

            observer.observe(titleElement, { childList: true, characterData: true, subtree: true });
        }

        async function startScraping() {
            await checkPause();
            if (isScraping || !tickerSymbol) return;
            isScraping = true;
            updateTabTicker(tickerSymbol);

            await waitForBackground();
            const config = await new Promise(resolve => sendMessage({ action: 'get_config' }, (response) => resolve(response?.config || {})));
            const apiFetchAnnouncements = config.apiFetchAnnouncements ?? true;
            const webScrapeAnnouncements = config.webScrapeAnnouncements ?? false;

            const transactions = scrapeTransactions();
            const directorInterests = scrapeDirectorInterests();
            const historicalDownloadUrl = scrapeHistoricalDownloadUrl();
            const companyOverview = scrapeCompanyOverview();
            const companyDetails = scrapeCompanyDetails();

            if (apiFetchAnnouncements) {
                console.log(`${tickerSymbol} - Fetching announcements via API`);
                await fetchAnnouncementsViaApi(tickerSymbol);
            }
            
            if (webScrapeAnnouncements) {
                console.log(`${tickerSymbol} - Scraping announcements from DOM`);
                await scrapeAnnouncementsViaDom();
            }
            
            await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails);

            updateTabStatus('Completed');
            isScraping = false;
        }

        function updateTabStatus(status) {
            sendMessage({ action: 'update_tab_status', status });
        }

        function updateTabTicker(ticker) {
            sendMessage({ action: 'update_tab_ticker', ticker });
            updateTabStatus('Starting');
        }
    }

    if (document.readyState === 'interactive' || document.readyState === 'complete') {
        console.log(`${tickerSymbol} - DOM already loaded for tab ${tabId}`);
        onDOMReady();
    } else {
        document.addEventListener('DOMContentLoaded', onDOMReady);
    }
} catch (e) {
    console.error(`Content script crashed for tab ${window.tabId}: ${e.message}`);
}