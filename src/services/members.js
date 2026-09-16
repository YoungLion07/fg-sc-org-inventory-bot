'use strict';

// Keeps the `members` table in sync with Discord roles.
// A member is anyone holding at least one of MEMBER_ROLE_NAMES (holding both is fine too).

const { config } = require('../config');
const { query } = require('../db');

function roleNames(guildMember) {
  return guildMember.roles.cache.map((r) => r.name);
}

function isOrgMember(guildMember) {
  const names = roleNames(guildMember);
  return config.memberRoleNames.some((n) => names.includes(n));
}

function isOfficer(guildMember) {
  return roleNames(guildMember).includes(config.officerRoleName);
}

function displayName(guildMember) {
  return guildMember.displayName || guildMember.user?.globalName || guildMember.user?.username || 'Unknown';
}

function rankFor(guildMember) {
  return isOfficer(guildMember) ? 'Officer' : 'Member';
}

/**
 * Inserts/updates one member row. `active` follows the member roles; officers without a
 * member role still get a row (so their actions can be recorded) but stay inactive
 * as inventory owners until they're given a member role.
 */
async function upsertMember(guildMember) {
  const active = isOrgMember(guildMember);
  await query(
    `INSERT INTO members (member_id, discord_username, org_rank, active)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (member_id) DO UPDATE
       SET discord_username = EXCLUDED.discord_username,
           org_rank = EXCLUDED.org_rank,
           active = EXCLUDED.active,
           updated_at = now()`,
    [guildMember.id, displayName(guildMember), rankFor(guildMember), active],
  );
  return active;
}

/** Called when someone leaves the server. Never deletes: their history stays intact. */
async function deactivateMember(userId) {
  await query(`UPDATE members SET active = false, updated_at = now() WHERE member_id = $1`, [userId]);
}

/**
 * Real-time sync for a single member (role change / join). Only touches the table if the
 * person is relevant: they have a member or officer role now, or they already have a row.
 */
async function syncMember(guildMember) {
  if (guildMember.user?.bot) return;
  if (isOrgMember(guildMember) || isOfficer(guildMember)) {
    await upsertMember(guildMember);
    return;
  }
  await deactivateMember(guildMember.id);
}

/** Full roster sync: run on startup. Bulk-loads everyone with a qualifying role. */
async function syncAllMembers(guild) {
  const all = await guild.members.fetch();
  let active = 0;
  const seen = new Set();
  for (const gm of all.values()) {
    if (gm.user.bot) continue;
    seen.add(gm.id);
    if (isOrgMember(gm) || isOfficer(gm)) {
      if (await upsertMember(gm)) active += 1;
    }
  }
  // Anyone in the table who's no longer in the server, or no longer has a member role.
  const { rows } = await query(`SELECT member_id FROM members WHERE active = true`);
  let deactivated = 0;
  for (const row of rows) {
    const id = String(row.member_id);
    const gm = all.get(id);
    if (!seen.has(id) || !gm || !isOrgMember(gm)) {
      await deactivateMember(id);
      deactivated += 1;
    }
  }
  return { active, deactivated };
}

async function getMember(userId) {
  const { rows } = await query(`SELECT * FROM members WHERE member_id = $1`, [userId]);
  return rows[0] || null;
}

async function setRsiHandle(userId, handle) {
  const { rowCount } = await query(
    `UPDATE members SET rsi_handle = $2, updated_at = now() WHERE member_id = $1`,
    [userId, handle],
  );
  return rowCount > 0;
}

module.exports = {
  isOrgMember,
  isOfficer,
  displayName,
  upsertMember,
  syncMember,
  syncAllMembers,
  deactivateMember,
  getMember,
  setRsiHandle,
};
