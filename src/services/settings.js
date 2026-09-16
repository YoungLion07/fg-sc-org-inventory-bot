'use strict';

const { query } = require('../db');

const cache = new Map();

async function getSetting(key) {
  if (cache.has(key)) return cache.get(key);
  const { rows } = await query(`SELECT value FROM bot_settings WHERE key = $1`, [key]);
  const value = rows[0] ? rows[0].value : null;
  cache.set(key, value);
  return value;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO bot_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value)],
  );
  cache.set(key, String(value));
}

// Channel IDs saved by /setup-server, keyed like "channel.input", "channel.logs", ...
const channelKey = (purpose) => `channel.${purpose}`;

const getChannelId = (purpose) => getSetting(channelKey(purpose));
const setChannelId = (purpose, id) => setSetting(channelKey(purpose), id);

module.exports = { getSetting, setSetting, getChannelId, setChannelId };
