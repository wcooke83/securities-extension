document.addEventListener("DOMContentLoaded", () => {
    chrome.storage.local.get(["maxTabs"], (data) => {
        if (data.maxTabs) document.getElementById("maxTabs").value = data.maxTabs;
    });
});

document.getElementById("start").addEventListener("click", async () => {
    let maxTabs = parseInt(document.getElementById("maxTabs").value);

    chrome.storage.local.set({ maxTabs }); // Save settings
    chrome.runtime.sendMessage({ action: "start_scraping", maxTabs });

    document.getElementById("status").innerText = "Scraping started...";
});

document.getElementById("pause").addEventListener("click", async () => {
    chrome.runtime.sendMessage({ action: "pause_scraping" });
    document.getElementById("status").innerText = "Paused...";
});

document.getElementById("resume").addEventListener("click", async () => {
    chrome.runtime.sendMessage({ action: "resume_scraping" });
    document.getElementById("status").innerText = "Resuming...";
});
