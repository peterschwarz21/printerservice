#!/usr/bin/env node
/**
 * reminders.js
 * Prints any scheduled reminders whose time has arrived and removes them from
 * the store. Reminders are created by the SMS webhook (src/server.js) when a
 * message says "remind me ..." with a parseable time.
 * Cron: * * * * * cd /home/admin/printerservice && . "$HOME/.nvm/nvm.sh" && node reminders.js >> /tmp/reminders.log 2>&1
 */

require('dotenv').config();

const { readAll, writeAll } = require('./src/reminders-store');
const { printMessage } = require('./src/printer');

async function main() {
  const all = readAll();
  if (all.length === 0) return;

  const now = Date.now();
  const due = [];
  const pending = [];
  for (const r of all) {
    if (new Date(r.fireAt).getTime() <= now) due.push(r);
    else pending.push(r);
  }

  if (due.length === 0) return;
  console.log(`${new Date().toISOString()} — ${due.length} reminder(s) due`);

  // Print each due reminder. Keep any that fail so the next run retries them.
  const failed = [];
  for (const r of due) {
    try {
      await printMessage(r.body, r.from, { header: 'REMINDER' });
      console.log(`Printed reminder ${r.id}: "${r.body}"`);
    } catch (err) {
      console.error(`Failed to print reminder ${r.id}: ${err.message} — will retry`);
      failed.push(r);
    }
  }

  writeAll([...pending, ...failed]);
}

main().catch((err) => {
  console.error('Error:', err.message, err.cause ? `(${err.cause})` : '');
  process.exit(1);
});
