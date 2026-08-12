import glob
import io
import logging
import os
import textwrap
from urllib.parse import unquote

from dotenv import load_dotenv
from flask import Flask, request, jsonify
from escpos.printer import Usb
from PIL import Image, ImageOps, ImageDraw, ImageFont

# Load shared .env from the repo root (one level up from this file)
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("print_server")

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

# Where to hunt for fonts. We glob these recursively rather than hardcode exact
# paths, because different distros/packages drop the same font in different dirs.
FONT_DIRS = [
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        os.path.expanduser("~/.fonts"),
        "/Library/Fonts",          # macOS dev
        "/System/Library/Fonts",   # macOS dev
]
# Monospace base font (filename patterns, most-preferred first): keeps the box
# borders (═ ─) and centered padding aligned. fonts-dejavu-core provides the first.
BASE_FONT_NAMES = [
        "DejaVuSansMono.ttf",
        "LiberationMono-Regular.ttf",
        "DejaVuSansMono-Bold.ttf",
        "Menlo.ttc",
]
# Monochrome emoji fonts, preferred: they render clean 1-bit glyphs a thermal head
# can print directly. fonts-noto-core (or fonts-noto) provides NotoEmoji-Regular.
MONO_EMOJI_NAMES = [
        "NotoEmoji-Regular.ttf",
        "NotoEmoji-VariableFont_wght.ttf",
        "Symbola.ttf",
        "Symbola_hint.ttf",
]
# Color emoji fonts, accepted as a fallback. fonts-noto-color-emoji provides the
# first. These are color bitmap fonts, so we render them with embedded_color and
# flatten to grayscale — messier than mono, but far better than "?".
COLOR_EMOJI_NAMES = [
        "NotoColorEmoji.ttf",
        "AppleColorEmoji.ttf",
        "Apple Color Emoji.ttc",
        "seguiemj.ttf",
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


def _find_font(names):
        """Return the first existing font path matching `names` (in priority
        order), searched recursively under FONT_DIRS."""
        for name in names:
                for d in FONT_DIRS:
                        hits = glob.glob(os.path.join(d, "**", name), recursive=True)
                        if hits:
                                return sorted(hits)[0]
        return None


# Lazily built once and cached:
# (base_font, emoji_font, cell_w, line_h, emoji_is_color). False = unavailable.
_font_cache = None


def _load_fonts():
        """Load the monospace + emoji fonts, sizing them so LINE_WIDTH columns
        fill the printer width. Returns None (and logs why) if fonts are missing."""
        global _font_cache
        if _font_cache is not None:
                return _font_cache or None

        base_path = _find_font(BASE_FONT_NAMES)
        emoji_path = _find_font(MONO_EMOJI_NAMES)
        emoji_is_color = False
        if not emoji_path:
                emoji_path = _find_font(COLOR_EMOJI_NAMES)
                emoji_is_color = bool(emoji_path)

        if not base_path or not emoji_path:
                log.warning(
                        "Emoji rendering DISABLED (falling back to '?'): base_font=%s "
                        "emoji_font=%s. Install: sudo apt install -y fonts-dejavu-core "
                        "fonts-noto-core (or fonts-noto-color-emoji).",
                        base_path, emoji_path,
                )
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
        emoji_font = _load_emoji_font(emoji_path, line_h, emoji_is_color)

        log.info(
                "Emoji rendering ENABLED: base_font=%s emoji_font=%s (color=%s) "
                "cell_w=%d line_h=%d", base_path, emoji_path, emoji_is_color,
                cell_w, line_h,
        )
        _font_cache = (base_font, emoji_font, cell_w, line_h, emoji_is_color)
        return _font_cache


def _load_emoji_font(path, line_h, is_color):
        """Load the emoji font at line height. Color bitmap fonts (e.g.
        NotoColorEmoji) only ship fixed strike sizes, so fall back to one of
        those and let the per-glyph tile downscale."""
        if not is_color:
                return ImageFont.truetype(path, line_h)
        try:
                return ImageFont.truetype(path, line_h)
        except OSError:
                for strike in (109, 128, 136, 160):
                        try:
                                return ImageFont.truetype(path, strike)
                        except OSError:
                                continue
                raise


def _paste_emoji(base_img, ch, x, y, cell_w, line_h, emoji_font, is_color):
        """Render one emoji glyph to its own tile, flatten to grayscale, scale to
        the line height, and paste it centered in its column. Handles both mono
        and color fonts; never raises (a failed glyph is just skipped)."""
        try:
                tile = Image.new("RGBA", (line_h * 3, line_h * 3), (255, 255, 255, 0))
                ImageDraw.Draw(tile).text(
                        (0, 0), ch, font=emoji_font,
                        embedded_color=is_color, fill=(0, 0, 0),
                )
                bbox = tile.getbbox()
                if not bbox:
                        return
                glyph = tile.crop(bbox)
                scale = line_h / glyph.height
                gw = max(1, int(round(glyph.width * scale)))
                gh = max(1, int(round(glyph.height * scale)))
                glyph = glyph.resize((gw, gh), Image.LANCZOS)
                flat = Image.new("RGBA", glyph.size, (255, 255, 255, 255))
                flat.alpha_composite(glyph)
                dx = int(x + max((cell_w - gw) // 2, 0))
                base_img.paste(flat.convert("L"), (dx, int(y)))
        except Exception as e:
                log.warning("skipped emoji %r: %s", ch, e)


def render_text_image(text):
        """Rasterize `text` (already laid out with \\n) onto a monospace grid,
        drawing emoji with the emoji font. Returns an L image, or None if fonts
        are unavailable."""
        fonts = _load_fonts()
        if not fonts:
                return None
        base_font, emoji_font, cell_w, line_h, emoji_is_color = fonts

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
                        if is_emoji_char(ch):
                                _paste_emoji(img, ch, x, y, cell_w, line_h,
                                             emoji_font, emoji_is_color)
                        else:
                                # Center the glyph within its column.
                                glyph_w = draw.textlength(ch, font=base_font)
                                dx = max((cell_w - glyph_w) / 2, 0)
                                draw.text((x + dx, y), ch, font=base_font, fill=0)

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
