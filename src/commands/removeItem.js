'use strict';

const { SlashCommandBuilder, EmbedBuilder, InteractionContextType } = require('discord.js');
const catalog = require('../services/catalog');
const inventory = require('../services/inventory');
const members = require('../services/members');
const { postLog } = require('../services/logs');
const { UserError } = require('../lib/errors');
const { createPending } = require('../lib/pending');
const {
  EPHEMERAL, COLORS, requireOfficer, requireChannel, confirmRow,
} = require('../lib/discord');
const shared = require('./shared');

const data = new SlashCommandBuilder()
  .setName('remove-item')
  .setDescription('Officers: retract stock that exists in the pool')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('owner').setDescription('Whose record to take from').setRequired(true))
  .addStringOption((o) => o.setName('record').setDescription('Item they hold (only shows what they actually have)')
    .setRequired(true).setAutocomplete(true))
  .addNumberOption((o) => o.setName('quantity').setDescription('How much to remove').setRequired(true).setMinValue(0))
  .addStringOption((o) => o.setName('note').setDescription('Optional reason for the log (used, sold, lost...)').setMaxLength(200));

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'record') await shared.autocompleteHoldings(interaction, focused);
}

async function execute(interaction) {
  requireOfficer(interaction);
  await requireChannel(interaction, 'output');
  await members.upsertMember(interaction.member);

  const owner = interaction.options.getUser('owner', true);
  const holding = await shared.resolveHolding(interaction.options.getString('record', true), owner.id);
  const quantity = interaction.options.getNumber('quantity', true);
  const note = interaction.options.getString('note');

  const current = Number(holding.quantity);
  if (!(quantity > 0)) throw new UserError('Quantity must be greater than zero.');
  if (quantity > current) {
    throw new UserError(`${holding.owner_name} only has ${catalog.formatQuantity(current)} ${holding.unit} on that record — you can't remove ${catalog.formatQuantity(quantity)}.`);
  }
  const remaining = current - quantity;
  const where = [holding.location_name, holding.parent_planet_id === 'PLNONE' ? null : holding.planet_name, holding.system_name]
    .filter(Boolean).join(', ');

  const action = {
    command: 'remove-item',
    inventoryId: holding.id,
    expectedOwnerId: owner.id,
    quantity,
    note,
    display: {
      item: holding.item_name,
      unit: holding.unit,
      owner: holding.owner_name,
      designation: holding.designation,
      location: where,
      qualityReading: holding.quality_reading,
      qualityTier: holding.quality_tier,
    },
  };
  const pendingId = createPending(interaction.user.id, action);

  const embed = new EmbedBuilder()
    .setColor(COLORS.remove)
    .setTitle('Confirm: remove stock')
    .addFields(
      { name: 'Item', value: `${holding.item_name}${shared.qualityText(holding.quality_reading, holding.quality_tier)}` },
      { name: 'Owner', value: `<@${owner.id}>`, inline: true },
      { name: 'Designation', value: holding.designation === 'org' ? 'Org' : 'Personal', inline: true },
      { name: 'Location', value: where },
      {
        name: 'Quantity',
        value: `${catalog.formatQuantity(current)} → ${catalog.formatQuantity(remaining)} ${holding.unit}`
          + (remaining <= 0 ? '\nThis empties the record, so it will be removed from the pool.' : ''),
      },
    );
  if (note) embed.addFields({ name: 'Note', value: note });
  embed.setFooter({ text: 'Nothing is saved until you press Confirm. This prompt expires in 10 minutes.' });

  await interaction.reply({ embeds: [embed], components: [confirmRow(pendingId)], flags: EPHEMERAL });
}

async function confirm(interaction, action) {
  requireOfficer(interaction);
  const result = await inventory.removeStock({ ...action, actorId: interaction.user.id });
  const d = action.display;
  const amount = shared.formatAmount(action.quantity, d.unit, d.item);
  const quality = shared.qualityText(d.qualityReading, d.qualityTier);
  const outcome = result.deleted
    ? 'Record emptied and removed from the pool.'
    : `${catalog.formatQuantity(result.before)} → ${catalog.formatQuantity(result.after)} ${d.unit} left.`;

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLORS.remove).setTitle('✅ Stock removed')
      .setDescription(`${amount}${quality} from **${d.owner}** (${d.designation}) at ${d.location}.\n${outcome}`)],
    components: [],
  });

  await postLog(
    interaction.client,
    `📤 **${members.displayName(interaction.member)}** removed ${amount}${quality} ← **${d.owner}** · ${d.designation} · ${d.location}`
      + ` (${result.deleted ? 'record emptied' : `${catalog.formatQuantity(result.after)} left`})${shared.noteText(action.note)}`,
  );
}

module.exports = { data, execute, autocomplete, confirm };
