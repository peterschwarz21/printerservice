#!/usr/bin/env node
/**
 * weather.js
 * Fetches today's weather and sends a formatted receipt to the thermal print server.
 * Cron: 0 7 * * * cd /home/admin/printerservice && . "$HOME/.nvm/nvm.sh" && node weather.js
 */

require('dotenv').config();

// ---------------------------------------------------------------------------
// CONFIG (from .env)
// ---------------------------------------------------------------------------
const LAT       = process.env.WEATHER_LAT      || '39.7392';
const LON       = process.env.WEATHER_LON      || '-104.9903';
const TIMEZONE  = process.env.WEATHER_TIMEZONE || 'America/Denver';
// 127.0.0.1, not localhost — see src/printer.js
const PRINT_URL = process.env.PRINTER_URL      || 'http://127.0.0.1:5000/print';
const WIDTH     = 48;

// Open-Meteo weather code -> short description
const WEATHER_CODES = {
  0:  "Clear Sky",
  1:  "Mostly Clear",
  2:  "Partly Cloudy",
  3:  "Overcast",
  45: "Foggy",
  48: "Icy Fog",
  51: "Light Drizzle",
  53: "Drizzle",
  55: "Heavy Drizzle",
  61: "Light Rain",
  63: "Rain",
  65: "Heavy Rain",
  71: "Light Snow",
  73: "Snow",
  75: "Heavy Snow",
  77: "Snow Grains",
  80: "Light Showers",
  81: "Showers",
  82: "Heavy Showers",
  85: "Snow Showers",
  86: "Heavy Snow Showers",
  95: "Thunderstorm",
  96: "Thunderstorm w/ Hail",
  99: "Thunderstorm w/ Heavy Hail",
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function windDirection(deg) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

function center(str) {
  const pad = Math.max(0, Math.floor((WIDTH - str.length) / 2));
  return " ".repeat(pad) + str;
}

function row(label, value) {
  return `  ${label.padEnd(14)}${value}`;
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month:   "short",
    day:     "numeric",
    timeZone: TIMEZONE,
  });
}

// ---------------------------------------------------------------------------
// FETCH WEATHER
// ---------------------------------------------------------------------------
async function fetchWeather() {
  const params = new URLSearchParams({
    latitude:   LAT,
    longitude:  LON,
    current:    [
      "temperature_2m",
      "apparent_temperature",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
      "relative_humidity_2m",
    ].join(","),
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_probability_max",
    ].join(","),
    temperature_unit: "fahrenheit",
    wind_speed_unit:  "mph",
    timezone:         TIMEZONE,
    forecast_days:    1,
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// FORMAT RECEIPT
// ---------------------------------------------------------------------------
function formatReceipt(data) {
  const now   = data.current;
  const daily = data.daily;

  const temp       = Math.round(now.temperature_2m);
  const feelsLike  = Math.round(now.apparent_temperature);
  const humidity   = Math.round(now.relative_humidity_2m);
  const windSpd    = Math.round(now.wind_speed_10m);
  const windDir    = windDirection(now.wind_direction_10m);
  const condition  = WEATHER_CODES[now.weather_code] ?? "Unknown";
  const high       = Math.round(daily.temperature_2m_max[0]);
  const low        = Math.round(daily.temperature_2m_min[0]);
  const rainChance = Math.round(daily.precipitation_probability_max[0]);
  const dateStr    = formatDate(new Date());

  const DIVIDER = "=".repeat(WIDTH);
  const THIN    = "-".repeat(WIDTH);

  const lines = [
    DIVIDER,
    center("GOOD MORNING"),
    center(dateStr),
    DIVIDER,
    "",
    center(`[ ${condition} ]`),
    "",
    THIN,
    center("NOW       HIGH      LOW"),
    center(`${temp}F        ${high}F       ${low}F`),
    THIN,
    "",
    row("Feels Like :", `${feelsLike}F`),
    row("Humidity   :", `${humidity}%`),
    row("Rain Chance:", `${rainChance}%`),
    row("Wind       :", `${windSpd} mph ${windDir}`),
    "",
    DIVIDER,
    center("Have a great day!"),
    DIVIDER,
    "",
    "",  // extra feed so paper clears the tear bar
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// SEND TO PRINTER
// ---------------------------------------------------------------------------
async function sendToPrinter(content) {
  const res = await fetch(PRINT_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ content }),
  });
  return res.status;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  console.log("Fetching weather...");
  const data = await fetchWeather();

  console.log("Formatting receipt...");
  const receipt = formatReceipt(data);

  console.log("--- PREVIEW ---");
  console.log(receipt);
  console.log("--- END PREVIEW ---");

  console.log("Sending to printer...");
  const status = await sendToPrinter(receipt);
  console.log(`Print server responded with HTTP ${status}`);
}

main().catch((err) => {
  // fetch() wraps the real network error (e.g. ECONNREFUSED) in err.cause
  console.error("Error:", err.message, err.cause ? `(${err.cause})` : "");
  process.exit(1);
});