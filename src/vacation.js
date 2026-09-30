require('dotenv').config();
const fs = require('fs');
const path = require('path');
const chrono = require('chrono-node');

const { TIMEZONE, localDateStr, tzOffsetMinutes, zonedWallToUtc } = require('./reminder-parser');

// Vacation mode pauses the *scheduled* printing (daily receipts, weather alerts)
// and reroutes due reminders to SMS. Texted messages still print. Toggled by the
// admin-only /vacation command; the webhook and every cron job are separate
// processes, so the state lives in a file and is read fresh on each call.
// File absent = off.
const FILE = process.env.VACATION_FILE || path.resolve(__dirname, '..', 'vacation.json');

function readFile() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`vacation: could not read ${FILE}: ${err.message}`);
    }
    return null;
  }
}

// { since, until } while vacation mode is on, else null. An end date that has
// passed reads as off — no cron job needed to switch it back.
function getVacation(now = new Date()) {
  const v = readFile();
  if (!v) return null;
  if (v.until && new Date(v.until).getTime() <= now.getTime()) return null;
  return { since: v.since || null, until: v.until || null };
}

// Atomic write (temp file + rename), mirroring src/reminders-store.js.
function startVacation(until = null) {
  const state = {
    since: new Date().toISOString(),
    until: until instanceof Date ? until.toISOString() : until,
  };
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
  return state;
}

function endVacation() {
  try {
    fs.unlinkSync(FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// "Oct 12", "next friday", "Oct 12 6pm" -> Date, or null if unparseable or not
// in the future. A bare date ends at midnight starting that day, so the morning
// receipts are waiting on the day you get home.
function parseVacationEnd(text, now = new Date()) {
  const results = chrono.parse(text, { instant: now, timezone: tzOffsetMinutes(now) }, { forwardDate: true });
  if (!results.length) return null;

  const start = results[0].start;
  let end = start.date();
  if (!start.isCertain('hour')) {
    end = zonedWallToUtc(localDateStr(end), 0, 0);
  }
  return end.getTime() > now.getTime() ? end : null;
}

function describeVacation(v) {
  if (!v || !v.until) return 'until further notice';
  const until = new Date(v.until);
  const opts = { weekday: 'short', month: 'short', day: 'numeric', timeZone: TIMEZONE };
  // Midnight means "the day you're back" — don't clutter it with "12:00 AM".
  const midnight = until.getTime() === zonedWallToUtc(localDateStr(until), 0, 0).getTime();
  if (!midnight) Object.assign(opts, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `until ${until.toLocaleString('en-US', opts)}`;
}

module.exports = { getVacation, startVacation, endVacation, parseVacationEnd, describeVacation, FILE };
