import io
import os
import textwrap
from urllib.parse import unquote

from dotenv import load_dotenv
from flask import Flask, request, jsonify
from escpos.printer import Usb
from PIL import Image, ImageOps, ImageDraw, ImageFont

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
# The Node text formatter lays out at this fixed column count (box borders,
# centered padding). We render the emoji fallback on the same grid so it lines up.
LINE_WIDTH = 48

# --- Emoji / Unicode text rendering -----------------------------------------
# The printer's text mode only knows a few ROM codepages (CP437/CP850/...), so
# python-escpos replaces anything outside them — every emoji — with "?". The
# workaround: when a message contains such characters, rasterize the whole block
# to a bitmap with an emoji-capable font and print it through p.image() instead.

# Monospace base font: keeps the box borders (═ ─) and centered padding aligned.
BASE_FONT_PATHS = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",  # Raspberry Pi OS / Debian
        "/System/Library/Fonts/Menlo.ttc",                      # macOS dev fallback
]
# Monochrome Noto Emoji (NOT the color build): renders clean 1-bit glyphs that a
# thermal head can print. The color font would need embedded_color + thresholding.
EMOJI_FONT_PATHS = [
        "/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf",
        "/usr/share/fonts/truetype/ancient-scripts/NotoEmoji-Regular.ttf",
]

# Unicode ranges that the printer can't render as text and that should trigger
# image mode. Box Drawing (U+2500–257F) is deliberately excluded — those chars
# are in the printer's codepages and are used by the normal receipt layout.
EMOJI_RANGES = (
        (0x1F000, 0x1FAFF),  # emoji, pictographs, symbols (astral planes)
        (0x2600, 0x26FF),    # Miscellaneous Symbols (☀ ☔ ⚡ ...)
        (0x2700, 0x27BF),    # Dingbats (✂ ✅ ❤ ...)
        (0x2300, 0x23FF),    # Miscellaneous Technical (⌚ ⏰ ⏳ ...)
        (0x2B00, 0x2BFF),    # Miscellaneous Symbols and Arrows (⭐ ...)
        (0xFE00, 0xFE0F),    # Variation Selectors (emoji-style presentation)
        (0x1F1E6, 0x1F1FF),  # Regional Indicators (flags)
)


def is_emoji_char(ch):
        cp = ord(ch)
        return any(lo <= cp <= hi for lo, hi in EMOJI_RANGES)


def needs_image_mode(text):
        return any(is_emoji_char(c) for c in text)


def _first_existing(paths):
        for path in paths:
                if os.path.exists(path):
                        return path
        return None


# Lazily built once and cached: (base_font, emoji_font, cell_w, line_h).
_font_cache = None


def _load_fonts():
        """Load the monospace + emoji fonts, sizing them so LINE_WIDTH columns
        fill the printer width. Returns None if the fonts aren't installed."""
        global _font_cache
        if _font_cache is not None:
                return _font_cache

        base_path = _first_existing(BASE_FONT_PATHS)
        emoji_path = _first_existing(EMOJI_FONT_PATHS)
        if not base_path or not emoji_path:
                _font_cache = False
                return None

        target_cell = IMAGE_WIDTH / LINE_WIDTH  # dots per character column
        # Pick the base font size whose advance width best matches target_cell.
        size = 8
        base_font = ImageFont.truetype(base_path, size)
        while size < 200:
                nxt = ImageFont.truetype(base_path, size + 1)
                if nxt.getlength("M") > target_cell:
                        break
                base_font, size = nxt, size + 1

        cell_w = max(int(round(base_font.getlength("M"))), 1)
        ascent, descent = base_font.getmetrics()
        line_h = ascent + descent
        # Emoji glyphs are square; size them to the line height so they read at
        # text scale (they may bleed slightly past one column, which is fine in
        # the free-text body where emoji actually appear).
        emoji_font = ImageFont.truetype(emoji_path, line_h)

        _font_cache = (base_font, emoji_font, cell_w, line_h)
        return _font_cache


def render_text_image(text):
        """Rasterize `text` (already laid out with \\n) onto a monospace grid,
        drawing emoji with the emoji font. Returns a 1-bit-friendly L image, or
        None if fonts are unavailable."""
        fonts = _load_fonts()
        if not fonts:
                return None
        base_font, emoji_font, cell_w, line_h = fonts

        lines = text.split("\n")
        cols = max((len(line) for line in lines), default=0)
        width = max(cell_w * cols, 1)
        height = max(line_h * len(lines), 1)

        img = Image.new("L", (width, height), 255)
        draw = ImageDraw.Draw(img)
        for row, line in enumerate(lines):
                y = row * line_h
                for col, ch in enumerate(line):
                        if ch == " ":
                                continue
                        x = col * cell_w
                        font = emoji_font if is_emoji_char(ch) else base_font
                        # Center the glyph within its column.
                        glyph_w = draw.textlength(ch, font=font)
                        dx = max((cell_w - glyph_w) / 2, 0)
                        draw.text((x + dx, y), ch, font=font, fill=0)

        if img.width > IMAGE_WIDTH:
                h = round(img.height * IMAGE_WIDTH / img.width)
                img = img.resize((IMAGE_WIDTH, h), Image.LANCZOS)
        return img


def get_printer():
        return Usb(VENDOR_ID, PRODUCT_ID)

@app.route('/print', methods=['POST'])
def print_message():
        data = request.json
        message = data.get('content', '')

        if not message:
                return jsonify({"error": "No content provided"}), 400

        # If the message has emoji/Unicode the printer can't encode, render it as
        # a bitmap so it prints properly instead of as "?" placeholders. Fall back
        # to native text if it's plain (crisper/faster) or if the fonts are missing.
        img = render_text_image(message) if needs_image_mode(message) else None

        try:
                p = get_printer()
                if img is not None:
                        p.image(img, center=True)
                        p.text("\n")
                else:
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
