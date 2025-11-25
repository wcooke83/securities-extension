import { tickerSymbol } from './constants.js';

export function generateUniqueFilename(tickerSymbol, rawDate, sanitizedHeading, usedFilenames) {
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

export async function fetchFileSize(pdfLink) {
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

export async function getChromeSetting({ action, defaultValue, extractValue, params = {} }) {
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

export function dedupeAnnouncements(announcements, tickerSymbol) {
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

export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}