require('dotenv').config();

// Shared by ALLOWED_NUMBERS (who may print) and ADMIN_NUMBERS (who gets paged
// when a job fails) so both lists accept the same comma-separated E.164 format.
function parseNumbers(value) {
  return (value || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
}

const allowedNumbers = parseNumbers(process.env.ALLOWED_NUMBERS);
// Operational alerts and texted commands. Deliberately NOT a superset of the
// allowlist: the household prints, but only admins run the printer.
const adminNumbers = parseNumbers(process.env.ADMIN_NUMBERS);

function isAllowed(phoneNumber) {
  return allowedNumbers.includes(phoneNumber);
}

function isAdmin(phoneNumber) {
  return adminNumbers.includes(phoneNumber);
}

module.exports = { isAllowed, isAdmin, parseNumbers, adminNumbers };
