# CLAUDE.md - AI Assistant Guide for Securities Extension

**Last Updated:** 2025-11-14
**Project:** ASX Securities Data Scraper Chrome Extension
**Version:** 1.0

---

## Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [File Structure](#file-structure)
4. [Key Components](#key-components)
5. [Development Workflows](#development-workflows)
6. [Communication Patterns](#communication-patterns)
7. [Database Schema](#database-schema)
8. [Common Tasks](#common-tasks)
9. [Code Conventions](#code-conventions)
10. [Debugging & Logging](#debugging--logging)
11. [Important Gotchas](#important-gotchas)

---

## Project Overview

### What This Is
A **Chrome Extension (Manifest V3)** that automates scraping of Australian Securities Exchange (ASX) financial data from MarketIndex.com.au. The extension collects:
- Company fundamentals (market cap, sector, financial ratios)
- Director transactions (insider trading)
- Director interests (shareholdings)
- Company announcements (via API and DOM scraping)
- Historical trading data (OHLCV via CSV downloads)

### Technology Stack
- **Frontend:** Vanilla JavaScript (ES6+), Chrome Extension APIs
- **Backend:** Flask (Python), PostgreSQL, SQLAlchemy
- **Build System:** None (direct file editing, no bundler)
- **External Dependencies:** date-fns.min.js (referenced but not in repo)

### Key Characteristics
- **Multi-tab processing:** 1-10 concurrent scraping tabs
- **Dual data sources:** API fetching + DOM scraping for redundancy
- **Port-based messaging:** Long-lived connections between components
- **Sophisticated pause/resume:** Individual tab and global controls
- **Extensive logging:** 20+ configurable log categories

---

## Architecture

### High-Level Flow
```
User Popup (popup.js)
    ↓ (port connection)
Background Service Worker (background.js)
    ↓ (creates tabs, injects scripts)
Content Scripts (content.js) × N tabs
    ↓ (scrapes data)
Background Service Worker
    ↓ (HTTP POST)
Flask Server (server.py)
    ↓ (saves to)
PostgreSQL Database
```

### Component Responsibilities

| Component | File | Purpose | Lines |
|-----------|------|---------|-------|
| Service Worker | `background.js` | Orchestrates scraping, manages tabs/queue, routes messages | 1,004 |
| Content Script | `content.js` | Performs DOM scraping, handles page interactions | 1,155 |
| Popup UI | `popup.js` | User interface controller, settings management | 530 |
| Backend API | `server.py` | Data persistence, ticker queue management | 631 |
| UI Markup | `popup.html` | Extension popup interface | 163 |

### Communication Architecture
**Port-based messaging** (NOT traditional `chrome.runtime.sendMessage`):
- Each content script connects as `content-{tabId}`
- Popup connects as `popup`
- Supports message callbacks with timeout handling
- Auto-reconnection on disconnection

---

## File Structure

```
/home/user/securities-extension/
├── .git/                          # Git repository
├── .gitignore                     # Ignores chrome/*.log
└── chrome/                        # Main extension directory
    ├── .gitignore                 # Ignores *.log, dist/
    ├── manifest.json              # Extension manifest (MV3)
    ├── icon.png                   # Extension icon (1024×1024)
    ├── popup.html                 # Popup UI
    ├── popup.js                   # Popup controller
    ├── background.js              # Service worker
    ├── content.js                 # Content script
    └── server.py                  # Flask backend
```

**Important:** All working code is in `/home/user/securities-extension/chrome/`

---

## Key Components

### 1. background.js (Service Worker)

**Location:** `/home/user/securities-extension/chrome/background.js`

**Core Responsibilities:**
- Tab lifecycle management (create, monitor, close)
- Ticker queue processing (fetches from `/get_tickers`)
- Message routing between popup and content scripts
- Data forwarding to Flask server
- Download management for CSV files
- Error handling and retry logic

**Key Data Structures:**
```javascript
const tabStates = new Map(); // Track tab status
// Structure: {
//   tabId: number,
//   ticker: string,
//   status: 'idle'|'scraping'|'paused'|'complete'|'error',
//   port: Port,
//   startTime: number
// }

let tickerQueue = []; // Array of ticker symbols
let currentlyProcessing = new Set(); // Active ticker symbols
let maxConcurrentTabs = 3; // Configurable 1-10
```

**Critical Functions:**
- `processNextTicker()` - Main queue processing loop
- `createTabForTicker(ticker)` - Creates tab and injects content script
- `handleMessage(message, port, sendResponse)` - Central message router (20+ actions)
- `sendMessageWithCallback(port, message, callback, timeout)` - Message helper with timeout
- `handleHttpError(error, context)` - HTTP error handler

**Message Actions Handled:**
```javascript
'start_scraping', 'pause_scraping', 'resume_scraping',
'pause_tab', 'resume_tab', 'restart_tab', 'close_tab',
'scraping_complete', 'next_ticker', 'scrape_single_ticker',
'save_scraped_announcement_batch', 'save_api_announcement_batch',
'get_existing_files', 'get_config', 'update_config'
```

**Logging Categories:**
```javascript
// 20+ categories organized in 4 groups:
// - Diagnostic: ErrorHandling, Error, Warning, General, Debug, Notification
// - Operation: Scrape, Server, TickerCompletion, Data, Announcement
// - System: Tab, Port, Config, Retry, Action, Perf, Download
// - Prefix: DateTime, TickerSymbol, TabId, PortName
```

---

### 2. content.js (Content Script)

**Location:** `/home/user/securities-extension/chrome/content.js`

**Core Responsibilities:**
- Scrape company data from MarketIndex.com.au pages
- Fetch announcements via API and DOM
- Handle pagination for announcements
- Manage pause/resume state
- Verify page validity (404 detection)

**Key Classes:**
```javascript
class PauseManager {
  // Sophisticated pause/resume with promise-based state
  pause()  // Pauses execution
  resume() // Resumes execution
  checkPause() // Async wait during pause
}
```

**Scraping Workflow:**
1. **Page Verification** - Checks ticker matches page title/H1
2. **Company Overview** - Market cap, sector, EPS, DPS, book value
3. **Company Details** - Website, auditor, listing date
4. **Director Transactions** - Insider trading activity
5. **Director Interests** - Current shareholdings
6. **Announcements** - Dual method (API + DOM)
7. **Historical Data** - Triggers CSV download

**Announcement Collection:**
```javascript
// Method 1: API Fetch (preferred)
fetch(`https://data-api.marketindex.com.au/companies/${ticker}/announcements`)
// - Faster, more reliable
// - Supports up to 1M announcements
// - Batch sends 500 at a time

// Method 2: DOM Scraping (backup)
// - Paginates through announcement tables
// - Fetches PDF file sizes (5s timeout each)
// - Batch sends 100 at a time
// - Retries failed pages up to 3 times
```

**Data Extraction Helpers:**
```javascript
getTextContent(selector) // Gets trimmed text from element
getNumericValue(selector) // Extracts number from text
getDateValue(selector) // Parses date strings
```

---

### 3. popup.js (UI Controller)

**Location:** `/home/user/securities-extension/chrome/popup.js`

**Core Responsibilities:**
- Render real-time tab status with timers
- Handle user interactions (start/pause/resume)
- Manage configuration settings
- Persist logging preferences
- Ad-hoc single ticker scraping

**Key Features:**
- **Tab Visualization:** Dynamic timer updates every second
- **Individual Tab Controls:** Pause/resume/restart/close per tab
- **Configuration Panel:**
  - Max concurrent tabs (1-10)
  - API fetch toggle
  - Web scrape toggle
  - PDF download toggle
  - Auto-close tabs toggle
- **Logging Preferences:** 20+ categories with group select-all

**State Management:**
```javascript
// Persisted in chrome.storage.local
const loggingPrefs = {
  categories: {
    ErrorHandling: true,
    Error: true,
    // ... 18 more categories
  },
  prefixes: {
    DateTime: true,
    TickerSymbol: true,
    TabId: true,
    PortName: false
  }
};
```

**Timer Format:** `MM:SS` (e.g., "03:45" for 3 minutes 45 seconds)

---

### 4. server.py (Flask Backend)

**Location:** `/home/user/securities-extension/chrome/server.py`

**Environment Variables Required:**
```bash
POSTGRES_HOST=localhost
POSTGRES_USER=pguser
POSTGRES_PASSWORD=pgpass
POSTGRES_DATABASE=securities_db
POSTGRES_PORT=15432
```

**API Endpoints:**

| Method | Endpoint | Purpose | Request Body | Response |
|--------|----------|---------|--------------|----------|
| GET | `/get_tickers` | Get ticker queue | - | `{tickers: ["AAA.AX", ...]}` |
| GET | `/api/files/<ticker>` | Get existing files | - | `{files: [{filename, file_size}]}` |
| POST | `/api/announcements_via_dom` | Save DOM announcements | `{ticker, announcements[]}` | `{status, message}` |
| POST | `/api/announcements_via_api` | Save API announcements | `{ticker, announcements[]}` | `{status, message}` |
| POST | `/save_data` | Save all scraped data | `{ticker, ...data}` | `{status, updates{}}` |

**Key Functions:**
```python
normalize_ticker(ticker)      # Ensures .AX suffix
clean_numeric(value)          # Extracts numbers from strings
clean_date(date_string)       # Parses 13+ date formats
detect_date_format(date_str)  # Auto-detects date format
clean_time(time_string)       # Converts 12-hour to 24-hour
```

**Database Operations:**
- Upsert director transactions (conflict on unique constraint)
- Delete + insert director interests (replaces existing)
- Bulk insert historical data from CSV
- Update timestamps for completed data types

**Logging:**
- File: `server.log`
- Level: WARNING and above
- Format: `%(asctime)s - %(levelname)s - %(message)s`

---

## Database Schema

**Note:** Schema not in repository, inferred from code.

### Core Tables

#### `market_instruments`
```sql
-- Primary ticker information table
ticker VARCHAR(10) PRIMARY KEY
name VARCHAR(255)
market_cap NUMERIC
sector VARCHAR(100)
eps NUMERIC
dps NUMERIC
book_value NUMERIC
shares_issued NUMERIC
company_website VARCHAR(255)
auditor VARCHAR(255)
listing_date DATE
last_scrape_attempt TIMESTAMP
overview_last_updated TIMESTAMP
details_last_updated TIMESTAMP
transactions_last_updated TIMESTAMP
interests_last_updated TIMESTAMP
history_last_updated TIMESTAMP
announcements_last_updated TIMESTAMP
```

#### `director_transactions`
```sql
-- Insider trading records
id SERIAL PRIMARY KEY
ticker VARCHAR(10) REFERENCES market_instruments(ticker)
transaction_date DATE
director_name VARCHAR(255)
transaction_type VARCHAR(50)
quantity INTEGER
price NUMERIC
total_value NUMERIC
UNIQUE (ticker, transaction_date, director_name, transaction_type)
```

#### `director_interests`
```sql
-- Current director shareholdings
id SERIAL PRIMARY KEY
ticker VARCHAR(10) REFERENCES market_instruments(ticker)
director_name VARCHAR(255)
direct_shares BIGINT
indirect_shares BIGINT
options BIGINT
convertibles BIGINT
```

#### `market_history_as_traded`
```sql
-- OHLCV historical trading data
id SERIAL PRIMARY KEY
ticker VARCHAR(10) REFERENCES market_instruments(ticker)
date DATE
open NUMERIC
high NUMERIC
low NUMERIC
close NUMERIC
volume BIGINT
UNIQUE (ticker, date)
```

#### `announcements`
```sql
-- DOM-scraped announcements
id SERIAL PRIMARY KEY
ticker VARCHAR(10) REFERENCES market_instruments(ticker)
announcement_date DATE
announcement_time TIME
announcement_heading TEXT
pdf_link VARCHAR(500) UNIQUE
num_pages INTEGER
price_sensitive BOOLEAN
file_size BIGINT
```

#### `announcement_records`
```sql
-- API-fetched announcements
id SERIAL PRIMARY KEY
ticker VARCHAR(10) REFERENCES market_instruments(ticker)
announcement_id VARCHAR(50) UNIQUE
announcement_date TIMESTAMP
heading TEXT
pdf_link VARCHAR(500)
```

#### `announcement_types`
```sql
-- Classification of announcements
id SERIAL PRIMARY KEY
type_name VARCHAR(100) UNIQUE
```

#### `announcement_type_links`
```sql
-- Many-to-many: announcements ↔ types
announcement_id INTEGER REFERENCES announcement_records(id)
type_id INTEGER REFERENCES announcement_types(id)
PRIMARY KEY (announcement_id, type_id)
```

---

## Development Workflows

### Initial Setup

1. **Clone Repository:**
   ```bash
   git clone <repo-url>
   cd securities-extension
   ```

2. **Install Python Dependencies:**
   ```bash
   pip install flask flask-cors psycopg2 sqlalchemy python-dotenv
   ```

3. **Configure Database:**
   Create `.env` file in `/chrome/` directory:
   ```bash
   POSTGRES_HOST=localhost
   POSTGRES_USER=pguser
   POSTGRES_PASSWORD=pgpass
   POSTGRES_DATABASE=securities_db
   POSTGRES_PORT=15432
   ```

4. **Setup Database Schema:**
   (Schema files not in repo - needs creation or import)

5. **Start Flask Server:**
   ```bash
   cd chrome
   python server.py
   ```
   Server runs on http://127.0.0.1:5000

6. **Load Extension in Chrome:**
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select `/home/user/securities-extension/chrome/` directory
   - Note the extension ID (should match `nkhbkjimmfojklinimpgcgllkeiijmko`)

### Development Iteration

**For JavaScript Changes:**
1. Edit files (`background.js`, `content.js`, `popup.js`)
2. Go to `chrome://extensions/`
3. Click refresh icon on extension card
4. Test in browser

**For Python Changes:**
1. Edit `server.py`
2. Stop server (Ctrl+C)
3. Restart: `python server.py`
4. Test API endpoints

**For UI Changes:**
1. Edit `popup.html` or `popup.js`
2. Reload extension
3. Close and reopen popup to see changes

### Testing Workflow

**No automated tests exist.** Manual testing approach:

1. **Single Ticker Test:**
   - Open extension popup
   - Enter ticker in "Scrape Single Ticker" field
   - Click "Scrape"
   - Monitor console logs (F12 → Console)
   - Check database for saved data

2. **Multi-Ticker Test:**
   - Configure max tabs (start with 1-2)
   - Click "Start Scraping"
   - Monitor tab states in popup
   - Check `server.log` for errors
   - Verify database updates

3. **Error Testing:**
   - Test with invalid ticker
   - Test with network disconnection
   - Test pause/resume functionality
   - Test tab restart/close

**Debugging Tools:**
- **Browser Console:** `F12` → Console (for content.js logs)
- **Extension Service Worker Console:**
  - `chrome://extensions/` → "Service worker" link (for background.js)
- **Server Logs:** `tail -f chrome/server.log`
- **Network Tab:** Monitor API calls and responses

---

## Communication Patterns

### Port-Based Messaging

**Establishing Connection:**
```javascript
// Content Script → Background
const port = chrome.runtime.connect({ name: `content-${tabId}` });

// Popup → Background
const port = chrome.runtime.connect({ name: 'popup' });

// Background receives
chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith('content-')) { /* ... */ }
  if (port.name === 'popup') { /* ... */ }
});
```

**Sending Messages:**
```javascript
// With callback and timeout
sendMessageWithCallback(port, {
  action: 'get_existing_files',
  ticker: 'AAA.AX'
}, (response) => {
  console.log(response.files);
}, 30000); // 30s timeout

// Simple send
port.postMessage({
  action: 'scraping_complete',
  ticker: 'AAA.AX'
});
```

**Message Structure:**
```javascript
{
  action: string,           // Required: action type
  ticker?: string,          // Optional: ticker symbol
  data?: any,              // Optional: payload
  tabId?: number,          // Optional: tab identifier
  callbackId?: string,     // Auto-added for callbacks
  ...additionalFields
}
```

**Handling Disconnection:**
```javascript
port.onDisconnect.addListener(() => {
  console.log('Port disconnected');
  // Auto-reconnect logic in background.js
  // Reloads tab and re-injects content script
});
```

### Message Actions Reference

**From Popup to Background:**
- `start_scraping` - Begin scraping process
- `pause_scraping` - Pause all tabs
- `resume_scraping` - Resume all tabs
- `pause_tab` - Pause specific tab
- `resume_tab` - Resume specific tab
- `restart_tab` - Restart specific tab
- `close_tab` - Close specific tab
- `scrape_single_ticker` - Ad-hoc single ticker
- `get_config` - Retrieve current config
- `update_config` - Update configuration

**From Content to Background:**
- `scraping_complete` - Finished scraping ticker
- `save_scraped_announcement_batch` - Save DOM announcements
- `save_api_announcement_batch` - Save API announcements
- `get_existing_files` - Request existing announcement files
- `error` - Report error

**From Background to Content:**
- `pause` - Pause scraping
- `resume` - Resume scraping
- `start_scraping` - Begin scraping (with ticker)

---

## Common Tasks

### Adding a New Data Point to Scrape

1. **Modify content.js:**
   ```javascript
   // In scrapeCompanyData() function
   const newField = getTextContent('.new-selector');

   // Add to data object
   const data = {
     ticker,
     // ... existing fields
     newField: newField
   };
   ```

2. **Modify server.py:**
   ```python
   # In /save_data endpoint
   new_field = data.get('newField')

   # Add to SQL UPDATE
   UPDATE market_instruments
   SET new_field = %s
   WHERE ticker = %s
   ```

3. **Update database schema:**
   ```sql
   ALTER TABLE market_instruments
   ADD COLUMN new_field VARCHAR(255);
   ```

### Adding a New Message Action

1. **In background.js:**
   ```javascript
   function handleMessage(message, port, sendResponse) {
     const { action } = message;

     if (action === 'new_action') {
       // Handle new action
       log('Action', `Handling new_action`);
       sendResponse({ status: 'success' });
       return;
     }

     // ... existing actions
   }
   ```

2. **In sender (content.js or popup.js):**
   ```javascript
   port.postMessage({
     action: 'new_action',
     ticker: currentTicker,
     data: someData
   });
   ```

### Adding a New Configuration Option

1. **In popup.html:**
   ```html
   <label>
     <input type="checkbox" id="newOption" />
     New Option Description
   </label>
   ```

2. **In popup.js:**
   ```javascript
   // Load config
   chrome.storage.local.get(['config'], (result) => {
     if (result.config?.newOption !== undefined) {
       document.getElementById('newOption').checked = result.config.newOption;
     }
   });

   // Save config
   document.getElementById('updateConfig').addEventListener('click', () => {
     const config = {
       // ... existing options
       newOption: document.getElementById('newOption').checked
     };
     chrome.storage.local.set({ config });
   });
   ```

3. **In background.js:**
   ```javascript
   // Access in relevant function
   chrome.storage.local.get(['config'], (result) => {
     const newOption = result.config?.newOption ?? false;
     if (newOption) {
       // Apply option
     }
   });
   ```

### Adding a New Flask Endpoint

1. **In server.py:**
   ```python
   @app.route('/api/new_endpoint', methods=['POST'])
   def new_endpoint():
       try:
           data = request.get_json()
           ticker = data.get('ticker')

           # Process data
           cursor = db_connection.cursor()
           cursor.execute(
               "INSERT INTO table (ticker, field) VALUES (%s, %s)",
               (ticker, value)
           )
           db_connection.commit()

           return jsonify({
               'status': 'success',
               'message': 'Data saved'
           })
       except Exception as e:
           app.logger.error(f'Error in new_endpoint: {str(e)}')
           return jsonify({
               'status': 'error',
               'message': str(e)
           }), 500
   ```

2. **In background.js:**
   ```javascript
   async function callNewEndpoint(ticker, data) {
     try {
       const response = await fetch('http://127.0.0.1:5000/api/new_endpoint', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ ticker, data })
       });
       return await response.json();
     } catch (error) {
       handleHttpError(error, 'callNewEndpoint');
     }
   }
   ```

---

## Code Conventions

### JavaScript Style

**Naming Conventions:**
- `camelCase` for variables and functions
- `PascalCase` for classes
- `UPPER_SNAKE_CASE` for constants
- Descriptive names (e.g., `processNextTicker`, not `processNext`)

**Logging Pattern:**
```javascript
// Always check logging preferences before logging
function log(category, message, level = 'log') {
  chrome.storage.local.get(['loggingPrefs'], (result) => {
    const prefs = result.loggingPrefs || {};
    if (!prefs.categories?.[category]) return;

    let prefix = '';
    if (prefs.prefixes?.DateTime) prefix += `[${new Date().toISOString()}] `;
    if (prefs.prefixes?.TickerSymbol && ticker) prefix += `[${ticker}] `;

    console[level](prefix + message);
  });
}

// Usage
log('Scrape', 'Starting to scrape company data');
log('Error', 'Failed to fetch announcements', 'error');
```

**Error Handling Pattern:**
```javascript
try {
  // Risky operation
  const result = await fetchData();
} catch (error) {
  log('Error', `Failed to fetch: ${error.message}`, 'error');

  // Decide: retry, prompt user, or continue
  if (shouldRetry) {
    setTimeout(() => retryOperation(), 5000);
  } else {
    chrome.notifications.create({
      type: 'basic',
      title: 'Error',
      message: error.message
    });
  }
}
```

**Async/Await Preference:**
- Use async/await over promise chains
- Always wrap in try/catch
- Handle rejection explicitly

**Data Validation:**
```javascript
// Always validate external data
function processTickerData(data) {
  if (!data || typeof data !== 'object') {
    log('Error', 'Invalid data received', 'error');
    return null;
  }

  const ticker = data.ticker?.trim();
  if (!ticker || !ticker.endsWith('.AX')) {
    log('Warning', `Invalid ticker: ${ticker}`, 'warn');
    return null;
  }

  return { ticker, ...data };
}
```

### Python Style

**Naming Conventions:**
- `snake_case` for functions and variables
- `PascalCase` for classes
- `UPPER_SNAKE_CASE` for constants

**Database Error Handling:**
```python
try:
    cursor.execute(sql, params)
    db_connection.commit()
except psycopg2.IntegrityError as e:
    db_connection.rollback()
    app.logger.error(f'Integrity error: {str(e)}')
    return jsonify({'status': 'error', 'message': 'Duplicate entry'}), 409
except Exception as e:
    db_connection.rollback()
    app.logger.error(f'Database error: {str(e)}')
    return jsonify({'status': 'error', 'message': str(e)}), 500
```

**Data Cleaning:**
```python
# Always clean user input
def clean_numeric(value):
    """Extract numeric value from string with units/formatting."""
    if not value:
        return None
    # Remove currency symbols, commas, units
    cleaned = re.sub(r'[^\d.-]', '', str(value))
    try:
        return float(cleaned)
    except ValueError:
        return None
```

### SQL Conventions

**Always use parameterized queries:**
```python
# Good
cursor.execute(
    "INSERT INTO table (col1, col2) VALUES (%s, %s)",
    (val1, val2)
)

# Bad (SQL injection risk)
cursor.execute(f"INSERT INTO table (col1, col2) VALUES ('{val1}', '{val2}')")
```

**Use transactions for multi-step operations:**
```python
try:
    cursor.execute("DELETE FROM director_interests WHERE ticker = %s", (ticker,))
    for interest in interests:
        cursor.execute("INSERT INTO director_interests ...", params)
    db_connection.commit()
except:
    db_connection.rollback()
    raise
```

---

## Debugging & Logging

### Logging System

**20+ Log Categories:**

**Diagnostic Group:**
- `ErrorHandling` - Error handling flows
- `Error` - Actual errors
- `Warning` - Warnings
- `General` - General information
- `Debug` - Debug information
- `Notification` - User notifications

**Operation Group:**
- `Scrape` - Scraping operations
- `Server` - Server communication
- `TickerCompletion` - Ticker completion events
- `Data` - Data processing
- `Announcement` - Announcement handling

**System Group:**
- `Tab` - Tab lifecycle
- `Port` - Port connections
- `Config` - Configuration changes
- `Retry` - Retry attempts
- `Action` - Message actions
- `Perf` - Performance metrics
- `Download` - Download events

**Prefix Options:**
- `DateTime` - ISO timestamp
- `TickerSymbol` - Current ticker
- `TabId` - Tab identifier
- `PortName` - Port name

### Debugging Locations

**Content Script Logs:**
```
1. Open the page being scraped
2. Press F12 (Developer Tools)
3. Go to Console tab
4. Filter by "content" or ticker symbol
```

**Background Script Logs:**
```
1. Go to chrome://extensions/
2. Find "ASX Scraper"
3. Click "service worker" link (blue text)
4. Console opens showing background.js logs
```

**Popup Script Logs:**
```
1. Open extension popup
2. Right-click in popup
3. Select "Inspect"
4. Console shows popup.js logs
```

**Server Logs:**
```bash
# Real-time monitoring
tail -f /home/user/securities-extension/chrome/server.log

# View last 50 lines
tail -n 50 /home/user/securities-extension/chrome/server.log

# Search for errors
grep ERROR /home/user/securities-extension/chrome/server.log
```

### Common Debugging Scenarios

**Tab Not Scraping:**
1. Check background script console for injection errors
2. Verify ticker exists in queue
3. Check tab state in `tabStates` Map
4. Look for port disconnection messages
5. Verify MarketIndex.com.au is accessible

**Data Not Saving:**
1. Check server logs for database errors
2. Verify Flask server is running (curl http://127.0.0.1:5000/get_tickers)
3. Check network tab for failed requests
4. Verify database connection in server.py
5. Check for SQL constraint violations

**Announcements Not Fetching:**
1. Check API response (network tab)
2. Verify deduplication isn't skipping all files
3. Check for pagination issues in DOM scraping
4. Look for timeout errors (5s file size timeout)
5. Verify `announcements_api_fetch` config is enabled

**Pause/Resume Not Working:**
1. Check PauseManager state in content script
2. Verify port connection is active
3. Look for message delivery failures
4. Check if tab is actually paused vs. waiting

---

## Important Gotchas

### 1. Port Disconnection
**Issue:** Ports disconnect if content script is removed/reloaded.

**Solution:** Background script automatically detects disconnection and reloads tab:
```javascript
port.onDisconnect.addListener(() => {
  log('Port', `Port disconnected for tab ${tabId}`);
  // Reload tab after 30s
  setTimeout(() => {
    chrome.tabs.reload(tabId);
  }, 30000);
});
```

**Implication:** Scraping will resume after 30s, but state is lost. Design scrapers to be idempotent.

### 2. Service Worker Lifecycle
**Issue:** Background script (service worker) can be terminated by Chrome after inactivity.

**Current State:** Extension keeps service worker alive via active ports and periodic messages.

**Implication:** Don't rely on long-lived variables. Use `chrome.storage.local` for persistence.

### 3. CSV Download Timing
**Issue:** Historical data CSV downloads trigger Chrome's download manager, which is asynchronous.

**Solution:** Download triggered in content script, but data extraction happens separately:
```javascript
// content.js triggers download
const downloadUrl = getHistoricalDownloadUrl();
port.postMessage({ action: 'trigger_download', url: downloadUrl, ticker });

// background.js monitors downloads
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete') {
    // Process CSV file
  }
});
```

**Implication:** Historical data may be saved slightly after other data. Check timestamps.

### 4. Date Format Variations
**Issue:** MarketIndex.com.au uses 13+ different date formats.

**Solution:** `clean_date()` in server.py handles many formats, but new formats may appear.

**When Adding Features:** Always test with multiple tickers. Date formats vary by company.

### 5. Extension ID Hardcoded
**Issue:** CORS in server.py hardcodes extension ID:
```python
CORS(app, resources={r"/api/*": {"origins": [
    "chrome-extension://nkhbkjimmfojklinimpgcgllkeiijmko"
]}})
```

**Implication:** If extension is reinstalled/reloaded with new ID, CORS will block requests.

**Solution:** Update `server.py` with new extension ID, or use wildcard for development:
```python
CORS(app, resources={r"/api/*": {"origins": "*"}})
```

### 6. Ticker Format Normalization
**Issue:** Tickers may be provided as "AAA" or "AAA.AX".

**Solution:** Always use `normalize_ticker()` in server.py:
```python
ticker = normalize_ticker(data.get('ticker'))  # Ensures .AX suffix
```

**Implication:** Database expects `.AX` format. Never store tickers without suffix.

### 7. Race Conditions in Tab Creation
**Issue:** Multiple tabs may attempt to scrape same ticker if queue processing is too fast.

**Solution:** `currentlyProcessing` Set prevents duplicates:
```javascript
if (currentlyProcessing.has(ticker)) {
  log('Warning', `Ticker ${ticker} already being processed`);
  return;
}
currentlyProcessing.add(ticker);
```

**Implication:** Safe to increase `maxConcurrentTabs`, but monitor for edge cases.

### 8. Database Connection Pooling
**Issue:** Flask server creates single database connection, not a pool.

**Current Code:**
```python
db_connection = psycopg2.connect(...)
```

**Implication:** Single connection may become bottleneck under high concurrency.

**Future Improvement:** Use SQLAlchemy connection pooling (already imported but not used).

### 9. No Build Process
**Issue:** No webpack/bundler means no transpilation, minification, or module system.

**Implication:**
- Cannot use npm packages without CDN links
- Cannot use TypeScript
- Cannot use modern JS features unsupported by Chrome
- File size larger than necessary

**If Adding Dependencies:** Use CDN links in HTML or vendor the file.

### 10. Missing External Dependency
**Issue:** `popup.html` references `date-fns.min.js` but file not in repository:
```html
<script src="date-fns.min.js"></script>
```

**Current Impact:** Unclear if date-fns is actually used. No obvious date formatting in popup.js.

**If Errors Occur:** Download from https://cdn.jsdelivr.net/npm/date-fns/index.min.js

---

## Common Pitfalls to Avoid

### When Modifying Code

1. **Don't break port connections** - Always maintain port.postMessage structure
2. **Don't forget to reload extension** - Chrome doesn't auto-reload on file changes
3. **Don't skip database rollback** - Always rollback on SQL errors
4. **Don't assume page structure** - MarketIndex.com.au may change HTML anytime
5. **Don't hardcode timeouts** - Use configurable values from config
6. **Don't forget logging** - Every significant operation should log
7. **Don't skip error handling** - Network/DOM operations can always fail
8. **Don't mutate shared state** - Use immutable patterns or deep clones
9. **Don't use sendMessage** - This codebase uses port-based messaging exclusively
10. **Don't commit secrets** - Database credentials via .env, not hardcoded

### When Adding Features

1. **Test with multiple tickers** - Data formats vary significantly
2. **Handle missing data gracefully** - Not all companies have all fields
3. **Update all three contexts** - background.js, content.js, popup.js often need coordinated changes
4. **Consider pause state** - New async operations should respect PauseManager
5. **Document message actions** - Add to message actions reference above
6. **Add logging category if needed** - Don't overload existing categories
7. **Test port disconnection** - Close/reload tabs mid-scrape to verify recovery
8. **Check database schema** - Ensure columns exist before saving data
9. **Validate input** - Never trust scraped data or user input
10. **Consider retry logic** - Network operations should retry before failing

---

## Quick Reference

### File Paths
```
Extension Root:     /home/user/securities-extension/
Chrome Extension:   /home/user/securities-extension/chrome/
Background Script:  /home/user/securities-extension/chrome/background.js
Content Script:     /home/user/securities-extension/chrome/content.js
Popup Controller:   /home/user/securities-extension/chrome/popup.js
Popup UI:           /home/user/securities-extension/chrome/popup.html
Flask Server:       /home/user/securities-extension/chrome/server.py
Manifest:           /home/user/securities-extension/chrome/manifest.json
Server Logs:        /home/user/securities-extension/chrome/server.log
```

### URLs
```
MarketIndex URL:    https://www.marketindex.com.au/asx/{ticker}
API Endpoint:       https://data-api.marketindex.com.au/companies/{ticker}/announcements
Flask Server:       http://127.0.0.1:5000
Extension Page:     chrome://extensions/
```

### Key Commands
```bash
# Start Flask server
cd /home/user/securities-extension/chrome && python server.py

# Monitor server logs
tail -f /home/user/securities-extension/chrome/server.log

# Install Python dependencies
pip install flask flask-cors psycopg2 sqlalchemy python-dotenv

# Load extension (manual via Chrome UI)
# chrome://extensions/ → Load unpacked → select chrome/ directory
```

### Configuration Defaults
```
Max Concurrent Tabs:        3
API Fetch Enabled:          true
Web Scrape Enabled:         true
PDF Download Enabled:       false
Auto-close Tabs Enabled:    true
Port:                       5000
Database Port:              15432
Retry Timeout:              30000ms
Download Timeout:           300000ms (5 min)
File Size Timeout:          5000ms
```

---

## Recent Changes (Git Log)

```
47b75bc - Adding timer for ticker processing duration
1f8827a - Adding adhoc process for single ticker
ae541db - Working, commit before adding adhoc process for single ticker
8490965 - Change messaging system to use ports, working
dbe4ce0 - Working before move to webpack
```

**Key Insight:** Recent work focused on:
- Performance monitoring (timers)
- Ad-hoc ticker scraping
- Migration to port-based messaging
- Webpack consideration (but not implemented)

---

## Future Considerations

### Potential Improvements
1. **Add TypeScript** - Type safety would prevent many runtime errors
2. **Implement testing** - Jest for JS, pytest for Python
3. **Connection pooling** - Use SQLAlchemy pools for database
4. **Build system** - Webpack for bundling and optimization
5. **Error recovery** - More sophisticated retry with exponential backoff
6. **Progress persistence** - Save queue state to survive service worker termination
7. **Rate limiting** - Avoid overwhelming MarketIndex.com.au
8. **Duplicate detection** - Check database before scraping (avoid re-scraping)
9. **Schema versioning** - Alembic migrations for database changes
10. **Production deployment** - Remote server instead of localhost

### Known Limitations
- No pagination for director transactions (assumes all fit on first page)
- Single database connection (no pooling)
- No rate limiting (could get IP blocked)
- No incremental updates (always full scrape)
- CSV download requires manual processing (not automated)
- date-fns.min.js missing from repository
- Extension ID hardcoded in CORS
- No automated tests
- No CI/CD pipeline
- No production deployment strategy

---

## Conclusion

This is a sophisticated Chrome extension with well-structured communication patterns, robust error handling, and comprehensive logging. The port-based messaging architecture is more complex than typical extensions but provides better control for long-running operations.

When working with this codebase:
1. **Always test with real data** - Scraping is unpredictable
2. **Check all three contexts** - background, content, popup
3. **Monitor logs religiously** - Debugging without logs is painful
4. **Respect the pause/resume system** - It's carefully designed
5. **Validate everything** - Web scraping requires defensive programming

The code is generally well-organized and commented. The main complexity lies in the state management across multiple tabs and the dual announcement collection system. Understanding the port-based messaging is key to making any significant changes.

---

**For Questions or Issues:**
- Check browser console (F12)
- Check service worker console (chrome://extensions/)
- Check server.log file
- Review this document's debugging section
- Test with single ticker first, then scale to multiple

**Last Updated:** 2025-11-14 by AI Assistant (Claude)
