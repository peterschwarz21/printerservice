require('dotenv').config();
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const { parseNumbers } = require('./allowlist');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
// An A2P 10DLC campaign attaches to a Messaging Service, so prefer it over a
// bare number — sends through the number alone may not carry the campaign.
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Operational alerts only. Deliberately NOT falling back to ALLOWED_NUMBERS:
// the print allowlist is the household, and they don't need a paper-jam page.
const adminNumbers = parseNumbers(process.env.ADMIN_NUMBERS);

// One outage fails all four 7am cron jobs within six minutes. Remember when we
// last paged about each kind of failure and stay quiet for a while after.
const COOLDOWN_MINUTES = parseInt(process.env.NOTIFY_COOLDOWN_MINUTES || '360', 10);
const STATE_FILE = process.env.NOTIFY_STATE_FILE || path.resolve(__dirname, '..', 'notify-state.json');

// True once the .env holds real credentials rather than the .env.example
// placeholders, and something to send from.
function isConfigured() {
  if (!ACCOUNT_SID || !AUTH_TOKEN) return false;
  if (!ACCOUNT_SID.startsWith('AC') || ACCOUNT_SID.startsWith('ACxxxx')) return false;
  if (AUTH_TOKEN === 'your_twilio_auth_token_here') return false;
  return Boolean(MESSAGING_SERVICE_SID || FROM_NUMBER);
}

function readState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    // Missing file (first run) or unreadable -> treat as "never alerted".
    if (err.code !== 'ENOENT') {
      console.warn(`notify: could not read ${STATE_FILE}: ${err.message}`);
    }
    return {};
  }
}

// Atomic write (temp file + rename), mirroring reminders-store.js: the
// per-minute reminder sweeper and the 7am cron jobs can both land here at once.
function writeState(state) {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// Sends and throws on failure — callers that must know (the reminder fallback)
// catch it. Returns the message SID.
async function sendSms(to, body) {
  if (!isConfigured()) {
    throw new Error('Twilio is not configured (check TWILIO_* values in .env)');
  }
  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
  const opts = { to, body };
  if (MESSAGING_SERVICE_SID) opts.messagingServiceSid = MESSAGING_SERVICE_SID;
  else opts.from = FROM_NUMBER;

  const sent = await client.messages.create(opts);
  return sent.sid;
}

// Page ADMIN_NUMBERS about a failure, at most once per `key` per cooldown
// window. Never throws: a notifier that crashes the job it was reporting on is
// worse than silence. Returns true if anything was sent.
async function notifyAdmins(key, body) {
  try {
    if (adminNumbers.length === 0) {
      console.log(`notify: ADMIN_NUMBERS is empty, not alerting (${key})`);
      return false;
    }
    if (!isConfigured()) {
      console.warn(`notify: Twilio not configured, not alerting (${key})`);
      return false;
    }

    const state = readState();
    const last = state[key] ? new Date(state[key]).getTime() : 0;
    const quietUntil = last + COOLDOWN_MINUTES * 60 * 1000;
    if (Date.now() < quietUntil) {
      console.log(`notify: "${key}" is in cooldown until ${new Date(quietUntil).toISOString()}, staying quiet`);
      return false;
    }

    let sent = 0;
    for (const to of adminNumbers) {
      try {
        const sid = await sendSms(to, body);
        console.log(`notify: alerted ${to} about "${key}" (${sid})`);
        sent++;
      } catch (err) {
        console.error(`notify: could not alert ${to}: ${err.message}`);
      }
    }

    // Only start the cooldown if someone actually heard about it, so a total
    // Twilio outage doesn't silence the next six hours of real alerts.
    if (sent > 0) {
      state[key] = new Date().toISOString();
      writeState(state);
    }
    return sent > 0;
  } catch (err) {
    console.error(`notify: unexpected failure alerting about "${key}": ${err.message}`);
    return false;
  }
}

module.exports = { sendSms, notifyAdmins, isConfigured, STATE_FILE };
