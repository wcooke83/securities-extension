import os
import re
import psycopg2
import logging
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv
from sqlalchemy import create_engine
from psycopg2.extras import execute_values

logging.basicConfig(
    filename=f"{os.path.splitext(os.path.basename(__file__))[0]}.log",
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "chrome-extension://nkhbkjimmfojklinimpgcgllkeiijmko"}})
logger.info("CORS initialized with origin: chrome-extension://nkhbkjimmfojklinimpgcgllkeiijmko")

# Database Configuration
def db_connect():
    POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
    POSTGRES_USER = os.getenv("POSTGRES_USER", "pguser")
    POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "pgpass")
    POSTGRES_DB = os.getenv("POSTGRES_DATABASE", "securities_db")
    POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", 15432))

    DB_URL = f"postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"
    return create_engine(DB_URL)

engine = db_connect()

@app.route("/get_tickers", methods=["GET"])
def get_tickers():
    conn = None
    try:
        logger.info("Fetching ticker symbols...")
        conn = engine.raw_connection()
        cursor = conn.cursor()

        query = '''SELECT DISTINCT LEFT(i.ticker_symbol, POSITION('.' IN i.ticker_symbol) - 1) AS symbol, i.last_scrape_attempt 
                    FROM market_instruments i
                    WHERE i.is_active = TRUE 
                    AND i.instrument_type = 'stock' 
                    AND i.ticker_symbol LIKE '%.AX'
                    ORDER BY i.last_scrape_attempt DESC, symbol ASC;'''
        cursor.execute(query)
        tickers = [row[0] for row in cursor.fetchall()]
        logger.info(f"Fetched {len(tickers)} tickers.")

        cursor.close()
        conn.close()
        return jsonify(tickers)

    except Exception as e:
        logger.error(f"Error fetching tickers: {e}")
        if conn is not None:
            conn.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            try:
                conn.close()
                logger.info("Connection closed in get_tickers.")
            except Exception as e:
                logger.error(f"Error closing connection in get_tickers: {e}")

@app.route("/api/files/<tickerSymbol>", methods=["GET"])
def get_existing_files(tickerSymbol):
    conn = None
    try:
        logger.info(f"Fetching existing files for {tickerSymbol}")
        conn = engine.raw_connection()
        cursor = conn.cursor()

        query = """
            SELECT filename, file_size 
            FROM announcements 
            WHERE ticker_symbol = %s
        """
        cursor.execute(query, (f"{tickerSymbol}.AX",))
        files = [{"filename": row[0], "file_size": row[1]} for row in cursor.fetchall()]
        logger.info(f"Fetched {len(files)} existing files for {tickerSymbol}")

        cursor.close()
        conn.close()
        return jsonify({"files": files})

    except Exception as e:
        logger.error(f"Error fetching files for {tickerSymbol}: {e}")
        if conn is not None:
            conn.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            try:
                conn.close()
                logger.info("Connection closed in get_existing_files.")
            except Exception as e:
                logger.error(f"Error closing connection in get_existing_files: {e}")

@app.route("/api/announcements", methods=["POST"])
def save_announcements():
    conn = None
    try:
        data = request.json
        announcements = data.get("announcements", [])
        total_announcements = len(announcements)
        logger.info(f"Received save_announcements request with {total_announcements} announcements")

        if not announcements:
            return jsonify({"error": "No announcements provided"}), 400

        conn = engine.raw_connection()
        cursor = conn.cursor()

        batch_data = []
        for announcement in announcements:
            announcement_date = clean_date(announcement.get("date"))
            if not announcement_date:
                logger.warning(f"Invalid date for announcement {announcement.get('filename')}, skipping...")
                continue

            announcement_time = clean_time(announcement.get("time"))
            batch_data.append((
                announcement.get("tickerSymbol"),
                announcement_date,
                announcement.get("heading"),
                announcement.get("pages"),
                announcement_time,
                announcement.get("pdfLink"),
                announcement.get("filename"),
                announcement.get("fileSize"),
                announcement.get("priceSensitive", False),
                announcement.get("downloaded", False)
            ))

        if batch_data:
            query = """
                INSERT INTO announcements (ticker_symbol, date, heading, pages, time, pdf_link, filename, file_size, price_sensitive, downloaded)
                    VALUES %s
                    ON CONFLICT (pdf_link) DO UPDATE SET
                        date = EXCLUDED.date,
                        heading = EXCLUDED.heading,
                        pages = EXCLUDED.pages,
                        time = EXCLUDED.time,
                        filename = EXCLUDED.filename,
                        file_size = EXCLUDED.file_size,
                        price_sensitive = EXCLUDED.price_sensitive,
                        downloaded = EXCLUDED.downloaded
            """
            execute_values(cursor, query, batch_data)
            logger.info(f"Saved {len(batch_data)} announcements for {announcements[0].get('tickerSymbol')}")

            ticker_symbol = announcements[0].get("tickerSymbol")
            cursor.execute(
                """UPDATE market_instruments SET announcements_last_updated = %s WHERE ticker_symbol = %s""",
                (datetime.now(), ticker_symbol)
            )

        conn.commit()
        cursor.close()
        conn.close()
        return jsonify({"status": "success"})

    except Exception as e:
        logger.error(f"Error in save_announcements: {str(e)}")
        if conn is not None:
            conn.rollback()
        return jsonify({"error": "Internal Server Error", "details": str(e)}), 500
    finally:
        if conn is not None:
            try:
                conn.close()
                logger.info("Connection closed in save_announcements.")
            except Exception as e:
                logger.error(f"Error closing connection in save_announcements: {e}")

@app.route("/save_data", methods=["POST", "OPTIONS"])
def save_data():
    if request.method == "OPTIONS":
        response = jsonify({"status": "ok"})
        response.headers['Access-Control-Allow-Origin'] = 'chrome-extension://nkhbkjimmfojklinimpgcgllkeiijmko'
        response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        logger.debug("Handled OPTIONS preflight request")
        return response

    conn = None
    try:
        logger.info(f"Received save_data request: {request.json}")
        data = request.json
        if not data or "tickerSymbol" not in data:
            return jsonify({"error": "Invalid request format: missing tickerSymbol"}), 400
        
        conn = engine.raw_connection()
        cursor = conn.cursor()

        formatted_ticker_symbol = f"{data.get('tickerSymbol')}.AX"
        transactions = data.get("transactions", [])
        director_interests = data.get("director_interests", [])
        file_path = data.get("historical_download_url")
        company_overview = data.get("company_overview", {})
        company_details = data.get("company_details", {})

        # Record scrape attempt
        cursor.execute(
            """UPDATE market_instruments SET last_scrape_attempt = %s WHERE ticker_symbol = %s""",
            (datetime.now(), formatted_ticker_symbol)
        )
        logger.debug(f"Recorded scrape attempt for {formatted_ticker_symbol}")

        # Save transactions
        if transactions:
            batch_data = [
                (
                    formatted_ticker_symbol,
                    clean_date(t.get("date")),
                    t.get("director"),
                    t.get("type"),
                    clean_numeric(t.get("quantity")),
                    clean_numeric(t.get("price")),
                    clean_numeric(t.get("value")),
                    t.get("notes")
                ) for t in transactions
            ]
            deduped_data = list({
                (row[0], row[1], row[2], row[3], row[4], row[5]): row for row in batch_data
            }.values())
            query = """
                INSERT INTO director_transactions (ticker_symbol, date, director, type, quantity, price, value, notes)
                VALUES %s
                ON CONFLICT (ticker_symbol, date, director, type, quantity, price) DO UPDATE SET
                    quantity = EXCLUDED.quantity,
                    price = EXCLUDED.price,
                    value = EXCLUDED.value,
                    notes = EXCLUDED.notes
            """
            execute_values(cursor, query, deduped_data)
            logger.info(f"Saved {len(transactions)} transactions for {formatted_ticker_symbol}")
            cursor.execute(
                """UPDATE market_instruments SET director_transactions_last_updated = %s WHERE ticker_symbol = %s""",
                (datetime.now(), formatted_ticker_symbol)
            )

        # Save director interests
        if director_interests:
            cursor.execute("DELETE FROM director_interests WHERE ticker_symbol = %s", (formatted_ticker_symbol,))
            batch_data = [
                (
                    formatted_ticker_symbol,
                    d.get("director"),
                    clean_numeric(d.get("directShares")),
                    clean_numeric(d.get("indirectShares"))
                ) for d in director_interests
            ]
            query = """
                INSERT INTO director_interests (ticker_symbol, director, direct_shares, indirect_shares)
                VALUES %s
            """
            execute_values(cursor, query, batch_data)
            logger.info(f"Saved {len(director_interests)} director interests for {formatted_ticker_symbol}")
            cursor.execute(
                """UPDATE market_instruments SET director_interests_last_updated = %s WHERE ticker_symbol = %s""",
                (datetime.now(), formatted_ticker_symbol)
            )

        # Save historical data from file_path
        if file_path:
            if not os.path.exists(file_path):
                return jsonify({"error": f"File not found at {file_path}"}), 400
            
            logger.debug(f"Reading historical data from {file_path}")
            with open(file_path, 'r') as f:
                csv_content = f.read().splitlines()
            
            headers = csv_content[0].split(",")
            historical_records_saved = 0
            total_records = len(csv_content) - 1
            batch_data = []

            for line in csv_content[1:]:
                if not line.strip():
                    total_records -= 1
                    continue
                values = line.split(",")
                if len(values) != len(headers):
                    total_records -= 1
                    continue
                
                try:
                    date = clean_date(values[0])
                    if not date:
                        logger.warning(f"Invalid date '{values[0]}' in historical record, skipping...")
                        continue
                    open_price = float(values[1])
                    high = float(values[2])
                    low = float(values[3])
                    close = float(values[4])
                    volume = int(values[5])

                    batch_data.append((
                        formatted_ticker_symbol,
                        date,
                        open_price,
                        high,
                        low,
                        close,
                        None,
                        volume
                    ))
                    historical_records_saved += 1

                except Exception as e:
                    logger.error(f"Error processing historical record {line}: {str(e)}")
                    conn.rollback()
                    return jsonify({"error": f"Failed to process historical record: {str(e)}"}), 500

            if batch_data:
                query = """
                    INSERT INTO market_history_as_traded (ticker_symbol, date, open, high, low, close, adj_close, volume)
                    VALUES %s
                    ON CONFLICT (ticker_symbol, date) DO UPDATE SET
                        open = EXCLUDED.open,
                        high = EXCLUDED.high,
                        low = EXCLUDED.low,
                        close = EXCLUDED.close,
                        adj_close = EXCLUDED.adj_close,
                        volume = EXCLUDED.volume
                """
                execute_values(cursor, query, batch_data)
                logger.info(f"Successfully saved {historical_records_saved}/{total_records} historical records for {formatted_ticker_symbol}")
                cursor.execute(
                    """UPDATE market_instruments SET historical_as_traded_last_updated = %s WHERE ticker_symbol = %s""",
                    (datetime.now(), formatted_ticker_symbol)
                )
            elif total_records > 0:
                conn.rollback()
                return jsonify({"error": f"Failed to save historical data for {formatted_ticker_symbol}: no valid records processed"}), 500

        # Save company overview and details to market_instruments
        if company_overview or company_details:
            update_query = """
                UPDATE market_instruments 
                SET 
                    market_cap = %s,
                    sector = %s,
                    eps = %s,
                    dps = %s,
                    book_value_per_share = %s,
                    shares_issued = %s,
                    website = %s,
                    auditor = %s,
                    listing_date = %s
                WHERE ticker_symbol = %s
            """
            cursor.execute(update_query, (
                clean_numeric(company_overview.get("marketCap")),
                company_overview.get("sector"),
                clean_numeric(company_overview.get("eps")),
                clean_numeric(company_overview.get("dps")),
                clean_numeric(company_overview.get("bookValuePerShare")),
                clean_numeric(company_overview.get("sharesIssued")),
                company_details.get("website"),
                company_details.get("auditor"),
                clean_date(company_details.get("dateListed")),
                formatted_ticker_symbol
            ))
            logger.info(f"Updated market_instruments with company overview and details for {formatted_ticker_symbol}")

        conn.commit()
        logger.info("Changes committed to the database successfully.")

        cursor.close()
        conn.close()
        return jsonify({"status": "success"})

    except Exception as e:
        logger.error(f"❌ ERROR: {str(e)}")
        if conn is not None:
            conn.rollback()
        return jsonify({"error": "Internal Server Error", "details": str(e)}), 500
    finally:
        if conn is not None:
            try:
                if hasattr(conn, 'closed') and not conn.closed:
                    conn.close()
                    logger.info("Connection closed in finally block.")
            except Exception as e:
                logger.error(f"Error closing connection in finally block: {e}")

def clean_numeric(value):
    """Clean a string to return an integer/float or None if not numeric."""
    if not value or value.strip().upper() == "N/A":
        return None
    cleaned = re.sub(r"[^0-9.]", "", value)
    try:
        return float(cleaned) if '.' in cleaned else int(cleaned)
    except ValueError:
        return None

def clean_date(date_str, output_format=None):
    if not date_str or date_str.strip().upper() == "N/A":
        return None
    
    detected_format = detect_date_format(date_str)
    if detected_format is None:
        logger.warning(f"Could not detect date format for '{date_str}', treating as None")
        return None
    
    try:
        date_obj = datetime.strptime(date_str, detected_format)
        if output_format is not None:
            return date_obj.strftime(output_format)
        return date_obj.date()
    except ValueError as e:
        logger.error(f"Error converting date '{date_str}' with format '{detected_format}': {e}")
        return None

def detect_date_format(date_str):
    common_formats = [
        "%Y-%m-%d", "%d-%m-%Y", "%m-%d-%Y", "%d-%m-%y",
        "%Y/%m/%d", "%d/%m/%Y", "%m/%d/%Y", "%d/%m/%y",
        "%Y%m%d", "%d%m%Y", "%d %b %Y", "%d %B %Y",
        "%b %d, %Y", "%B %d, %Y", "%d %m %y"
    ]
    for fmt in common_formats:
        try:
            datetime.strptime(date_str, fmt)
            return fmt
        except ValueError:
            continue
    return None

def clean_time(time_str):
    if not time_str or time_str.strip().upper() == "N/A":
        return None
    try:
        return datetime.strptime(time_str, "%I:%M%p").time()
    except ValueError as e:
        logger.error(f"Error converting time '{time_str}': {e}")
        return None

if __name__ == "__main__":
    app.run(debug=True, port=5000)