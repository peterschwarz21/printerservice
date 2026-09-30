require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { allowedNumbers } = require('./allowlist');
const { sendSms, messageAdmins, isConfigured, isPermanentFailure } = require('./notify');

// ALLOWED_NUMBERS has no history of its own, so "just added" means "on the list
// but not in this file yet". The webhook runs welcome() on every start (an .env
// edit needs a restart anyway) and welcome.js runs it by hand, so both
// processes can land here — same atomic write as src/reminders-store.js.
const FILE = process.env.WELCOMED_FILE || path.resolve(__dirname, '..', 'welcomed.json');

// No emoji or curly quotes on purpose: either one flips the whole message from
// GSM-7 (153 chars a segment) to UCS-2 (67), doubling what this costs to send.
// Doubles as the A2P opt-in confirmation, hence the HELP/STOP/rates line.
const DEFAULT_MESSAGE = "You've been added to the text-to-print printer! Text this number a message "
  + 'or photo and it prints at home. Try "remind me at 7pm to take out the trash" too. '
  + 'Reply HELP for help, STOP to opt out. Msg & data rates may apply.';
const MESSAGE = process.env.WELCOME_MESSAGE || DEFAULT_MESSAGE;

// Returns null when the file doesn't exist yet, so the first run can tell
// "never welcomed anyone" from "welcomed everyone already".
function readWelcomed() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`welcome: could not read ${FILE}: ${err.message}`);
      return {};
    }
    return null;
  }
}

function writeWelcomed(state) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

function summarize({ sent, optedOut, failed }) {
  const lines = [];
  if (sent.length) lines.push(`👋 Welcome text sent to ${sent.join(', ')}.`);
  if (optedOut.length) lines.push(`⚠️ ${optedOut.join(', ')} opted out — they'd need to text START.`);
  if (failed.length) lines.push(`❌ Couldn't reach ${failed.join(', ')} — will retry on the next restart.`);
  return lines.join('\n');
}

// Text the welcome to everyone on ALLOWED_NUMBERS who hasn't had it (or to
// everyone, with `all`), then tell ADMIN_NUMBERS who got it. Never throws: it
// runs as the webhook starts, and a welcome must not be what keeps the printer
// down. Returns the numbers in each outcome.
async function welcome({ all = false, dryRun = false } = {}) {
  const result = { sent: [], optedOut: [], failed: [], seeded: [] };
  try {
    const existing = readWelcomed();
    const state = existing || {};

    // Forget anyone taken off the list, so adding them back welcomes them again.
    let changed = false;
    for (const number of Object.keys(state)) {
      if (!allowedNumbers.includes(number)) {
        delete state[number];
        changed = true;
      }
    }

    // First run: everyone already on the list predates this feature and has
    // been texting the printer for a while. Record them without sending, so a
    // deploy doesn't surprise the whole household — --all is there for that.
    if (existing === null && !all) {
      const now = new Date().toISOString();
      for (const number of allowedNumbers) {
        state[number] = { welcomedAt: now, status: 'seeded' };
      }
      result.seeded = [...allowedNumbers];
      if (dryRun) {
        console.log(`welcome: [dry run] first run — would record ${allowedNumbers.length} existing number(s) without texting them`);
      } else {
        writeWelcomed(state);
        console.log(`welcome: first run — recorded ${allowedNumbers.length} existing number(s) without texting them. Run \`node welcome.js --all\` to welcome everyone.`);
      }
      return result;
    }

    const targets = all ? [...allowedNumbers] : allowedNumbers.filter((n) => !state[n]);
    if (targets.length === 0) {
      if (changed && !dryRun) writeWelcomed(state);
      console.log('welcome: nobody new on ALLOWED_NUMBERS');
      return result;
    }

    if (dryRun) {
      console.log(`welcome: [dry run] would text ${targets.join(', ')}:\n${MESSAGE}`);
      return result;
    }

    if (!isConfigured()) {
      if (changed) writeWelcomed(state);
      console.warn(`welcome: Twilio not configured, not welcoming ${targets.join(', ')}`);
      return result;
    }

    for (const to of targets) {
      try {
        const sid = await sendSms(to, MESSAGE);
        console.log(`welcome: sent ${to} the welcome text (${sid})`);
        state[to] = { welcomedAt: new Date().toISOString(), status: 'sent' };
        result.sent.push(to);
      } catch (err) {
        if (isPermanentFailure(err)) {
          // Recorded so every restart doesn't retry a guaranteed failure.
          console.error(`welcome: ${to} cannot receive messages (${err.message})`);
          state[to] = { welcomedAt: new Date().toISOString(), status: 'opted-out' };
          result.optedOut.push(to);
        } else {
          // Left unrecorded, so the next run tries again.
          console.error(`welcome: could not reach ${to}: ${err.message}`);
          result.failed.push(to);
          continue;
        }
      }
      // After every send, so a crash halfway through can't double-text anyone.
      writeWelcomed(state);
    }
    // Persist the pruning even if every send failed and nothing wrote above.
    if (changed) writeWelcomed(state);

    await messageAdmins(summarize(result), 'welcome summary');
    return result;
  } catch (err) {
    console.error(`welcome: unexpected failure: ${err.message}`);
    return result;
  }
}

module.exports = { welcome, DEFAULT_MESSAGE, FILE };
