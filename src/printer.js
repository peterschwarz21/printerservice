require('dotenv').config();
const axios = require('axios');

const PRINTER_URL = process.env.PRINTER_URL || 'http://printer-server';
const LINE_WIDTH = 48;

function pad(str, width) {
  const len = str.length;
  if (len >= width) return str.substring(0, width);
  const leftPad = Math.floor((width - len) / 2);
  return ' '.repeat(leftPad) + str + ' '.repeat(width - len - leftPad);
}

function formatMessage(text, from) {
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
    pad('📋 NEW TODO', LINE_WIDTH),
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

async function printMessage(text, from) {
  const content = formatMessage(text, from);
  await axios.post(PRINTER_URL, { content });
}

module.exports = { printMessage };
