import os

from dotenv import load_dotenv
from flask import Flask, request, jsonify
from escpos.printer import Usb

# Load shared .env from the repo root (one level up from this file)
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

app = Flask(__name__)

VENDOR_ID = int(os.environ.get("PRINTER_VENDOR_ID", "0x0483"), 16)
PRODUCT_ID = int(os.environ.get("PRINTER_PRODUCT_ID", "0x5743"), 16)
PORT = int(os.environ.get("PRINTER_PORT", "5000"))

def get_printer():
        return Usb(VENDOR_ID, PRODUCT_ID)

@app.route('/print', methods=['POST'])
def print_message():
        data = request.json
        message = data.get('content', '')

        if not message:
                return jsonify({"error": "No content provided"}), 400

        try:
                p = get_printer()
                p.text(message + "\n")
                p.cut()
                p.close()
                return jsonify({"status": "success"}), 200
        except Exception as e:
                return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
        app.run(host='0.0.0.0', port=PORT)
