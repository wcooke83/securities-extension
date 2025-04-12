console.log("content.js loaded into page");

// Derive tickerSymbol from URL
const tickerSymbol = window.location.pathname.split('/').pop().split('.').shift().toLowerCase();

// Global Set to track unique pdfLinks
const allPdfLinks = new Set();

function toValidSelector(id) {
    return `#${id.replace(/^(\d)/, '\\3$1 ')}`;
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

async function getExistingFiles(tickerSymbol) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "get_existing_files", tickerSymbol }, (response) => {
            resolve(response?.files || []);
        });
    }).catch((error) => {
        console.error(`❌ getExistingFiles failed:`, error);
        return [];
    });
}

async function getDownloadAnnouncementsSetting() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "get_download_announcements" }, (response) => {
            resolve(response?.downloadAnnouncements ?? true);
        });
    }).catch((error) => {
        console.error(`❌ getDownloadAnnouncementsSetting failed:`, error);
        return true;
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
    try {
        let table = tableContainer.querySelector('table');
        if (!table) {
            console.log(`❌ No table found on page ${pageCounter.value}, observing tableContainer for changes`);
            return new Promise((resolve) => {
                const observer = new MutationObserver(async (mutations, obs) => {
                    table = tableContainer.querySelector('table');
                    if (table) {
                        obs.disconnect();
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
                }, 10000); // Reduced timeout for faster recovery
            });
        }

        await new Promise(resolve => setTimeout(resolve, 500)); // Brief delay for DOM stability
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

        // Deduplicate announcements
        announcements = dedupeAnnouncements(announcements, tickerSymbol);

        // Check if page is successful
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
    console.log(`🔍 Scraping announcements for ${tickerSymbol}`);
    let allAnnouncements = [];
    const usedFilenames = [];
    const successfulPages = new Set();
    let failedPages = [];
    const existingFiles = await getExistingFiles(tickerSymbol);
    const downloadAnnouncements = await getDownloadAnnouncementsSetting();
    const batchSize = 100;
    const maxRetries = 5;
    let pageCounter = { value: 1 };
    let isFinished = false;
    let isPaused = false;

    const announcementsContainer = document.querySelector(`${toValidSelector(tickerSymbol.toLowerCase())}-all-announcements`);
    if (!announcementsContainer) {
        console.log(`⏹️ ${tickerSymbol} No announcements container found`);
        await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }

    const tableContainer = announcementsContainer.querySelector('#app-table');
    if (!tableContainer) {
        console.log(`❌ ${tickerSymbol} No table container found`);
        await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }

    console.log(`📄 Scraping page ${pageCounter.value} for ${tickerSymbol}`);
    allAnnouncements = await scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements, successfulPages);
    console.log(`📄 Page ${pageCounter.value} scraped, found ${allAnnouncements.length} announcements`);

    // Send initial announcements if no next page or batch immediately
    if (allAnnouncements.length > 0) {
        let nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
        if (!nextButton) {
            console.log(`⏹️ No next page button found, sending initial batch for ${tickerSymbol}`);
            await sendBatch(allAnnouncements.splice(0, allAnnouncements.length));
            await proceedWithFailedPages();
            return;
        } else if (allAnnouncements.length >= batchSize) {
            await sendBatch(allAnnouncements.splice(0, batchSize));
        }
    } else {
        await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }

    async function proceedWithNextPage() {
        const nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
        if (!nextButton || isFinished) {
            console.log(`⏹️ No more pages to scrape for ${tickerSymbol}`);
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
            console.log(`📄 Scraping page ${pageCounter.value} for ${tickerSymbol}`);
            const announcements = await scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements, successfulPages);
            console.log(`📄 Page ${pageCounter.value} scraped, found ${announcements.length} announcements`);
            allAnnouncements.push(...announcements);
            if (allAnnouncements.length >= batchSize) {
                await sendBatch(allAnnouncements.splice(0, batchSize));
            }
            await proceedWithNextPage();
        };

        const retryLogic = async () => {
            clearTimeout(timeoutId);
            if (retryCount >= maxRetries) {
                console.log(`❌ Max retries (${maxRetries}) reached for page ${pageCounter.value + 1}, marking as failed`);
                failedPages.push(pageCounter.value + 1);
                await proceedWithNextPage();
                return;
            }

            retryCount++;
            console.log(`🔄 Retry ${retryCount}/${maxRetries} for page ${pageCounter.value + 1}`);
            const activeButton = getActiveBtn();
            if (!activeButton) {
                console.log(`⏹️ No next button found after retries for page ${pageCounter.value + 1}, proceeding to failed pages`);
                await proceedWithFailedPages();
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

    async function proceedWithFailedPages() {
        if (isFinished) return;
    
        try {
            // Get pagination buttons
            const buttons = Array.from(
                tableContainer.querySelectorAll('button.btn.ghost[data-position]:not([style*="display: none"]):not(#dynamic-button)')
            );
    
            // Calculate total pages with fallback
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
    
            // Identify failed pages
            const allPages = Array.from({ length: totalPages }, (_, i) => i + 1);
            const failedPages = allPages.filter((page) => !successfulPages.has(page));
            console.log(`🛑 Failed pages for ${tickerSymbol}: ${failedPages.length > 0 ? failedPages.join(', ') : 'None'}`);
    
            // Retry failed pages if any
            if (failedPages.length > 0) {
                await retryFailedPages(failedPages, tableContainer, isFinished);
            }
    
            // Process remaining announcements and final data
            if (!isFinished) {
                if (allAnnouncements.length > 0) {
                    await sendBatch(allAnnouncements.splice(0, allAnnouncements.length));
                }
    
                const calculatedTotal = calculateTotalAnnouncements();
                const uniqueAnnouncementsCount = allPdfLinks.size;
                console.log(`📈 ${tickerSymbol} Total unique announcements: ${uniqueAnnouncementsCount}, Calculated total: ${calculatedTotal}`);
                await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
            }
        } catch (error) {
            console.error(`❌ Error in proceedWithFailedPages for ${tickerSymbol}:`, error);
        }
    }
    
    // Helper Functions (move these outside proceedWithFailedPages for reusability)
    
    async function handlePageLoad(failedPage) {
        try {
            console.log(`✅ Loaded failed page ${failedPage}`);
            const announcements = await scrapeAnnouncementsFromCurrentPage(
                tableContainer, usedFilenames, existingFiles, { value: failedPage }, downloadAnnouncements, successfulPages
            );
            console.log(`📄 Failed page ${failedPage} scraped, found ${announcements.length} announcements`);
            allAnnouncements.push(...announcements);
            if (allAnnouncements.length >= batchSize) {
                await sendBatch(allAnnouncements.splice(0, batchSize));
            }
            return announcements;
        } catch (error) {
            console.error(`❌ Error handling page load for ${failedPage}:`, error);
            throw error; // Propagate to retry logic
        }
    }
    
    function paginateClick(page) {
        const dynamicButton = document.createElement('button');
        dynamicButton.id = 'dynamic-button';
        dynamicButton.dataset.position = page; // Consistent with selector
        dynamicButton.className = 'btn ghost';
        dynamicButton.textContent = `Page ${page}`;
    
        const activeBtn = tableContainer.querySelector('button.btn.ghost.active');
        if (activeBtn) activeBtn.appendChild(dynamicButton);
    
        dynamicButton.click();
        return dynamicButton;
    }
    
    function removeDynamicButton() {
        const btn = document.getElementById('dynamic-button');
        if (btn) btn.remove();
    }
    
    function getActiveBtn() {
        return tableContainer.querySelector('button.btn.ghost.active');
    }
    
    function getActivePage() {
        const btn = getActiveBtn();
        return btn ? Number(btn.dataset.position) : null; // Consistent with selector
    }
    
    async function retryFailedPages(failedPages, tableContainer, isFinished) {
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
                failedPages.push(failedPage); // Requeue for retry
            } finally {
                removeDynamicButton(); // Always clean up
            }
        }
    
        async function retryPage(page, container) {
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

    function calculateTotalAnnouncements() {
        if (!announcementsContainer) {
            console.log(`❌ No announcements container found for ${tickerSymbol}`);
            return 0;
        }

        const activeButton = announcementsContainer.querySelector('button.btn.ghost.active');
        const currentPage = activeButton ? parseInt(activeButton.getAttribute('data-pagination'), 10) : 1;
        const rowsOnLastPage = tableContainer ? tableContainer.querySelectorAll('tbody tr').length : 0;

        const totalAnnouncements = (currentPage - 1) * 10 + rowsOnLastPage;
        console.log(`Calculated total announcements: ${totalAnnouncements} for ${tickerSymbol}`);
        return totalAnnouncements;
    }

    async function sendBatch(batch) {
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

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log(`❌ ${tickerSymbol} Timeout waiting for save_announcement_batch response, pausing`);
                isPaused = true;
                resolve(false);
            }, 30000);

            chrome.runtime.sendMessage({ action: "save_announcement_batch", batch: uniqueBatch }, (response) => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) {
                    console.log(`❌ ${tickerSymbol} Error sending batch: ${chrome.runtime.lastError.message}, pausing`);
                    isPaused = true;
                    resolve(false);
                } else {
                    console.log(`✅ ${tickerSymbol} Sent batch of ${uniqueBatch.length} unique announcements`);
                    resolve(response?.success || false);
                }
            });
        });
    }

    async function sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, announcements = []) {
        if (isFinished) {
            console.log(`Already finished for ${tickerSymbol}, skipping sendFinalScrapedData`);
            return;
        }
        isFinished = true;

        try {
            if (Array.isArray(announcements) && announcements.length) {
                console.log(`Sending final batch of ${announcements.length} announcements`);
                const success = await sendBatch(announcements);
                if (!success && isPaused) {
                    await waitForResume(announcements, transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails);
                    return;
                }
            }

            const totalAnnouncements = calculateTotalAnnouncements();
            const data = {
                transactions,
                director_interests: directorInterests,
                historical_download_url: historicalDownloadUrl,
                company_overview: companyOverview,
                company_details: companyDetails,
                totalAnnouncements
            };
            console.log(`Sending scraping_complete message for ${tickerSymbol} with totalAnnouncements: ${totalAnnouncements}`);

            const response = await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.log(`⚠️ ${tickerSymbol} Timeout waiting for scraping_complete response, assuming sent`);
                    resolve({ success: false, error: "Timeout" });
                }, 30000);

                chrome.runtime.sendMessage({ action: "scraping_complete", data }, (response) => {
                    clearTimeout(timeout);
                    if (chrome.runtime.lastError) {
                        console.log(`❌ ${tickerSymbol} Error sending scraping_complete: ${chrome.runtime.lastError.message}`);
                        resolve({ success: false, error: chrome.runtime.lastError.message });
                    } else {
                        console.log(`✅ ${tickerSymbol} Received response from background:`, response);
                        resolve(response);
                    }
                });
            });

            if (response.success === false) {
                console.log(`❌ ${tickerSymbol} Scraping_complete failed: ${response.error}, pausing`);
                isPaused = true;
                await waitForResume([], transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails);
                return;
            } else if (response.error) {
                console.log(`⚠️ ${tickerSymbol} Scraping completed with note: ${response.error}`);
            }

            console.log(`✅ ${tickerSymbol} Scraping completed`);
        } catch (error) {
            console.error(`❌ ${tickerSymbol} Error in sendFinalScrapedData:`, error);
            isPaused = true;
            await waitForResume([], transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails);
        }
    }

    await proceedWithNextPage();
}

async function waitForResume(announcements, transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails) {
    console.log(`⏸️ ${tickerSymbol} Paused due to standby or error, waiting for resume`);
    await new Promise((resolve) => {
        chrome.runtime.onMessage.addListener(function listener(message) {
            if (message.action === "resume_after_standby") {
                console.log(`▶️ ${tickerSymbol} Resuming after standby`);
                chrome.runtime.onMessage.removeListener(listener);
                isPaused = false;
                resolve();
            }
        });
    });
    isFinished = false;
    await sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, announcements);
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
            chrome.runtime.sendMessage({ action: "ping" }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn(`Ping attempt ${attempts} failed: ${chrome.runtime.lastError.message}`);
                    if (attempts < maxAttempts) {
                        setTimeout(check, 100);
                    } else {
                        reject(new Error(`Background script not responding after ${maxAttempts} attempts`));
                    }
                } else {
                    console.log(`Ping successful on attempt ${attempts}`);
                    resolve(response || {});
                }
            });
        };
        console.log("Starting background ping");
        check();
    });
}

async function startScraping() {
    if (!tickerSymbol) {
        console.error("❌ No ticker symbol defined");
        return;
    }
    console.log(`🔍 Starting scraping for ${tickerSymbol}`);
    try {
        await waitForBackground().catch((error) => {
            console.error(`❌ Failed to connect to background script: ${error.message}`);
            throw error;
        });

        // Use let if these might be modified, or ensure no reassignment
        let transactions = scrapeTransactions();
        let directorInterests = scrapeDirectorInterests();
        let historicalDownloadUrl = scrapeHistoricalDownloadUrl();
        let companyOverview = scrapeCompanyOverview();
        let companyDetails = scrapeCompanyDetails();

        await scrapeAnnouncements(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails);
    } catch (error) {
        console.error(`❌ Scraping failed for ${tickerSymbol}:`, error);
        try {
            chrome.runtime.sendMessage({ action: "scraping_complete", data: {} });
        } catch (sendError) {
            console.error(`❌ Failed to send scraping_complete: ${sendError.message}`);
        }
    }
}

startScraping();