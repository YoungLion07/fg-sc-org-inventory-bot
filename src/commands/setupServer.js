'use strict';

const {
  SlashCommandBuilder, ChannelType, PermissionFlagsBits: P, InteractionContextType,
} = require('discord.js');
const { config } = require('../config');
const { getChannelId, setChannelId, getSetting, setSetting } = require('../services/settings');
const { UserError } = require('../lib/errors');
const { EPHEMERAL, requireOfficer } = require('../lib/discord');

const data = new SlashCommandBuilder()
  .setName('setup-server')
  .setDescription('Officers: create (or repair) the inventory channels and their permissions')
  .setContexts(InteractionContextType.Guild);

const READ = [P.ViewChannel, P.ReadMessageHistory];
const USE = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.UseApplicationCommands];
const BOT = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.AttachFiles];

/**
 * Channel layout. Everything is hidden from @everyone and shown to org-role holders, so
 * guests in the server don't see org inventory.
 *  - input/output: officers only
 *  - logs/board:   org members can read, only the bot posts
 *  - tickets:      org members can read and run commands
 */
const LAYOUT = [
  { purpose: 'input', topic: 'Officers: /add-item — stock coming into the pool', officers: USE, members: null },
  { purpose: 'output', topic: 'Officers: /remove-item and /transfer-item — stock leaving or moving', officers: USE, members: null },
  { purpose: 'logs', topic: 'Automatic history of every inventory change (read-only)', officers: READ, members: READ, readOnly: true },
  { purpose: 'board', topic: 'Live org inventory board (read-only)', officers: READ, members: READ, readOnly: true },
  { purpose: 'tickets', topic: 'Members: request an add / remove / transfer for officer review', officers: USE, members: USE },
];

function overwritesFor(entry, guild, botId, officerRole, memberRoles) {
  const deny = [P.ViewChannel];
  const list = [
    { id: guild.roles.everyone.id, deny },
    { id: botId, allow: BOT },
    { id: officerRole.id, allow: entry.officers, deny: entry.readOnly ? [P.SendMessages] : [] },
  ];
  for (const role of memberRoles) {
    if (role.id === officerRole.id) continue;
    if (entry.members) {
      list.push({ id: role.id, allow: entry.members, deny: entry.readOnly ? [P.SendMessages] : [] });
    }
  }
  return list;
}

async function ensureCategory(guild) {
  const storedId = await getSetting('channel.category');
  let category = storedId ? guild.channels.cache.get(storedId) : null;
  if (!category) {
    category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === config.channelCategoryName.toLowerCase(),
    );
  }
  if (!category) {
    category = await guild.channels.create({ name: config.channelCategoryName, type: ChannelType.GuildCategory });
  }
  await setSetting('channel.category', category.id);
  return category;
}

async function execute(interaction) {
  requireOfficer(interaction);
  await interaction.deferReply({ flags: EPHEMERAL });

  const { guild } = interaction;
  await guild.roles.fetch();
  await guild.channels.fetch();

  const officerRole = guild.roles.cache.find((r) => r.name === config.officerRoleName);
  if (!officerRole) throw new UserError(`Couldn't find a role named **${config.officerRoleName}**.`);
  const memberRoles = config.memberRoleNames
    .map((n) => guild.roles.cache.find((r) => r.name === n))
    .filter(Boolean);
  const missingRoles = config.memberRoleNames.filter((n) => !guild.roles.cache.some((r) => r.name === n));

  const me = guild.members.me;
  if (!me.permissions.has(P.ManageChannels) || !me.permissions.has(P.ManageRoles)) {
    throw new UserError('The bot needs the **Manage Channels** and **Manage Roles** permissions to set up channels. Re-invite it with the link from the setup guide, or grant those to its role.');
  }

  const category = await ensureCategory(guild);
  const lines = [];

  for (const entry of LAYOUT) {
    const name = config.channels[entry.purpose];
    const permissionOverwrites = overwritesFor(entry, guild, interaction.client.user.id, officerRole, memberRoles);

    const storedId = await getChannelId(entry.purpose);
    let channel = storedId ? guild.channels.cache.get(storedId) : null;
    let status = 'kept';
    if (!channel) {
      channel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === name && c.parentId === category.id,
      );
      status = channel ? 'linked existing' : 'created';
    }

    if (channel) {
      await channel.permissionOverwrites.set(permissionOverwrites);
      if (channel.topic !== entry.topic) await channel.setTopic(entry.topic).catch(() => {});
    } else {
      channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: entry.topic,
        permissionOverwrites,
      });
    }
    await setChannelId(entry.purpose, channel.id);
    lines.push(`• <#${channel.id}> — ${status}, permissions applied`);
  }

  let message = `**Inventory channels are ready** (under **${category.name}**):\n${lines.join('\n')}`;
  if (missingRoles.length) {
    message += `\n\n⚠️ Couldn't find these member roles, so they weren't given access: ${missingRoles.join(', ')}. Check the MEMBER_ROLE_NAMES setting matches your role names exactly.`;
  }
  message += '\n\nYou can rename or move these channels freely — the bot tracks them by ID, not name. Run this again anytime to repair permissions.';
  await interaction.editReply({ content: message });
}

module.exports = { data, execute };
