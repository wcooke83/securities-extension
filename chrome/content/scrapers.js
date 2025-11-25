import { tickerSymbol, usedFilenames, allPdfLinks, successfulPages, failedPages, pageCounter, tableContainer } from './constants.js';
import { checkPause } from './pauseResume.js';
import { generateUniqueFilename, fetchFileSize, dedupeAnnouncements } from './utils.js';

export function scrapeTableData(rootSelector, minCells, mapFn) {
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

export function scrapeTransactions() {
    console.log(`🔍 Scraping transactions for ${tickerSymbol}`);
    return scrapeTableData('#directors-transactions-root', 6, (cells) => ({
        date: cells[0].textContent.trim(),
        director: cells[1].textContent.trim(),
        type: cells[2].textContent.trim(),
        quantity: cells[3].textContent.trim().replace(/[^0-9-]/g, ''),
        price: cells[4].textContent.trim().replace(/[^0-9.]/g, ''),
        value: cells[5].textContent.trim().replace(/[^0-9.]/g, ''),
        notes: cells[6]?.textContent.trim() || ''
    }));
}

export function scrapeDirectorInterests() {
    console.log(`🔍 Scraping director interests for ${tickerSymbol}`);
    return scrapeTableData('#directors-interests-root', 6, (cells) => ({
        director: cells[0].textContent.trim(),
        lastNotice: cells[1].textContent.trim(),
        directShares: cells[2].textContent.trim().replace(/[^0-9]/g, '') || '0',
        indirectShares: cells[3].textContent.trim().replace(/[^0-9]/g, '') || '0',
        options: cells[4].textContent.trim().replace(/[^0-9]/g, '') || '0',
        convertibles: cells[5].textContent.trim().replace(/[^0-9]/g, '') || '0'
    }));
}

export function scrapeHistoricalDownloadUrl() {
    console.log(`🔍 Scraping historical download URL for ${tickerSymbol}`);
    const link = document.querySelector('a[href*="/download-historical-data/"]');
    if (link) {
        console.log(`✅ Found historical download URL: ${link.href}`);
        return link.href;
    }
    console.log("❌ No historical download URL found.");
    return null;
}

export function scrapeCompanyOverview() {
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

export function scrapeCompanyDetails() {
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

export async function scrapeAnnouncementsFromCurrentPage(tableContainer, usedFilenames, existingFiles, pageCounter, downloadAnnouncements, successfulPages) {
    await checkPause();
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

function updateTabStatus(status) {
    chrome.runtime.sendMessage({ action: 'update_tab_status', status });
}