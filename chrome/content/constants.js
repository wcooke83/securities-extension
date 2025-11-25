export const apiSaveFetchedAnnouncementMaxRetries = 5;
export const apiSaveFetchedAnnouncementSendBatchSize = 500;
export const apiSaveFetchedAnnouncementSendRetryTime = 30000;
export const apiSaveFetchedAnnouncementFailPause = true;
export const apiFetchAnnouncementMaxRetries = 5;
export const apiFetchAnnouncementRetryTime = 30000;
export const apiFetchAnnouncementFailPause = true;
export const apiFetchAnnouncementTimeout = 30000;
export const apiFetchAnnouncementTimeoutRetryTime = 10000;
export const apiFetchAnnouncementTimeoutMaxRetries = 3;
export const apiFetchAnnouncementTimeoutFailPause = true;
export const scrapedAnnouncementScrapeMaxRetries = 5;
export const scrapedAnnouncementSendBatchMaxRetries = 5;
export const scrapedAnnouncementSendBatchRetryTime = 5000;
export const scrapedAnnouncementSendBatchSize = 100;

export let tabId = window.tabid;
export let tickerSymbol = window.location.pathname.split('/').pop().split('.').shift().toLowerCase();
export const allPdfLinks = new Set();
export let isPaused = false;
export let currentState = 'resumed';
export let isFinished = false;
export let isScraping = false;
export let totalScrapeableAnnouncements = 0;
export let totalAPIFetchedAnnouncements = 0;
export const usedFilenames = [];
export const successfulPages = new Set();
export let failedPages = [];
export let allAnnouncements = [];
export let pageCounter = { value: 1 };

export const announcementsContainer = document.querySelector(`${toValidSelector(tickerSymbol)}-all-announcements`);
export const tableContainer = announcementsContainer?.querySelector('#app-table');

function toValidSelector(id) {
    return `#${id.replace(/^(\d)/, '\\3$1 ')}`;
}