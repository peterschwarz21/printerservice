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
const { sendSms, isPermanentFailure } = require('./src/notify');

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

  // Print each due reminder. If the printer is down the reminder is already
  // late, so fall back to texting it — the content is the point, the paper
  // isn't. Anything we can neither print nor text stays queued for the next run.
  const failed = [];
  for (const r of due) {
    try {
      await printMessage(r.body, r.from, { header: 'REMINDER' });
      console.log(`Printed reminder ${r.id}: "${r.body}"`);
      continue;
    } catch (err) {
      console.error(`Failed to print reminder ${r.id}: ${err.message} — trying SMS`);
    }

    // Someone who texted STOP can never receive the fallback, so don't spend an
    // API call rediscovering that every minute — keep retrying the printer only.
    if (r.smsUndeliverable) {
      failed.push(r);
      continue;
    }

    try {
      // Label it, so an unexpected text reads as the reminder it is.
      const sid = await sendSms(r.from, `⏰ Reminder (printer offline): ${r.body}`);
      console.log(`Texted reminder ${r.id} to ${r.from} (${sid})`);
    } catch (err) {
      if (isPermanentFailure(err)) {
        console.error(`Reminder ${r.id}: ${r.from} cannot receive SMS (${err.message}) — will keep retrying the printer only`);
        failed.push({ ...r, smsUndeliverable: true });
      } else {
        // Drop it only once it has actually reached them; a Twilio hiccup must
        // not be what destroys the reminder.
        console.error(`Failed to text reminder ${r.id}: ${err.message} — will retry`);
        failed.push(r);
      }
    }
  }

  writeAll([...pending, ...failed]);
}

main().catch((err) => {
  console.error('Error:', err.message, err.cause ? `(${err.cause})` : '');
  process.exit(1);
});
