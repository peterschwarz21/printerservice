require('dotenv').config();
const axios = require('axios');

// 127.0.0.1, not localhost: on Node 18 fetch/undici, localhost can resolve to
// ::1 (IPv6) with no IPv4 fallback, and Flask only listens on IPv4.
const PRINTER_URL = process.env.PRINTER_URL || 'http://127.0.0.1:5000/print';
// Derive the image endpoint from PRINTER_URL so it tracks the same host/port.
const PRINTER_IMAGE_URL = process.env.PRINTER_IMAGE_URL || PRINTER_URL.replace(/\/print$/, '/print-image');
const LINE_WIDTH = 48;

function pad(str, width) {
  const len = str.length;
  if (len >= width) return str.substring(0, width);
  const leftPad = Math.floor((width - len) / 2);
  return ' '.repeat(leftPad) + str + ' '.repeat(width - len - leftPad);
}

function formatMessage(text, from, header = 'NEW TODO') {
  const border = '═'.repeat(LINE_WIDTH);
  const thin = '─'.repeat(LINE_WIDTH);

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Wrap text at LINE_WIDTH
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + (current ? ' ' : '') + word).length <= LINE_WIDTH) {
      current += (current ? ' ' : '') + word;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  const parts = [
    border,
    pad(header, LINE_WIDTH),
    thin,
    pad(`${dateStr} ${timeStr}`, LINE_WIDTH),
    pad(`from ${from}`, LINE_WIDTH),
    thin,
    '',
    ...lines,
    '',
    border,
    '',
    '',
  ];

  return parts.join('\n');
}

async function printMessage(text, from, opts = {}) {
  const content = formatMessage(text, from, opts.header);
  await axios.post(PRINTER_URL, { content });
}

// Print an image (MMS). The raw bytes go in the body; caption/sender ride along
// as URL-encoded headers so the Flask side can keep the body purely binary.
async function printImage(imageBuffer, from, opts = {}) {
  const headers = {
    'Content-Type': opts.contentType || 'application/octet-stream',
    'X-From': encodeURIComponent(from || ''),
  };
  if (opts.caption) headers['X-Caption'] = encodeURIComponent(opts.caption);
  await axios.post(PRINTER_IMAGE_URL, imageBuffer, { headers });
}

module.exports = { printMessage, printImage };
