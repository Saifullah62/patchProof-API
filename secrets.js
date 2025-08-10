// secrets.js
const secretsCache = {};

// Map of logical secret names to env var names
const SECRET_ENV_MAP = {
  'MASTER_SECRET': 'MASTER_SECRET',
  'JWT_SECRET': 'JWT_SECRET',
  'API_KEY': 'API_KEY',
  'CORS_ALLOWED_ORIGINS': 'CORS_ALLOWED_ORIGINS',
  'MERCHANT_API_URL': 'MERCHANT_API_URL',
  'UTXO_TXID': 'UTXO_TXID',
  'UTXO_OUTPUT_INDEX': 'UTXO_OUTPUT_INDEX',
  'UTXO_SATOSHIS': 'UTXO_SATOSHIS',
  'UTXO_SCRIPT_HEX': 'UTXO_SCRIPT_HEX',
  'UTXO_PRIVKEY_WIF': 'UTXO_PRIVKEY_WIF',
  'UTXO_CHANGE_ADDRESS': 'UTXO_CHANGE_ADDRESS'
};

function getSecret(name) {
  if (secretsCache[name]) return secretsCache[name];
  const envVar = SECRET_ENV_MAP[name];
  const value = process.env[envVar] || null;
  secretsCache[name] = value;
  return value;
}

module.exports = { getSecret };
