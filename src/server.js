require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { isAllowed } = require('./allowlist');
const { printMessage } = require('./printer');
const { parseReminder, TIMEZONE } = require('./reminder-parser');
const { addReminder } = require('./reminders-store');

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

function twimlReply(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.type('text/xml').send(twiml.toString());
}

app.post('/webhook', (req, res) => {
  // Validate the request is genuinely from Twilio
  const signature = req.headers['x-twilio-signature'];
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
  const host = req.get('x-original-host') || req.get('host');
  const url = `${protocol}://${host}${req.originalUrl}`;
  const isValid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);

  if (!isValid) {
    console.warn(`Twilio signature validation failed for URL: ${url}`);
    return res.status(403).send('Forbidden');
  }

  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  if (!isAllowed(from)) {
    console.log(`Rejected message from unauthorized number: ${from}`);
    return twimlReply(res, '🚫 Sorry, your number is not on the printer allowlist.');
  }

  if (!body) {
    return twimlReply(res, '⚠️ Empty message received — nothing to print!');
  }

  // Reminders: "remind me at 7pm to take out the trash" -> schedule, don't print now.
  // Falls through to immediate printing when there's no time to parse.
  const { fireAt, body: reminderBody } = parseReminder(body, new Date());
  if (fireAt && fireAt.getTime() > Date.now()) {
    addReminder({ from, body: reminderBody, fireAt, original: body });
    const when = fireAt.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TIMEZONE,
    });
    console.log(`Scheduled reminder from ${from} for ${when}: "${reminderBody}"`);
    return twimlReply(res, `⏰ Reminder set for ${when}: "${reminderBody}"`);
  }

  console.log(`Printing message from ${from}: "${body}"`);

  printMessage(body, from)
    .then(() => {
      twimlReply(res, '✅ Printed!');
    })
    .catch((err) => {
      console.error('Printer error:', err.message);
      twimlReply(res, '❌ Printer error — message not printed. Try again!');
    });
});

app.listen(PORT, () => {
  console.log(`🖨️  Thermal print webhook listening on http://localhost:${PORT}/webhook`);
  console.log(`   Point your Twilio number's webhook to: https://<ngrok-id>.ngrok.io/webhook`);
});
