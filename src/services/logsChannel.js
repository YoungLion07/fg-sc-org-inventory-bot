'use strict';

// Swapping #logs during full wipes and their reverts.
//
// Discord only lets bots bulk-delete messages younger than 14 days, so a full wipe "clears"
// #logs by creating a fresh copy (same name, topic, place, permissions) and turning the old
// channel into a hidden archive (renamed, visible only to the Admiral role). Nothing is lost,
// so a revert can swap the archive back in.

const { PermissionFlagsBits: P } = require('discord.js');
const { config } = require('../config');
const { getChannelId, setChannelId } = require('./settings');

const BOT = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.AttachFiles];

function channelDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Hidden from everyone; the Admiral role can read it; only the bot can post. */
async function hiddenOverwrites(guild) {
  await guild.roles.fetch().catch(() => {});
  const list = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: guild.client.user.id, allow: BOT },
  ];
  const admiral = guild.roles.cache.find((r) => r.name === config.admiralRoleName);
  if (admiral) list.push({ id: admiral.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] });
  return list;
}

async function fetchChannel(guild, id) {
  return id ? guild.channels.fetch(id).catch(() => null) : null;
}

/**
 * Full wipe: a fresh copy becomes #logs; the old channel is renamed logs-archive-<date> and hidden.
 * Returns { status: 'cleared' | 'kept' | 'missing', channel?, archive? }.
 */
async function archiveLogs(guild, { date, reason }) {
  const old = await fetchChannel(guild, await getChannelId('logs'));
  if (!old) return { status: 'missing' };

  let fresh;
  try {
    fresh = await old.clone({ reason });
  } catch (err) {
    console.error('Could not create the new #logs channel:', err);
    return { status: 'kept', channel: old };
  }
  try {
    await setChannelId('logs', fresh.id);
    await old.edit({
      name: `logs-archive-${channelDate(date)}`,
      permissionOverwrites: await hiddenOverwrites(guild),
      reason,
    });
    return { status: 'cleared', channel: fresh, archive: old };
  } catch (err) {
    console.error('Could not archive the old #logs channel:', err);
    await setChannelId('logs', old.id).catch(() => {});
    await fresh.delete(reason).catch(() => {});
    return { status: 'kept', channel: old };
  }
}

/**
 * Full-wipe revert: the archived channel becomes #logs again (taking the current channel's
 * name, place and permissions); the channel used since the wipe is renamed
 * logs-after-wipe-<date> and hidden, so its lines aren't lost either.
 * Returns { status: 'restored' | 'no-archive' | 'failed' | 'missing', channel?, between? }.
 */
async function restoreLogs(guild, { archiveChannelId, wipeDate, reason }) {
  const current = await fetchChannel(guild, await getChannelId('logs'));
  const archived = await fetchChannel(guild, archiveChannelId);
  if (!archived) return current ? { status: 'no-archive', channel: current } : { status: 'missing' };
  if (current && current.id === archived.id) return { status: 'restored', channel: archived };

  if (!current) {
    // No live #logs to copy from: bring the archive back by name; /setup-server repairs permissions.
    try {
      await archived.edit({ name: config.channels.logs, reason });
      await setChannelId('logs', archived.id);
      return { status: 'restored', channel: archived, needsSetup: true };
    } catch (err) {
      console.error('Could not restore the archived #logs channel:', err);
      return { status: 'missing' };
    }
  }

  try {
    await archived.edit({
      name: current.name,
      permissionOverwrites: current.permissionOverwrites.cache,
      parent: current.parentId,
      position: current.rawPosition,
      reason,
    });
    await setChannelId('logs', archived.id);
  } catch (err) {
    console.error('Could not restore the archived #logs channel:', err);
    return { status: 'failed', channel: current };
  }
  try {
    await current.edit({
      name: `logs-after-wipe-${channelDate(wipeDate)}`,
      permissionOverwrites: await hiddenOverwrites(guild),
      reason,
    });
  } catch (err) {
    console.error('Could not hide the #logs channel used since the wipe:', err);
  }
  return { status: 'restored', channel: archived, between: current };
}

module.exports = { archiveLogs, restoreLogs };
