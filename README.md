# Thermal Print SMS Service

Text a message to your Twilio number and it prints on a thermal receipt printer
wired to a Raspberry Pi. Includes optional daily **weather** and **Google
Calendar** receipts on a schedule.

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

  weather.js   (cron, 7:00am) ─┐
  calendar.js  (cron, 7:02am) ─┴─►  print_server.py  ──►  printer
```

Three long-running services (managed by **systemd**, start on boot):

| Service | File | What it does |
|---|---|---|
| `print_server` | `printer/print_server.py` | Flask app on `:5000`, `POST /print`, drives the printer over USB |
| `sms-listener` | `src/server.js` | Express webhook that receives Twilio SMS and forwards to the print server |
| `ngrok` | `ngrok.yml` | Public tunnel (static domain) so Twilio can reach the webhook |

Two scheduled jobs (cron) also POST to the print server: `weather.js` and `calendar.js`.

---

## Hardware

- Raspberry Pi (or any Linux box) with a USB **ESC/POS thermal receipt printer**.
- Find your printer's USB IDs:

  ```bash
  lsusb
  # e.g. "Bus 001 Device 005: ID 0483:5743 ..."  ->  idVendor 0483, idProduct 5743
  ```

  Put them in `.env` as `PRINTER_VENDOR_ID=0x0483` and `PRINTER_PRODUCT_ID=0x5743`.

- The print server needs permission to open the raw USB device. Group
  membership alone is **not** enough — `/dev/bus/usb/...` nodes are owned
  `root:root` until a udev rule hands them to a group. Two steps:

  ```bash
  # 1. Make sure the service user is in plugdev (then re-log or reboot)
  sudo usermod -aG plugdev admin

  # 2. Install the udev rule (edit the vendor/product IDs first if yours
  #    differ from the defaults in deploy/99-thermal-printer.rules)
  sudo cp deploy/99-thermal-printer.rules /etc/udev/rules.d/
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

---

## Setup

Everything below assumes a fresh **Raspberry Pi OS Lite (32-bit)** install with
the default user **`admin`**, the repo at **`/home/admin/printerservice`**, and
Node installed via **nvm**. If any of those differ, adjust the paths in the
`deploy/*.service` files and the cron lines to match.

### 1. Install system prerequisites

```bash
sudo apt update
sudo apt install -y git python3-venv libusb-1.0-0 libopenjp2-7
```

(`libusb` is for the USB printer; `libopenjp2` is a runtime dep of Pillow,
which `python-escpos` pulls in.)

**Node 18 via nvm:**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. ~/.bashrc   # or log out and back in
nvm install 18
node --version
```

> **Pi Zero / Pi 1 (ARMv6):** nodejs.org stopped publishing ARMv6 binaries
> after Node 11, so a plain `nvm install 18` falls back to compiling from
> source — which takes many hours on a Zero. Point nvm at the unofficial
> builds instead:
>
> ```bash
> NVM_NODEJS_ORG_MIRROR=https://unofficial-builds.nodejs.org/download/release nvm install 18
> ```

**ngrok** (the systemd unit expects it at `/usr/local/bin/ngrok`):

```bash
curl -sLo /tmp/ngrok.tgz https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm.tgz
sudo tar -xzf /tmp/ngrok.tgz -C /usr/local/bin
ngrok version
```

If `ngrok version` prints `Illegal instruction` on a Pi Zero, see
[Troubleshooting](#troubleshooting).

### 2. Clone and configure

```bash
cd ~
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
| `PRINTER_URL` | Print server endpoint (default `http://127.0.0.1:5000/print` — keep the IP, not `localhost`; see Troubleshooting) |
| `PRINTER_VENDOR_ID` / `PRINTER_PRODUCT_ID` | USB IDs from `lsusb` (hex, `0x…`) |
| `PRINTER_PORT` | Port for the Flask print server (default `5000`) |
| `WEATHER_LAT` / `WEATHER_LON` / `WEATHER_TIMEZONE` | Location for the weather job |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth Desktop-app client for the calendar job (see [step 7](#7-optional-daily-google-calendar-receipt)) |
| `GOOGLE_OAUTH_TOKEN` | Optional path to the refresh-token file (default `./google-token.json`) |
| `CALENDAR_IDS` | Comma-separated `calendarId:Label` pairs for the calendar job |
| `CALENDAR_TIMEZONE` | Optional; the calendar job falls back to `WEATHER_TIMEZONE` |

> `.env` is read once at process startup. After editing it, restart the
> services: `sudo systemctl restart print_server sms-listener`.

### 3. Install dependencies

```bash
# Node (webhook + cron jobs) — slow on a Pi Zero's single core; let it finish
npm ci

# Python (print server)
python3 -m venv .venv
.venv/bin/pip install -r printer/requirements.txt
```

Raspberry Pi OS preconfigures pip to use [piwheels](https://www.piwheels.org/),
so Pillow installs as a prebuilt wheel. If pip starts *building* Pillow from
source on a Pi Zero, stop and check that piwheels is in `/etc/pip.conf` —
a source build can take hours or run out of memory.

### 4. Install the systemd services

The unit files in `deploy/` assume the repo lives at `/home/admin/printerservice`,
runs as user `admin`, and that nvm lives at `/home/admin/.nvm` (the
`sms-listener` unit sources `nvm.sh` to find `node`, since nvm installs don't
create `/usr/bin/node`). Edit the `User=`, `WorkingDirectory=`, and `ExecStart=`
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

### 5. Set up ngrok (static domain — set once)

1. Create a free ngrok account and copy your authtoken.
2. Claim a **free static domain** at <https://dashboard.ngrok.com/domains>.
3. Configure ngrok:

   ```bash
   cp ngrok.yml.example ngrok.yml
   ```

   Fill in `authtoken` and your `domain` (e.g. `your-name.ngrok-free.app`).
   The `ngrok` systemd service serves this on boot. (`ngrok.yml` is gitignored —
   it holds your authtoken.)

### 6. Point Twilio at the tunnel (once)

Because the ngrok domain is static, you only do this **one time**:

1. [Twilio Console → Phone Numbers → Active Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/active)
2. Open your number → **Messaging → A Message Comes In**:
   - **Webhook**: `https://your-name.ngrok-free.app/webhook`
   - **HTTP Method**: `POST`
3. Save.

### 7. (Optional) Daily Google Calendar receipt

`calendar.js` prints today's events from any number of Google accounts, merged
into one timeline. It authenticates as one **hub account** (e.g. yours) that
everyone shares their calendar with: a one-time browser authorization on your
laptop mints a refresh token, which the Pi silently renews forever after.
Everything below is free (no billing account needed); personal `@gmail.com`
calendars work fine.

> Why not a service account? Newer Google Cloud accounts block service-account
> key downloads by default (`iam.disableServiceAccountKeyCreation`), so this
> uses a normal OAuth client instead — those aren't affected.

1. Create a Google Cloud project at <https://console.cloud.google.com>
   (any name, e.g. `printer-service`).
2. Enable the **Google Calendar API**: APIs & Services → Library → search
   "Google Calendar API" → Enable.
3. Set up the consent screen: **Google Auth Platform** (search "OAuth consent"
   if you can't find it) → **Branding**: app name + support email;
   **Audience**: External.
4. Still under **Audience**, click **Publish app** so the status is
   **In production**. This matters: in Testing, refresh tokens expire after
   7 days and the daily job would break weekly. No Google verification is
   needed — you'll click through a "Google hasn't verified this app" warning
   exactly once, and only your hub account ever authorizes.
5. **Clients → Create client → Desktop app**. Copy the client ID **and
   secret into `.env` immediately** — Google shows the secret only at
   creation:

   ```bash
   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

6. On a laptop with a browser: clone the repo, `npm ci`, fill in `.env`, then

   ```bash
   node authorize.js
   ```

   Open the printed URL, sign in as the **hub account**, click through the
   unverified-app warning (**Advanced → continue**), and approve. This writes
   `google-token.json` (gitignored — never commit it).
7. Copy the token to the Pi (whose `.env` needs the same client ID/secret):

   ```bash
   scp google-token.json admin@<pi-ip>:/home/admin/printerservice/
   ```

8. Each person shares their calendar with the **hub account's gmail**:
   Google Calendar (web) → Settings → *[their calendar]* → **Share with
   specific people** → add the hub gmail with **"See all event details"**.
   The share alone is enough — no need to accept it — but give it a few
   minutes to propagate.
9. Configure `CALENDAR_IDS` — comma-separated `calendarId:Label` pairs, where
   the calendar ID is usually the account's gmail address and the label is
   the tag printed next to that person's events:

   ```bash
   CALENDAR_IDS=taylor@gmail.com:T,peter@gmail.com:P
   ```

10. Test: `node calendar.js` (prints a preview to stdout before sending).
    Adding another account later is just steps 8–9 for that account.

### 8. (Optional) Schedule the daily receipts

`crontab -e` (as `admin`), then add. Cron doesn't load `.env` (so `cd` into
the repo first) and doesn't know about nvm (so source `nvm.sh` to get `node`
on PATH). The calendar job is staggered 2 minutes after weather so the
receipts always print in the same order:

```cron
SHELL=/bin/bash
0 7 * * * cd /home/admin/printerservice && . "$HOME/.nvm/nvm.sh" && node weather.js  >> /tmp/weather.log  2>&1
2 7 * * * cd /home/admin/printerservice && . "$HOME/.nvm/nvm.sh" && node calendar.js >> /tmp/calendar.log 2>&1
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
│   ├── ngrok.service      # systemd units (start on boot)
│   └── 99-thermal-printer.rules  # udev rule (USB permissions)
├── weather.js             # Daily weather receipt (cron)
├── calendar.js            # Daily Google Calendar receipt (cron)
├── authorize.js           # One-time Google OAuth setup (run on a laptop)
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
- **`fetch failed` from the Node jobs, but `curl` to the print server works** —
  `PRINTER_URL` (or the built-in default) points at `localhost`, which Node
  18's `fetch` may resolve to IPv6 `::1` with no IPv4 fallback, while Flask
  only listens on IPv4. Use `http://127.0.0.1:5000/print` in `.env`.
- **"Access denied (insufficient permissions)" / `[Errno 13]`** — the udev
  rule isn't installed or its IDs don't match your printer. Install
  `deploy/99-thermal-printer.rules` (see [Hardware](#hardware)), confirm the
  user is in `plugdev` (`groups admin`), then `sudo udevadm trigger` (or
  replug the printer) and `sudo systemctl restart print_server`.
- **"Printing with USB connection requires a usb library"** — `pyusb` is
  missing from the venv (python-escpos v3 made it an optional extra). Reinstall
  with `.venv/bin/pip install -r printer/requirements.txt` (which requests
  `python-escpos[usb]`) and restart: `sudo systemctl restart print_server`.
- **Service fails with `status=203/EXEC`** — the binary path in the unit file
  is wrong. `sms-listener` expects nvm at `/home/admin/.nvm`; the `ngrok` unit
  expects `/usr/local/bin/ngrok`. Check with `ls ~/.nvm/nvm.sh` and
  `which ngrok`, fix the unit, then `sudo systemctl daemon-reload` and restart.
- **Service fails with `status=200/CHDIR`** — the repo isn't at
  `/home/admin/printerservice`; fix `WorkingDirectory=` (and the paths in
  `ExecStart=`) in the unit files.
- **`ngrok: Illegal instruction` on a Pi Zero** — the ARM build you installed
  was compiled for ARMv7, and the Zero is ARMv6. Try a different/older ngrok
  ARM build, or run the tunnel from another machine on your network pointed at
  `http://<pi-ip>:3000`.
- **ngrok restarts repeatedly right after boot** — it's coming up before DNS is
  ready. The unit waits on `network-online.target`, which only works if
  `NetworkManager-wait-online.service` is enabled
  (`sudo systemctl enable NetworkManager-wait-online`). Either way
  `Restart=always` recovers on its own within a few retries.
- **Test a job manually** — `node weather.js` or `node calendar.js` (each
  prints a preview to stdout before sending).
- **Calendar receipt shows `Could not load calendar [X] (HTTP 404)`** — that
  calendar isn't shared with the hub account, the ID in `CALENDAR_IDS` is
  wrong, or the share hasn't propagated yet (give it a few minutes). Re-check
  step 8 of the calendar setup.
- **Calendar job fails with `invalid_grant` / "Refresh token expired or
  revoked"** — the hub account revoked the app, the client secret was reset,
  or the consent screen was left in **Testing** (tokens then expire after
  7 days). Confirm Google Auth Platform → Audience shows **In production**,
  re-run `node authorize.js` on the laptop, and scp the new
  `google-token.json` to the Pi.

## License

MIT — see [LICENSE](LICENSE).
