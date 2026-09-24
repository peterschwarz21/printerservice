#!/usr/bin/env node
/**
 * calendar.js
 * Fetches today's Google Calendar events (multiple accounts, each shared with
 * one OAuth "hub" account) and sends a formatted receipt to the thermal print
 * server. One-time setup: node authorize.js (on a laptop) — see README.
 * Cron: 2 7 * * * cd /home/admin/printerservice && . "$HOME/.nvm/nvm.sh" && node calendar.js
 */

require('dotenv').config();

const { notifyAdmins } = require('./src/notify');

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CONFIG (from .env)
// ---------------------------------------------------------------------------
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TOKEN_FILE    = process.env.GOOGLE_OAUTH_TOKEN || './google-token.json';
const TIMEZONE  = process.env.CALENDAR_TIMEZONE || process.env.WEATHER_TIMEZONE || 'America/Denver';
// 127.0.0.1, not localhost — see src/printer.js
const PRINT_URL = process.env.PRINTER_URL || 'http://127.0.0.1:5000/print';
const WIDTH     = 48;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// CALENDAR_IDS="taylor@gmail.com:T,peter@gmail.com:P" -> [{id, label}]
function parseCalendars() {
  const raw = process.env.CALENDAR_IDS || '';
  const calendars = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const sep = entry.lastIndexOf(':');
      if (sep < 1 || sep === entry.length - 1) {
        throw new Error(`Bad CALENDAR_IDS entry "${entry}" (expected calendarId:Label)`);
      }
      return { id: entry.slice(0, sep).trim(), label: entry.slice(sep + 1).trim() };
    });
  if (calendars.length === 0) {
    throw new Error('CALENDAR_IDS is not set (expected "id1@gmail.com:A,id2@gmail.com:B")');
  }
  return calendars;
}

function loadRefreshToken() {
  const tokenPath = path.resolve(__dirname, TOKEN_FILE);
  let token;
  try {
    token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read token file at ${tokenPath}: ${err.message}. ` +
      'Run `node authorize.js` on your laptop and scp google-token.json here.'
    );
  }
  if (!token.refresh_token) {
    throw new Error(`${tokenPath} has no refresh_token — re-run \`node authorize.js\``);
  }
  return token.refresh_token;
}

// ---------------------------------------------------------------------------
// GOOGLE AUTH (refresh token -> access token, no libraries needed)
// ---------------------------------------------------------------------------
async function getAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes('invalid_grant')) {
      throw new Error(
        'Refresh token expired or revoked — re-run `node authorize.js` on your laptop ' +
        'and copy the new google-token.json to the Pi (also check the Google Auth ' +
        'Platform consent screen is In production, not Testing)'
      );
    }
    throw new Error(`Google token exchange failed: HTTP ${res.status} ${body}`);
  }
  return (await res.json()).access_token;
}

// ---------------------------------------------------------------------------
// TIME HELPERS (the Pi's clock is UTC; all "today" math uses TIMEZONE)
// ---------------------------------------------------------------------------
// "2026-07-17" for a Date, in the configured timezone
function localDateStr(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// UTC instant of local midnight for a "YYYY-MM-DD": guess midnight UTC, then
// correct by the observed wall-clock offset (twice, for DST edges).
function zonedMidnightUtc(dateStr) {
  let guess = new Date(`${dateStr}T00:00:00Z`);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(guess).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
    const wall = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
    const target = new Date(`${dateStr}T00:00:00Z`);
    guess = new Date(guess.getTime() + (target.getTime() - wall.getTime()));
  }
  return guess;
}

function localDayRange() {
  const timeMin = zonedMidnightUtc(localDateStr(new Date()));
  // Local midnight tomorrow: jump 26h past today's midnight, take that local
  // date, resolve its midnight (handles 23/24/25-hour DST days).
  const timeMax = zonedMidnightUtc(localDateStr(new Date(timeMin.getTime() + 26 * 3600 * 1000)));
  return { timeMin, timeMax };
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month:   'short',
    day:     'numeric',
    timeZone: TIMEZONE,
  });
}

// "8:00a" / "12:30p", padded to 6 chars so columns align
function formatTime(date) {
  const t = date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TIMEZONE,
  });
  return t.replace(' AM', 'a').replace(' PM', 'p').padStart(6);
}

// ---------------------------------------------------------------------------
// FETCH EVENTS
// ---------------------------------------------------------------------------
// Descriptions can contain HTML; strip tags, decode common entities, collapse
// whitespace, and keep the first 100 characters.
function cleanDescription(html) {
  if (!html) return '';
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 100 ? text.slice(0, 100).trimEnd() + '...' : text;
}

async function fetchCalendar(token, calendar, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin:      timeMin.toISOString(),
    timeMax:      timeMax.toISOString(),
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '50',
    fields:       'items(summary,location,description,start,end,status)',
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || [])
    .filter((ev) => ev.status !== 'cancelled')
    .map((ev) => ({
      label:       calendar.label,
      title:       ev.summary || '(no title)',
      location:    (ev.location || '').trim(),
      description: cleanDescription(ev.description),
      allDay:      !ev.start.dateTime,
      start:       ev.start.dateTime ? new Date(ev.start.dateTime) : null,
      end:         ev.end?.dateTime ? new Date(ev.end.dateTime) : null,
    }));
}

// ---------------------------------------------------------------------------
// DEDUPE
// ---------------------------------------------------------------------------
// The same real-world event often sits on several calendars (a shared dinner,
// a kid's game both parents track). Each copy is a separate Google event, so
// without this it prints once per calendar. Match on normalized title + exact
// start/end, and merge the copies into one line tagged with every calendar it
// came from: [T] + [P] -> [T/P].
function dedupeKey(ev) {
  const title = ev.title.toLowerCase().replace(/\s+/g, ' ').trim();
  // All-day events carry no start (fetchCalendar only reads start.dateTime)
  // and the fetch window is a single day, so the title alone identifies them.
  if (ev.allDay) return `allday|${title}`;
  return `${ev.start.getTime()}|${ev.end ? ev.end.getTime() : ''}|${title}`;
}

function dedupeEvents(events) {
  const byKey = new Map();
  for (const ev of events) {
    const key = dedupeKey(ev);
    const seen = byKey.get(key);
    if (!seen) {
      // Copy, so merging never mutates the objects fetchCalendar returned.
      byKey.set(key, { ...ev, labels: [ev.label] });
      continue;
    }
    if (!seen.labels.includes(ev.label)) seen.labels.push(ev.label);
    // Copies differ in detail: the organizer's has the address, an invitee's
    // is often bare. Keep the first non-empty value for each field.
    seen.location    = seen.location    || ev.location;
    seen.description = seen.description || ev.description;
  }
  // `events` arrives in CALENDAR_IDS order (Promise.allSettled preserves input
  // order), so labels come out in config order — no sort needed.
  return [...byKey.values()].map(({ labels, ...ev }) => ({ ...ev, label: labels.join('/') }));
}

// ---------------------------------------------------------------------------
// FORMAT RECEIPT
// ---------------------------------------------------------------------------
function center(str) {
  const pad = Math.max(0, Math.floor((WIDTH - str.length) / 2));
  return ' '.repeat(pad) + str;
}

// Word-wrap text into lines of `width`, breaking oversized words
function wrap(text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if ((current + (current ? ' ' : '') + word).length <= width) {
      current += (current ? ' ' : '') + word;
    } else {
      if (current) lines.push(current);
      current = word.length > width ? word.slice(0, width) : word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// One event as receipt lines: prefix on the first line, everything else
// (wrapped title, location, description) indented to line up under it
function eventLines(prefix, ev) {
  const width = WIDTH - prefix.length;
  const indent = ' '.repeat(prefix.length);
  const lines = wrap(ev.title, width).map((line, i) => (i === 0 ? prefix : indent) + line);
  if (ev.location) {
    lines.push(...wrap(`@ ${ev.location}`, width).map((line) => indent + line));
  }
  if (ev.description) {
    lines.push(...wrap(ev.description, width).map((line) => indent + line));
  }
  return lines;
}

function formatReceipt(events, warnings) {
  const DIVIDER = '='.repeat(WIDTH);
  const THIN    = '-'.repeat(WIDTH);

  // Merged events carry wider tags ([T/P]); pad them all to the widest so the
  // titles line up. Seeded with 1 so an empty `events` can't yield -Infinity.
  const tagWidth = Math.max(...events.map((ev) => ev.label.length), 1) + 2;
  const tag = (ev) => `[${ev.label}]`.padEnd(tagWidth);

  const allDay = events.filter((ev) => ev.allDay);
  const timed  = events
    .filter((ev) => !ev.allDay)
    .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));

  const lines = [
    DIVIDER,
    center("TODAY'S PLAN"),
    center(formatDate(new Date())),
    DIVIDER,
    '',
  ];

  if (events.length === 0) {
    lines.push(center('No events today'));
    lines.push('');
  }

  if (allDay.length > 0) {
    lines.push('ALL DAY', THIN);
    for (const ev of allDay) {
      lines.push(...eventLines(` ${tag(ev)} `, ev));
    }
    lines.push('');
  }

  if (timed.length > 0) {
    lines.push('SCHEDULE', THIN);
    for (const ev of timed) {
      const time = ev.end
        ? `${formatTime(ev.start)}-${formatTime(ev.end).trimStart()}`
        : formatTime(ev.start);
      lines.push(...eventLines(`${time.padEnd(13)} ${tag(ev)} `, ev));
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push(THIN);
    for (const warning of warnings) lines.push(` ! ${warning}`);
    lines.push('');
  }

  const count = events.length;
  lines.push(
    DIVIDER,
    center(count === 0 ? 'Enjoy the open day!' : `${count} event${count === 1 ? '' : 's'} today`),
    DIVIDER,
    '',
    '', // extra feed so paper clears the tear bar
  );

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
  // A printer exception comes back as a 500 from print_server.py; treat that as
  // a failed job so the catch below can alert, rather than logging "HTTP 500"
  // and exiting 0.
  if (!res.ok) throw new Error(`Print server error: ${res.status}`);
  return res.status;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env (see README)');
  }
  const calendars = parseCalendars();
  const refreshToken = loadRefreshToken();

  console.log('Authenticating with Google...');
  const token = await getAccessToken(refreshToken);

  console.log(`Fetching ${calendars.length} calendar(s)...`);
  const { timeMin, timeMax } = localDayRange();
  const results = await Promise.allSettled(
    calendars.map((cal) => fetchCalendar(token, cal, timeMin, timeMax))
  );

  // One broken calendar (revoked share, typo'd ID) shouldn't kill the receipt
  const collected = [];
  const warnings = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      collected.push(...result.value);
    } else {
      console.error(`Calendar [${calendars[i].label}] failed:`, result.reason.message);
      warnings.push(`Could not load calendar [${calendars[i].label}] (${result.reason.message})`);
    }
  });

  const events = dedupeEvents(collected);
  if (events.length < collected.length) {
    console.log(`Merged ${collected.length - events.length} duplicate event(s) across calendars.`);
  }

  // Nothing worth printing: no events and no calendar failures to report.
  // Skip the receipt entirely so an empty day doesn't waste paper.
  if (events.length === 0 && warnings.length === 0) {
    console.log('No events today — nothing to print.');
    return;
  }

  console.log('Formatting receipt...');
  const receipt = formatReceipt(events, warnings);

  console.log('--- PREVIEW ---');
  console.log(receipt);
  console.log('--- END PREVIEW ---');

  console.log('Sending to printer...');
  const status = await sendToPrinter(receipt);
  console.log(`Print server responded with HTTP ${status}`);
}

// Guarded so the dedupe helpers can be required and exercised with fixtures;
// running `node calendar.js` (and cron) is unchanged.
if (require.main === module) {
  main().catch(async (err) => {
    // fetch() wraps the real network error (e.g. ECONNREFUSED) in err.cause
    console.error('Error:', err.message, err.cause ? `(${err.cause})` : '');
    // await, not fire-and-forget: process.exit kills the in-flight request.
    await notifyAdmins('cron:calendar', `Calendar receipt failed: ${err.message}`);
    process.exit(1);
  });
} else {
  module.exports = { dedupeEvents, dedupeKey, formatReceipt };
}
