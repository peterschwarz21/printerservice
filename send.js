#!/usr/bin/env node
/**
 * send.js
 * Sends an outbound SMS via Twilio. Useful for verifying an A2P 10DLC campaign
 * is live: send through the Messaging Service the campaign is attached to, not
 * a bare number, so the message actually exercises the registered campaign.
 *
 * Usage: node send.js +18885551234 "message text"
 */

require('dotenv').config();

const twilio = require('twilio');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage: node send.js <to-number-E.164> "<message>"');
  process.exit(1);
}

async function main() {
  const [to, body] = process.argv.slice(2);
  if (!to || !body) usage('need a destination number and a message body');
  if (!/^\+[1-9]\d{6,14}$/.test(to)) usage(`"${to}" is not an E.164 number (e.g. +15551234567)`);

  if (!ACCOUNT_SID || !AUTH_TOKEN || ACCOUNT_SID.startsWith('ACxxxx')) {
    usage('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are unset or still placeholders in .env');
  }
  // Prefer the Messaging Service — that is what an A2P campaign is bound to.
  if (!MESSAGING_SERVICE_SID && !FROM_NUMBER) {
    usage('set TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_PHONE_NUMBER in .env');
  }

  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
  const opts = { to, body };
  if (MESSAGING_SERVICE_SID) opts.messagingServiceSid = MESSAGING_SERVICE_SID;
  else opts.from = FROM_NUMBER;

  const sent = await client.messages.create(opts);
  console.log(`Sent ${sent.sid} to ${to} — status: ${sent.status}`);
  console.log(`Via: ${MESSAGING_SERVICE_SID ? `messaging service ${MESSAGING_SERVICE_SID}` : `number ${FROM_NUMBER}`}`);
  console.log('Check delivery: https://console.twilio.com/us1/monitor/logs/sms');
}

main().catch((err) => {
  console.error(`Failed to send: ${err.message}${err.code ? ` (Twilio code ${err.code})` : ''}`);
  process.exit(1);
});
