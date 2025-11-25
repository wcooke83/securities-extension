# server.py
import os
import re
import psycopg2
import logging
import pandas as pd
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv
from sqlalchemy import create_engine
from psycopg2.extras import execute_values
from psycopg2.extras import execute_values
from psycopg2 import Error as PsycopgError

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

# Utility function to normalize ticker symbols
def normalize_ticker(ticker):
    if not ticker:
        return None
    ticker = ticker.upper()
    return ticker if ticker.endswith('.AX') else f"{ticker}.AX"

@app.route("/get_tickers", methods=["GET"])
def get_tickers():
    conn = None
    try:
        logger.info("Fetching ticker symbols...")
        conn = engine.raw_connection()
        cursor = conn.cursor()

        query = '''SELECT DISTINCT LEFT(i.ticker_symbol, POSITION('.' IN i.ticker_symbol) - 1) AS symbol, i.last_scrape_attempt , history_last_updated
                    FROM market_instruments i
                    WHERE history_last_updated IS null
                    AND i.instrument_type = 'stock' 
                    AND i.ticker_symbol LIKE '%.AX'
					AND LENGTH(i.ticker_symbol) = 6
                    AND ticker_symbol_404_count < 1
                    ORDER BY i.last_scrape_attempt NULLS FIRST, symbol ASC;'''

        query1 = '''WITH ranked_instruments AS (
                        SELECT 
                            LEFT(i.ticker_symbol, POSITION('.' IN i.ticker_symbol) - 1) AS symbol, 
                            i.ticker_symbol AS full_ticker_symbol,
                            i.last_scrape_attempt, 
                            i.history_last_updated, 
                            i.director_transactions_last_updated, 
                            i.historical_as_traded_last_updated, 
                            i.director_interests_last_updated,
                            i.is_active,
                            ROW_NUMBER() OVER (PARTITION BY i.ticker_symbol ORDER BY last_scrape_attempt NULLS FIRST) as rn
                        FROM market_instruments i
                        WHERE 
                            i.is_active = TRUE 
                            AND i.history_last_updated IS NULL
                            AND i.instrument_type = 'stock' 
                            AND i.ticker_symbol LIKE '%.AX'
                            AND LENGTH(i.ticker_symbol) = 6
                    )
                    SELECT 
                        symbol,
                        last_scrape_attempt,
                        history_last_updated,
                        director_transactions_last_updated,
                        historical_as_traded_last_updated,
                        director_interests_last_updated,
                        is_active
                    FROM ranked_instruments
                    WHERE rn = 1
                    ORDER BY last_scrape_attempt NULLS FIRST;'''


        query2 = '''SELECT LEFT(mi.ticker_symbol, POSITION('.' IN mi.ticker_symbol) - 1) AS symbol
                    FROM market_instruments mi
                    LEFT JOIN market_history_as_traded mht
                        ON mi.ticker_symbol = mht.ticker_symbol
                    WHERE mi.instrument_type = 'stock'
                        AND LENGTH(mi.ticker_symbol) = 6
                        AND mht.ticker_symbol IS NULL
                        AND ticker_symbol_404_count < 1
                    ORDER BY last_scrape_attempt NULLS FIRST;'''


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

@app.route('/increment_404_count', methods=['POST'])
def increment_404_count():
    conn = None
    try:
        data = request.json
        ticker_symbol = normalize_ticker(data.get('tickerSymbol'))
        if not ticker_symbol:
            return jsonify({'error': 'Invalid ticker symbol'}), 400

        conn = engine.raw_connection()
        cursor = conn.cursor()

        query = """
            UPDATE market_instruments
            SET ticker_symbol_404_count = COALESCE(ticker_symbol_404_count, 0) + 1
            WHERE ticker_symbol = %s
        """
        cursor.execute(query, (ticker_symbol,))
        if cursor.rowcount == 0:
            logger.warning(f"No record found for ticker_symbol: {ticker_symbol}")
            return jsonify({'error': 'Ticker symbol not found'}), 404

        conn.commit()
        cursor.close()
        conn.close()
        return jsonify({'status': 'success'})

    except Exception as e:
        logger.error(f"Error incrementing 404 count: {e}")
        if conn is not None:
            conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception as e:
                logger.error(f"Error closing connection: {e}")

@app.route("/api/files/<tickerSymbol>", methods=["GET"])
def get_existing_files(tickerSymbol):
    conn = None
    try:
        formatted_ticker_symbol = normalize_ticker(tickerSymbol)
        logger.info(f"Fetching existing files for {formatted_ticker_symbol}")
        conn = engine.raw_connection()
        cursor = conn.cursor()

        query = """
            SELECT filename, file_size 
            FROM announcements 
            WHERE ticker_symbol = %s
        """
        cursor.execute(query, (formatted_ticker_symbol,))
        files = [{"filename": row[0], "file_size": row[1]} for row in cursor.fetchall()]
        logger.info(f"Fetched {len(files)} existing files for {formatted_ticker_symbol}")

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

@app.route("/api/announcements_via_dom", methods=["POST"])
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

            ticker_symbol = normalize_ticker(announcement.get("tickerSymbol"))
            announcement_time = clean_time(announcement.get("time"))
            batch_data.append((
                ticker_symbol,
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

        seen_pdf_links = set()
        unique_batch_data = []
        for row in batch_data:
            pdf_link = row[5]  # pdf_link is at index 5
            if pdf_link not in seen_pdf_links:
                seen_pdf_links.add(pdf_link)
                unique_batch_data.append(row)

        if unique_batch_data:
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
            execute_values(cursor, query, unique_batch_data)
            logger.info(f"Saved {len(unique_batch_data)} announcements for {unique_batch_data[0][0]}")

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

# New endpoint for saving API-fetched announcements
@app.route("/api/announcements_via_api", methods=["POST"])
def save_api_announcements():
    conn = None
    try:
        data = request.json
        announcements = data.get("announcements", [])
        total_announcements = len(announcements)
        logger.info(f"Received save_api_announcements request with {total_announcements} announcements")

        if not announcements:
            return jsonify({"error": "No announcements provided"}), 400

        conn = engine.raw_connection()
        cursor = conn.cursor()

        for announcement in announcements:
            ticker_symbol = normalize_ticker(announcement.get("tickerSymbol"))
            identifier = announcement.get("identifier")
            file_id = announcement.get("fileId")
            page_count = announcement.get("pageCount")
            symbol_id = announcement.get("symbolId")
            security_name = announcement.get("securityName")
            file_size = announcement.get("fileSize")
            heading = announcement.get("heading")
            date_time = announcement.get("dateTime")
            file_type = announcement.get("fileType")
            is_price_sensitive = announcement.get("isPriceSensitive", False)
            file_key = announcement.get("fileKey")
            types = announcement.get("types", [])

            # Insert into announcement_records
            insert_record_query = """
                INSERT INTO announcement_records (ticker_symbol, identifier, file_id, page_count, symbol_id, security_name, file_size, heading, date_time, file_type, is_price_sensitive, file_key)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (identifier) DO UPDATE SET
                    ticker_symbol = EXCLUDED.ticker_symbol,
                    file_id = EXCLUDED.file_id,
                    page_count = EXCLUDED.page_count,
                    symbol_id = EXCLUDED.symbol_id,
                    security_name = EXCLUDED.security_name,
                    file_size = EXCLUDED.file_size,
                    heading = EXCLUDED.heading,
                    date_time = EXCLUDED.date_time,
                    file_type = EXCLUDED.file_type,
                    is_price_sensitive = EXCLUDED.is_price_sensitive,
                    file_key = EXCLUDED.file_key
                RETURNING id
            """
            cursor.execute(insert_record_query, (
                ticker_symbol, identifier, file_id, page_count, symbol_id, security_name, file_size, heading, date_time, file_type, is_price_sensitive, file_key
            ))
            announcement_id = cursor.fetchone()[0]

            # Handle types
            for announcement_type in types:
                type_title = announcement_type.get("title")
                # Ensure the type exists in announcement_types
                cursor.execute("SELECT id FROM announcement_types WHERE title = %s", (type_title,))
                type_row = cursor.fetchone()
                if type_row:
                    type_id = type_row[0]
                else:
                    cursor.execute("INSERT INTO announcement_types (title) VALUES (%s) RETURNING id", (type_title,))
                    type_id = cursor.fetchone()[0]

                # Link the announcement to the type
                cursor.execute("""
                    INSERT INTO announcement_type_links (announcement_id, type_id)
                    VALUES (%s, %s)
                    ON CONFLICT DO NOTHING
                """, (announcement_id, type_id))

        conn.commit()
        cursor.close()
        conn.close()
        return jsonify({"status": "success"})

    except Exception as e:
        logger.error(f"Error in save_api_announcements: {str(e)}")
        if conn is not None:
            conn.rollback()
        return jsonify({"error": "Internal Server Error", "details": str(e)}), 500
    finally:
        if conn is not None:
            try:
                conn.close()
                logger.info("Connection closed in save_api_announcements.")
            except Exception as e:
                logger.error(f"Error closing connection in save_api_announcements: {e}")

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
        logger.info(f"Received save_data request:")
        data = request.json
        if not data or "tickerSymbol" not in data:
            return jsonify({"error": "Invalid request format: missing tickerSymbol"}), 400
        
        conn = engine.raw_connection()
        cursor = conn.cursor()

        formatted_ticker_symbol = normalize_ticker(data.get("tickerSymbol"))
        transactions = data.get("transactions", [])
        director_interests = data.get("director_interests", [])
        historical_filepath = data.get("historical_filepath")
        company_overview = data.get("company_overview", {})
        company_details = data.get("company_details", {})
        update_timestamps = data.get("update_timestamps", {})

        # Record scrape attempt and log result
        query = """UPDATE market_instruments SET last_scrape_attempt = CURRENT_TIMESTAMP WHERE ticker_symbol = %s"""
        cursor.execute(query, (formatted_ticker_symbol, ))
        if cursor.rowcount == 0:
            logger.warning(f"Failed to process save_data for {formatted_ticker_symbol} - ticker may not exist")
            return jsonify({"error": f"Failed to process save_data for {formatted_ticker_symbol} - ticker may not exist"}), 500
        else:
            logger.info(f"Updated last_scrape_attempt to CURRENT_TIMESTAMP for {formatted_ticker_symbol}")

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
            update_timestamps["director_transactions_last_updated"] = True

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
            update_timestamps["director_interests_last_updated"] = True

        # Save historical data from historical_filepath
        if historical_filepath:
            if not os.path.exists(historical_filepath):
                logger.error(f"Error: File not found at {historical_filepath}")
                return jsonify({"error": f"File not found at {historical_filepath}"}), 400

            # Read CSV with pandas
            try:
                df = pd.read_csv(historical_filepath, dtype={'Date': str, 'Open': float, 'High': float, 'Low': float, 'Close': float, 'Volume': int})
            except Exception as e:
                logger.error(f"Failed to read CSV at {historical_filepath}: {str(e)}")
                return jsonify({"error": f"Failed to read CSV: {str(e)}"}), 400

            if df.empty:
                logger.error(f"Empty file at {historical_filepath}")
                return jsonify({"error": f"Empty file at {historical_filepath}"}), 400

            expected_data_rows = len(df)
            logger.info(f"File {historical_filepath} has {expected_data_rows} data rows")

            # Remove duplicates and empty rows
            df = df.dropna().loc[df[['Date', 'Open', 'High', 'Low', 'Close', 'Volume']].ne('').all(axis=1)]
            duplicates = df.duplicated(subset=['Date']).sum()  # Since Symbol is not in CSV, use Date for deduplication
            df = df.drop_duplicates(subset=['Date'])
            logger.info(f"After deduplication: {len(df)} unique records, {duplicates} duplicates removed")

            # Validate and format data
            batch_data = []
            skipped_rows = []
            for idx, row in df.iterrows():
                try:
                    # Parse date: Convert YYYYMMDD to YYYY-MM-DD
                    date = clean_date(row['Date'])
                    if pd.isna(date):
                        skipped_rows.append((dict(row), f"Invalid date: {row['Date']}"))
                        continue
                    date = date.strftime('%Y-%m-%d')
                    symbol = formatted_ticker_symbol  # ABR.AX
                    # Validate numeric fields
                    open_price = float(row['Open'])
                    high = float(row['High'])
                    low = float(row['Low'])
                    close = float(row['Close'])
                    volume = int(row['Volume'])
                    for col, val in [('Open', open_price), ('High', high), ('Low', low), ('Close', close)]:
                        if pd.isna(val) or val < 0 or val > 999999.9999:
                            skipped_rows.append((dict(row), f"Invalid {col}: {val}"))
                            continue
                    if pd.isna(volume) or volume < 0 or volume > 2**63-1:
                        skipped_rows.append((dict(row), f"Invalid Volume: {volume}"))
                        continue
                    batch_data.append((symbol, date, open_price, high, low, close, None, volume))
                except (ValueError, TypeError) as e:
                    skipped_rows.append((dict(row), f"Validation error: {str(e)}"))
                    continue

            # Rest of the code remains unchanged...

            valid_records = len(batch_data)
            logger.info(f"Validated {valid_records} records, skipped {len(skipped_rows)} rows")
            if skipped_rows:
                logger.warning(f"Skipped rows (first 10): {[(row[0], row[1]) for row in skipped_rows][:10]}{'...' if len(skipped_rows) > 10 else ''}")

            if not batch_data:
                logger.error(f"No valid records for {formatted_ticker_symbol}")
                return jsonify({"error": f"No valid records for {formatted_ticker_symbol}"}), 400

            # Execute insert/update
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
                RETURNING ticker_symbol, date, open, high, low, close, volume
            """
            try:
                result = execute_values(cursor, query, batch_data, fetch=True)
                returned_rows = len(result)
                affected_rows = cursor.rowcount
                logger.info(f"cursor.rowcount: {affected_rows}, RETURNING rows: {returned_rows}")
                
                # Use returned_rows for success check
                inserted = {(row[0], str(row[1])): (float(row[2]), float(row[3]), float(row[4]), float(row[5]), row[6]) for row in result}
                expected = {(row[0], str(row[1])): (row[2], row[3], row[4], row[5], row[7]) for row in batch_data}
                missing = expected.keys() - inserted.keys()
                logger.info(f"Processed {returned_rows}/{valid_records} rows for {formatted_ticker_symbol}")

                # Log inserted and missing rows
                if inserted:
                    logger.debug(f"Inserted/updated rows (first 10): {[(k, v) for k, v in list(inserted.items())[:10]]}{'...' if len(inserted) > 10 else ''}")
                if missing:
                    missing_details = []
                    no_op_query = """
                        SELECT ticker_symbol, date
                        FROM market_history_as_traded
                        WHERE (ticker_symbol, date) = (%s, %s)
                        AND open = %s AND high = %s AND low = %s AND close = %s AND volume = %s
                        AND (adj_close IS NULL) = (%s IS NULL)
                    """
                    for row in batch_data:
                        key = (row[0], str(row[1]))
                        if key in missing:
                            cursor.execute(no_op_query, (row[0], row[1], row[2], row[3], row[4], row[5], row[7], row[6]))
                            reason = "No-op update (data matches existing)" if cursor.fetchone() else "Unknown reason (possible constraint)"
                            missing_details.append((key, expected[key], reason))
                    logger.warning(f"Missing from RETURNING {len(missing)} rows (first 10): {missing_details[:10]}{'...' if len(missing_details) > 10 else ''}")

                # Check success using returned_rows
                if returned_rows == valid_records:
                    logger.info(f"Successfully saved {returned_rows}/{valid_records} rows for {formatted_ticker_symbol}")
                    update_timestamps["historical_as_traded_last_updated"] = True
                else:
                    logger.error(f"Incomplete save for {formatted_ticker_symbol}: {returned_rows}/{valid_records} rows")
                    conn.rollback()
                    return jsonify({
                        "error": f"Incomplete save for {formatted_ticker_symbol}",
                        "details": f"Processed {returned_rows}/{valid_records} rows, missing: {len(missing)}"
                    }), 400
            except PsycopgError as e:
                logger.error(f"Database error: {e.pgcode} - {e.pgerror}")
                conn.rollback()
                return jsonify({"error": f"Database error: {str(e)}"}), 500
            
        # if historical_filepath:
        #     if not os.path.exists(historical_filepath):
        #         logger.error(f"Error: File not found at {historical_filepath}")
        #         return jsonify({"error": f"File not found at {historical_filepath}"}), 400
            
        #     logger.debug(f"Reading historical data from {historical_filepath}")
        #     with open(historical_filepath, 'r', encoding='utf-8') as f:
        #         csv_content = f.read().splitlines()
            
        #     if not csv_content:
        #         logger.error(f"Empty file at {historical_filepath}")
        #         return jsonify({"error": f"Empty file at {historical_filepath}"}), 400

        #     # Count total lines and adjust for header
        #     total_lines = len(csv_content)
        #     has_header = total_lines > 0  # Assume header if file is not empty
        #     expected_data_rows = total_lines - 1 if has_header else total_lines
        #     logger.info(f"File {historical_filepath} has {total_lines} lines, expecting {expected_data_rows} data rows")

        #     headers = [h.strip() for h in csv_content[0].split(",")] if has_header else []
        #     batch_data = []
        #     valid_records = 0

        #     # Determine column indices based on header
        #     if has_header:
        #         try:
        #             date_col = headers.index('Date')
        #             symbol_col = headers.index('Symbol') if 'Symbol' in headers else None
        #             open_col = headers.index('Open')
        #             high_col = headers.index('High')
        #             low_col = headers.index('Low')
        #             close_col = headers.index('Close')
        #             volume_col = headers.index('Volume')
        #         except ValueError as e:
        #             logger.error(f"Missing required column in header: {str(e)}")
        #             return jsonify({"error": f"CSV file is missing required column: {str(e)}"}), 400

        #     # Process data rows (skip header if present)
        #     start_index = 1 if has_header else 0
        #     for line in csv_content[start_index:]:
        #         if not line.strip():
        #             expected_data_rows -= 1
        #             continue
                
        #         values = [v.strip() for v in line.split(",")]
        #         if has_header and len(values) != len(headers):
        #             expected_data_rows -= 1
        #             continue
                
        #         try:
        #             date = clean_date(values[date_col])
        #             if not date:
        #                 logger.warning(f"Invalid date '{values[date_col]}' in historical record, skipping...")
        #                 expected_data_rows -= 1
        #                 continue
                    
        #             symbol = values[symbol_col] if symbol_col is not None else formatted_ticker_symbol
                    
        #             open_price = float(values[open_col])
        #             high = float(values[high_col])
        #             low = float(values[low_col])
        #             close = float(values[close_col])
        #             volume = int(values[volume_col])

        #             batch_data.append((
        #                 symbol,
        #                 date,
        #                 open_price,
        #                 high,
        #                 low,
        #                 close,
        #                 None,  # adj_close (not in source data)
        #                 volume
        #             ))
        #             valid_records += 1

        #         except (ValueError, IndexError) as e:
        #             logger.warning(f"Skipping invalid historical record '{line}': {str(e)}")
        #             expected_data_rows -= 1
        #             continue
            
        #     if not batch_data:
        #         logger.error(f"No valid records processed for {formatted_ticker_symbol}")
        #         return jsonify({"error": f"Failed to save historical data for {formatted_ticker_symbol}: no valid records processed"}), 400

        #     # Execute insert/update and count affected rows
        #     query = """
        #         INSERT INTO market_history_as_traded (ticker_symbol, date, open, high, low, close, adj_close, volume)
        #         VALUES %s
        #         ON CONFLICT (ticker_symbol, date) DO UPDATE SET
        #             open = EXCLUDED.open,
        #             high = EXCLUDED.high,
        #             low = EXCLUDED.low,
        #             close = EXCLUDED.close,
        #             adj_close = EXCLUDED.adj_close,
        #             volume = EXCLUDED.volume
        #         RETURNING ticker_symbol
        #     """
        #     execute_values(cursor, query, batch_data, fetch=True)
        #     affected_rows = cursor.rowcount
        #     logger.info(f"Processed {valid_records} valid records, inserted/updated {affected_rows}/{expected_data_rows} rows for {formatted_ticker_symbol}")

        #     # Check if the number of affected rows matches the expected data rows
        #     if affected_rows == expected_data_rows:
        #         logger.info(f"Successfully saved {affected_rows}/{expected_data_rows} historical records for {formatted_ticker_symbol}")
        #         update_timestamps["historical_as_traded_last_updated"] = True
        #     else:
        #         logger.error(f"Failed to save historical data for {formatted_ticker_symbol}: inserted/updated {affected_rows} rows, expected {expected_data_rows}")
        #         conn.rollback()
        #         return jsonify({
        #             "error": f"Failed to save historical data for {formatted_ticker_symbol}",
        #             "details": f"Inserted/updated {affected_rows} rows, expected {expected_data_rows}"
        #         }), 400

        # Save company overview and details to market_instruments
        if company_overview or company_details:
            update_query = f"""
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
            update_timestamps["basic_fundamentals_last_updated"] = True

        # Initialize response for timestamp updates
        timestamp_columns = [
            "basic_fundamentals_last_updated",
            "director_transactions_last_updated",
            "director_interests_last_updated",
            "historical_as_traded_last_updated",
            "announcements_api_last_updated",
            "announcements_dom_last_updated"
        ]
        timestamp_status = {col: update_timestamps.get(col, False) for col in timestamp_columns}

        # Update timestamps in the database
        if len(update_timestamps) > 0:
            columns_to_update = [col for col in timestamp_columns if update_timestamps.get(col, False)]
            if columns_to_update:
                set_clause = ", ".join([f"{col} = CURRENT_TIMESTAMP" for col in columns_to_update])
                update_query = f"""
                    UPDATE market_instruments 
                    SET {set_clause}
                    WHERE ticker_symbol = %s
                """
                cursor.execute(update_query, (formatted_ticker_symbol,))
                logger.info(f"Updated market_instruments with updated timestamps for {columns_to_update}")
            else:
                logger.warning(f"No timestamps to update for {formatted_ticker_symbol}")

        conn.commit()
        logger.info("Changes committed to the database successfully.")

        cursor.close()
        conn.close()

        # Return JSON response with status and timestamp updates
        return jsonify({
            "status": "success",
            "timestamp_updates": timestamp_status
        })

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