#!/usr/bin/env node
/**
 * send.js
 * Sends an outbound SMS via Twilio. Useful for verifying an A2P 10DLC campaign
 * is live: sends through the Messaging Service the campaign is attached to, not
 * a bare number, so the message actually exercises the registered campaign.
 *
 * Usage: node send.js +18885551234 "message text"
 */

require('dotenv').config();

const { sendSms, isConfigured } = require('./src/notify');

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage: node send.js <to-number-E.164> "<message>"');
  process.exit(1);
}

async function main() {
  const [to, body] = process.argv.slice(2);
  if (!to || !body) usage('need a destination number and a message body');
  if (!/^\+[1-9]\d{6,14}$/.test(to)) usage(`"${to}" is not an E.164 number (e.g. +15551234567)`);
  if (!isConfigured()) {
    usage('Twilio credentials are unset or still the .env.example placeholders');
  }

  const sid = await sendSms(to, body);
  console.log(`Sent ${sid} to ${to}`);
  console.log('Check delivery: https://console.twilio.com/us1/monitor/logs/sms');
}

main().catch((err) => {
  console.error(`Failed to send: ${err.message}${err.code ? ` (Twilio code ${err.code})` : ''}`);
  process.exit(1);
});
