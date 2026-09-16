'use strict';

require('dotenv').config({ quiet: true });

function list(value, fallback) {
  const raw = value && value.trim() ? value : fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: String(process.env.DATABASE_SSL || '').toLowerCase() === 'true',
  officerRoleName: (process.env.OFFICER_ROLE_NAME || 'officer-sc').trim(),
  memberRoleNames: list(process.env.MEMBER_ROLE_NAMES, 'Star Citizen,Organization-SC'),

  // Names used by /setup-server. Stored channel IDs (not names) are what the bot actually checks.
  channelCategoryName: 'Org Inventory',
  channels: {
    input: 'input',
    output: 'output',
    logs: 'logs',
    board: 'org-inventory-data',
    tickets: 'inventory-tickets',
  },

  // How long an unconfirmed Confirm/Cancel prompt stays valid.
  pendingActionTtlMs: 10 * 60 * 1000,
};

function requireConfig(keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) {
    const envNames = {
      token: 'DISCORD_TOKEN',
      clientId: 'DISCORD_CLIENT_ID',
      guildId: 'DISCORD_GUILD_ID',
      databaseUrl: 'DATABASE_URL',
    };
    const names = missing.map((k) => envNames[k] || k).join(', ');
    console.error(`Missing required environment variable(s): ${names}. See .env.example.`);
    process.exit(1);
  }
}

module.exports = { config, requireConfig };
