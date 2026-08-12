require('dotenv').config();
const axios = require('axios');
const express = require('express');
const twilio = require('twilio');
const { isAllowed } = require('./allowlist');
const { printMessage, printImage } = require('./printer');
const { parseReminder, TIMEZONE } = require('./reminder-parser');
const { addReminder } = require('./reminders-store');

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

function twimlReply(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.type('text/xml').send(twiml.toString());
}

// Download each image attachment from Twilio and print it. Returns a status
// object describing what happened so the caller can pick a reply.
async function handleMedia(numMedia, body, from, caption) {
  const images = [];
  for (let i = 0; i < numMedia; i++) {
    const contentType = body[`MediaContentType${i}`] || '';
    const url = body[`MediaUrl${i}`];
    if (url && contentType.startsWith('image/')) {
      images.push({ url, contentType });
    }
  }

  if (images.length === 0) {
    return { printed: 0, hadNonImage: numMedia > 0 };
  }

  let printed = 0;
  for (const [i, image] of images.entries()) {
    // Media URLs require Twilio Basic auth (Account SID + Auth Token). axios
    // follows the redirect to Twilio's CDN and drops Authorization on the
    // cross-host hop, so it won't clash with the pre-signed URL.
    const resp = await axios.get(image.url, {
      responseType: 'arraybuffer',
      auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
    });
    // Attach the caption to the first image only, to avoid repeating it.
    await printImage(Buffer.from(resp.data), from, {
      contentType: image.contentType,
      caption: i === 0 ? caption : undefined,
    });
    printed++;
  }
  return { printed, hadNonImage: images.length < numMedia };
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

  // MMS: an image (with optional caption) prints as a photo. Check before the
  // empty-body guard, since a photo can arrive with no text at all.
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  if (numMedia > 0) {
    console.log(`Printing ${numMedia} media item(s) from ${from}`);
    handleMedia(numMedia, req.body, from, body)
      .then(({ printed, hadNonImage }) => {
        if (printed === 0) {
          return twimlReply(res, '⚠️ Only images can be printed — that attachment isn’t supported.');
        }
        const noun = printed === 1 ? 'photo' : `${printed} photos`;
        const extra = hadNonImage ? ' (skipped non-image attachments)' : '';
        twimlReply(res, `✅ Printed your ${noun}!${extra}`);
      })
      .catch((err) => {
        console.error('Image print error:', err.message);
        twimlReply(res, '❌ Printer error — photo not printed. Try again!');
      });
    return;
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
