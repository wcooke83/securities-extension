(function () {
    function scrapeDirectorTransactions() {
        let transactions = [];
        let table = document.querySelector("#directors-transactions-root table.mi-table");

        if (!table) {
            console.log("❌ No Director Transactions table found.");
        } else {
            let rows = table.querySelectorAll("tbody tr");
            rows.forEach(row => {
                let cells = row.querySelectorAll("td");
                if (cells.length < 7) return; // Ensure all columns exist

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

        // Send data to background.js with the expected action
        chrome.runtime.sendMessage({
            action: "scraping_complete",
            data: {
                ticker: window.tickerSymbol || "UNKNOWN",
                transactions: transactions
            }
        });
    }

    scrapeDirectorTransactions();
})();