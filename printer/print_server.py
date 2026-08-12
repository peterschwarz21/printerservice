import io
import os
import textwrap
from urllib.parse import unquote

from dotenv import load_dotenv
from flask import Flask, request, jsonify
from escpos.printer import Usb
from PIL import Image, ImageOps

# Load shared .env from the repo root (one level up from this file)
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

app = Flask(__name__)

VENDOR_ID = int(os.environ.get("PRINTER_VENDOR_ID", "0x0483"), 16)
PRODUCT_ID = int(os.environ.get("PRINTER_PRODUCT_ID", "0x5743"), 16)
PORT = int(os.environ.get("PRINTER_PORT", "5000"))
# Max image width in dots. 80mm printers are 576; 58mm are typically 384.
IMAGE_WIDTH = int(os.environ.get("PRINTER_IMAGE_WIDTH", "576"))
# Characters per line for wrapping captions (matches the Node text formatter).
CAPTION_WIDTH = 48

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

@app.route('/print-image', methods=['POST'])
def print_image():
        data = request.get_data()
        if not data:
                return jsonify({"error": "No image data provided"}), 400

        # Caption and sender arrive URL-encoded in headers so binary body stays clean.
        caption = unquote(request.headers.get('X-Caption', ''))
        sender = unquote(request.headers.get('X-From', ''))

        try:
                img = Image.open(io.BytesIO(data))
                # Honor the EXIF orientation phones bake into photos, then flatten.
                img = ImageOps.exif_transpose(img)
                img = img.convert("L")
                # Scale down to the printer width; never upscale small images.
                if img.width > IMAGE_WIDTH:
                        height = round(img.height * IMAGE_WIDTH / img.width)
                        img = img.resize((IMAGE_WIDTH, height), Image.LANCZOS)
        except Exception as e:
                return jsonify({"status": "error", "message": f"bad image: {e}"}), 400

        try:
                p = get_printer()
                p.image(img, center=True)
                if caption:
                        p.text("\n")
                        p.set(align="center")
                        for line in textwrap.wrap(caption, CAPTION_WIDTH):
                                p.text(line + "\n")
                        p.set(align="left")
                if sender:
                        p.set(align="center")
                        p.text(f"from {sender}\n")
                        p.set(align="left")
                p.cut()
                p.close()
                return jsonify({"status": "success"}), 200
        except Exception as e:
                return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
        app.run(host='0.0.0.0', port=PORT)
