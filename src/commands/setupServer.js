'use strict';

const {
  SlashCommandBuilder, ChannelType, PermissionFlagsBits: P, InteractionContextType,
} = require('discord.js');
const { config } = require('../config');
const { getChannelId, setChannelId, getSetting, setSetting } = require('../services/settings');
const { UserError } = require('../lib/errors');
const { EPHEMERAL, requireOfficer } = require('../lib/discord');
const registerMember = require('./registerMember');

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
 *  - register:     officers only, read-only; holds the "Register member" button panel
 */
const LAYOUT = [
  { purpose: 'input', topic: 'Officers: /add-item — stock coming into the pool', officers: USE, members: null },
  { purpose: 'output', topic: 'Officers: /remove-item and /transfer-item — stock leaving or moving', officers: USE, members: null },
  { purpose: 'logs', topic: 'Automatic history of every inventory change (read-only)', officers: READ, members: READ, readOnly: true },
  { purpose: 'board', topic: 'Live org inventory board (read-only)', officers: READ, members: READ, readOnly: true },
  { purpose: 'tickets', topic: 'Members: request an add / remove / transfer for officer review', officers: USE, members: USE },
  { purpose: 'register', topic: 'Officers: link a Discord member to their in-game gamertag (RSI handle)', officers: READ, members: null, readOnly: true },
];

function overwritesFor(entry, guild, botId, officerRoles, memberRoles) {
  const deny = [P.ViewChannel];
  const list = [
    { id: guild.roles.everyone.id, deny },
    { id: botId, allow: BOT },
  ];
  for (const role of officerRoles) {
    list.push({ id: role.id, allow: entry.officers, deny: entry.readOnly ? [P.SendMessages] : [] });
  }
  const officerIds = new Set(officerRoles.map((r) => r.id));
  for (const role of memberRoles) {
    if (officerIds.has(role.id)) continue;
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

  const findRoles = (names) => names.map((n) => guild.roles.cache.find((r) => r.name === n)).filter(Boolean);
  const officerRoles = findRoles(config.officerRoleNames);
  if (!officerRoles.length) {
    throw new UserError(`Couldn't find any officer role (looked for ${config.officerRoleNames.map((r) => `**${r}**`).join(', ')}).`);
  }
  const missingOfficerRoles = config.officerRoleNames.filter((n) => !guild.roles.cache.some((r) => r.name === n));
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
  let registerChannel = null;

  for (const entry of LAYOUT) {
    const name = config.channels[entry.purpose];
    const permissionOverwrites = overwritesFor(entry, guild, interaction.client.user.id, officerRoles, memberRoles);

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
    if (entry.purpose === 'register') registerChannel = channel;
    lines.push(`• <#${channel.id}> — ${status}, permissions applied`);
  }

  let panelNote = '';
  try {
    await registerMember.ensurePanel(registerChannel);
    panelNote = `\nThe **Register member** button is posted and pinned in <#${registerChannel.id}>.`;
  } catch (err) {
    console.error('Could not post the register panel:', err);
    panelNote = `\n⚠️ Couldn't post the **Register member** button in <#${registerChannel.id}> — check the bot can send messages there, then run this again.`;
  }

  let message = `**Inventory channels are ready** (under **${category.name}**):\n${lines.join('\n')}${panelNote}`;
  if (missingOfficerRoles.length) {
    message += `\n\n⚠️ Couldn't find these officer roles, so they weren't given access: ${missingOfficerRoles.join(', ')}. Check the OFFICER_ROLE_NAMES setting matches your role names exactly.`;
  }
  if (missingRoles.length) {
    message += `\n\n⚠️ Couldn't find these member roles, so they weren't given access: ${missingRoles.join(', ')}. Check the MEMBER_ROLE_NAMES setting matches your role names exactly.`;
  }
  message += '\n\nYou can rename or move these channels freely — the bot tracks them by ID, not name. Run this again anytime to repair permissions.';
  await interaction.editReply({ content: message });
}

module.exports = { data, execute };
