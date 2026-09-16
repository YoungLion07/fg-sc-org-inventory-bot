'use strict';

// Test setup. Tests WIPE the database they point at, so they only run when
// TEST_DATABASE_URL is set explicitly (never against DATABASE_URL by accident).

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
  process.env.OFFICER_ROLE_NAME = 'officer-sc';
  process.env.MEMBER_ROLE_NAMES = 'Star Citizen,Organization-SC';
}

const skip = TEST_URL ? false : 'set TEST_DATABASE_URL to a throwaway database to run these tests';

async function resetDatabase() {
  const { query } = require('../src/db');
  const { migrate } = require('../scripts/migrate');
  const { seed } = require('../scripts/seed');
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await seed();
}

async function addMember(id, name, active = true) {
  const { query } = require('../src/db');
  await query(
    `INSERT INTO members (member_id, discord_username, org_rank, active) VALUES ($1, $2, 'Member', $3)
     ON CONFLICT (member_id) DO UPDATE SET active = EXCLUDED.active`,
    [id, name, active],
  );
}

// ---------------------------------------------------------------------------
// Minimal fake Discord objects for exercising command handlers end to end
// ---------------------------------------------------------------------------

function fakeGuildMember(id, name, roles) {
  return {
    id,
    displayName: name,
    user: { id, bot: false, username: name },
    roles: { cache: { map: (fn) => roles.map((r) => fn({ name: r })) } },
  };
}

function fakeInteraction({ user, member, guildMembers = {}, channelId, options = {}, logSink = [] }) {
  const calls = { reply: [], editReply: [], update: [] };
  const interaction = {
    user: { id: user.id, bot: false },
    member,
    channelId,
    guildId: 'guild',
    deferred: false,
    replied: false,
    guild: {
      members: {
        fetch: async (id) => {
          if (!guildMembers[id]) throw new Error('Unknown Member');
          return guildMembers[id];
        },
      },
    },
    client: {
      channels: {
        fetch: async () => ({ isTextBased: () => true, send: async (msg) => { logSink.push(msg.content); } }),
      },
    },
    options: {
      getUser: (n, req) => {
        const v = options[n];
        if (v === undefined && req) throw new Error(`missing ${n}`);
        return v === undefined ? null : { id: v, bot: false };
      },
      getString: (n, req) => {
        const v = options[n];
        if (v === undefined && req) throw new Error(`missing ${n}`);
        return v === undefined ? null : v;
      },
      getNumber: (n) => (options[n] === undefined ? null : options[n]),
      getInteger: (n) => (options[n] === undefined ? null : options[n]),
      get: (n) => (options[n] === undefined ? null : { value: options[n] }),
    },
    reply: async (payload) => { interaction.replied = true; calls.reply.push(payload); },
    editReply: async (payload) => { calls.editReply.push(payload); },
    deferUpdate: async () => { interaction.deferred = true; },
    calls,
  };
  return interaction;
}

module.exports = { skip, resetDatabase, addMember, fakeGuildMember, fakeInteraction };
