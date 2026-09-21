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

function isAllowed(phoneNumber) {
  return allowedNumbers.includes(phoneNumber);
}

module.exports = { isAllowed, parseNumbers };
