# Thermal Print SMS Service

Text a message to your Twilio number and it prints on a thermal receipt printer
wired to a Raspberry Pi. Includes optional daily **weather** and **World Cup
2026** receipts on a schedule.

## How it works

```
        You text
           │
           ▼
        Twilio  ──►  ngrok (static domain)  ──►  src/server.js  (Express, :3000)
                                                      │  validates Twilio signature
                                                      │  checks allowlist, formats
                                                      ▼
                                            printer/print_server.py  (Flask, :5000)
                                                      │  ESC/POS over USB
                                                      ▼
                                                 thermal printer

  weather.js  (cron, 7am) ─┐
  games.js    (cron, 8am) ─┴─►  print_server.py  ──►  printer
```

Three long-running services (managed by **systemd**, start on boot):

| Service | File | What it does |
|---|---|---|
| `print_server` | `printer/print_server.py` | Flask app on `:5000`, `POST /print`, drives the printer over USB |
| `sms-listener` | `src/server.js` | Express webhook that receives Twilio SMS and forwards to the print server |
| `ngrok` | `ngrok.yml` | Public tunnel (static domain) so Twilio can reach the webhook |

Two scheduled jobs (cron) also POST to the print server: `weather.js` and `games.js`.

---

## Hardware

- Raspberry Pi (or any Linux box) with a USB **ESC/POS thermal receipt printer**.
- Find your printer's USB IDs:

  ```bash
  lsusb
  # e.g. "Bus 001 Device 005: ID 0483:5743 ..."  ->  idVendor 0483, idProduct 5743
  ```

  Put them in `.env` as `PRINTER_VENDOR_ID=0x0483` and `PRINTER_PRODUCT_ID=0x5743`.

- The print server needs permission to talk to the USB device. The simplest
  option is to add your user to the right groups:

  ```bash
  sudo usermod -aG plugdev,lp pi
  ```

  (or install a udev rule for your printer's vendor/product ID).

---

## Setup

### 1. Clone and configure

```bash
git clone <your-repo-url> printerservice
cd printerservice
cp .env.example .env
```

Edit `.env` — a single file shared by **all** services:

| Variable | Description |
|---|---|
| `TWILIO_AUTH_TOKEN` | From your [Twilio Console](https://console.twilio.com); used to validate webhooks |
| `TWILIO_PHONE_NUMBER` | Your Twilio number in E.164 (informational) |
| `ALLOWED_NUMBERS` | Comma-separated E.164 numbers allowed to print |
| `PORT` | Local port for the webhook server (default `3000`) |
| `PRINTER_URL` | Print server endpoint (default `http://localhost:5000/print`) |
| `PRINTER_VENDOR_ID` / `PRINTER_PRODUCT_ID` | USB IDs from `lsusb` (hex, `0x…`) |
| `PRINTER_PORT` | Port for the Flask print server (default `5000`) |
| `WEATHER_LAT` / `WEATHER_LON` / `WEATHER_TIMEZONE` | Location for the weather job |

### 2. Install dependencies

```bash
# Node (webhook + cron jobs)
npm ci

# Python (print server)
python3 -m venv .venv
.venv/bin/pip install -r printer/requirements.txt
```

### 3. Install the systemd services

The unit files in `deploy/` assume the repo lives at `/home/pi/printerservice`
and runs as user `pi`. Edit the `User=`, `WorkingDirectory=`, and `ExecStart=`
paths if yours differ, then:

```bash
sudo cp deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now print_server sms-listener ngrok
```

Check status:

```bash
systemctl status print_server sms-listener ngrok
```

### 4. Set up ngrok (static domain — set once)

1. Create a free ngrok account and copy your authtoken.
2. Claim a **free static domain** at <https://dashboard.ngrok.com/domains>.
3. Configure ngrok:

   ```bash
   cp ngrok.yml.example ngrok.yml
   ```

   Fill in `authtoken` and your `domain` (e.g. `your-name.ngrok-free.app`).
   The `ngrok` systemd service serves this on boot. (`ngrok.yml` is gitignored —
   it holds your authtoken.)

### 5. Point Twilio at the tunnel (once)

Because the ngrok domain is static, you only do this **one time**:

1. [Twilio Console → Phone Numbers → Active Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/active)
2. Open your number → **Messaging → A Message Comes In**:
   - **Webhook**: `https://your-name.ngrok-free.app/webhook`
   - **HTTP Method**: `POST`
3. Save.

### 6. (Optional) Schedule the daily receipts

`crontab -e`, then add (cron doesn't load `.env`, so `cd` into the repo first):

```cron
0 7 * * * cd /home/pi/printerservice && /usr/bin/node weather.js >> /tmp/weather.log 2>&1
0 8 * * * cd /home/pi/printerservice && /usr/bin/node games.js   >> /tmp/games.log   2>&1
```

---

## Usage

Text any message to your Twilio number from an allowed phone number. It gets
wrapped in an ASCII border with a timestamp and printed. You get a confirmation
text back; numbers not on the allowlist are rejected.

**Example output:**

```
================================================
                   NEW TODO
------------------------------------------------
              Mar 27 2025  3:45 PM
               from +15559876543
------------------------------------------------

Buy oat milk and sourdough bread from the store

================================================
```

---

## Project structure

```
printerservice/
├── src/
│   ├── server.js          # Express webhook server (Twilio -> printer)
│   ├── printer.js         # Message formatter + POST to print server
│   └── allowlist.js       # Phone number allowlist
├── printer/
│   ├── print_server.py    # Flask ESC/POS print server (USB)
│   └── requirements.txt   # Python deps
├── deploy/
│   ├── print_server.service
│   ├── sms-listener.service
│   └── ngrok.service      # systemd units (start on boot)
├── weather.js             # Daily weather receipt (cron)
├── games.js               # World Cup 2026 daily matches (cron)
├── ngrok.yml.example      # ngrok static-domain config template
├── .env.example           # Shared config template
└── package.json
```

---

## Troubleshooting

- **Nothing prints / USB error** — confirm `lsusb` shows the printer and the IDs
  match `.env`; confirm the service user is in `plugdev`/`lp`. Test directly:

  ```bash
  curl -X POST localhost:5000/print -H 'Content-Type: application/json' \
       -d '{"content":"hello\n\n"}'
  ```

- **SMS not arriving** — `systemctl status ngrok sms-listener`; confirm the
  Twilio webhook URL matches your static domain and ends in `/webhook`.
- **Test a job manually** — `node weather.js` or `node games.js` (each prints a
  preview to stdout before sending).

## License

MIT — see [LICENSE](LICENSE).
