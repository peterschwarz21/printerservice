require('dotenv').config();
const chrono = require('chrono-node');

// Timezone convention matches calendar.js / weather.js. The Pi's clock is UTC,
// so all reminder math is done in this zone and stored as absolute UTC instants.
const TIMEZONE = process.env.CALENDAR_TIMEZONE || process.env.WEATHER_TIMEZONE || 'America/Denver';
// When a reminder names a day but no time ("in 2 days", "tomorrow"), fire at this hour, local.
const DEFAULT_HOUR = parseInt(process.env.REMINDER_DEFAULT_HOUR || '8', 10);

const TRIGGER = /\bremind me\b/i;

// "2026-08-09" for a Date, in TIMEZONE (matches calendar.js localDateStr).
function localDateStr(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// Minutes east of UTC for TIMEZONE at a given instant (chrono's reference offset,
// and DST-correct because it's computed from the actual instant).
function tzOffsetMinutes(date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((acc, x) => ({ ...acc, [x.type]: x.value }), {});
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

// UTC instant of a local wall-clock time ("YYYY-MM-DD" + hour/minute) in TIMEZONE.
// Same guess-and-correct approach as calendar.js zonedMidnightUtc, generalized to
// an arbitrary time so it survives DST edges.
function zonedWallToUtc(dateStr, hour, minute) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const target = new Date(`${dateStr}T${hh}:${mm}:00Z`);
  let guess = new Date(target.getTime());
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(guess).reduce((acc, x) => ({ ...acc, [x.type]: x.value }), {});
    const wall = new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    guess = new Date(guess.getTime() + (target.getTime() - wall.getTime()));
  }
  return guess;
}

// Strip the time phrase and "remind me" filler to isolate the reminder body.
// Heuristic — good enough for texts, falls back to the whole message minus the phrase.
function extractBody(text, matchIndex, matchText) {
  let body = (text.slice(0, matchIndex) + ' ' + text.slice(matchIndex + matchText.length))
    .replace(TRIGGER, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Drop leading connector words left dangling by the removed phrase ("to", "at", ...).
  const leading = /^(?:to|at|on|in|by|that|about|me|please|,|:|-)\b[\s,:-]*/i;
  while (leading.test(body)) body = body.replace(leading, '').trim();
  // Drop a trailing dangling preposition ("...take out the trash at" -> remove "at").
  body = body.replace(/[\s,]*\b(?:at|on|by|in|to)\s*$/i, '').trim();
  // Trim stray surrounding punctuation.
  body = body.replace(/^[,.:;\s-]+|[,.:;\s-]+$/g, '').trim();

  return body;
}

/**
 * parseReminder(text, now) -> { fireAt: Date|null, body: string }
 * Returns fireAt=null (and the original text) when the message is not a reminder
 * or when no time can be parsed — callers print those immediately.
 */
function parseReminder(text, now = new Date()) {
  if (!TRIGGER.test(text)) return { fireAt: null, body: text };

  const results = chrono.parse(text, { instant: now, timezone: tzOffsetMinutes(now) }, { forwardDate: true });
  if (!results.length) return { fireAt: null, body: text };

  const result = results[0];
  let fireAt = result.start.date();

  // Day given but no explicit time -> default to DEFAULT_HOUR local on that day.
  if (!result.start.isCertain('hour')) {
    fireAt = zonedWallToUtc(localDateStr(fireAt), DEFAULT_HOUR, 0);
  }

  let body = extractBody(text, result.index, result.text);
  if (!body) body = text.replace(TRIGGER, ' ').replace(/\s+/g, ' ').trim() || text;

  return { fireAt, body };
}

module.exports = { parseReminder, TIMEZONE };
