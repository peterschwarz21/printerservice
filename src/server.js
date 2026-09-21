require('dotenv').config();
const axios = require('axios');
const express = require('express');
const twilio = require('twilio');
const { isAllowed } = require('./allowlist');
const { printMessage, printImage } = require('./printer');
const { parseReminder, TIMEZONE } = require('./reminder-parser');
const { addReminder } = require('./reminders-store');
const { notifyAdmins, sendSms, isPermanentFailure } = require('./notify');

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

// Tell the sender about an outcome that landed after we already replied. This
// is a real outbound message rather than TwiML, so it costs a send — reserve it
// for things the sender can't see for themselves.
function followUp(to, message) {
  sendSms(to, message).catch((err) => {
    if (isPermanentFailure(err)) {
      console.error(`Could not follow up with ${to} (${err.message}) — they have opted out`);
    } else {
      console.error(`Could not follow up with ${to}: ${err.message}`);
    }
  });
}

// A valid TwiML document with no message in it: Twilio sees a clean 200 and
// sends nothing back. Used for senders we don't want to answer at all.
function twimlSilence(res) {
  const twiml = new twilio.twiml.MessagingResponse();
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
    // Deliberately silent. Replying would bill an outbound message to a
    // stranger — a wrong number, or a spammer probing the line — and
    // unsolicited traffic to numbers that never opted in is exactly what
    // carrier filtering scores an A2P campaign on. The log is the record.
    console.log(`Rejected message from unauthorized number: ${from}`);
    return twimlSilence(res);
  }

  // MMS: an image (with optional caption) prints as a photo. Check before the
  // empty-body guard, since a photo can arrive with no text at all.
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  if (numMedia > 0) {
    console.log(`Printing ${numMedia} media item(s) from ${from}`);
    // Ack now, print after. Downloading from Twilio's CDN and rasterizing on a
    // Pi Zero can outlast Twilio's ~15s webhook window, and a TwiML reply
    // written after that window is simply discarded — which is how a failed
    // photo print used to end in silence. Only bad news gets a follow-up; a
    // photo that prints announces itself on paper.
    twimlReply(res, '📷 Got it — working on that now…');

    handleMedia(numMedia, req.body, from, body)
      .then(({ printed, hadNonImage }) => {
        if (printed === 0) {
          return followUp(from, '⚠️ Only images can be printed — that attachment isn’t supported.');
        }
        const noun = printed === 1 ? 'photo' : `${printed} photos`;
        console.log(`Printed ${noun} from ${from}`);
        if (hadNonImage) {
          return followUp(from, `✅ Printed your ${noun} — skipped the non-image attachments.`);
        }
      })
      .catch((err) => {
        console.error('Image print error:', err.message);
        notifyAdmins('printer:print-failed', `Printer error on an incoming photo: ${err.message}`);
        followUp(from, '❌ Printer error — photo not printed. Try again!');
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
      // Not awaited: the TwiML reply has to beat Twilio's ~15s webhook window,
      // and notifyAdmins swallows its own failures.
      notifyAdmins('printer:print-failed', `Printer error on an incoming text: ${err.message}`);
      twimlReply(res, '❌ Printer error — message not printed. Try again!');
    });
});

app.listen(PORT, () => {
  console.log(`🖨️  Thermal print webhook listening on http://localhost:${PORT}/webhook`);
  console.log(`   Point your Twilio number's webhook to: https://<ngrok-id>.ngrok.io/webhook`);
});
