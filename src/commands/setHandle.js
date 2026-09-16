'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const members = require('../services/members');
const { UserError } = require('../lib/errors');
const { EPHEMERAL } = require('../lib/discord');

const data = new SlashCommandBuilder()
  .setName('set-handle')
  .setDescription('Save your Star Citizen (RSI) handle to the org roster')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('handle').setDescription('Your RSI handle').setRequired(true)
    .setMinLength(2).setMaxLength(60));

async function execute(interaction) {
  const handle = interaction.options.getString('handle', true).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(handle)) {
    throw new UserError('RSI handles can only contain letters, numbers, dashes, and underscores.');
  }
  const active = await members.upsertMember(interaction.member);
  if (!active) throw new UserError('Only org members can save a handle to the roster.');
  await members.setRsiHandle(interaction.user.id, handle);
  await interaction.reply({ content: `✅ Saved your RSI handle as **${handle}**.`, flags: EPHEMERAL });
}

module.exports = { data, execute };
