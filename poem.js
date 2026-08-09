#!/usr/bin/env node
/**
 * poem.js
 * Fetches a short public-domain poem and sends a formatted receipt to the
 * thermal print server. Uses the free PoetryDB API (no key/account required).
 * Cron: 4 7 * * * cd /home/admin/printerservice && . "$HOME/.nvm/nvm.sh" && node poem.js
 */

require('dotenv').config();

// ---------------------------------------------------------------------------
// CONFIG (from .env)
// ---------------------------------------------------------------------------
// Free PoetryDB API — no key, no account, no quota. https://poetrydb.org
const API_BASE  = process.env.POEM_API_BASE   || 'https://poetrydb.org';
// Keep receipts short: only pull poems up to this many lines.
const MAX_LINES = parseInt(process.env.POEM_MAX_LINES || '12', 10);
const MIN_LINES = 4;
// 127.0.0.1, not localhost — see src/printer.js
const PRINT_URL = process.env.PRINTER_URL     || 'http://127.0.0.1:5000/print';
const TIMEZONE  = process.env.WEATHER_TIMEZONE || 'America/Denver';
const WIDTH     = 48;

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function center(str) {
  const pad = Math.max(0, Math.floor((WIDTH - str.length) / 2));
  return ' '.repeat(pad) + str;
}

// Word-wrap text into lines of `width`, hard-breaking words longer than width.
function wrap(text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    let w = word;
    // Break words that can't fit on a line at all (rare in poetry).
    while (w.length > width) {
      if (current) { lines.push(current); current = ''; }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if ((current + (current ? ' ' : '') + w).length <= width) {
      current += (current ? ' ' : '') + w;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month:   'short',
    day:     'numeric',
    timeZone: TIMEZONE,
  });
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// FETCH POEM
// ---------------------------------------------------------------------------
// PoetryDB's /linecount/{N} returns every poem with exactly N lines, so picking
// a small N guarantees a short poem. We try a few random line counts in case a
// particular count comes back empty.
async function fetchPoem() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const n   = randInt(MIN_LINES, MAX_LINES);
    const res = await fetch(`${API_BASE}/linecount/${n}`);
    if (!res.ok) throw new Error(`PoetryDB error: ${res.status}`);

    const data = await res.json();
    // PoetryDB returns an array of poems, or a {status, reason} object if none.
    if (Array.isArray(data) && data.length > 0) {
      const poem = data[randInt(0, data.length - 1)];
      return {
        title:  poem.title  || 'Untitled',
        author: poem.author || 'Unknown',
        lines:  Array.isArray(poem.lines) ? poem.lines : [],
      };
    }
  }
  throw new Error('PoetryDB returned no poems after 3 attempts');
}

// ---------------------------------------------------------------------------
// FORMAT RECEIPT
// ---------------------------------------------------------------------------
function formatReceipt(poem) {
  const DIVIDER = '='.repeat(WIDTH);
  const THIN    = '-'.repeat(WIDTH);
  const dateStr = formatDate(new Date());

  const lines = [
    DIVIDER,
    center('POEM OF THE DAY'),
    center(dateStr),
    DIVIDER,
    '',
  ];

  // Title (wrapped, indented) and author.
  for (const line of wrap(poem.title, WIDTH - 2)) lines.push('  ' + line);
  lines.push('  by ' + poem.author);
  lines.push('');
  lines.push(THIN);

  // Poem body: preserve blank lines (stanza breaks), wrap the rest.
  for (const raw of poem.lines) {
    if (raw.trim() === '') {
      lines.push('');
    } else {
      for (const line of wrap(raw, WIDTH - 2)) lines.push('  ' + line);
    }
  }

  lines.push('');
  lines.push(DIVIDER);
  lines.push('');
  lines.push(''); // extra feed so paper clears the tear bar

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// SEND TO PRINTER
// ---------------------------------------------------------------------------
async function sendToPrinter(content) {
  const res = await fetch(PRINT_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ content }),
  });
  return res.status;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  console.log('Fetching poem...');
  const poem = await fetchPoem();

  console.log('Formatting receipt...');
  const receipt = formatReceipt(poem);

  console.log('--- PREVIEW ---');
  console.log(receipt);
  console.log('--- END PREVIEW ---');

  console.log('Sending to printer...');
  const status = await sendToPrinter(receipt);
  console.log(`Print server responded with HTTP ${status}`);
}

main().catch((err) => {
  // fetch() wraps the real network error (e.g. ECONNREFUSED) in err.cause
  console.error('Error:', err.message, err.cause ? `(${err.cause})` : '');
  process.exit(1);
});
