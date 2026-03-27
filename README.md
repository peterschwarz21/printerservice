# 🖨️ Thermal Print SMS Service

Text a message to your Twilio number → it prints on your thermal receipt printer.

## How it works

```
You text → Twilio → ngrok tunnel → this server → http://printer-server
```

Your message gets wrapped in a fun ASCII border with a timestamp and your number, then printed.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `TWILIO_AUTH_TOKEN` | Found in your [Twilio Console](https://console.twilio.com) dashboard |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number in E.164 format (e.g. `+15551234567`) |
| `ALLOWED_NUMBERS` | Comma-separated E.164 numbers that can trigger the printer |
| `PORT` | Local port for the webhook server (default: `3000`) |
| `PRINTER_URL` | URL of your printer service (default: `http://printer-server`) |

### 3. Start ngrok

```bash
ngrok http 3000
```

Copy the `https://` forwarding URL (e.g. `https://abc123.ngrok.io`).

> **Note:** The free ngrok tier generates a new URL each restart. You'll need to update your Twilio webhook URL each time.

### 4. Configure your Twilio number

1. Go to [Twilio Console → Phone Numbers → Manage → Active Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/active)
2. Click your number
3. Under **Messaging → A Message Comes In**, set:
   - **Webhook**: `https://abc123.ngrok.io/webhook`
   - **HTTP Method**: `POST`
4. Save

### 5. Start the server

```bash
npm start
```

---

## Usage

Text any message to your Twilio number from an allowed phone number.

**Example output on the printer:**

```
════════════════════════════════
         📋 NEW TODO
────────────────────────────────
      Mar 27 2025  3:45 PM
       from +15559876543
────────────────────────────────

Buy oat milk and sourdough
bread from the store

════════════════════════════════
```

You'll get a confirmation text back: `✅ Printed!`

Unauthorized numbers receive: `🚫 Sorry, your number is not on the printer allowlist.`

---

## Project structure

```
thermalprint/
├── src/
│   ├── server.js      # Express webhook server
│   ├── printer.js     # Message formatter + printer POST
│   └── allowlist.js   # Phone number allowlist
├── .env               # Your secrets (never commit this)
├── .env.example       # Template
└── package.json
```
# printerservice
