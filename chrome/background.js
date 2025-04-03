// Global state variables
let isRunning = false;
let isPaused = false;
let currentMaxTabs = 0;
let activeTabs = new Set();
let tickerQueue = [];
let tabsToCloseGracefully = new Set();

chrome.storage.local.get(["maxTabs"], (data) => {
    if (data.maxTabs) currentMaxTabs = data.maxTabs;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "start_scraping") {
        const newMaxTabs = message.maxTabs;

        if (!isRunning) {
            // First time starting
            isRunning = true;
            currentMaxTabs = newMaxTabs;
            fetchTickersAndStartScraping();
            console.log(`✅ Scraping started with ${currentMaxTabs} tabs`);
        } else {
            // Scraping is already running, adjust tabs
            currentMaxTabs = newMaxTabs;
            adjustTabs();
            console.log(`🔄 Adjusted to ${currentMaxTabs} tabs`);
        }
    } else if (message.action === "pause_scraping") {
        isPaused = true;
        console.log("Scraping paused.");
    } else if (message.action === "resume_scraping") {
        isPaused = false;
        console.log("Scraping resumed.");
        processTickerQueue(message.delay); // Resume processing only if needed
    } 
    // else if (message.action === "save_data") {
    //     saveScrapedData(message.tickerSymbol, message.data);
    // }
});

// Save scraped data to server
async function saveScrapedData(tickerSymbol, data) {
    try {
        const response = await fetch("http://127.0.0.1:5000/save_data", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tickerSymbol, data })
        });
        const result = await response.json();
        console.log(`✅ ${tickerSymbol} Data saved:`, result);
    } catch (error) {
        console.error(`❌ Error saving data for ${tickerSymbol}:`, error);
    }
}

// Fetch tickers and initialize the queue
async function fetchTickersAndStartScraping() {
    try {
        let response = await fetch("http://127.0.0.1:5000/get_tickers");
        tickerQueue = await response.json();
        console.log("Initial ticker queue:", tickerQueue);
        await adjustTabs();
    } catch (error) {
        console.error("Error fetching tickers:", error);
    }
}

// Process the ticker queue by initializing tabs
async function processTickerQueue(delay) {
    if (isPaused) {
        console.log("⏸️ Scraping is paused.");
        return;
    }

    const tabPromises = [];
    const targetTabs = currentMaxTabs;
    const currentActive = activeTabs.size;

    if (currentActive < targetTabs) {
        const tabsToCreate = targetTabs - currentActive;
        for (let i = 0; i < tabsToCreate; i++) {
            let tab = await chrome.tabs.create({ url: "about:blank", active: false });
            activeTabs.add(tab.id);
            console.log(`🌟 Created tab ${tab.id} for processing`);
            tabPromises.push(processTab(tab.id));
        }
    }

    if (tabPromises.length > 0) {
        await Promise.all(tabPromises);
        console.log("✅ All newly created tabs have finished processing.");
    }
}

// Process a single tab's ticker queue
async function processTab(tabId) {
    while (tickerQueue.length > 0) {
        let ticker;
        try {
            if (isPaused) {
                await new Promise((resolve) => {
                    const listener = (message) => {
                        if (message.action === "resume_scraping") {
                            chrome.runtime.onMessage.removeListener(listener);
                            resolve();
                        }
                    };
                    chrome.runtime.onMessage.addListener(listener);
                });
            }

            ticker = tickerQueue.shift();
            let url = `https://www.marketindex.com.au/asx/${ticker}`;
            console.log(`🚀 Updating tab ${tabId} for ${ticker}`);

            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab) {
                console.log(`Tab ${tabId} no longer exists. Stopping...`);
                activeTabs.delete(tabId);
                tabsToCloseGracefully.delete(tabId);
                return;
            }

            await chrome.tabs.update(tabId, { url });
            await waitForTabLoad(tabId);

            let { isCloudflare, hasExpectedContent } = await checkTabContent(tabId);
            if (isCloudflare) {
                console.log("Cloudflare detected. Waiting for content...");
                let success = await waitForExpectedContent(tabId);
                if (!success) {
                    console.log("Cloudflare didn’t resolve. Skipping...");
                    continue;
                }
                ({ hasExpectedContent } = await checkTabContent(tabId));
            }

            if (hasExpectedContent) {
                const scrapedData = await executeScraping(tabId, ticker);
                await saveScrapedData(ticker, scrapedData.transactions);
                console.log(`Scraped and saved data for ${ticker}:`, scrapedData);
            } else {
                console.log(`Expected content not found for ${ticker}. Skipping...`);
            }

            // Check if this tab should close gracefully after this scrape
            if (tabsToCloseGracefully.has(tabId)) {
                console.log(`🛑 Tab ${tabId} finished current scrape, closing gracefully`);
                activeTabs.delete(tabId);
                tabsToCloseGracefully.delete(tabId);
                chrome.tabs.remove(tabId);
                return; // Exit the loop and stop processing
            }
        } catch (error) {
            console.error(`Error in tab ${tabId} for ticker ${ticker || "unknown"}:`, error);
            // If marked for closure, close even on error to avoid stalling
            if (tabsToCloseGracefully.has(tabId)) {
                console.log(`🛑 Tab ${tabId} errored, closing gracefully`);
                activeTabs.delete(tabId);
                tabsToCloseGracefully.delete(tabId);
                chrome.tabs.remove(tabId);
                return;
            }
        }
    }
    console.log(`✅ Tab ${tabId} finished processing queue`);
    activeTabs.delete(tabId);
    chrome.tabs.remove(tabId);
}

// Adjust the number of active tabs based on currentMaxTabs
async function adjustTabs() {
    const targetTabs = currentMaxTabs;
    const currentActive = activeTabs.size;

    if (currentActive < targetTabs) {
        const tabsToCreate = targetTabs - currentActive;
        for (let i = 0; i < tabsToCreate; i++) {
            let tab = await chrome.tabs.create({ url: "about:blank", active: false });
            activeTabs.add(tab.id);
            console.log(`🌟 Created tab ${tab.id} for processing`);
            processTab(tab.id);
        }
    } else if (currentActive > targetTabs) {
        const tabsToClose = Array.from(activeTabs).slice(targetTabs);
        for (let tabId of tabsToClose) {
            tabsToCloseGracefully.add(tabId); // Mark for closure after current scrape
            console.log(`⏳ Tab ${tabId} marked to close gracefully after current scrape`);
        }
    }
}

// Execute scraping in the tab
async function executeScraping(tabId, tickerSymbol) {
    console.log(`🔍 Executing scraping for ${tickerSymbol} (Tab ID: ${tabId})`);
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (ticker) => { window.tickerSymbol = ticker; },
            args: [tickerSymbol]
        });

        const scrapedData = await Promise.race([
            new Promise((resolve) => {
                chrome.runtime.onMessage.addListener(function handler(message, sender) {
                    if (message.action === "scraping_complete" && sender.tab.id === tabId) {
                        chrome.runtime.onMessage.removeListener(handler);
                        resolve(message.data);
                    }
                });
                chrome.scripting.executeScript({
                    target: { tabId },
                    files: ["content.js"]
                }).catch(err => console.error(`❌ Failed to inject content.js:`, err));
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Scraping timeout")), 30000))
        ]);

        return scrapedData;
    } catch (error) {
        console.error(`🚨 Error during scraping for ${tickerSymbol}:`, error);
        throw error;
    }
}

// Helper function to wait for a tab to load
async function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.onUpdated.addListener(function listener(tabIdUpdated, info) {
            if (tabIdUpdated === tabId && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        });
    });
}

// Helper function to wait for a specified time
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Check tab content for Cloudflare or expected elements with retries
async function checkTabContent(tabId) {
    const maxAttempts = 10;
    let attempt = 1;

    while (attempt <= maxAttempts) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    return {
                        isCloudflare: document.title.includes("Just a moment"),
                        hasExpectedContent: !!document.querySelector("#directors-transactions-root")
                    };
                }
            });

            const result = results[0].result;
            console.log(`Attempt ${attempt} for tab ${tabId}:`, result);

            // If we get a definitive result, return it
            if (result.isCloudflare || result.hasExpectedContent) {
                return result;
            }

            // If it's the last attempt, return the final result
            if (attempt === maxAttempts) {
                console.log(`Max attempts (${maxAttempts}) reached for tab ${tabId}`);
                return result;
            }

            // Wait 1 second before the next attempt
            await delay(1000);
            attempt++;
        } catch (error) {
            console.error(`Error checking tab ${tabId} content on attempt ${attempt}:`, error);
            
            // If it's the last attempt, return default values
            if (attempt === maxAttempts) {
                return { isCloudflare: false, hasExpectedContent: false };
            }

            // Wait 1 second before retrying
            await delay(1000);
            attempt++;
        }
    }

    // Fallback return (shouldn't reach here due to while loop logic)
    return { isCloudflare: false, hasExpectedContent: false };
}

// Wait for Cloudflare to resolve
async function waitForExpectedContent(tabId) {
    const MAX_ATTEMPTS = 20;
    const CHECK_INTERVAL = 2000;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
        const { hasExpectedContent } = await checkTabContent(tabId);
        if (hasExpectedContent) {
            console.log(`Cloudflare resolved after ${attempts} attempts`);
            return true;
        }
    }
    console.log(`Cloudflare timeout after ${MAX_ATTEMPTS} attempts`);
    return false;
}

// Unused functions from your original code (left as-is)
function cleanupTab(tabId) {
    chrome.tabs.remove(tabId, () => {
        if (!chrome.runtime.lastError) {
            console.log(`🛑 Closed tab ${tabId} due to exceptional case`);
        }
    });
}

async function waitForCloudflare(tabId, ticker) {
    const MAX_ATTEMPTS = 20;
    const CHECK_INTERVAL = 2000;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL));
        const { hasExpectedContent } = await checkTabContent(tabId);
        if (hasExpectedContent) {
            return true;
        }
    }
    return false;
}

async function waitForResume() {
    while (isPaused) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}