import os
import re
import psycopg2
import logging
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv
from sqlalchemy import create_engine

logging.basicConfig(
    filename=f"{os.path.splitext(os.path.basename(__file__))[0]}.log",
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})
logger.info("CORS initialized with origins: *")

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

def clean_numeric(value):
    """Clean a string to return an integer or None if not numeric."""
    if not value or value.strip().upper() == "N/A":
        return None
    cleaned = re.sub(r"[^0-9]", "", value)
    return int(cleaned) if cleaned else None

def clean_date(date_str, output_format=None):
    """
    Converts a date string from detected input format to a date object or formatted string.

    :param date_str: The date string to be converted.
    :param output_format: The desired output format (default: None, returns date object).
    :return: A date object if output_format is None, otherwise a formatted string, or None if conversion fails.
    """
    if not date_str or date_str.strip().upper() == "N/A":
        return None
    
    detected_format = detect_date_format(date_str)
    if detected_format is None:
        logger.warning(f"Could not detect date format for '{date_str}', treating as None")
        return None
    
    try:
        date_obj = datetime.strptime(date_str, detected_format)
        if output_format is not None:  # Return formatted string if format provided
            return date_obj.strftime(output_format)
        return date_obj.date()  # Otherwise return date object for DB
    except ValueError as e:
        logger.error(f"Error converting date '{date_str}' with format '{detected_format}': {e}")
        return None

def detect_date_format(date_str):
    """
    Try to detect the format of a date string from a list of common formats.
    
    :param date_str: The input date string.
    :return: The detected format as a string, or None if not detected.
    """
    common_formats = [
        "%Y-%m-%d",      # 2023-04-03
        "%d-%m-%Y",      # 03-04-2023
        "%m-%d-%Y",      # 04-03-2023
        "%d-%m-%y",      # 05-05-16
        "%Y/%m/%d",      # 2023/04/03
        "%d/%m/%Y",      # 03/04/2023
        "%m/%d/%Y",      # 04/03/2023
        "%d/%m/%y",      # 05/05/16
        "%Y%m%d",        # 20230403
        "%d%m%Y",        # 03042023
        "%d %b %Y",      # 03 Apr 2023
        "%d %B %Y",      # 03 April 2023
        "%b %d, %Y",     # Apr 03, 2023
        "%B %d, %Y"      # April 03, 2023
        "%d %m %y",      # 05 05 16
    ]

    for fmt in common_formats:
        try:
            datetime.strptime(date_str, fmt)
            return fmt
        except ValueError:
            continue
    
    return None

@app.route("/save_data", methods=["POST", "OPTIONS"])
def save_data():
    if request.method == "OPTIONS":
        response = jsonify({"status": "ok"})
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        logger.debug("Handled OPTIONS preflight request")
        return response

    conn = None
    try:
        logger.info(f"Received save_data request: {request.json}")
        data = request.json
        if not data or "tickerSymbol" not in data:
            return jsonify({"error": "Invalid request format"}), 400
        
        conn = engine.raw_connection()
        cursor = conn.cursor()

        formatted_ticker_symbol = f"{data.get('tickerSymbol')}.AX"
        data_type = data.get("type")

        # Record scrape attempt at the start
        query = """UPDATE market_instruments SET last_scrape_attempt = %s WHERE ticker_symbol = %s"""
        params = (datetime.now(), formatted_ticker_symbol)
        cursor.execute(query, params)
        logging.debug(f"Recorded scrape attempt for {formatted_ticker_symbol}")

        if data_type == "transactions":
            transactions_saved = 0
            total_transactions = len(data.get("data", []))
            for transaction in data.get("data", []):
                try:
                    # logging.debug(f"Processing transaction {formatted_ticker_symbol}: {transaction}")

                    transaction_date = clean_date(transaction.get("date"))
                    if not transaction_date:
                        logging.warning("No valid date found in transaction, skipping...")
                        continue

                    formatted_price = re.sub(r"[^0-9.]", "", transaction.get("price", "0"))
                    formatted_value = re.sub(r"[^0-9.]", "", transaction.get("value", "0"))
                    formatted_amount = re.sub(r"[^0-9]", "", transaction.get("amount", "0"))

                    cursor.execute("""
                        INSERT INTO director_transactions (ticker_symbol, director_name, date, transaction_type, amount, price, value, notes)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (ticker_symbol, date, director_name, transaction_type, amount, price)
                        DO UPDATE SET value = EXCLUDED.value, notes = EXCLUDED.notes;
                    """, (
                        formatted_ticker_symbol,
                        transaction.get("director_name"),
                        transaction_date,
                        transaction.get("transaction_type"),
                        formatted_amount,
                        formatted_price,
                        formatted_value,
                        transaction.get("notes", None)
                    ))
                    transactions_saved += 1

                except Exception as e:
                    logging.error(f"Error processing transaction {transaction}: {str(e)}")
                    conn.rollback()
                    transactions_saved = 0
                    continue

            if transactions_saved == total_transactions and total_transactions > 0:
                query = """UPDATE market_instruments SET director_transactions_last_updated = %s WHERE ticker_symbol = %s"""
                params = (datetime.now(), formatted_ticker_symbol)
                cursor.execute(query, params)
                logging.info(f"Successfully saved {transactions_saved}/{total_transactions} transactions for {formatted_ticker_symbol}")
            elif total_transactions > 0:
                conn.rollback()
                return jsonify({"error": f"Failed to save transactions for {formatted_ticker_symbol}: processed {transactions_saved}/{total_transactions} before rollback"}), 500

        elif data_type == "director_interests":
            cursor.execute("DELETE FROM director_interests WHERE ticker_symbol = %s", (formatted_ticker_symbol,))
            director_interests_saved = 0
            total_interests = len(data.get("data", []))
            for interest in data.get("data", []):
                try:
                    last_notice = clean_date(interest.get("last_notice"))
                    direct_shares = clean_numeric(interest.get("direct_shares"))
                    indirect_shares = clean_numeric(interest.get("indirect_shares"))
                    options = clean_numeric(interest.get("options"))
                    convertibles = clean_numeric(interest.get("convertibles"))

                    cursor.execute("""
                        INSERT INTO director_interests (ticker_symbol, director, last_notice, direct_shares, indirect_shares, options, convertibles, last_updated)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """, (
                        formatted_ticker_symbol,
                        interest.get("director"),
                        last_notice,
                        direct_shares,
                        indirect_shares,
                        options,
                        convertibles,
                        datetime.now()
                    ))
                    director_interests_saved += 1

                except Exception as e:
                    logging.error(f"Error processing director interest {interest} {interest.get('director')}: {str(e)}")
                    conn.rollback()
                    director_interests_saved = 0
                    continue

            if director_interests_saved == total_interests and total_interests > 0:
                query = """UPDATE market_instruments SET director_interests_last_updated = %s WHERE ticker_symbol = %s"""
                params = (datetime.now(), formatted_ticker_symbol)
                cursor.execute(query, params)
                logging.info(f"Successfully saved {director_interests_saved}/{total_interests} director interests for {formatted_ticker_symbol}")
            elif total_interests > 0:
                conn.rollback()
                return jsonify({"error": f"Failed to save director interests for {formatted_ticker_symbol}: processed {director_interests_saved}/{total_interests} before rollback"}), 500

        elif data_type == "historical_data":
            file_path = data.get("file_path")
            if not file_path or not os.path.exists(file_path):
                return jsonify({"error": f"File not found at {file_path}"}), 400
            
            logging.debug(f"Reading historical data from {file_path}")
            with open(file_path, 'r') as f:
                csv_content = f.read().splitlines()
            
            headers = csv_content[0].split(",")
            historical_records_saved = 0
            total_records = len(csv_content) - 1  # Exclude header
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
                        logging.warning(f"Invalid date '{values[0]}' in historical record, skipping...")
                        continue
                    open_price = float(values[1])
                    high = float(values[2])
                    low = float(values[3])
                    close = float(values[4])
                    volume = int(values[5])

                    cursor.execute("""
                        INSERT INTO market_history_as_traded (ticker_symbol, date, open, high, low, close, adj_close, volume)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (ticker_symbol, date)
                        DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, 
                                      adj_close = EXCLUDED.adj_close, volume = EXCLUDED.volume;
                    """, (
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
                    logging.error(f"Error processing historical record {line}: {str(e)}")
                    conn.rollback()
                    historical_records_saved = 0
                    continue

            if historical_records_saved == total_records and total_records > 0:
                query = """UPDATE market_instruments SET historical_as_traded_last_updated = %s WHERE ticker_symbol = %s"""
                params = (datetime.now(), formatted_ticker_symbol)
                cursor.execute(query, params)
                logging.info(f"Successfully saved {historical_records_saved}/{total_records} historical records for {formatted_ticker_symbol}")
            elif total_records > 0:
                conn.rollback()
                return jsonify({"error": f"Failed to save historical data for {formatted_ticker_symbol}: processed {historical_records_saved}/{total_records} before rollback"}), 500

        conn.commit()
        logging.info("Changes committed to the database successfully.")

        cursor.close()
        conn.close()
        logging.info("Connection closed.")
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

if __name__ == "__main__":
    app.run(debug=True, port=5000)