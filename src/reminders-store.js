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

module.exports = { readAll, writeAll, addReminder, FILE };
