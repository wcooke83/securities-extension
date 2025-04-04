(function () {
    // Scrape Director Transactions
    function scrapeDirectorTransactions() {
        let transactions = [];
        let table = document.querySelector("#directors-transactions-root table.mi-table");

        if (!table) {
            console.log("❌ No Director Transactions table found.");
        } else {
            let rows = table.querySelectorAll("tbody tr");
            rows.forEach(row => {
                let cells = row.querySelectorAll("td");
                if (cells.length < 7) return;

                let transaction = {
                    date: cells[0].textContent.trim(),
                    director_name: cells[1].textContent.trim(),
                    transaction_type: cells[2].textContent.trim(),
                    amount: cells[3].textContent.trim(),
                    price: cells[4].textContent.trim(),
                    value: cells[5].textContent.trim(),
                    notes: cells[6].textContent.trim(),
                };
                transactions.push(transaction);
            });
            console.log("✅ Scraped Transactions:", transactions);
        }
        return transactions;
    }

    // Scrape Director Interests
    function scrapeDirectorInterests() {
        let interests = [];
        let table = document.querySelector("#directors-interests-root table.mi-table");

        if (!table) {
            console.log("❌ No Director Interests table found.");
        } else {
            let rows = table.querySelectorAll("tr");
            rows.forEach(row => {
                let cells = row.querySelectorAll("td");
                if (cells.length < 6) return;

                let interest = {
                    director: cells[0].textContent.trim(),
                    last_notice: cells[1].textContent.trim(),
                    direct_shares: cells[2].textContent.trim(),
                    indirect_shares: cells[3].textContent.trim(),
                    options: cells[4].textContent.trim(),
                    convertibles: cells[5].textContent.trim(),
                };
                interests.push(interest);
            });
            console.log("✅ Scraped Director Interests:", interests);
        }
        return interests;
    }

    // Trigger Historical Price Data Download
    function triggerHistoricalDownload() {
        const downloadLink = document.querySelector('a.btn[href*="download-historical-data"]');
        if (downloadLink) {
            console.log("✅ Found historical data download link:", downloadLink.href);
            downloadLink.click(); // Trigger the download
            return downloadLink.href;
        } else {
            console.log("❌ No historical data download link found.");
            return null;
        }
    }

    const transactions = scrapeDirectorTransactions();
    const interests = scrapeDirectorInterests();
    const historicalDownloadUrl = triggerHistoricalDownload();

    chrome.runtime.sendMessage({
        action: "scraping_complete",
        data: {
            ticker: window.tickerSymbol || "UNKNOWN",
            transactions: transactions,
            director_interests: interests,
            historical_download_url: historicalDownloadUrl
        }
    });
})();