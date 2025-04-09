// content.js

console.log("content.js loaded into page");

function scrapeTransactions() {
    console.log(`🔍 Scraping transactions for ${window.tickerSymbol}`);
    const transactions = [];
    const root = document.querySelector('#directors-transactions-root');
    if (!root) {
        console.log("❌ No transactions root found.");
        return transactions;
    }
    const rows = root.querySelectorAll('tbody tr');
    for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 6) continue;

        const date = cells[0].textContent.trim();
        const director = cells[1].textContent.trim();
        const type = cells[2].textContent.trim();
        const quantity = cells[3].textContent.trim().replace(/[^0-9-]/g, '');
        const price = cells[4].textContent.trim().replace(/[^0-9.]/g, '');
        const value = cells[5].textContent.trim().replace(/[^0-9.]/g, '');
        const notes = cells[6].textContent.trim();

        transactions.push({ date, director, type, quantity, price, value, notes });
    }
    console.log(`✅ Scraped ${transactions.length} transactions`);
    return transactions;
}

function scrapeDirectorInterests() {
    console.log(`🔍 Scraping director interests for ${window.tickerSymbol}`);
    const directorInterests = [];
    const root = document.querySelector('#directors-interests-root');
    if (!root) {
        console.log("❌ No director interests root found.");
        return directorInterests;
    }
    const rows = root.querySelectorAll('tbody tr');
    for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) continue;

        const director = cells[0].textContent.trim();
        const directShares = cells[1].textContent.trim().replace(/[^0-9]/g, '');
        const indirectShares = cells[2].textContent.trim().replace(/[^0-9]/g, '');

        directorInterests.push({ director, directShares, indirectShares });
    }
    console.log(`✅ Scraped ${directorInterests.length} director interests`);
    return directorInterests;
}

function scrapeHistoricalDownloadUrl() {
    console.log(`🔍 Scraping historical download URL for ${window.tickerSymbol}`);
    const link = document.querySelector('a[href*="/download-historical-data/"]');
    if (link) {
        const url = link.href;
        console.log(`✅ Found historical download URL: ${url}`);
        return url;
    }
    console.log("❌ No historical download URL found.");
    return null;
}

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

    // Target the correct table for Market Cap
    const marketCapTableRows = document.querySelectorAll('table.mi-table[data-company-market-rank-target="table"] tbody tr');
    for (const row of marketCapTableRows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;

        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();

        if (label.includes('market cap')) {
            overview.marketCap = value.replace(/[^0-9]/g, ''); // e.g., "$1,735,873,782" -> "1735873782"
        }
    }

    // Target the existing table for other fields
    const otherRows = document.querySelectorAll('div.sm\\:flex.flex-wrap table tr');
    if (!otherRows.length && !marketCapTableRows.length) {
        console.log("❌ No company overview tables found.");
        return overview;
    }

    for (const row of otherRows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;

        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();

        switch (label) {
            case 'sector':
                overview.sector = value;
                break;
            case 'eps':
                overview.eps = value.replace(/[^0-9.]/g, '');
                break;
            case 'dps':
                overview.dps = value.replace(/[^0-9.]/g, '');
                break;
            case 'book value per share':
                overview.bookValuePerShare = value.replace(/[^0-9.]/g, '');
                break;
            case 'shares issued':
                overview.sharesIssued = value.replace(/[^0-9]/g, '');
                break;
        }
    }

    console.log(`✅ Scraped company overview:`, overview);
    return overview;
}

function scrapeCompanyDetails() {
    console.log(`🔍 Scraping company details for ${window.tickerSymbol}`);
    const details = {
        website: null,
        auditor: null,
        dateListed: null
    };

    const rows = document.querySelectorAll('.content-box table.mi-table tr');
    if (!rows.length) {
        console.log("❌ No corporate details table found.");
        return details;
    }

    for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;

        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();

        switch (label) {
            case 'website':
                const link = cells[1].querySelector('a');
                const rawWebsite = link ? link.href : value;
                details.website = rawWebsite ? rawWebsite.split('?')[0] : null; // Remove query params
                break;
            case 'auditor':
                details.auditor = value;
                break;
            case 'date listed':
                details.dateListed = value;
                break;
        }
    }

    console.log(`✅ Scraped company details:`, details);
    return details;
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
            if (chrome.runtime.lastError) {
                console.error("Error in getExistingFiles:", chrome.runtime.lastError.message);
                resolve([]);
            } else if (response && response.files) {
                console.log(`📋 Retrieved ${response.files.length} existing files for ${tickerSymbol}`);
                resolve(response.files);
            } else {
                console.log(`❌ No existing files found for ${tickerSymbol}`);
                resolve([]);
            }
        });
    }).catch(error => {
        console.error(`❌ getExistingFiles failed for ${tickerSymbol}:`, error);
        return [];
    });
}

async function getDownloadAnnouncementsSetting() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "get_download_announcements" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error in getDownloadAnnouncementsSetting:", chrome.runtime.lastError.message);
                resolve(true);
            } else {
                resolve(response.downloadAnnouncements !== undefined ? response.downloadAnnouncements : true);
            }
        });
    }).catch(error => {
        console.error("❌ getDownloadAnnouncementsSetting failed:", error);
        return true;
    });
}

async function scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements) {
    const announcements = [];
    const table = tableContainer.querySelector('table');
    if (!table) {
        console.log("❌ No table found inside #app-table on this page.");
        return announcements;
    }
    const rows = table.querySelectorAll('tbody tr');
    if (rows.length === 0) {
        console.log("❌ No announcement rows found on this page.");
        return announcements;
    }
    console.log('🔎 Found announcement rows on current page:', rows.length);

    let announcementCounter = { value: 0 };

    for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) continue;

        const rawDate = cells[0].textContent.trim();
        const rawTime = cells[3].textContent.trim();
        const rawHeading = cells[1].textContent.trim();
        let priceSensitive = false;
        let cleanedHeading = rawHeading;
        if (rawHeading.endsWith(' $')) {
            priceSensitive = true;
            cleanedHeading = rawHeading.slice(0, -2);
        }
        const sanitizedHeading = cleanedHeading.replace(/[<>:"/\\|?*]+/g, '').trim().substring(0, 50);
        const pdfLink = cells[4].querySelector('a.announcement-pdf-link')?.href || null;

        const filename = generateUniqueFilename(window.tickerSymbol, rawDate, sanitizedHeading, usedFilenames);
        const fileSize = downloadAnnouncements && pdfLink ? await fetchFileSize(pdfLink) : 0;

        const existingFile = existingFiles.find(f => f.filename === filename && f.fileSize === fileSize);
        if (existingFile) {
            console.log(`⏩ Skipping already downloaded file: ${filename} (${fileSize} bytes)`);
            continue;
        }

        announcementCounter.value++;
        announcements.push({
            filename: filename,
            date: rawDate,
            heading: rawHeading,
            pages: parseInt(cells[2].textContent.trim()) || 0,
            priceSensitive: priceSensitive,
            time: rawTime,
            pdfLink: pdfLink,
            fileSize: fileSize,
            downloaded: downloadAnnouncements
        });
        console.log(`📝 Page ${pageCounter.value} - ${announcementCounter.value} - Scraped announcement: ${sanitizedHeading}, filename: ${filename}, size: ${fileSize} bytes, downloaded: ${downloadAnnouncements}`);
    }
    console.log(`✅ Scraped ${announcements.length} announcements from current page`);
    return announcements;
}

async function scrapeAnnouncements(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails) {
    console.log(`🔍 Scraping announcements for ${window.tickerSymbol}`);
    let allAnnouncements = [];
    let usedFilenames = [];
    let failedPages = [];
    const existingFiles = await getExistingFiles(window.tickerSymbol);
    const downloadAnnouncements = await getDownloadAnnouncementsSetting();
    console.log(`📥 Download Announcements setting: ${downloadAnnouncements}`);
    const batchSize = 100;
    let pageCounter = { value: 1 };
    let retryCount = 0;
    const maxRetries = 5;
    let isFinished = false;

    const announcementsContainerId = window.tickerSymbol.toLowerCase() + '-all-announcements';
    const announcementsContainer = document.querySelector(`#${announcementsContainerId}`);
    if (!announcementsContainer) {
        console.log(`⏹️ No announcements container found for ${window.tickerSymbol}, finishing scraping`);
        sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }
    console.log(`🔎 Initial container found for ${window.tickerSymbol}`);

    const announcementsTableContainer = announcementsContainer.querySelector('#app-table');
    if (!announcementsTableContainer) {
        console.log(`❌ No #app-table div found in container for ${window.tickerSymbol}`);
        sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }

    const initialAnnouncements = await scrapeAnnouncementsFromCurrentPage(announcementsTableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements);
    allAnnouncements = allAnnouncements.concat(initialAnnouncements);
    if (initialAnnouncements.length === 0) {
        console.log(`⏹️ No announcements found on initial page for ${window.tickerSymbol}, finishing scraping`);
        sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }

    let nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
    console.log(`Next button check: ${nextButton ? 'Found' : 'Not found'}`);
    if (!nextButton) {
        console.log(`🏁 No next button found for ${window.tickerSymbol}, finishing scraping`);
        sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
        return;
    }

    if (allAnnouncements.length >= batchSize) {
        await sendBatch(allAnnouncements);
        allAnnouncements = [];
    }

    let timeoutId;
    let observer;

    const setupObserver = () => {
        observer = new MutationObserver((mutations, obs) => {
            console.log(`🔄 Mutation detected in #app-table for ${window.tickerSymbol}`);
            obs.disconnect();
            document.querySelector(`#dynamic-button`)?.remove();

            checkAndCorrectPage(pageCounter, announcementsContainer, announcementsTableContainer, () => {
                pageCounter.value++;
                retryCount = 0;
                scrapeAnnouncementsFromCurrentPage(announcementsTableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements).then(newAnnouncements => {
                    allAnnouncements = allAnnouncements.concat(newAnnouncements);
                    if (allAnnouncements.length >= batchSize) {
                        const batch = allAnnouncements.splice(0, batchSize);
                        sendBatch(batch).then(() => {
                            allAnnouncements = [];
                            proceedWithNextPage();
                        });
                    } else {
                        proceedWithNextPage();
                    }
                }).catch(error => {
                    console.error(`❌ Error scraping page ${pageCounter.value}:`, error);
                    failedPages.push(pageCounter.value);
                    console.log(`❌ Added page ${pageCounter.value} to failedPages due to scrape error:`, failedPages);
                    proceedWithNextPage();
                });
            });
        });
        console.log(`🚀 Starting MutationObserver on #app-table for ${window.tickerSymbol}`);
        observer.observe(announcementsTableContainer, { childList: true, subtree: true });
    };

    const checkAndCorrectPage = (pageCounter, container, tableContainer, callback) => {
        const activeButton = container.querySelector('.btn.ghost.active');
        if (activeButton) {
            const activePage = activeButton.getAttribute('data-pagination');
            const expectedPage = String(pageCounter.value + 1);

            console.log(`🔍 Checking active page: ${Number(activePage)} vs expected page: ${Number(expectedPage)}`);

            if (activePage !== expectedPage) {
                console.log(`⚠️ Active page ${Number(activePage)} does not match expected page ${Number(expectedPage)}, correcting pagination`);

                const position = parseInt(activeButton.getAttribute('data-position') || '0') + 1;
                const newButton = document.createElement('button');
                newButton.className = 'btn ghost';
                newButton.setAttribute('data-pagination', expectedPage);
                newButton.setAttribute('data-position', position);
                newButton.id = 'dynamic-button';
                newButton.innerHTML = expectedPage;

                activeButton.insertAdjacentElement('afterend', newButton);

                const tempObserver = new MutationObserver((mutations, obs) => {
                    obs.disconnect();
                    console.log(`✅ Loaded page ${expectedPage} via new button`);
                    newButton.remove();
                    callback();
                });
                tempObserver.observe(tableContainer, { childList: true, subtree: true });
                newButton.click();
            } else {
                console.log(`✅ Active page ${Number(activePage)} matches expected page ${Number(expectedPage)}, proceeding with scraping`);
                callback();
            }
        } else {
            console.log(`❌ No active page button found after mutation`);
            callback();
        }
    };

    async function setPageTimeout() {
        clearTimeout(timeoutId);
        console.log(`⏳ Resetting timeout for ${window.tickerSymbol}, new 15s countdown started`);
        timeoutId = setTimeout(async () => {
            console.log(`⏰ 15-second timeout reached for ${window.tickerSymbol} on page `, (pageCounter.value + 1), `retryCount: ${retryCount}`);
            observer?.disconnect();
            document.querySelector(`#dynamic-button`)?.remove();

            if (allAnnouncements.length > 0) {
                console.log(`💾 Saving ${allAnnouncements.length} announcements before retry`);
                await sendBatch(allAnnouncements);
                allAnnouncements = [];
            }

            if (retryCount < maxRetries) {
                retryCount++;
                console.log(`🔄 Retrying page ${pageCounter.value}, attempt ${retryCount} of ${maxRetries}`);

                const expectedPage = String(pageCounter.value);
                const newButton = document.createElement('button');
                newButton.className = 'btn ghost';
                newButton.setAttribute('data-pagination', expectedPage);
                newButton.setAttribute('data-position', '6');
                newButton.id = 'dynamic-button';
                newButton.innerHTML = expectedPage;

                const activeButton = announcementsContainer.querySelector('.btn.ghost.active')
                activeButton.insertAdjacentElement('afterend', newButton);

                await setupObserver();
                newButton.click();
                setPageTimeout();

            } else {
                failedPages.push(pageCounter.value);
                console.log(`❌ Added page`, pageCounter.value, `to failedPages:`, failedPages);
                console.log(`🚨 Max retries (${maxRetries}) reached for page`, pageCounter.value, `moving to next page or finishing`);
                const nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
                if (nextButton) {
                    pageCounter.value++;
                    retryCount = 0;
                    await setupObserver();
                    nextButton.click();
                    setPageTimeout();
                } else if (!isFinished) {
                    isFinished = true;
                    sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
                }
            }
        }, 15000);
    }

    async function proceedWithNextPage() {
        try {
            nextButton = announcementsContainer.querySelector('[data-pagination="next"]:not([disabled])');
            console.log(`Next button status: ${nextButton ? 'Enabled' : 'Not found or disabled'}`);
            if (nextButton && !isFinished) {
                console.log(`➡️ Preparing to click next button for ${window.tickerSymbol}`);

                await setupObserver();
                setPageTimeout();
                nextButton.click();
                console.log(`➡️ Next button clicked for ${window.tickerSymbol}`);
            } else if (!isFinished) {
                if (timeoutId) clearTimeout(timeoutId);
                observer?.disconnect();
                console.log(`🏁 No more pages for ${window.tickerSymbol}`);
                sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
            }
        } catch (error) {
            console.error(`❌ Error in proceedWithNextPage for ${window.tickerSymbol}:`, error);
            if (!isFinished) {
                if (timeoutId) clearTimeout(timeoutId);
                observer?.disconnect();
                sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, allAnnouncements);
            }
        }
    }

    async function sendBatch(batch) {
        return new Promise((resolve) => {
            console.log(`📤 Sending batch of ${batch.length} announcements to background.js`);
            chrome.runtime.sendMessage({ action: "save_announcement_batch", batch }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error("Error sending batch:", chrome.runtime.lastError.message);
                    resolve(false);
                } else {
                    console.log(`✅ Batch saved, response:`, response);
                    resolve(response.success);
                }
            });
        }).catch(error => {
            console.error("❌ sendBatch failed:", error);
            return false;
        });
    }

    async function retryFailedPages() {
        if (failedPages.length === 0) {
            console.log(`✅ No failed pages to retry for ${window.tickerSymbol}`);
            return;
        }

        console.log(`🔄 Retrying ${failedPages.length} failed pages for ${window.tickerSymbol}:`, failedPages);

        const page = failedPages.shift();
        console.log(`🔍 Attempting to scrape failed page ${page}`);

        const newButton = document.createElement('button');
        newButton.className = 'btn ghost';
        newButton.setAttribute('data-pagination', String(page));
        newButton.setAttribute('data-position', '7');
        newButton.id = 'dynamic-button';
        newButton.innerHTML = String(page);

        const activeButton = announcementsContainer.querySelector('.btn.ghost.active');
        activeButton.insertAdjacentElement('afterend', newButton);

        const retryObserver = new MutationObserver(async (mutations, obs) => {
            obs.disconnect();
            newButton.remove();
            console.log(`✅ Loaded failed page ${page} for retry`);

            const activeButtonAfterLoad = announcementsContainer.querySelector('.btn.ghost.active');
            const activePage = activeButtonAfterLoad ? activeButtonAfterLoad.getAttribute('data-pagination') : null;
            if (activePage !== String(page)) {
                console.error(`❌ Active page ${activePage} does not match expected page ${page}, keeping in failedPages`);
                failedPages.unshift(page);
                await retryFailedPages();
                return;
            }

            const newAnnouncements = await scrapeAnnouncementsFromCurrentPage(
                announcementsTableContainer, 
                usedFilenames, 
                existingFiles, 
                { value: page },
                downloadAnnouncements
            );
            allAnnouncements = allAnnouncements.concat(newAnnouncements);
            if (allAnnouncements.length >= batchSize) {
                const batch = allAnnouncements.splice(0, batchSize);
                await sendBatch(batch);
                allAnnouncements = [];
            }

            console.log(`✅ Successfully scraped page ${page}, remaining failedPages:`, failedPages);

            if (failedPages.length > 0) {
                console.log(`🔄 Triggering retry for remaining ${failedPages.length} failed pages`);
                await retryFailedPages();
            }
        });

        retryObserver.observe(announcementsTableContainer, { childList: true, subtree: true });
        retryButton.click();
    }

    function sendFinalScrapedData(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails, announcements) {
        if (isFinished) return;
        isFinished = true;

        const finalAction = async () => {
            if (announcements.length > 0) {
                const success = await sendBatch(announcements);
                if (!success) console.error("Failed to save last batch of announcements");
            }

            await retryFailedPages();

            const scrapedData = {
                transactions,
                director_interests: directorInterests,
                historical_download_url: historicalDownloadUrl,
                company_overview: companyOverview,
                company_details: companyDetails
            };
            console.log(`✅ All announcements processed, sending final data:`, scrapedData);
            chrome.runtime.sendMessage({ action: "scraping_complete", data: scrapedData }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error("Error sending final data:", chrome.runtime.lastError.message);
                } else {
                    console.log("Received final response from background.js:", response);
                }
            });
        };

        finalAction();
    }

    console.log(`🚀 Starting pagination for ${window.tickerSymbol}`);
    proceedWithNextPage();
}

async function waitForBackground() {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 50;
        const checkConnection = () => {
            attempts++;
            console.log(`Pinging background script (attempt ${attempts}/${maxAttempts})`);
            chrome.runtime.sendMessage({ action: "ping" }, (response) => {
                if (chrome.runtime.lastError) {
                    console.log(`Waiting for background script:`, chrome.runtime.lastError.message);
                    if (attempts >= maxAttempts) {
                        reject(new Error("Background script not responding after 5 seconds"));
                    } else {
                        setTimeout(checkConnection, 100);
                    }
                } else {
                    console.log("Background script is ready!");
                    resolve();
                }
            });
        };
        checkConnection();
    }).catch(error => {
        console.error("❌ Failed to connect to background script:", error);
        throw error;
    });
}

async function startScraping() {
    if (!window.tickerSymbol) {
        console.error("❌ No ticker symbol defined, aborting scraping");
        return;
    }
    console.log("🔍 content.js running for", window.tickerSymbol);
    try {
        await waitForBackground();
        const transactions = scrapeTransactions();
        const directorInterests = scrapeDirectorInterests();
        const historicalDownloadUrl = scrapeHistoricalDownloadUrl();
        const companyOverview = scrapeCompanyOverview();
        const companyDetails = scrapeCompanyDetails();
        await scrapeAnnouncements(transactions, directorInterests, historicalDownloadUrl, companyOverview, companyDetails);
    } catch (error) {
        console.error("❌ Scraping aborted:", error);
        chrome.runtime.sendMessage({ action: "scraping_complete", data: {} });
    }
}

// Start the scraping process immediately after injection
startScraping();