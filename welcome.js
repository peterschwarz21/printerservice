#!/usr/bin/env node
/**
 * welcome.js
 * Texts a welcome to everyone on ALLOWED_NUMBERS who hasn't had one yet, then
 * tells ADMIN_NUMBERS who got it. The webhook does the same on every start, so
 * this is for a bulk send or a preview.
 *   node welcome.js            # just the new numbers
 *   node welcome.js --all      # everyone on the allowlist
 *   node welcome.js --dry-run  # show who would get it; sends nothing (combines with --all)
 */

const { welcome } = require('./src/welcome');

const args = process.argv.slice(2);
const unknown = args.filter((a) => !['--all', '--dry-run'].includes(a));
if (unknown.length) {
  console.error(`Unknown option(s): ${unknown.join(' ')}\nUsage: node welcome.js [--all] [--dry-run]`);
  process.exit(2);
}

welcome({ all: args.includes('--all'), dryRun: args.includes('--dry-run') }).then(({ failed }) => {
  process.exit(failed.length ? 1 : 0);
});
