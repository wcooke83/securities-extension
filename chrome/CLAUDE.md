# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension for scraping ASX (Australian Stock Exchange) data from marketindex.com.au. Scrapes stock information including director transactions, director interests, company fundamentals, historical price data, and announcements. Data is sent to a Flask backend server that stores it in PostgreSQL.

## Build Commands

```bash
# Build content scripts (webpack bundles content/*.js into dist/content.js)
npm run build

# Run Flask server (requires virtual environment)
source .venv/bin/activate
python server.py

# Install Python dependencies in venv
.venv/bin/pip install -r requirements.txt  # if requirements.txt exists
# or manually: .venv/bin/pip install flask flask-cors psycopg2-binary pandas python-dotenv sqlalchemy
```

## Architecture

### Extension Components

- **background.js**: Service worker managing tab lifecycle, message routing via Chrome ports, ticker queue processing, and server communication. Controls parallel scraping across multiple tabs.
- **popup.html/popup.js**: UI for controlling scraping (start/pause/resume), configuring logging preferences, and monitoring tab states.
- **content/**: Modular content scripts bundled by webpack:
  - `main.js` - Entry point, orchestrates scraping workflow
  - `scrapers.js` - DOM scraping functions for transactions, interests, overview, etc.
  - `api.js` - Fetches announcements via marketindex API
  - `messages.js` - Chrome runtime message handling
  - `pauseResume.js` - Pause/resume state management
  - `constants.js` - Shared constants (ticker symbol, tab ID)
  - `utils.js` - Helper utilities

### Backend (server.py)

Flask server with endpoints:
- `GET /get_tickers` - Returns list of tickers to scrape from database
- `POST /save_data` - Saves scraped data (transactions, interests, historical data, company info)
- `POST /api/announcements_via_dom` - Saves DOM-scraped announcements
- `POST /api/announcements_via_api` - Saves API-fetched announcements
- `GET /api/files/<ticker>` - Returns existing announcement files
- `POST /increment_404_count` - Tracks failed ticker lookups

### Communication Flow

1. Background opens tabs for each ticker from queue
2. Injects content script which establishes port connection to background
3. Content script scrapes page data, sends to background via messages
4. Background forwards data to Flask server
5. Server stores in PostgreSQL (market_instruments, director_transactions, announcements, etc.)

## Key Database Tables

- `market_instruments` - Stock metadata, scrape timestamps, fundamentals
- `director_transactions` - Buy/sell transactions by directors
- `director_interests` - Current shareholdings
- `market_history_as_traded` - Historical OHLCV data
- `announcements` - DOM-scraped announcements
- `announcement_records` - API-fetched announcements with types

## Development Notes

- Extension uses Manifest V3 with service worker
- Content scripts are bundled via webpack (entry: content/main.js -> dist/content.js)
- CORS configured for specific extension ID in server.py
- Logging is configurable per category via popup UI and stored in chrome.storage.local
