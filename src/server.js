require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { isAllowed } = require('./allowlist');
const { printMessage } = require('./printer');

const app = express();
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
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const isValid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);

  if (!isValid) {
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
