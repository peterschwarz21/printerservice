require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Pending reminders live in a small JSON file (gitignored). Volume is tiny
// (single household), so a plain file is plenty. Default sits at the repo root
// next to google-token.json.
const FILE = process.env.REMINDERS_FILE || path.resolve(__dirname, '..', 'reminders.json');

function readAll() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    // Missing file (first run) or unreadable -> treat as empty.
    if (err.code !== 'ENOENT') {
      console.warn(`reminders-store: could not read ${FILE}: ${err.message}`);
    }
    return [];
  }
}

// Write atomically (temp file + rename) so the webhook writer and the cron
// sweeper never see a half-written file. Mirrors authorize.js's careful write.
function writeAll(entries) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, FILE);
}

function addReminder({ from, body, fireAt, original }) {
  const entries = readAll();
  entries.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from,
    body,
    fireAt: fireAt instanceof Date ? fireAt.toISOString() : fireAt,
    createdAt: new Date().toISOString(),
    original,
  });
  writeAll(entries);
}

// The id is `<timestamp>-<random>`; the random half alone is short enough to
// text back and stays stable as reminders fire, which a list index would not.
function handleOf(id) {
  return String(id).split('-').pop();
}

// Remove by handle. Returns the reminder that was removed, or null if no such
// handle — the caller needs to tell "cancelled" from "never existed".
function removeReminder(handle) {
  const wanted = String(handle).trim().toLowerCase();
  const entries = readAll();
  const match = entries.find((r) => handleOf(r.id).toLowerCase() === wanted);
  if (!match) return null;
  writeAll(entries.filter((r) => r !== match));
  return match;
}

module.exports = { readAll, writeAll, addReminder, removeReminder, handleOf, FILE };
