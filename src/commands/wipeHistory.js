'use strict';

// /wipe-history — every wipe with its number, date, type, who ran it, and whether it was reverted.
// Officers and the Admiral can view it.

const { SlashCommandBuilder, InteractionContextType, EmbedBuilder } = require('discord.js');
const { config } = require('../config');
const { query } = require('../db');
const members = require('../services/members');
const wipe = require('../services/wipe');
const { UserError } = require('../lib/errors');
const { EPHEMERAL, COLORS } = require('../lib/discord');

const LIMIT = 25;
const DESCRIPTION_LIMIT = 4000;

const data = new SlashCommandBuilder()
  .setName('wipe-history')
  .setDescription('Officers: list past inventory wipes with their dates')
  .setContexts(InteractionContextType.Guild);

const unixOf = (date) => Math.floor(new Date(date).getTime() / 1000);

function describe(w) {
  const label = w.type ? w.type.label : w.wipe_type;
  const lines = [
    `**#${w.wipe_id}** · <t:${unixOf(w.wiped_at)}:f> · **${label}** · by ${w.wiped_by_name}`,
    `  Removed: ${wipe.describeCounts(w.counts) || 'nothing'}`,
  ];
  lines.push(w.reverted_at
    ? `  ↩️ Reverted by ${w.reverted_by_name} on <t:${unixOf(w.reverted_at)}:f>`
    : '  Not reverted');
  return lines.join('\n');
}

async function execute(interaction) {
  const m = interaction.member;
  if (!m || !(members.isOfficer(m) || members.isAdmiral(m))) {
    throw new UserError(`Only officers and the **${config.admiralRoleName}** role can view the wipe history.`);
  }
  const rows = await wipe.listWipes({ query }, { limit: LIMIT });
  if (!rows.length) {
    await interaction.reply({ content: 'No wipes have been made yet.', flags: EPHEMERAL });
    return;
  }
  let text = '';
  for (const w of rows) {
    const block = describe(w);
    if (text.length + block.length + 2 > DESCRIPTION_LIMIT) break;
    text += `${text ? '\n\n' : ''}${block}`;
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`Wipe history (${rows.length === LIMIT ? `latest ${LIMIT}` : rows.length})`)
    .setDescription(text)
    .setFooter({ text: 'Dates are shown in your own time zone. Undo a wipe with /wipe-revert.' });
  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] }, flags: EPHEMERAL });
}

module.exports = { data, execute };
