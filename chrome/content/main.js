import { tickerSymbol, isScraping, tableContainer, tabId } from './constants.js';
import { checkPause } from './pauseResume.js';
import { scrapeTransactions, scrapeDirectorInterests, scrapeHistoricalDownloadUrl, scrapeCompanyOverview, scrapeCompanyDetails, scrapeAnnouncementsFromCurrentPage } from './scrapers.js';
import { fetchAnnouncementsViaApi } from './api.js';
import { sendRuntimeMessage } from './messages.js';

async function startScraping() {
    await checkPause();
    if (isScraping || !tickerSymbol) {
        console.error(`❌ Scraping already in progress or no ticker symbol for ${tickerSymbol}`);
        updateTabStatus("Error: Invalid state");
        return;
    }
    isScraping = true;
    console.log(`🔍 Starting scraping for ${tickerSymbol}`);
    updateTabStatus("Starting");

    try {
        await waitForBackground();
        const config = window.scrapingConfig || {
            apiFetchAnnouncements: true,
            webScrapeAnnouncements: true,
            downloadPdfs: true,
            closeTabs: true
        };
        console.log(`Scraping config: ${JSON.stringify(config, null, 2)}`);

        // Run non-announcement scrapers
        let transactions = scrapeTransactions();
        let directorInterests = scrapeDirectorInterests();
        let historicalDownloadUrl = scrapeHistoricalDownloadUrl();
        let companyOverview = scrapeCompanyOverview();
        let companyDetails = scrapeCompanyDetails();
        updateTabStatus("Scraped other data");

        // Run announcement scrapers based on config
        if (config.apiFetchAnnouncements || config.webScrapeAnnouncements) {
            updateTabStatus("Scraping announcements");
            if (config.apiFetchAnnouncements) {
                await fetchAnnouncementsViaApi(tickerSymbol);
            }
            if (config.webScrapeAnnouncements) {
                await scrapeAnnouncementsFromCurrentPage(tableContainer, [], [], { value: 1 }, true, new Set());
            }
        }

        updateTabStatus("Completed");
        sendRuntimeMessage({ action: "scraping_complete", tickerSymbol, tabId }, (response) => {
            console.log(`[${tickerSymbol}] Scraping complete response:`, JSON.stringify(response, null, 2));
        });
    } catch (error) {
        console.error(`❌ Scraping failed for ${tickerSymbol}: ${error.message}`);
        updateTabStatus(`Error: ${error.message}`);
    } finally {
        isScraping = false;
    }
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

function updateTabStatus(status) {
    sendRuntimeMessage({ action: 'update_tab_status', status, tabId }, null);
}

// Run startScraping only if triggered by background.js
if (window.scrapingConfig) {
    startScraping();
}