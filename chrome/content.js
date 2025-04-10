// content.js

console.log("content.js loaded into page");

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
    console.log(`🔍 Scraping transactions for ${window.tickerSymbol}`);
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
    console.log(`🔍 Scraping director interests for ${window.tickerSymbol}`);
    return scrapeTableData('#directors-interests-root', 6, (cells) => {
        return {
            director: cells[0].textContent.trim(),
            lastNotice: cells[1].textContent.trim(),
            directShares: cells[2].textContent.trim().replace(/[^0-9]/g, '') || '0', // Handle N/A
            indirectShares: cells[3].textContent.trim().replace(/[^0-9]/g, '') || '0', // Handle N/A
            options: cells[4].textContent.trim().replace(/[^0-9]/g, '') || '0', // Handle N/A
            convertibles: cells[5].textContent.trim().replace(/[^0-9]/g, '') || '0' // Handle N/A
        };
    });
}

// Scrape historical download URL
function scrapeHistoricalDownloadUrl() {
    console.log(`🔍 Scraping historical download URL for ${window.tickerSymbol}`);
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
    console.log(`🔍 Scraping company overview for ${window.tickerSymbol}`);
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
        'eps': { key: 'eps', cleaner: (v) => v.replace(/[^0-9.]/g, '') },
        'dps': { key: 'dps', cleaner: (v) => v.replace(/[^0-9.]/g, '') },
        'book value per share': { key: 'bookValuePerShare', cleaner: (v) => v.replace(/[^0-9.]/g, '') },
        'shares issued': { key: 'sharesIssued', cleaner: (v) => v.replace(/[^0-9]/g, '') }
    };

    const processRows = (rows) => {
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) continue;
            const label = cells[0].textContent.trim().toLowerCase();
            const value = cells[1].textContent.trim();
            const mapping = labelMappings[label];
            if (mapping) overview[mapping.key] = mapping.cleaner(value);
        }
    };

    processRows(document.querySelectorAll('table.mi-table[data-company-market-rank-target="table"] tbody tr'));
    processRows(document.querySelectorAll('div.sm\\:flex.flex-wrap table tr'));

    console.log(`✅ Scraped company overview:`, overview);
    return overview;
}

// Scrape company details with mappings
function scrapeCompanyDetails() {
    console.log(`🔍 Scraping company details for ${window.tickerSymbol}`);
    const details = {
        website: null,
        auditor: null,
        dateListed: null
    };

    const labelMappings = {
        'website': { key: 'website', cleaner: (cells) => {
            const link = cells[1].querySelector('a');
            const raw = link ? link.href : cells[1].textContent.trim();
            return raw ? raw.split('?')[0] : null;
        }},
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

// Utility functions (unchanged)
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

async function getExistingFiles(tickerSymbol) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "get_existing_files", tickerSymbol }, (response) => {
            resolve(response?.files || []);
        });
    }).catch(error => {
        console.error(`❌ getExistingFiles failed:`, error);
        return [];
    });
}

async function getDownloadAnnouncementsSetting() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "get_download_announcements" }, (response) => {
            resolve(response?.downloadAnnouncements ?? true);
        });
    }).catch(error => {
        console.error(`❌ getDownloadAnnouncementsSetting failed:`, error);
        return true;
    });
}

// Announcements scraping with improved structure
async function scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements) {
    const table = tableContainer.querySelector('table');
    if (!table) {
        console.log(`❌ No table found on page ${pageCounter.value}`);
        return [];
    }
    const rows = table.querySelectorAll('tbody tr');
    if (!rows.length) {
        console.log(`❌ No rows found on page ${pageCounter.value}`);
        return [];
    }

    const announcements = [];
    for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) continue;

        const rawDate = cells[0].textContent.trim();
        const rawTime = cells[3].textContent.trim();
        let rawHeading = cells[1].textContent.trim();
        const priceSensitive = rawHeading.endsWith(' $');
        const cleanedHeading = priceSensitive ? rawHeading.slice(0, -2) : rawHeading;
        const sanitizedHeading = cleanedHeading.replace(/[<>:"/\\|?*]+/g, '').trim().substring(0, 50);
        const pdfLink = cells[4].querySelector('a.announcement-pdf-link')?.href || null;

        const filename = generateUniqueFilename(window.tickerSymbol, rawDate, sanitizedHeading, usedFilenames);
        const fileSize = downloadAnnouncements && pdfLink ? await fetchFileSize(pdfLink) : 0;

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
    console.log(`✅ Scraped ${announcements.length} announcements from page ${pageCounter.value}`);
    return announcements;
}

async function scrapeAnnouncements(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails) {
    console.log(`🔍 Scraping announcements for ${window.tickerSymbol}`);
    let allAnnouncements = [];
    const usedFilenames = [];
    const failedPages = [];
    const existingFiles = await getExistingFiles(window.tickerSymbol);
    const downloadAnnouncements = await getDownloadAnnouncementsSetting();
    const batchSize = 100;
    const maxRetries = 5;
    let pageCounter = { value: 1 };
    let isFinished = false;
  
    const announcementsContainer = document.querySelector(`#${window.tickerSymbol.toLowerCase()}-all-announcements`);
    if (!announcementsContainer) {
        console.log(`⏹️ No announcements container found`);
        await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }
  
    const tableContainer = announcementsContainer.querySelector('#app-table');
    if (!tableContainer) {
        console.log(`❌ No table container found`);
        await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }
  
    // Scrape initial page
    allAnnouncements = await scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements);
    if (!allAnnouncements.length) {
        await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }
  
    let nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
    if (!nextButton) {
        await proceedWithFailedPages();
        return;
    }
  
    // Pagination for regular pages
    async function proceedWithNextPage() {
        const nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
        if (!nextButton || isFinished) {
            await proceedWithFailedPages();
            return;
        }
  
        let retryCount = 0;
        let timeoutId;
    
        const observeAndScrape = async () => {
            observer.disconnect();
            clearTimeout(timeoutId);
            document.querySelector('#dynamic-button')?.remove();
    
            pageCounter.value++;
            const announcements = await scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements);
            allAnnouncements.push(...announcements);
            if (allAnnouncements.length >= batchSize) {
                await sendBatch(allAnnouncements.splice(0, batchSize));
            }
            await proceedWithNextPage();
        };
  
        const retryLogic = async () => {
            clearTimeout(timeoutId);
            if (retryCount >= maxRetries) {
                console.log(`❌ Max retries (${maxRetries}) reached for page ${pageCounter.value + 1}`);
                failedPages.push(pageCounter.value + 1);
                pageCounter.value++;
                await proceedWithNextPage();
                return;
            }
  
            retryCount++;
            console.log(`🔄 Retry ${retryCount}/${maxRetries} for page ${pageCounter.value + 1}`);
            const freshNextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
            if (!freshNextButton) {
                await proceedWithFailedPages();
                return;
            }
  
            observer.observe(tableContainer, { childList: true, subtree: true });
            freshNextButton.click();
            timeoutId = setTimeout(retryLogic, 15000);
        };
  
        const observer = new MutationObserver(observeAndScrape);
        observer.observe(tableContainer, { childList: true, subtree: true });
        nextButton.click();
        timeoutId = setTimeout(retryLogic, 15000);
    }
  
    // Handle failed pages
    async function proceedWithFailedPages() {
        while (failedPages.length > 0 && !isFinished) {
            const failedPage = failedPages.shift();
            console.log(`🔄 Retrying failed page ${failedPage}`);
    
            const dynamicButton = document.createElement('button');
            dynamicButton.id = 'dynamic-button';
            dynamicButton.setAttribute('data-pagination', String(failedPage));
            dynamicButton.className = 'btn ghost';
            announcementsContainer.appendChild(dynamicButton);
    
            try {
                await new Promise((resolve, reject) => {
                    const retryObserver = new MutationObserver(async () => {
                        retryObserver.disconnect();
                        dynamicButton.remove();
                        console.log(`✅ Loaded failed page ${failedPage}`);
    
                        const announcements = await scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, { value: failedPage }, downloadAnnouncements);
                        allAnnouncements.push(...announcements);
                        if (allAnnouncements.length >= batchSize) {
                            await sendBatch(allAnnouncements.splice(0, batchSize));
                        }
                        resolve();
                    });
                    retryObserver.observe(tableContainer, { childList: true, subtree: true });
                    dynamicButton.click();
    
                    setTimeout(() => {
                        retryObserver.disconnect();
                        dynamicButton.remove();
                        reject(new Error(`Retry timeout for page ${failedPage}`));
                    }, 15000);
                });
            } catch (error) {
                console.error(`❌ Failed to retry page ${failedPage}:`, error);
                failedPages.push(failedPage);
            }
        }
    
        if (!isFinished) {
            console.log(`✅ All pages processed, including retries`);
            await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        }
    }
  
    // Reusable batch sender
    async function sendBatch(batch) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log(`❌ ${window.tickerSymbol} Timeout waiting for save_announcement_batch response`);
                resolve(false); // Fallback to false if no response
            }, 30000); // 30-second timeout

            chrome.runtime.sendMessage({ action: "save_announcement_batch", batch }, (response) => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) {
                    console.error(`❌ ${window.tickerSymbol} Error sending batch: ${chrome.runtime.lastError.message}`);
                    resolve(false);
                } else {
                    console.log(`✅ ${window.tickerSymbol} Sent batch of ${batch.length} announcements`);
                    resolve(response?.success || false);
                }
            });
        });
    }
  
    // Final data sender
    async function sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, announcements) {
        if (isFinished) {
            console.log(`Already finished for ${window.tickerSymbol}, skipping sendFinalScrapedData`);
            return;
        }
        isFinished = true;

        try {
            if (announcements.length) {
                console.log(`Sending final batch of ${announcements.length} announcements`);
                await sendBatch(announcements);
            }
            const data = { transactions, director_interests: directorInterests, historical_download_url: historicalDownloadUrl, company_overview: companyOverview, company_details: companyDetails };
            console.log(`Sending scraping_complete message for ${window.tickerSymbol}`);
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.log(`❌ ${window.tickerSymbol} Timeout waiting for scraping_complete response`);
                    resolve();
                }, 30000); // 30-second timeout

                chrome.runtime.sendMessage({ action: "scraping_complete", data }, (response) => {
                    clearTimeout(timeout);
                    if (chrome.runtime.lastError) {
                        console.log(`❌ ${window.tickerSymbol} No listener for scraping_complete: ${chrome.runtime.lastError.message}`);
                        resolve();
                    } else {
                        console.log(`Received response from background:`, response);
                        resolve(response);
                    }
                });
            });
            console.log(`✅ ${window.tickerSymbol} Scraping completed`);
        } catch (error) {
            console.error(`❌ ${window.tickerSymbol} Error in sendFinalScrapedData:`, error);
        }
    }

    await proceedWithNextPage();
}

async function waitForBackground() {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 50;
        const check = () => {
            attempts++;
            chrome.runtime.sendMessage({ action: "ping" }, (response) => {
                if (chrome.runtime.lastError && attempts < maxAttempts) {
                    setTimeout(check, 100);
                } else if (attempts >= maxAttempts) {
                    reject(new Error("Background script not responding"));
                } else {
                    resolve();
                }
            });
        };
        check();
    });
}

async function startScraping() {
    if (!window.tickerSymbol) {
        console.error("❌ No ticker symbol defined");
        return;
    }
    console.log(`🔍 Starting scraping for ${window.tickerSymbol}`);
    try {
        await waitForBackground();
        const transactions = scrapeTransactions();
        const directorInterests = scrapeDirectorInterests();
        const historicalDownloadUrl = scrapeHistoricalDownloadUrl();
        const companyOverview = scrapeCompanyOverview();
        const companyDetails = scrapeCompanyDetails();
        await scrapeAnnouncements(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails);
    } catch (error) {
        console.error("❌ Scraping failed:", error);
        chrome.runtime.sendMessage({ action: "scraping_complete", data: {} });
    }
}

startScraping();