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
| `PRINTER_URL` | Print server endpoint (default `http://localhost:5000/print`) |
| `PRINTER_VENDOR_ID` / `PRINTER_PRODUCT_ID` | USB IDs from `lsusb` (hex, `0x…`) |
| `PRINTER_PORT` | Port for the Flask print server (default `5000`) |
| `WEATHER_LAT` / `WEATHER_LON` / `WEATHER_TIMEZONE` | Location for the weather job |

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

### 7. (Optional) Schedule the daily receipts

`crontab -e` (as `admin`), then add. Cron doesn't load `.env` (so `cd` into
the repo first) and doesn't know about nvm (so source `nvm.sh` to get `node`
on PATH):

```cron
SHELL=/bin/bash
0 7 * * * cd /home/admin/printerservice && . "$HOME/.nvm/nvm.sh" && node weather.js >> /tmp/weather.log 2>&1
0 8 * * * cd /home/admin/printerservice && . "$HOME/.nvm/nvm.sh" && node games.js   >> /tmp/games.log   2>&1
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
- **Test a job manually** — `node weather.js` or `node games.js` (each prints a
  preview to stdout before sending).

## License

MIT — see [LICENSE](LICENSE).
