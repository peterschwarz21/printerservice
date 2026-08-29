#!/usr/bin/env node
/**
 * gameday.js
 * Prints a receipt for upcoming games for the teams in NFL_TEAMS: any game
 * today, any game tomorrow, and — when it runs on a Friday — the rest of the
 * weekend too. Prints nothing at all when no team plays in that window.
 * Uses ESPN's public NFL API (no key/account required).
 * Cron: 6 7 * * * cd /home/admin/printerservice && . "$HOME/.nvm/nvm.sh" && node gameday.js
 */

require('dotenv').config();

// ---------------------------------------------------------------------------
// CONFIG (from .env)
// ---------------------------------------------------------------------------
// ESPN's public API — no key, no account. Note the two different path prefixes
// below (/apis/site/v2/... vs /apis/v2/...); that's ESPN's doing, not a typo.
const API_BASE       = process.env.NFL_API_BASE || 'https://site.api.espn.com';
const SCOREBOARD_URL = `${API_BASE}/apis/site/v2/sports/football/nfl/scoreboard`;
const STANDINGS_URL  = `${API_BASE}/apis/v2/sports/football/nfl/standings`;
// Comma-separated ESPN team abbreviations to watch. BRONCOS_TEAM is the older
// single-team name, still honored so an existing .env keeps working.
const TEAMS         = (process.env.NFL_TEAMS || process.env.BRONCOS_TEAM || 'den,buf')
  .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
// 127.0.0.1, not localhost — see src/printer.js
const PRINT_URL     = process.env.PRINTER_URL      || 'http://127.0.0.1:5000/print';
const TIMEZONE      = process.env.WEATHER_TIMEZONE || 'America/Denver';
// Pretend it's this date (YYYY-MM-DD) instead of today. Testing only.
const DATE_OVERRIDE = process.env.NFL_DATE || process.env.BRONCOS_DATE || '';
const WIDTH         = 48;

const FRIDAY = 5;

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function center(str) {
  const pad = Math.max(0, Math.floor((WIDTH - str.length) / 2));
  return ' '.repeat(pad) + str;
}

// Word-wrap text into lines of `width`, hard-breaking words longer than width.
function wrap(text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    let w = word;
    while (w.length > width) {
      if (current) { lines.push(current); current = ''; }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if ((current + (current ? ' ' : '') + w).length <= width) {
      current += (current ? ' ' : '') + w;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// The local calendar date as YYYY-MM-DD. en-CA gives ISO ordering for free.
function localDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit',
  }).format(date);
}

// Calendar-date arithmetic. These treat a YYYY-MM-DD string as a bare date and
// anchor it at UTC midnight, so adding a day can't be knocked sideways by a DST
// transition the way local-midnight arithmetic can.
function parseDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(dateStr, n) {
  const d = parseDay(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayIndex(dateStr) {
  return parseDay(dateStr).getUTCDay();
}

function formatDay(dateStr, opts) {
  return parseDay(dateStr).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}

function formatKickoff(date) {
  return date.toLocaleTimeString('en-US', {
    hour:         'numeric',
    minute:       '2-digit',
    timeZoneName: 'short',
    timeZone:     TIMEZONE,
  });
}

function ordinal(n) {
  // 11th/12th/13th are the exceptions to the 1st/2nd/3rd pattern.
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}

// Today's date in the local timezone, honoring the NFL_DATE test override.
function today() {
  if (DATE_OVERRIDE) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE_OVERRIDE)) {
      throw new Error(`NFL_DATE must be YYYY-MM-DD, got "${DATE_OVERRIDE}"`);
    }
    return DATE_OVERRIDE;
  }
  return localDate(new Date());
}

// Today and tomorrow, plus the rest of the weekend when today is a Friday, so
// Friday's receipt covers Saturday and Sunday in one go.
function datesToCheck(todayStr) {
  const dates = [todayStr, addDays(todayStr, 1)];
  if (weekdayIndex(todayStr) === FRIDAY) dates.push(addDays(todayStr, 2));
  return [...new Set(dates)];
}

// "TODAY" / "TOMORROW" / "SUNDAY" — how a game's day is labeled on the receipt.
function dayLabel(dateStr, todayStr) {
  if (dateStr === todayStr) return 'TODAY';
  if (dateStr === addDays(todayStr, 1)) return 'TOMORROW';
  return formatDay(dateStr, { weekday: 'long' }).toUpperCase();
}

// ---------------------------------------------------------------------------
// FIND GAMES
// ---------------------------------------------------------------------------
// ESPN's ?dates= parameter buckets games by EASTERN day, not UTC — the Week 1
// Monday-nighter at 2026-09-15T00:15Z lives under dates=20260914. So we ask for
// our own local date and then re-check each event's kickoff in our timezone
// rather than trusting ESPN's bucketing to agree with ours.
async function findGames(dateStr) {
  const url = `${SCOREBOARD_URL}?dates=${dateStr.replace(/-/g, '')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN scoreboard error: ${res.status}`);

  const data = await res.json();
  const games = [];

  for (const event of data.events || []) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;

    const competitors = comp.competitors || [];
    const ours = competitors.filter(
      (c) => TEAMS.includes((c.team?.abbreviation || '').toLowerCase())
    );
    if (ours.length === 0) continue;

    const kickoff = new Date(event.date);
    if (localDate(kickoff) !== dateStr) continue;

    games.push({
      id:      event.id,
      day:     dateStr,
      kickoff,
      home:    describeTeam(competitors.find((c) => c.homeAway === 'home')),
      away:    describeTeam(competitors.find((c) => c.homeAway === 'away')),
      venue:   comp.venue || null,
      network: (comp.broadcasts || []).flatMap((b) => b.names || []).join(', '),
      line:    (comp.odds || [])[0]?.details || '',
      week:    event.week?.number,
      // season.type: 1 = preseason, 2 = regular, 3 = postseason
      season:  event.season?.type,
    });
  }
  return games;
}

function describeTeam(competitor) {
  if (!competitor) return null;
  const total = (competitor.records || []).find((r) => r.type === 'total');
  return {
    abbr:     competitor.team?.abbreviation || '',
    name:     competitor.team?.displayName  || 'Unknown',
    homeAway: competitor.homeAway,
    record:   total?.summary || '',
  };
}

// ---------------------------------------------------------------------------
// FETCH STANDINGS
// ---------------------------------------------------------------------------
// ?level=3 returns the eight divisions. The entries within a division are NOT
// in standings order (2025's AFC West listed 14-3 Denver 4th), so rank has to be
// computed by sorting on win percentage.
async function fetchDivisions() {
  const res = await fetch(`${STANDINGS_URL}?level=3`);
  if (!res.ok) throw new Error(`ESPN standings error: ${res.status}`);
  const data = await res.json();

  const divisions = [];
  (function walk(node) {
    const entries = node.standings?.entries;
    if (entries && node.name) divisions.push({ name: node.name, entries });
    for (const child of node.children || []) walk(child);
  })(data);

  return divisions;
}

function statOf(entry, name) {
  return (entry.stats || []).find((s) => s.name === name);
}

// -> { division: 'AFC West', rank: 4, record: '1-1' }, or null if not found.
function placeInDivision(divisions, abbr) {
  const target = (abbr || '').toLowerCase();
  for (const division of divisions) {
    const found = division.entries.some(
      (e) => (e.team?.abbreviation || '').toLowerCase() === target
    );
    if (!found) continue;

    const sorted = [...division.entries].sort((a, b) => {
      const pct = (statOf(b, 'winPercent')?.value || 0) - (statOf(a, 'winPercent')?.value || 0);
      if (pct !== 0) return pct;
      return (statOf(b, 'wins')?.value || 0) - (statOf(a, 'wins')?.value || 0);
    });

    const rank = sorted.findIndex(
      (e) => (e.team?.abbreviation || '').toLowerCase() === target
    );
    const overall = statOf(sorted[rank], 'overall')?.displayValue || '';
    return { division: division.name, rank: rank + 1, record: overall };
  }
  return null;
}

// ---------------------------------------------------------------------------
// FORMAT RECEIPT
// ---------------------------------------------------------------------------
const DIVIDER = '='.repeat(WIDTH);
const THIN    = '-'.repeat(WIDTH);

function formatGame(game, divisions, todayStr) {
  const lines = [];
  const label = (text) => '  ' + text.padEnd(10);

  lines.push(THIN);
  lines.push(`  ${dayLabel(game.day, todayStr)} - ${formatDay(game.day, { weekday: 'short', month: 'short', day: 'numeric' })}`);
  lines.push(THIN);
  lines.push('');

  // Matchup, away over home, stacked so long names can't overflow 48 columns.
  for (const line of wrap(game.away.name, WIDTH - 2)) lines.push(center(line));
  lines.push(center('at'));
  for (const line of wrap(game.home.name, WIDTH - 2)) lines.push(center(line));
  lines.push('');

  // Detail rows. Anything the API didn't give us is omitted rather than printed
  // as "unknown" — odds in particular are often missing early in the week.
  lines.push(label('Kickoff') + formatKickoff(game.kickoff));
  if (game.network) lines.push(label('TV') + game.network);

  if (game.venue?.fullName) {
    lines.push(label('Where') + game.venue.fullName);
    const addr = game.venue.address;
    if (addr?.city) {
      const city = [addr.city, addr.state].filter(Boolean).join(', ');
      lines.push('  ' + ' '.repeat(10) + city);
    }
  }
  if (game.line) lines.push(label('Line') + game.line);

  if (game.week) {
    const prefix = { 1: 'Preseason ', 3: 'Postseason ' }[game.season] || '';
    lines.push(label('Week') + prefix + game.week);
  }

  // Records block, in the same away-then-home order as the matchup above.
  // Prefer the standings record: the scoreboard reports 0-0 placeholders for a
  // game that hasn't kicked off yet, which is exactly when this job runs.
  const rows = [game.away, game.home].filter(Boolean).map((team) => {
    const place = divisions ? placeInDivision(divisions, team.abbr) : null;
    const bits = [];
    const record = place?.record || team.record;
    if (record) bits.push(record);
    if (place) bits.push(`${ordinal(place.rank)} in ${place.division}`);
    return { name: team.name, detail: bits.join('   ') };
  });

  if (rows.some((r) => r.detail)) {
    lines.push('');
    for (const row of rows) {
      for (const line of wrap(row.name, WIDTH - 2)) lines.push('  ' + line);
      if (row.detail) lines.push('    ' + row.detail);
    }
  }

  lines.push('');
  return lines;
}

function formatReceipt(games, divisions, todayStr) {
  const lines = [
    DIVIDER,
    center('GAMEDAY'),
    center(formatDay(todayStr, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    })),
    DIVIDER,
    '',
  ];

  for (const game of games) lines.push(...formatGame(game, divisions, todayStr));

  lines.push(DIVIDER);
  lines.push('');
  lines.push(''); // extra feed so paper clears the tear bar

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// SEND TO PRINTER
// ---------------------------------------------------------------------------
async function sendToPrinter(content) {
  const res = await fetch(PRINT_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ content }),
  });
  return res.status;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  if (TEAMS.length === 0) throw new Error('NFL_TEAMS is empty — set it in .env');

  const todayStr = today();
  const dates    = datesToCheck(todayStr);
  console.log(`Checking ${TEAMS.join(', ').toUpperCase()} on ${dates.join(', ')}...`);

  // One scoreboard request per day in the window; a day with no game is cheap.
  const found = await Promise.all(dates.map((d) => findGames(d)));

  // Both watched teams can appear in the same game (DEN vs BUF), which would
  // otherwise add that game to the receipt twice.
  const seen  = new Set();
  const games = found.flat()
    .filter((g) => !seen.has(g.id) && seen.add(g.id))
    .sort((a, b) => a.kickoff - b.kickoff);

  // Nothing to say: skip the receipt entirely rather than printing "no games"
  // every morning and wasting paper.
  if (games.length === 0) {
    console.log('No games in the window — nothing to print.');
    return;
  }
  for (const g of games) {
    console.log(`Found: ${g.away.name} at ${g.home.name} (${g.day})`);
  }

  // A standings hiccup shouldn't cost us the whole receipt — print the game
  // cards without the division lines instead.
  let divisions = null;
  try {
    console.log('Fetching standings...');
    divisions = await fetchDivisions();
  } catch (err) {
    console.error('Standings unavailable:', err.message);
  }

  console.log('Formatting receipt...');
  const receipt = formatReceipt(games, divisions, todayStr);

  console.log('--- PREVIEW ---');
  console.log(receipt);
  console.log('--- END PREVIEW ---');

  console.log('Sending to printer...');
  const status = await sendToPrinter(receipt);
  console.log(`Print server responded with HTTP ${status}`);
}

main().catch((err) => {
  // fetch() wraps the real network error (e.g. ECONNREFUSED) in err.cause
  console.error('Error:', err.message, err.cause ? `(${err.cause})` : '');
  process.exit(1);
});
