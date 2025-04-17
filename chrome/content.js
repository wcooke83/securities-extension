// content.js
const tabId = window.tabid;
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
const apiFetchAnnouncementTimeout = 30000; // Timeout for fetch (ms)
const apiFetchAnnouncementTimeoutRetryTime = 10000; // Delay after timeout (ms)
const apiFetchAnnouncementTimeoutMaxRetries = 3; // Max timeout retries
const apiFetchAnnouncementTimeoutFailPause = true; // Pause on timeout failure
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

console.log("content.js loaded into page");

// Derive tickerSymbol from URL
const tickerSymbol = window.location.pathname.split('/').pop().split('.').shift().toLowerCase();

// Global Set to track unique pdfLinks
const allPdfLinks = new Set();

const announcementsContainer = document.querySelector(`${toValidSelector(tickerSymbol.toLowerCase())}-all-announcements`);
const tableContainer = announcementsContainer?.querySelector('#app-table');

// Utility to send messages with metadata
function sendRuntimeMessage(message, callback, retries = 3, delayMs = 3000) {
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

// Add message listener for pause/resume commands
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

// Function to check pause state and wait if paused
async function checkPause() {
    if (isPaused && currentState !== 'paused') {
        currentState = 'paused';
        updateTabStatus("Paused");
        console.log(`⏸️ ${tickerSymbol} Paused, Waiting to resume`);
        chrome.runtime.sendMessage({ action: "tab_paused", tabId });
        await checkResume(); // Wait for resume before proceeding
    } else if (!isPaused && currentState !== 'resumed') {
        currentState = 'resumed';
        updateTabStatus("Resuming");
        console.log(`▶️ ${tickerSymbol} Un-Paused, Resumed`);
        chrome.runtime.sendMessage({ action: "resume_tab", tabId });
    }
    // If state doesn't change, do nothing (no redundant messages)
}

// Function to wait for resume
async function checkResume() {
    if (currentState !== 'paused') return; // No need to wait if not paused

    return new Promise((resolve) => {
        const listener = (message, sender, sendResponse) => {
            if (message.action === 'resume_tab' && message.tabId === tabId) {
                isPaused = false;
                currentState = 'resumed';
                updateTabStatus("Resuming");
                console.log(`▶️ ${tickerSymbol} Resume signal received`);
                chrome.runtime.sendMessage({ action: "resume_tab", tabId });
                chrome.runtime.onMessage.removeListener(listener); // Remove listener after use
                sendResponse({ received: true });
                resolve();
            }
        };
        chrome.runtime.onMessage.addListener(listener);
    });
}

function toValidSelector(id) {
    return `#${id.replace(/^(\d)/, '\\3$1 ')}`;
}

// Update tab status with custom message
function updateTabStatus(status) {
    chrome.runtime.sendMessage({
        action: 'update_tab_status',
        status
    });
}

// Update tab ticker symbol
function updateTabTicker(ticker) {
    chrome.runtime.sendMessage({
        action: 'update_tab_ticker',
        ticker
    });
    updateTabStatus("Starting");
}

// Generic function to scrape table data
function scrapeTableData(rootSelector, minCells, mapFn) {
    const root = document.querySelector(rootSelector);
    if (!root) {
        console.log(`❌ No root found for ${rootSelector}.`);
        return [];
    }
    const rows = root.querySelectorAll('tbody tr');
    const data = [];
    for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < minCells) continue;
        const item = mapFn(cells);
        if (item) data.push(item);
    }
    console.log(`✅ Scraped ${data.length} items from ${rootSelector}`);
    return data;
}

// Scrape transactions
function scrapeTransactions() {
    console.log(`🔍 Scraping transactions for ${tickerSymbol}`);
    return scrapeTableData('#directors-transactions-root', 6, (cells) => {
        return {
            date: cells[0].textContent.trim(),
            director: cells[1].textContent.trim(),
            type: cells[2].textContent.trim(),
            quantity: cells[3].textContent.trim().replace(/[^0-9-]/g, ''),
            price: cells[4].textContent.trim().replace(/[^0-9.]/g, ''),
            value: cells[5].textContent.trim().replace(/[^0-9.]/g, ''),
            notes: cells[6]?.textContent.trim() || ''
        };
    });
}

// Scrape director interests
function scrapeDirectorInterests() {
    console.log(`🔍 Scraping director interests for ${tickerSymbol}`);
    return scrapeTableData('#directors-interests-root', 6, (cells) => {
        return {
            director: cells[0].textContent.trim(),
            lastNotice: cells[1].textContent.trim(),
            directShares: cells[2].textContent.trim().replace(/[^0-9]/g, '') || '0',
            indirectShares: cells[3].textContent.trim().replace(/[^0-9]/g, '') || '0',
            options: cells[4].textContent.trim().replace(/[^0-9]/g, '') || '0',
            convertibles: cells[5].textContent.trim().replace(/[^0-9]/g, '') || '0'
        };
    });
}

// Scrape historical download URL
function scrapeHistoricalDownloadUrl() {
    console.log(`🔍 Scraping historical download URL for ${tickerSymbol}`);
    const link = document.querySelector('a[href*="/download-historical-data/"]');
    if (link) {
        console.log(`✅ Found historical download URL: ${link.href}`);
        return link.href;
    }
    console.log("❌ No historical download URL found.");
    return null;
}

// Scrape company overview with mappings
function scrapeCompanyOverview() {
    console.log(`🔍 Scraping company overview for ${tickerSymbol}`);
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

    console.log(`✅ Scraped company overview:`, overview);
    return overview;
}

// Scrape company details with mappings
function scrapeCompanyDetails() {
    console.log(`🔍 Scraping company details for ${tickerSymbol}`);
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
        'auditor': { key: 'auditor', cleaner: (cells) => cells[1].textContent.trim() },
        'date listed': { key: 'dateListed', cleaner: (cells) => cells[1].textContent.trim() }
    };

    const rows = document.querySelectorAll('.content-box table.mi-table tr');
    for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;
        const label = cells[0].textContent.trim().toLowerCase();
        const mapping = labelMappings[label];
        if (mapping) details[mapping.key] = mapping.cleaner(cells);
    }

    console.log(`✅ Scraped company details:`, details);
    return details;
}

// Utility functions
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
        console.log(`📏 Fetched file size for ${pdfLink}: ${fileSize} bytes`);
        return fileSize;
    } catch (error) {
        console.error(`❌ Error fetching file size for ${pdfLink}:`, error);
        return 0;
    }
}

async function getChromeSetting({ action, defaultValue, extractValue, params = {} }) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ action, ...params }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error(`❌ ${action} error: ${chrome.runtime.lastError.message}`);
                    resolve(defaultValue);
                    return;
                }

                const value = extractValue ? extractValue(response) : response;
                resolve(value ?? defaultValue);
            });
        } catch (error) {
            console.error(`❌ ${action} failed: ${error.message}`);
            resolve(defaultValue);
        }
    });
}

function dedupeAnnouncements(announcements, tickerSymbol) {
    if (!Array.isArray(announcements)) {
        console.warn(`❌ ${tickerSymbol} Invalid announcements input: expected array, got ${typeof announcements}`);
        return [];
    }
    const seen = new Set();
    return announcements.filter(announcement => {
        const key = announcement.pdfLink || announcement.filename || JSON.stringify(announcement);
        if (seen.has(key)) {
            console.log(`⏩ ${tickerSymbol} Skipping duplicate announcement: ${key}`);
            return false;
        }
        seen.add(key);
        return true;
    });
}

// Announcements scraping
async function scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements, successfulPages) {
    await checkPause(); // Check pause before scraping
    try {
        updateTabStatus("Scrape Announcements");
        let table = tableContainer.querySelector('table');
        if (!table) {
            console.log(`❌ No table found on page ${pageCounter.value}, observing tableContainer for changes`);
            updateTabStatus("Observe Announcements Table");
            return new Promise((resolve) => {
                const observer = new MutationObserver(async (mutations, obs) => {
                    table = tableContainer.querySelector('table');
                    if (table) {
                        obs.disconnect();
                        updateTabStatus("Scrape Announcements");
                        console.log(`✅ Table detected on page ${pageCounter.value} after mutation`);
                        const announcements = await scrapeAnnouncementsFromCurrentPage(
                            tableContainer,
                            usedFilenames,
                            existingFiles,
                            pageCounter,
                            downloadAnnouncements,
                            successfulPages
                        );
                        resolve(announcements);
                    }
                });
                observer.observe(tableContainer, { childList: true, subtree: true });
                setTimeout(() => {
                    observer.disconnect();
                    console.log(`⏳ Timeout waiting for table on page ${pageCounter.value}, resolving with empty array`);
                    resolve([]);
                }, 10000);
            });
        }

        await new Promise(resolve => setTimeout(resolve, 500));
        const rows = table.querySelectorAll('tbody tr');
        if (!rows.length) {
            console.log(`❌ No rows found on page ${pageCounter.value}`);
            return [];
        }

        const parentContainer = tableContainer.parentElement;
        const activeButton = parentContainer.querySelector('button.btn.ghost.active');
        const activeTabNumber = activeButton
            ? parseInt(activeButton.getAttribute('data-pagination'), 10)
            : pageCounter.value;
        updateTabStatus(`Scrape Announcements Page: ${activeTabNumber}`);
        console.log(`📍 Active page for ${tickerSymbol} is ${activeTabNumber}`);

        let announcements = [];
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) {
                console.warn(`⚠️ Row on page ${pageCounter.value} has insufficient cells (${cells.length})`);
                continue;
            }

            const rawDate = cells[0].textContent.trim();
            const rawTime = cells[3].textContent.trim();
            let rawHeading = cells[1].textContent.trim();
            const priceSensitive = rawHeading.endsWith(' $');
            const cleanedHeading = priceSensitive ? rawHeading.slice(0, -2) : rawHeading;
            const sanitizedHeading = cleanedHeading.replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, 50);
            const pdfLink = cells[4].querySelector('a.announcement-pdf-link')?.href || null;
            console.log(`🔗 PDF Link: ${pdfLink || 'None'}`);

            const filename = generateUniqueFilename(tickerSymbol, rawDate, sanitizedHeading, usedFilenames);
            let fileSize = 0;
            if (downloadAnnouncements && pdfLink) {
                try {
                    fileSize = await Promise.race([
                        fetchFileSize(pdfLink),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('File size fetch timeout')), 5000))
                    ]);
                } catch (error) {
                    console.warn(`⚠️ Failed to fetch file size for ${filename}: ${error.message}`);
                    fileSize = 0;
                }
            }

            if (existingFiles.some(f => f.filename === filename && f.fileSize === fileSize)) {
                console.log(`⏩ Skipping ${filename} (${fileSize} bytes)`);
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

        announcements = dedupeAnnouncements(announcements, tickerSymbol);

        if (announcements.length > 0) {
            const buttons = parentContainer.querySelectorAll('button.btn.ghost');
            const highestVisiblePage = buttons.length
                ? parseInt(buttons[buttons.length - 1].getAttribute('data-pagination'), 10)
                : pageCounter.value;

            if (highestVisiblePage > pageCounter.value && announcements.length === 10) {
                console.log(`✅ Page ${pageCounter.value} not last, has 10 announcements, marking successful`);
                successfulPages.add(activeTabNumber);
            } else if (highestVisiblePage === pageCounter.value && announcements.length === rows.length) {
                console.log(`✅ Last page ${pageCounter.value}, announcements match rows (${announcements.length}), marking successful`);
                successfulPages.add(activeTabNumber);
            }
        }

        console.log(`✅ Scraped ${announcements.length} announcements from page ${pageCounter.value}`);
        return announcements;
    } catch (error) {
        console.error(`❌ Error scraping announcements on page ${pageCounter.value}:`, error);
        return [];
    }
}

async function scrapeAnnouncements(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails) {
    await checkPause(); // Check pause before starting
    console.log(`🔍 Scraping announcements for ${tickerSymbol}`);

    existingFiles = await getChromeSetting({ action: "get_existing_files", defaultValue: [], extractValue: (res) => res?.files, params: { tickerSymbol } });
    downloadAnnouncements = await getChromeSetting({ action: "get_download_announcements", defaultValue: false, extractValue: (res) => res?.downloadPdfs });
    apiFetchAnnouncements = await getChromeSetting({ action: "api_fetch_announcements", defaultValue: true, extractValue: (res) => res?.apiFetchAnnouncements });
    webScrapeAnnouncements = await getChromeSetting({ action: "web_scrap_announcements", defaultValue: false, extractValue: (res) => res?.webScrapeAnnouncements });
    
    if (apiFetchAnnouncements) {
        console.log(`⏹️ fetchAnnouncementsViaApi:`, tickerSymbol, apiSaveFetchedAnnouncementSendBatchSize);
        await fetchAnnouncementsViaApi(tickerSymbol, apiSaveFetchedAnnouncementSendBatchSize);
    }

    if (!webScrapeAnnouncements) {
        console.log(`⏹️ ${tickerSymbol} Scrape announcements via web is not checked`);
        await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }

    if (!announcementsContainer) {
        console.log(`⏹️ ${tickerSymbol} No announcements container found`);
        await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }

    if (!tableContainer) {
        console.log(`❌ ${tickerSymbol} No table container found`);
        await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }

    console.log(`📄 Scraping page ${pageCounter.value} for ${tickerSymbol}`);
    allAnnouncements = await scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements, successfulPages);
    console.log(`📄 Page ${pageCounter.value} scraped, found ${allAnnouncements.length} announcements`);

    if (allAnnouncements.length > 0) {
        let nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
        if (!nextButton) {
            console.log(`⏹️ No next page button found, sending initial batch for ${tickerSymbol}`);
            await sendScrapedBatch(allAnnouncements.splice(0, allAnnouncements.length));
            await proceedWithFailedScrapedPages();
            return;
        } else if (allAnnouncements.length >= scrapedAnnouncementSendBatchSize) {
            await sendScrapedBatch(allAnnouncements.splice(0, scrapedAnnouncementSendBatchSize));
        }
    } else {
        await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }

    async function proceedToScrapeNextPage() {
        await checkPause(); // Check pause before proceeding
        const nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
        if (!nextButton || isFinished) {
            console.log(`⏹️ No more pages to scrape for ${tickerSymbol}`);
            await proceedWithFailedScrapedPages();
            return;
        }

        let retryCount = 0;
        let timeoutId;

        const observeAndScrape = async () => {
            observer.disconnect();
            clearTimeout(timeoutId);
            document.querySelector('#dynamic-button')?.remove();

            pageCounter.value++;
            updateTabStatus(`Scrape Page: ${pageCounter.value}`);

            console.log(`📄 Scraping page ${pageCounter.value} for ${tickerSymbol}`);
            const announcements = await scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements, successfulPages);
            console.log(`📄 Page ${pageCounter.value} scraped, found ${announcements.length} announcements`);
            allAnnouncements.push(...announcements);
            if (allAnnouncements.length >= scrapedAnnouncementSendBatchSize) {
                await sendScrapedBatch(allAnnouncements.splice(0, scrapedAnnouncementSendBatchSize));
            }
            await proceedToScrapeNextPage();
        };

        const retryLogic = async () => {
            clearTimeout(timeoutId);
            if (retryCount >= scrapedAnnouncementScrapeMaxRetries) {
                updateTabStatus(`Scrape Page: ${pageCounter.value + 1}, Max retries (${scrapedAnnouncementScrapeMaxRetries}) reached`);
                console.log(`❌ Max retries (${scrapedAnnouncementScrapeMaxRetries}) reached for page ${pageCounter.value + 1}, marking as failed`);
                failedPages.push(pageCounter.value + 1);
                await proceedToScrapeNextPage();
                return;
            }

            retryCount++;
            await checkPause(); // Check pause during retries
            updateTabStatus(`Scrape Page: ${pageCounter.value + 1}, Retry ${retryCount}/${scrapedAnnouncementScrapeMaxRetries}`);
            console.log(`🔄 Retry ${retryCount}/${scrapedAnnouncementScrapeMaxRetries} for page ${pageCounter.value + 1}`);
            const activeButton = getActiveBtn();
            if (!activeButton) {
                console.log(`⏹️ No next button found after retries for page ${pageCounter.value + 1}, proceeding to failed pages`);
                await proceedWithFailedScrapedPages();
                return;
            }

            observer.observe(tableContainer, { childList: true, subtree: true });
            activeButton.click();
            timeoutId = setTimeout(retryLogic, 15000);
        };

        const observer = new MutationObserver(observeAndScrape);
        observer.observe(tableContainer, { childList: true, subtree: true });
        nextButton.click();
        timeoutId = setTimeout(retryLogic, 15000);
    }

    async function proceedWithFailedScrapedPages() {
        await checkPause(); // Check pause before proceeding
        if (isFinished) return;

        try {
            const buttons = Array.from(
                tableContainer.querySelectorAll('button.btn.ghost[data-position]:not([style*="display: none"]):not(#dynamic-button)')
            );

            let totalPages = 1;
            if (buttons.length > 0) {
                const lastButton = buttons[buttons.length - 1];
                const positionAttr = lastButton.getAttribute('data-position');
                totalPages = positionAttr ? parseInt(positionAttr, 10) : 1;
                if (isNaN(totalPages)) {
                    console.warn(`⚠️ Invalid data-position on last button, defaulting to 1`);
                    totalPages = 1;
                }
            }
            console.log(`📊 Total pages for ${tickerSymbol}: ${totalPages}`);

            const allPages = Array.from({ length: totalPages }, (_, i) => i + 1);
            failedPages = allPages.filter((page) => !successfulPages.has(page));
            console.log(`🛑 Failed pages for ${tickerSymbol}: ${failedPages.length > 0 ? failedPages.join(', ') : 'None'}`);

            if (failedPages.length > 0) {
                await retryFailedScrapedPages(failedPages, tableContainer, isFinished);
            }

            if (!isFinished) {
                if (allAnnouncements.length > 0) {
                    await sendScrapedBatch(allAnnouncements.splice(0, allAnnouncements.length));
                }

                await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
            }
        } catch (error) {
            console.error(`❌ Error in proceedWithFailedScrapedPages for ${tickerSymbol}:`, error);
        }
    }

    async function handlePageLoad(failedPage) {
        await checkPause(); // Check pause before loading page
        try {
            console.log(`✅ Loaded failed page ${failedPage}`);
            const announcements = await scrapeAnnouncementsFromCurrentPage(
                tableContainer, usedFilenames, existingFiles, { value: failedPage }, downloadAnnouncements, successfulPages
            );
            console.log(`📄 Failed page ${failedPage} scraped, found ${announcements.length} announcements`);
            allAnnouncements.push(...announcements);
            if (allAnnouncements.length >= scrapedAnnouncementSendBatchSize) {
                await sendScrapedBatch(allAnnouncements.splice(0, scrapedAnnouncementSendBatchSize));
            }
            return announcements;
        } catch (error) {
            console.error(`❌ Error handling page load for ${failedPage}:`, error);
            throw error;
        }
    }

    function paginateClick(page) {
        const btnGroup = document.querySelector(
            `#${window.location.pathname.split('/').pop().split('.').shift().toLowerCase().replace(/^(\d)/, '\\3$1 ')}-all-announcements div.btn-group`
        );
        const btn = btnGroup.querySelector(`button[data-pagination="next"]`);
        btn.dataset.pagination = page;
        btn.disabled = false;
        btn.click();
        btn.dataset.pagination = `next`;
    }

    function removeDynamicButton() {
        const btn = document.getElementById('dynamic-button');
        if (btn) btn.remove();
    }

    function getActiveBtn() {
        return announcementsContainer.querySelector('button.btn.ghost.active');
    }

    function getFirstBtn() {
        const btn = announcementsContainer.querySelector('button.btn.ghost[data-pagination="first"]');
        if (btn) btn.removeAttribute('disabled');
        return btn;
    }

    function getLastBtn() {
        const btn = announcementsContainer.querySelector('button.btn.ghost[data-pagination="last"]');
        if (btn) btn.removeAttribute('disabled');
        return btn;
    }

    function getActivePage() {
        const btn = getActiveBtn();
        return Number(btn?.dataset.pagination);
    }

    async function calculateTotalAnnouncements() {
        await checkPause(); // Check pause before calculating
        const lastPage = await new Promise((resolve, reject) => {
            const calcObserver = new MutationObserver(() => {
                calcObserver.disconnect();
                resolve(getActivePage());
            });

            calcObserver.observe(tableContainer, { childList: true, subtree: true });
            getLastBtn().click();
        });
        const totalAnnouncements = ((lastPage - 1) * 10) + tableContainer.querySelectorAll('tbody tr').length;
        getFirstBtn().click();
        return totalAnnouncements;
    }

    async function retryFailedScrapedPages(failedPages, tableContainer, isFinished) {
        const MAX_RETRIES = 3;
        const retryCounts = new Map();

        while (failedPages.length > 0 && !isFinished) {
            const failedPage = failedPages.shift();
            console.log(`🔄 Retrying failed page ${failedPage}`);

            const retries = (retryCounts.get(failedPage) || 0) + 1;
            if (retries > MAX_RETRIES) {
                console.error(`❌ Page ${failedPage} exceeded retry limit (${MAX_RETRIES})`);
                continue;
            }
            retryCounts.set(failedPage, retries);

            try {
                await retryPage(failedPage, tableContainer);
            } catch (error) {
                console.error(`❌ Failed to retry page ${failedPage} (attempt ${retries}):`, error);
                failedPages.push(failedPage);
            } finally {
                removeDynamicButton();
            }
        }

        async function retryPage(page, container) {
            await checkPause(); // Check pause before retrying
            return new Promise((resolve, reject) => {
                let timeoutId = null;
                const retryObserver = new MutationObserver(async (mutations, observer) => {
                    const activePage = getActivePage();
                    if (activePage !== page) return;

                    observer.disconnect();
                    clearTimeout(timeoutId);

                    try {
                        console.log(`ℹ️ Active page ${activePage} matches target ${page}, scraping...`);
                        await handlePageLoad(page);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });

                retryObserver.observe(container, { childList: true, subtree: true });

                try {
                    paginateClick(page);
                } catch (error) {
                    retryObserver.disconnect();
                    clearTimeout(timeoutId);
                    reject(error);
                    return;
                }

                timeoutId = setTimeout(() => {
                    retryObserver.disconnect();
                    const activePage = getActivePage();
                    if (activePage === page) {
                        console.log(`ℹ️ Timeout: Active page ${activePage} matches ${page}, scraping...`);
                        handlePageLoad(page).then(resolve).catch(reject);
                    } else {
                        reject(new Error(`Timeout: Active page ${activePage} does not match ${page}`));
                    }
                }, 10000);
            });
        }
    }

    // Update sendScrapedBatch to use sendRuntimeMessage
    async function sendScrapedBatch(batch) {
        await checkPause();
        const uniqueBatch = batch.filter((announcement) => {
            if (announcement.pdfLink) {
                if (allPdfLinks.has(announcement.pdfLink)) {
                    console.log(`⏩ ${tickerSymbol} Skipping duplicate pdfLink: ${announcement.pdfLink}`);
                    return false;
                }
                allPdfLinks.add(announcement.pdfLink);
                return true;
            }
            return true;
        });

        if (uniqueBatch.length === 0) {
            console.log(`ℹ️ ${tickerSymbol} No new unique announcements to send in batch`);
            return Promise.resolve(true);
        }

        let attempt = 1;

        while (attempt <= scrapedAnnouncementSendBatchMaxRetries) {
            await checkPause();
            try {
                const success = await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        console.log(`❌ ${tickerSymbol} Timeout waiting for save_scraped_announcement_batch response (attempt ${attempt}/${scrapedAnnouncementSendBatchMaxRetries})`);
                        resolve(false);
                    }, 30000);

                    sendRuntimeMessage(
                        { action: "save_scraped_announcement_batch", batch: uniqueBatch },
                        (response) => {
                            clearTimeout(timeout);
                            if (response?.success) {
                                console.log(`✅ ${tickerSymbol} Saved batch of ${uniqueBatch.length} announcements (attempt ${attempt})`);
                                resolve(true);
                            } else {
                                console.log(`❌ ${tickerSymbol} Failed to save batch: ${response?.error || 'Unknown error'} (attempt ${attempt})`);
                                resolve(false);
                            }
                        }
                    );
                });

                if (success) return true;

                if (attempt < scrapedAnnouncementSendBatchMaxRetries) {
                    console.log(`⏳ ${tickerSymbol} Retrying batch send in ${scrapedAnnouncementSendBatchRetryTime / 1000} seconds (attempt ${attempt + 1}/${scrapedAnnouncementSendBatchMaxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, scrapedAnnouncementSendBatchRetryTime));
                } else {
                    console.log(`❌ ${tickerSymbol} Max retries (${scrapedAnnouncementSendBatchMaxRetries}) reached, pausing`);
                    isPaused = true;
                    return false;
                }

                attempt++;
            } catch (error) {
                console.error(`❌ ${tickerSymbol} Unexpected error in sendScrapedBatch (attempt ${attempt}): ${error.message}`);
                if (attempt < scrapedAnnouncementSendBatchMaxRetries) {
                    await new Promise(resolve => setTimeout(resolve, scrapedAnnouncementSendBatchRetryTime));
                } else {
                    isPaused = true;
                    return false;
                }
                attempt++;
            }
        }

        return false;
    }

    async function sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, scrapedAnnouncements = []) {
        await checkPause();
        updateTabStatus(`Saving Final Scraped Data`);
        if (isFinished) {
            console.log(`Already finished for ${tickerSymbol}, skipping sendFinalScrapedData`);
            return;
        }
        isFinished = true;
    
        try {
            if (Array.isArray(scrapedAnnouncements) && scrapedAnnouncements.length) {
                console.log(`Sending final batch of ${scrapedAnnouncements.length} announcements`);
                const success = await sendScrapedBatch(scrapedAnnouncements);
                if (!success && isPaused) {
                    isFinished = false;
                    return;
                }
            }
    
            if (webScrapeAnnouncements) {
                updateTabStatus("Calculate Total Scrapeable Announcements");
                totalScrapeableAnnouncements = await calculateTotalAnnouncements();
                updateTabStatus("Finalizing Scrape");
            } else {
                totalScrapeableAnnouncements = 0;
            }
    
            const data = {
                transactions,
                director_interests: directorInterests,
                historical_download_url: historicalDownloadUrl,
                company_overview: companyOverview,
                company_details: companyDetails,
                total_scrapeable_announcements: totalScrapeableAnnouncements,
                total_api_fetchable_announcements: totalAPIFetchedAnnouncements
            };
    
            const response = await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.log(`⚠️ ${tickerSymbol} Timeout waiting for scraping_complete response`);
                    resolve({ success: false, error: "Timeout" });
                }, 30000);
    
                sendRuntimeMessage(
                    { action: "scraping_complete", data },
                    (response) => {
                        clearTimeout(timeout);
                        console.log(`✅ ${tickerSymbol} Received response for scraping_complete:`, response);
                        resolve(response);
                    }
                );
            });
    
            if (response.success === false) {
                console.log(`❌ ${tickerSymbol} Scraping_complete failed: ${response.error}, pausing`);
                isPaused = true;
                isFinished = false;
                return;
            } else if (response.error) {
                console.log(`⚠️ ${tickerSymbol} Scraping completed with note: ${response.error}`);
            }
    
            console.log(`✅ ${tickerSymbol} Scraping completed`);
        } catch (error) {
            console.error(`❌ ${tickerSymbol} Error in sendFinalScrapedData: ${error.message}`);
            isPaused = true;
            isFinished = false;
        }
    }

    async function fetchAnnouncementsViaApi(tickerSymbol) {
        console.log('fetchAnnouncementsViaApi');
        if (!apiFetchAnnouncements) return;
    
        updateTabStatus("API Fetch Announcements");
        const apiUrl = `https://data-api.marketindex.com.au/api/v1/announcements?codes=${tickerSymbol.toUpperCase()}%3AAUD%3AXASX&limit=1000000`;
    
        try {
            console.log('apiUrl', apiUrl);
            const announcements = await fetchApiData(apiUrl, tickerSymbol);
            console.log(`announcements`, announcements);
            console.log(`📡 Fetched ${announcements.length} announcements via API`);
            totalAPIFetchedAnnouncements = announcements.length;
            await processAnnouncements(announcements, tickerSymbol);
        } catch (error) {
            console.error(`❌ ${tickerSymbol} Failed to fetch or process announcements: ${error.message}`);
            if (apiFetchAnnouncementFailPause || apiFetchAnnouncementTimeoutFailPause) {
                isPaused = true;
                updateTabStatus("Paused: API Fetch Failed");
            } else {
                console.log(`⏭️ ${tickerSymbol} Skipping ticker due to API fetch failure`);
            }
        }
    }
    
    async function fetchApiData(url, tickerSymbol) {
        const maxErrorRetries = apiFetchAnnouncementMaxRetries;
        const errorRetryTime = apiFetchAnnouncementRetryTime;
        const maxTimeoutRetries = apiFetchAnnouncementTimeoutMaxRetries;
        const timeoutRetryTime = apiFetchAnnouncementTimeoutRetryTime;
        const timeoutMs = apiFetchAnnouncementTimeout;
        let errorAttempt = 1;
        let timeoutAttempt = 0; // Track timeout retries separately
        let totalAttempts = 0; // Track total attempts to prevent infinite loops
        const maxTotalAttempts = maxErrorRetries + maxTimeoutRetries; // Conservative limit
    
        console.log('fetchApiData');
    
        while (totalAttempts < maxTotalAttempts) {
            await checkPause();
            totalAttempts++;
            console.log(`[${tickerSymbol}] Fetch attempt ${totalAttempts} (error attempt ${errorAttempt}/${maxErrorRetries}, timeout attempt ${timeoutAttempt}/${maxTimeoutRetries})`);
    
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
                const response = await Promise.race([
                    fetch(url, { signal: controller.signal }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), timeoutMs))
                ]);
    
                clearTimeout(timeoutId);
    
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }
    
                const data = await response.json();
                console.log('data.statusCode', data.statusCode);
                if (data.statusCode !== 200) {
                    throw new Error(data.message);
                }
    
                console.log(`📡 ${tickerSymbol} Fetched ${data.data.announcements.length} announcements via API`);
                return data.data.announcements;
            } catch (error) {
                if (error.name === 'AbortError' || error.message === 'Fetch timeout') {
                    timeoutAttempt++;
                    console.error(`❌ ${tickerSymbol} API fetch timeout (timeout attempt ${timeoutAttempt}/${maxTimeoutRetries}): ${error.message}`);
                    if (timeoutAttempt < maxTimeoutRetries) {
                        console.log(`⏳ ${tickerSymbol} Retrying after timeout in ${timeoutRetryTime / 1000} seconds`);
                        await delay(timeoutRetryTime);
                        continue;
                    } else {
                        console.error(`❌ ${tickerSymbol} Max timeout retries (${maxTimeoutRetries}) reached`);
                        if (apiFetchAnnouncementTimeoutFailPause) {
                            isPaused = true;
                            updateTabStatus("Paused: API Fetch Timeout");
                            throw new Error(`Max timeout retries reached for ${tickerSymbol}`);
                        } else {
                            console.log(`⏭️ ${tickerSymbol} Skipping ticker due to timeout failure`);
                            throw new Error(`Max timeout retries reached, skipping ${tickerSymbol}`);
                        }
                    }
                } else {
                    errorAttempt++;
                    console.error(`❌ ${tickerSymbol} API fetch error (error attempt ${errorAttempt}/${maxErrorRetries}): ${error.message}`);
                    if (errorAttempt <= maxErrorRetries) {
                        console.log(`⏳ ${tickerSymbol} Retrying after error in ${errorRetryTime / 1000} seconds`);
                        await delay(errorRetryTime);
                        timeoutAttempt = 0; // Reset timeout retries on error retry
                        continue;
                    } else {
                        console.error(`❌ ${tickerSymbol} Max error retries (${maxErrorRetries}) reached`);
                        if (apiFetchAnnouncementFailPause) {
                            isPaused = true;
                            updateTabStatus("Paused: API Fetch Error");
                            throw new Error(`Max error retries reached for ${tickerSymbol}`);
                        } else {
                            console.log(`⏭️ ${tickerSymbol} Skipping ticker due to error failure`);
                            throw new Error(`Max error retries reached, skipping ${tickerSymbol}`);
                        }
                    }
                }
            }
        }
    
        console.error(`❌ ${tickerSymbol} Exceeded total attempts (${maxTotalAttempts})`);
        if (apiFetchAnnouncementTimeoutFailPause || apiFetchAnnouncementFailPause) {
            isPaused = true;
            updateTabStatus("Paused: API Fetch Failed");
        }
        throw new Error(`Failed to fetch API data for ${tickerSymbol} after ${maxTotalAttempts} attempts`);
    }
    
    async function processAnnouncements(announcements, tickerSymbol) {
        const batchSize = apiSaveFetchedAnnouncementSendBatchSize;
        let batch_counter = 0;
        for (let i = 0; i < announcements.length; i += batchSize) {
            await checkPause();
            batch_counter++;
            const batch = announcements.slice(i, i + batchSize).map(ann => ({
                ...ann,
                tickerSymbol,
                pdfLink: `https://www.marketindex.com.au/${ann.fileKey}`
            }));
            const success = await sendBatchToBackground(batch, tickerSymbol, batch_counter);
            if (!success) {
                console.error(`❌ ${tickerSymbol} Failed to send batch starting at index ${i}`);
                if (apiSaveFetchedAnnouncementFailPause) {
                    isPaused = true;
                    updateTabStatus("Paused: Batch Send Failed");
                }
            }
        }
    }
    
    async function sendBatchToBackground(batch, tickerSymbol, batch_counter) {
        const maxRetries = apiSaveFetchedAnnouncementMaxRetries;
        const retryTime = apiSaveFetchedAnnouncementSendRetryTime;
        let attempt = 1;
    
        while (attempt <= maxRetries) {
            await checkPause();
            updateTabStatus(`Save API Fetch Announcements Batch: ${batch_counter}, Contains: ${batch.length}, Attempt: ${attempt}/${maxRetries}`);
    
            const success = await new Promise((resolve) => {
                sendRuntimeMessage(
                    { action: "save_api_announcement_batch", batch: batch, batch_counter: batch_counter },
                    (response) => {
                        if (response?.success) {
                            console.log(`✅ ${tickerSymbol} Saved API batch of ${batch.length} announcements`);
                            resolve(true);
                        } else {
                            console.error(`❌ ${tickerSymbol} API batch: ${batch_counter} failed: ${response?.error || 'Unknown error'}`);
                            console.error(`❌ ${tickerSymbol} API batch: ${batch_counter} failed response: ${response}`);
                            console.dir(response, { depth: null });
                            resolve(false);
                        }
                    }
                );
            });
    
            if (success) return true;
    
            if (attempt < maxRetries) {
                updateTabStatus(`Retrying send batch ${batch_counter} in ${retryTime / 1000} s`);
                await delay(retryTime);
            } else {
                console.error(`❌ ${tickerSymbol} Max retries (${maxRetries}) reached for send batch: ${batch_counter}`);
                if (apiSaveFetchedAnnouncementFailPause) {
                    isPaused = true;
                }
                return false;
            }
            attempt++;
        }
    
        return false;
    }
    
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    await proceedToScrapeNextPage();
}

async function waitForBackground() {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 50;
        const check = () => {
            attempts++;
            if (!chrome.runtime?.id) {
                reject(new Error("Extension context invalidated"));
                return;
            }
            try {
                chrome.runtime.sendMessage({ action: "ping" }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.warn(`Ping attempt ${attempts} failed: ${chrome.runtime.lastError.message}`);
                        if (attempts < maxAttempts) {
                            setTimeout(check, 100);
                        } else {
                            reject(new Error(`Background script not responding after ${maxAttempts} attempts`));
                        }
                        return;
                    }
                    console.log(`Ping successful on attempt ${attempts}`);
                    resolve(response || {});
                });
            } catch (error) {
                console.error(`Ping attempt ${attempts} failed: ${error.message}`);
                if (attempts < maxAttempts) {
                    setTimeout(check, 100);
                } else {
                    reject(new Error(`Background script not responding after ${maxAttempts} attempts`));
                }
            }
        };
        console.log("Starting background ping");
        check();
    });
}

async function startScraping() {
    await checkPause(); // Check pause before starting
    if (isScraping || !tickerSymbol) {
        console.error(`❌ Scraping already in progress or no ticker symbol for ${tickerSymbol}`);
        updateTabStatus("Error: Invalid state");
        return;
    }
    isScraping = true;
    console.log(`🔍 Starting scraping for ${tickerSymbol}`);
    updateTabStatus("Starting");
    updateTabTicker(tickerSymbol);
    try {
        await waitForBackground().catch((error) => {
            console.error(`❌ Failed to connect to background script: ${error.message}`);
            updateTabStatus(`Error: ${error.message}`);
            throw error;
        });

        let transactions = scrapeTransactions();
        let directorInterests = scrapeDirectorInterests();
        let historicalDownloadUrl = scrapeHistoricalDownloadUrl();
        let companyOverview = scrapeCompanyOverview();
        let companyDetails = scrapeCompanyDetails();

        updateTabStatus("Scraping data");
        await scrapeAnnouncements(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails);
        updateTabStatus("Completed");
    } catch (error) {
        console.error(`❌ Scraping failed for ${tickerSymbol}: ${error.message}`);
        updateTabStatus(`Error: ${error.message}`);
        try {
            console.log(`Sending scraping_complete message for ${tickerSymbol} with error`);
            chrome.runtime.sendMessage({ action: "scraping_complete", data: {} }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error(`❌ Failed to send scraping_complete: ${chrome.runtime.lastError.message}`);
                }
            });
        } catch (sendError) {
            console.error(`❌ Failed to send scraping_complete: ${sendError.message}`);
        }
    } finally {
        isScraping = false;
    }
}

startScraping();