'use strict';

require('dotenv').config({ quiet: true });

function unique(values) {
  return [...new Set(values)];
}

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
  // Every role listed here counts as an officer. OFFICER_ROLE_NAME (the older, single-role
  // setting) is still honoured and added to the list, so existing Railway variables keep working.
  officerRoleNames: unique([
    ...list(process.env.OFFICER_ROLE_NAMES, 'officer-sc,officer'),
    ...list(process.env.OFFICER_ROLE_NAME, ''),
  ]),
  // Anyone holding at least one of these is an org member.
  memberRoleNames: list(process.env.MEMBER_ROLE_NAMES, 'Star Citizen,Organization-SC,Organization'),
  // The only role allowed to run /wipe-inventory (full reset after a game wipe).
  admiralRoleName: (process.env.ADMIRAL_ROLE_NAME || 'Admiral of Combat').trim(),

  // Names used by /setup-server. Stored channel IDs (not names) are what the bot actually checks.
  channelCategoryName: 'Org Inventory',
  channels: {
    input: 'input',
    output: 'output',
    logs: 'logs',
    board: 'org-inventory-data',
    tickets: 'inventory-tickets',
    register: 'register-member',
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

/** ["A", "B", "C"] -> "A, B or C" (optionally wrapping each name, e.g. in **bold**). */
function formatRoles(names, wrap = (n) => n) {
  const parts = names.map(wrap);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}` : parts.join('');
}

module.exports = { config, requireConfig, formatRoles };
