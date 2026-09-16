'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const { config, formatRoles } = require('../config');
const { UserError } = require('./errors');
const { getChannelId } = require('../services/settings');
const members = require('../services/members');

const EPHEMERAL = MessageFlags.Ephemeral;

const COLORS = {
  add: 0x2e8b57,
  remove: 0xc0392b,
  transfer: 0x2f6fb5,
  info: 0x5865f2,
};

/** Throws unless the person running the command holds the officer role. */
function requireOfficer(interaction) {
  if (!interaction.member || !members.isOfficer(interaction.member)) {
    throw new UserError(`Only officers can do this (${formatRoles(config.officerRoleNames, (r) => `**${r}**`)} role).`);
  }
}

/** Throws unless the person holds the Admiral role (the only role that can wipe the system). */
function requireAdmiral(interaction) {
  if (!interaction.member || !members.isAdmiral(interaction.member)) {
    throw new UserError(`Only members with the **${config.admiralRoleName}** role can do this.`);
  }
}

/** Throws unless the command is being run in the channel configured for `purpose`. */
async function requireChannel(interaction, purpose) {
  const channelId = await getChannelId(purpose);
  if (!channelId) {
    throw new UserError('The inventory channels haven\'t been set up yet. An officer needs to run **/setup-server** first.');
  }
  if (interaction.channelId !== channelId) {
    throw new UserError(`Please run this command in <#${channelId}>.`);
  }
}

/**
 * Makes sure a Discord user is an active org member (has a member role) and that their
 * row in `members` is current. Returns the GuildMember.
 */
async function requireActiveMember(guild, user, label = 'That person') {
  if (user.bot) throw new UserError(`${label} is a bot, not an org member.`);
  const gm = await guild.members.fetch(user.id).catch(() => null);
  if (!gm) throw new UserError(`${label} isn't in this server.`);
  const active = await members.upsertMember(gm);
  if (!active) {
    const roles = formatRoles(config.memberRoleNames);
    throw new UserError(label === 'You'
      ? `This is only for org members — you need the ${roles} role.`
      : `${label} (${members.displayName(gm)}) isn't an org member — they need the ${roles} role.`);
  }
  return gm;
}

function confirmRow(pendingId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm:${pendingId}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cancel:${pendingId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

function truncate(text, max = 100) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Formats rows from catalog search* functions into Discord autocomplete choices. */
function toChoices(rows) {
  return rows.slice(0, 25).map((r) => ({ name: truncate(r.label), value: truncate(r.id) }));
}

async function replyWithError(interaction, err) {
  const isUser = err instanceof UserError;
  if (!isUser) console.error('Unexpected error handling interaction:', err);
  const content = isUser ? `⚠️ ${err.message}` : '⚠️ Something went wrong on our side. The error has been logged — please try again, and tell an officer if it keeps happening.';
  try {
    if (interaction.deferred && !interaction.replied) {
      // Replace the "thinking…" placeholder (or, for buttons, the confirmation prompt).
      await interaction.editReply({ content, embeds: [], components: [] });
    } else if (interaction.replied) {
      await interaction.followUp({ content, flags: EPHEMERAL });
    } else {
      await interaction.reply({ content, flags: EPHEMERAL });
    }
  } catch (replyErr) {
    console.error('Could not send error reply:', replyErr);
  }
}

module.exports = {
  EPHEMERAL,
  COLORS,
  requireOfficer,
  requireAdmiral,
  requireChannel,
  requireActiveMember,
  confirmRow,
  truncate,
  toChoices,
  replyWithError,
};
