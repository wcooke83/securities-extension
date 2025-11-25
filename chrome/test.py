
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


def clean_date(date_str, output_format=None):
    if not date_str or date_str.strip().upper() == "N/A":
        return None
    
    detected_format = detect_date_format(date_str)
    if detected_format is None:
        print(f"Could not detect date format for '{date_str}', treating as None")
        return None
    
    try:
        date_obj = datetime.strptime(date_str, detected_format)
        if output_format is not None:
            return date_obj.strftime(output_format)
        return date_obj.date()
    except ValueError as e:
        print(f"Error converting date '{date_str}' with format '{detected_format}': {e}")
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

def test():
    formatted_ticker_symbol = "RMG.AX"
    historical_filepath = "C:/Users/wcook/Downloads/historical_data_RMG (5).csv"

    if historical_filepath:
        if not os.path.exists(historical_filepath):
            print(f"Error: File not found at {historical_filepath}")
            return jsonify({"error": f"File not found at {historical_filepath}"}), 400

        # Read CSV with pandas
        try:
            df = pd.read_csv(historical_filepath, dtype={'Date': str, 'Open': float, 'High': float, 'Low': float, 'Close': float, 'Volume': int})
        except Exception as e:
            print(f"Failed to read CSV at {historical_filepath}: {str(e)}")
            return jsonify({"error": f"Failed to read CSV: {str(e)}"}), 400

        if df.empty:
            print(f"Empty file at {historical_filepath}")
            return jsonify({"error": f"Empty file at {historical_filepath}"}), 400

        expected_data_rows = len(df)
        print(f"File {historical_filepath} has {expected_data_rows} data rows")

        # Remove duplicates and empty rows
        df = df.dropna().loc[df[['Date', 'Open', 'High', 'Low', 'Close', 'Volume']].ne('').all(axis=1)]
        duplicates = df.duplicated(subset=['Date']).sum()  # Since Symbol is not in CSV, use Date for deduplication
        df = df.drop_duplicates(subset=['Date'])
        print(f"After deduplication: {len(df)} unique records, {duplicates} duplicates removed")

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
        print(f"Validated {valid_records} records, skipped {len(skipped_rows)} rows")
        if skipped_rows:
            print(f"Skipped rows (first 10): {[(row[0], row[1]) for row in skipped_rows][:10]}{'...' if len(skipped_rows) > 10 else ''}")

        if not batch_data:
            print(f"No valid records for {formatted_ticker_symbol}")
            return jsonify({"error": f"No valid records for {formatted_ticker_symbol}"}), 400

        print(batch_data)



rs = test()
print(rs)