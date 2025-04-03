import os
import re
import psycopg2
import logging
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv
from sqlalchemy import create_engine, Column, Integer, String, Date, DateTime, UniqueConstraint, DECIMAL, ForeignKey, TIMESTAMP, func, Numeric, Text, Boolean


logging.basicConfig(
    filename=f"{os.path.splitext(os.path.basename(__file__))[0]}.log",
    level=logging.DEBUG,   # Sets log level (DEBUG, INFO, WARNING, ERROR, CRITICAL etc.)
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


app = Flask(__name__)
CORS(app)

# Database Configuration
def db_connect():
    # ✅ Load PostgreSQL credentials
    POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
    POSTGRES_USER = os.getenv("POSTGRES_USER", "pguser")
    POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "pgpass")
    POSTGRES_DB = os.getenv("POSTGRES_DATABASE", "securities_db")
    POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", 15432))

    # ✅ Create PostgreSQL connection
    DB_URL = f"postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"
    return create_engine(DB_URL)

engine = db_connect()

@app.route("/get_tickers", methods=["GET"])
def get_tickers():
    try:
        logger.info("Fetching ticker symbols...")
        conn = engine.raw_connection()
        cursor = conn.cursor()

        query = '''SELECT DISTINCT LEFT(i.ticker_symbol, POSITION('.' IN i.ticker_symbol) - 1) AS symbol, i.director_transactions_last_updated 
                    FROM market_instruments i
                    WHERE i.is_active = TRUE 
                    AND i.instrument_type = 'stock' 
                    AND i.ticker_symbol LIKE '%.AX'
                    ORDER BY i.director_transactions_last_updated DESC, symbol ASC;'''

        cursor.execute(query)
        tickers = [row[0] for row in cursor.fetchall()]
        logger.info(f"Fetched {len(tickers)} tickers.")

        cursor.close()
        conn.close()
        return jsonify(tickers)

    except Exception as e:
        logger.error(f"Error fetching tickers: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/save_data", methods=["POST"])
def save_data():
    try:
        data = request.json
        if not data or "tickerSymbol" not in data or "data" not in data:
            return jsonify({"error": "Invalid request format"}), 400  # Bad Request
        
        conn = engine.raw_connection()
        cursor = conn.cursor()

        formatted_ticker_symbol = f"{data.get('tickerSymbol')}.AX"
        logging.debug(f"Formatted ticker symbol: {formatted_ticker_symbol}")

        for transaction in data.get("data", []):  # Ensure transactions list exists
            try:
                logging.debug(f"Processing transaction {formatted_ticker_symbol}: {transaction}")

                # Formatting date
                transaction_date = transaction.get("date")
                if transaction_date:
                    formatted_date = datetime.strptime(transaction_date, "%d/%m/%y").date()
                    logging.debug(f"Formatted date: {formatted_date}")
                else:
                    logging.warning("No date found in transaction, skipping...")
                    continue

                formatted_price = re.sub(r"[^0-9.]", "", transaction.get("price", "0"))
                formatted_value = re.sub(r"[^0-9.]", "", transaction.get("value", "0"))
                formatted_amount = re.sub(r"[^0-9]", "", transaction.get("amount", "0"))

                logging.debug(f"Formatted price: {formatted_price}")
                logging.debug(f"Formatted value: {formatted_value}")
                logging.debug(f"Formatted amount: {formatted_amount}")

                cursor.execute("""
                    INSERT INTO director_transactions (ticker_symbol, director_name, date, transaction_type, amount, price, value, notes)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (ticker_symbol, date, director_name, transaction_type, amount, price)
                    DO UPDATE SET value = EXCLUDED.value, notes = EXCLUDED.notes;
                """, (
                        formatted_ticker_symbol,
                        transaction.get("director_name"),
                        formatted_date,
                        transaction.get("transaction_type"),
                        formatted_amount,
                        formatted_price,
                        formatted_value,
                        transaction.get("notes", None)
                    ))

                query = """UPDATE market_instruments SET director_transactions_last_updated = %s WHERE ticker_symbol = %s"""
                params = (datetime.now(), formatted_ticker_symbol)
                cursor.execute(query, params)

                logging.info(cursor.mogrify(query, params).decode())
                logging.debug("SQL query executed successfully.")

            except Exception as e:
                logging.error(f"Error processing transaction {transaction}: {str(e)}")
                continue  # Continue with the next transaction if there's an error

        conn.commit()
        logging.info("Changes committed to the database successfully.")

        cursor.close()
        conn.close()

        logging.info("Connection closed.")

        return jsonify({"status": "success"})
    

    except Exception as e:
        logging.error(f"❌ ERROR: {str(e)}")
        return jsonify({"error": "Internal Server Error", "details": str(e)}), 500

if __name__ == "__main__":
    app.run(debug=True, port=5000)
