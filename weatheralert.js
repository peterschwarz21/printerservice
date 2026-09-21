#!/usr/bin/env node
/**
 * weatheralert.js
 * Texts and prints official National Weather Service warnings for your
 * location, once per event. Prints nothing at all when nothing is active.
 * Cron: 0,15,30,45 * * * * cd /home/admin/printerservice && . "$HOME/.nvm/nvm.sh" && node weatheralert.js >> /tmp/weatheralert.log 2>&1
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { messageAdmins, notifyAdmins } = require('./src/notify');
const { printMessage } = require('./src/printer');

// ---------------------------------------------------------------------------
// CONFIG (from .env)
// ---------------------------------------------------------------------------
const LAT = process.env.WEATHER_LAT || '39.7392';
const LON = process.env.WEATHER_LON || '-104.9903';
const TIMEZONE = process.env.WEATHER_TIMEZONE || 'America/Denver';
const API_BASE = process.env.NWS_API_BASE || 'https://api.weather.gov';
// api.weather.gov returns 403 without a User-Agent, and their policy asks for a
// contact so they can reach you if a client misbehaves.
const USER_AGENT = process.env.NWS_USER_AGENT || 'printerservice (https://github.com/peterschwarz21/printerservice)';
// Extreme/Severe only. Moderate sweeps in routine advisories — dense fog, small
// craft — which aren't worth waking anyone over.
const SEVERITIES = process.env.NWS_SEVERITIES || 'Extreme,Severe';
// Watches come through as Severe but urgency Future. Without this filter a
// routine Flood Watch pages you exactly like a tornado warning.
const URGENCIES = (process.env.NWS_URGENCIES || 'Immediate,Expected')
  .split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);

const STATE_FILE = process.env.WEATHER_ALERT_FILE || path.resolve(__dirname, 'weather-alerts.json');

// ---------------------------------------------------------------------------
// SEEN-EVENT STORE
// ---------------------------------------------------------------------------
// Keyed by event name ("Flood Warning"), NOT by alert id: NWS reissues an
// ongoing warning under a fresh id every few minutes, so an id-keyed store
// would re-alert on every poll for the duration of one storm.
function readSeen() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`weatheralert: could not read ${STATE_FILE}: ${err.message}`);
    }
    return {};
  }
}

// Atomic write (temp file + rename), mirroring src/reminders-store.js.
function writeSeen(seen) {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(seen, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------------------------------------------------------------------------
// FETCH
// ---------------------------------------------------------------------------
async function fetchAlerts() {
  const params = new URLSearchParams({
    point: `${LAT},${LON}`,
    severity: SEVERITIES,
    status: 'actual', // drops NWS test and exercise messages
  });
  const res = await fetch(`${API_BASE}/alerts/active?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
  });
  if (!res.ok) throw new Error(`NWS alerts error: ${res.status}`);
  const data = await res.json();
  const features = Array.isArray(data.features) ? data.features : [];

  return features
    .map((f) => f.properties || {})
    .filter((p) => p.event && URGENCIES.includes(String(p.urgency || '').toLowerCase()));
}

// ---------------------------------------------------------------------------
// FORMAT
// ---------------------------------------------------------------------------
function formatWhen(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TIMEZONE,
  });
}

function formatAlert(p) {
  const lines = [p.event.toUpperCase()];
  if (p.areaDesc) lines.push(p.areaDesc);
  const until = formatWhen(p.ends || p.expires);
  if (until) lines.push(`Until ${until}`);
  if (p.headline) lines.push('', p.headline);
  if (p.instruction) lines.push('', p.instruction);
  return lines.join('\n');
}

// The text keeps it to one or two segments; the receipt carries the detail.
function formatSms(p) {
  const until = formatWhen(p.ends || p.expires);
  const where = p.areaDesc ? ` — ${p.areaDesc}` : '';
  return `⚠️ ${p.event}${where}${until ? `, until ${until}` : ''}`;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Checking NWS alerts for ${LAT},${LON}...`);
  const alerts = await fetchAlerts();
  const seen = readSeen();
  const active = new Set(alerts.map((p) => p.event));

  // Drop events that have cleared, so the next one of the same kind alerts.
  let pruned = 0;
  for (const event of Object.keys(seen)) {
    if (!active.has(event)) {
      delete seen[event];
      pruned++;
    }
  }
  if (pruned > 0) console.log(`Cleared ${pruned} expired event(s) from the seen list`);

  const fresh = alerts.filter((p) => !seen[p.event]);
  if (fresh.length === 0) {
    console.log(`${alerts.length} active alert(s), none new — nothing to send`);
    if (pruned > 0) writeSeen(seen);
    return;
  }

  for (const p of fresh) {
    console.log(`NEW: ${p.event} (${p.severity}/${p.urgency}) — ${p.areaDesc || 'your area'}`);
    console.log('--- RECEIPT PREVIEW ---');
    console.log(formatAlert(p));
    console.log('--- END PREVIEW ---');

    // Text first: it's the part that reaches you when you're not home, and a
    // printer failure shouldn't be what stops a tornado warning going out.
    const { sent } = await messageAdmins(formatSms(p), 'weather alert');
    try {
      await printMessage(formatAlert(p), 'NWS', { header: 'WEATHER ALERT' });
      console.log('Printed the alert receipt');
    } catch (err) {
      console.error(`Could not print the alert: ${err.message}`);
    }

    // Only mark it seen once someone was actually told. If every text failed
    // and the print failed, leave it unseen so the next run tries again.
    seen[p.event] = { alertedAt: new Date().toISOString(), severity: p.severity, sent };
  }

  writeSeen(seen);
}

main().catch(async (err) => {
  // fetch() wraps the real network error (e.g. ECONNREFUSED) in err.cause
  console.error('Error:', err.message, err.cause ? `(${err.cause})` : '');
  // await, not fire-and-forget: process.exit kills the in-flight request.
  await notifyAdmins('cron:weatheralert', `Weather alert check failed: ${err.message}`);
  process.exit(1);
});
