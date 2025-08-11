// secrets.js
const secretsCache = {};

// Map of logical secret names to env var names
const SECRET_ENV_MAP = {
  'MASTER_SECRET': 'MASTER_SECRET',
  'JWT_SECRET': 'JWT_SECRET',
  'API_KEY': 'API_KEY',
  'CORS_ALLOWED_ORIGINS': 'CORS_ALLOWED_ORIGINS',
  'MERCHANT_API_URL': 'MERCHANT_API_URL',
  'UTXO_CHANGE_ADDRESS': 'UTXO_CHANGE_ADDRESS',
  'MONGODB_URI': 'MONGODB_URI',
  'SMTP_HOST': 'SMTP_HOST',
  'SMTP_PORT': 'SMTP_PORT',
  'SMTP_USER': 'SMTP_USER',
  'SMTP_PASS': 'SMTP_PASS',
  'EMAIL_FROM': 'EMAIL_FROM'
};

function getSecret(name) {
  if (secretsCache[name]) return secretsCache[name];
  const envVar = SECRET_ENV_MAP[name];
  const value = process.env[envVar] || null;
  secretsCache[name] = value;
  return value;
}

module.exports = { getSecret };
