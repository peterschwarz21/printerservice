require('dotenv').config();

const allowedNumbers = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

function isAllowed(phoneNumber) {
  return allowedNumbers.includes(phoneNumber);
}

module.exports = { isAllowed };
