'use strict';

const { SlashCommandBuilder, EmbedBuilder, InteractionContextType } = require('discord.js');
const catalog = require('../services/catalog');
const inventory = require('../services/inventory');
const members = require('../services/members');
const { postLog } = require('../services/logs');
const { UserError } = require('../lib/errors');
const { createPending } = require('../lib/pending');
const {
  EPHEMERAL, COLORS, requireOfficer, requireChannel, requireActiveMember, confirmRow,
} = require('../lib/discord');
const shared = require('./shared');

const data = shared.addLocationOptions(
  new SlashCommandBuilder()
    .setName('transfer-item')
    .setDescription('Officers: move stock to another owner, location, or personal/org')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName('owner').setDescription('Current owner (source)').setRequired(true))
    .addStringOption((o) => o.setName('record').setDescription('Item they hold (only shows what they actually have)')
      .setRequired(true).setAutocomplete(true))
    .addNumberOption((o) => o.setName('quantity').setDescription('How much to move').setRequired(true).setMinValue(0))
    .addUserOption((o) => o.setName('to_owner').setDescription('New owner (leave empty to keep the same owner)'))
    .addStringOption((o) => o.setName('to_designation').setDescription('New designation (leave empty to keep it)')
      .addChoices({ name: 'Personal', value: 'personal' }, { name: 'Org', value: 'org' })),
  { prefix: 'to_', required: false, label: 'New' },
)
  .addStringOption((o) => o.setName('note').setDescription('Optional note for the log').setMaxLength(200));

function whereText(loc) {
  return catalog.describeLocation(loc);
}

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'record') {
    await shared.autocompleteHoldings(interaction, focused);
    return;
  }
  await shared.autocompleteLocation(interaction, focused, 'to_');
}

async function execute(interaction) {
  requireOfficer(interaction);
  await requireChannel(interaction, 'output');
  await members.upsertMember(interaction.member);

  const owner = interaction.options.getUser('owner', true);
  const holding = await shared.resolveHolding(interaction.options.getString('record', true), owner.id);
  const quantity = interaction.options.getNumber('quantity', true);
  const toUser = interaction.options.getUser('to_owner');
  const toDesignationInput = interaction.options.getString('to_designation');
  const note = interaction.options.getString('note');

  const current = Number(holding.quantity);
  if (!(quantity > 0)) throw new UserError('Quantity must be greater than zero.');
  if (quantity > current) {
    throw new UserError(`${holding.owner_name} only has ${catalog.formatQuantity(current)} ${holding.unit} on that record — you can't move ${catalog.formatQuantity(quantity)}.`);
  }

  let toOwnerName = holding.owner_name;
  let toOwnerId = String(holding.owner_member_id);
  if (toUser) {
    const gm = await requireActiveMember(interaction.guild, toUser, 'The new owner');
    toOwnerName = members.displayName(gm);
    toOwnerId = toUser.id;
  }
  const toDesignation = toDesignationInput || holding.designation;

  const newLocation = await shared.resolveLocation(interaction, { prefix: 'to_', required: false });
  const sourceLocation = await catalog.getLocation(holding.location_id);
  const destLocation = newLocation || sourceLocation;

  if (
    toOwnerId === String(holding.owner_member_id)
    && toDesignation === holding.designation
    && destLocation.location_id === holding.location_id
  ) {
    throw new UserError('Nothing would change — pick a different owner, designation, or location to move it to.');
  }

  const target = await catalog.findMergeTarget({
    itemId: holding.item_id,
    ownerId: toOwnerId,
    designation: toDesignation,
    locationId: destLocation.location_id,
    qualityReading: holding.quality_reading,
  });
  const remaining = current - quantity;

  const action = {
    command: 'transfer-item',
    inventoryId: holding.id,
    expectedOwnerId: owner.id,
    quantity,
    toOwnerId,
    toDesignation,
    toLocationId: destLocation.location_id,
    note,
    display: {
      item: holding.item_name,
      unit: holding.unit,
      qualityReading: holding.quality_reading,
      qualityTier: holding.quality_tier,
      fromOwner: holding.owner_name,
      fromDesignation: holding.designation,
      fromLocation: whereText(sourceLocation),
      toOwner: toOwnerName,
      toLocation: whereText(destLocation),
    },
  };
  const pendingId = createPending(interaction.user.id, action);

  const unit = holding.unit;
  const fromText = `<@${holding.owner_member_id}> · ${holding.designation}\n${whereText(sourceLocation)}\n`
    + `${catalog.formatQuantity(current)} → ${catalog.formatQuantity(remaining)} ${unit}`
    + (remaining <= 0 ? ' (record removed)' : '');
  const toText = `<@${toOwnerId}> · ${toDesignation}\n${whereText(destLocation)}\n`
    + (target
      ? `${catalog.formatQuantity(target.quantity)} → ${catalog.formatQuantity(Number(target.quantity) + quantity)} ${unit} (adds to existing record)`
      : `0 → ${catalog.formatQuantity(quantity)} ${unit} (new record)`);

  const embed = new EmbedBuilder()
    .setColor(COLORS.transfer)
    .setTitle('Confirm: transfer stock')
    .addFields(
      { name: 'Item', value: `${shared.formatAmount(quantity, unit, holding.item_name)}${shared.qualityText(holding.quality_reading, holding.quality_tier)}` },
      { name: 'From', value: fromText, inline: true },
      { name: 'To', value: toText, inline: true },
    );
  if (note) embed.addFields({ name: 'Note', value: note });
  embed.setFooter({ text: 'Nothing is saved until you press Confirm. This prompt expires in 10 minutes.' });

  await interaction.reply({ embeds: [embed], components: [confirmRow(pendingId)], flags: EPHEMERAL });
}

async function confirm(interaction, action) {
  requireOfficer(interaction);
  const result = await inventory.transferStock({ ...action, actorId: interaction.user.id });
  const d = action.display;
  const amount = shared.formatAmount(action.quantity, d.unit, d.item);
  const quality = shared.qualityText(d.qualityReading, d.qualityTier);

  const changes = [];
  if (action.toOwnerId !== String(action.expectedOwnerId)) changes.push(`**${d.fromOwner}** → **${d.toOwner}**`);
  if (action.toDesignation !== d.fromDesignation) changes.push(`${d.fromDesignation} → ${action.toDesignation}`);
  if (d.fromLocation !== d.toLocation) changes.push(`${d.fromLocation} → ${d.toLocation}`);

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLORS.transfer).setTitle('✅ Stock transferred')
      .setDescription(
        `${amount}${quality}\n${changes.join('\n')}\n\n`
        + `Source: ${result.sourceDeleted ? 'record emptied and removed' : `${catalog.formatQuantity(result.sourceAfter)} ${d.unit} left`}\n`
        + `Destination: ${result.destinationCreated ? 'new record' : `${catalog.formatQuantity(result.destinationBefore)} → ${catalog.formatQuantity(result.destinationAfter)} ${d.unit}`}`,
      )],
    components: [],
  });

  const context = d.fromOwner === d.toOwner ? ` (owner: **${d.fromOwner}**)` : '';
  await postLog(
    interaction.client,
    `🔁 **${members.displayName(interaction.member)}** moved ${amount}${quality}${context}: ${changes.join(' · ')}${shared.noteText(action.note)}`,
  );
}

module.exports = { data, execute, autocomplete, confirm };
