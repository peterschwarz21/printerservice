#!/usr/bin/env node
/**
 * authorize.js
 * One-time Google OAuth authorization for calendar.js. Run this on a laptop
 * (with a browser), signed in as the HUB account everyone shares their
 * calendars with — NOT on the headless Pi. Writes google-token.json, which
 * you then scp to the Pi. See README "Daily Google Calendar receipt".
 */

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TOKEN_PATH    = path.resolve(__dirname, process.env.GOOGLE_OAUTH_TOKEN || './google-token.json');

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE     = 'https://www.googleapis.com/auth/calendar.readonly';

const TIMEOUT_MS = 5 * 60 * 1000;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  console.error('(Google Auth Platform > Clients > Create client > Desktop app)');
  process.exit(1);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function exchangeCode(code, redirectUri, verifier) {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

function main() {
  const state    = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }

    if (url.searchParams.get('error')) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h3>Authorization failed — see terminal.</h3>');
      fail(`Google returned "${url.searchParams.get('error')}" (did you click Cancel?)`);
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h3>State mismatch — see terminal.</h3>');
      fail('state mismatch on callback (possible CSRF or stale tab) — re-run and use the fresh URL');
    }

    try {
      const redirectUri = `http://127.0.0.1:${server.address().port}/`;
      const tokens = await exchangeCode(url.searchParams.get('code'), redirectUri, verifier);
      if (!tokens.refresh_token) {
        throw new Error(
          'Google did not return a refresh token. Revoke this app at ' +
          'https://myaccount.google.com/connections and re-run.'
        );
      }
      fs.writeFileSync(
        TOKEN_PATH,
        JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2) + '\n',
        { mode: 0o600 }
      );
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h3>Authorized! You can close this tab.</h3>');
      server.close();

      console.log(`\nSaved refresh token to ${TOKEN_PATH}`);
      console.log('\nNow copy it to the Pi (and make sure the Pi\'s .env has the same client ID/secret):');
      console.log(`  scp ${path.basename(TOKEN_PATH)} admin@<pi-ip>:/home/admin/printerservice/`);
      process.exit(0);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h3>Token exchange failed — see terminal.</h3>');
      fail(err.message);
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const params = new URLSearchParams({
      client_id:             CLIENT_ID,
      redirect_uri:          `http://127.0.0.1:${server.address().port}/`,
      response_type:         'code',
      scope:                 SCOPE,
      access_type:           'offline',
      prompt:                'consent', // always issue a refresh_token, even on re-auth
      state,
      code_challenge:        challenge,
      code_challenge_method: 'S256',
    });
    console.log('Open this URL in your browser and sign in as the HUB account');
    console.log('(the one everyone shares their calendars with):\n');
    console.log(`  ${AUTH_URL}?${params}\n`);
    console.log('If Google warns the app is unverified: Advanced -> continue anyway.');
    console.log('Waiting for authorization...');
  });

  setTimeout(() => fail('timed out after 5 minutes waiting for authorization'), TIMEOUT_MS).unref();
}

main();
