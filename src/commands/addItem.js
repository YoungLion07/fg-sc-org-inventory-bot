'use strict';

const { SlashCommandBuilder, EmbedBuilder, InteractionContextType } = require('discord.js');
const catalog = require('../services/catalog');
const inventory = require('../services/inventory');
const members = require('../services/members');
const { postLog } = require('../services/logs');
const { deriveQualityTier } = require('../lib/quality');
const { UserError } = require('../lib/errors');
const { createPending } = require('../lib/pending');
const {
  EPHEMERAL, COLORS, requireOfficer, requireChannel, requireActiveMember, confirmRow, toChoices,
} = require('../lib/discord');
const shared = require('./shared');

const data = shared.addLocationOptions(
  new SlashCommandBuilder()
    .setName('add-item')
    .setDescription('Officers: log stock coming into the pool')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName('owner').setDescription('Who holds this item (also for org items)').setRequired(true))
    .addStringOption((o) => o.setName('category').setDescription('Item category').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('item').setDescription('The item (narrowed by category)').setRequired(true).setAutocomplete(true))
    .addNumberOption((o) => o.setName('quantity').setDescription('How many / how much').setRequired(true).setMinValue(0)),
)
  .addStringOption((o) => o.setName('designation').setDescription('Personal use or org property').setRequired(true)
    .addChoices({ name: 'Personal', value: 'personal' }, { name: 'Org', value: 'org' }))
  .addIntegerOption((o) => o.setName('quality').setDescription('Ores/minerals only: raw quality reading (1-1000)')
    .setMinValue(1).setMaxValue(1000))
  .addStringOption((o) => o.setName('note').setDescription('Optional note for the log').setMaxLength(200));

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (await shared.autocompleteLocation(interaction, focused)) return;

  if (focused.name === 'category') {
    await interaction.respond(toChoices(await catalog.searchSubcategories(focused.value)));
    return;
  }
  if (focused.name === 'item') {
    const subcategoryId = interaction.options.getString('category');
    await interaction.respond(toChoices(await catalog.searchItems(focused.value, subcategoryId)));
  }
}

async function execute(interaction) {
  requireOfficer(interaction);
  await requireChannel(interaction, 'input');

  const owner = interaction.options.getUser('owner', true);
  const ownerMember = await requireActiveMember(interaction.guild, owner, 'The owner');
  await members.upsertMember(interaction.member);

  const subcategoryId = interaction.options.getString('category', true);
  const itemId = interaction.options.getString('item', true);
  const quantity = interaction.options.getNumber('quantity', true);
  const designation = interaction.options.getString('designation', true);
  const reading = interaction.options.getInteger('quality');
  const note = interaction.options.getString('note');

  const subcategory = await catalog.getSubcategory(subcategoryId);
  if (!subcategory) throw new UserError('Please pick the category from the suggestion list.');
  const item = await catalog.getItem(itemId);
  if (!item) throw new UserError('Please pick the item from the suggestion list.');
  if (item.subcategory_id !== subcategoryId) {
    throw new UserError(`${item.name} is under ${item.category_name} › ${item.subcategory_name}, not the category you picked.`);
  }
  if (!(quantity > 0)) throw new UserError('Quantity must be greater than zero.');

  let tier = null;
  if (reading !== null) {
    if (!item.has_quality) {
      throw new UserError(`${item.name} doesn't have an ore/mineral quality rating — leave the quality field empty.`);
    }
    tier = deriveQualityTier(reading, item);
  }

  const location = await shared.resolveLocation(interaction);

  const action = {
    command: 'add-item',
    itemId: item.item_id,
    ownerId: owner.id,
    designation,
    locationId: location.location_id,
    quantity,
    qualityReading: reading,
    qualityTier: tier,
    note,
    display: {
      item: item.name,
      unit: item.unit,
      owner: members.displayName(ownerMember),
      location: catalog.describeLocation(location),
    },
  };
  const pendingId = createPending(interaction.user.id, action);

  const embed = new EmbedBuilder()
    .setColor(COLORS.add)
    .setTitle('Confirm: add stock')
    .addFields(
      { name: 'Item', value: `${item.name}${item.manufacturer ? ` (${item.manufacturer})` : ''}\n${item.category_name} › ${item.subcategory_name}` },
      { name: 'Quantity', value: `${catalog.formatQuantity(quantity)} ${item.unit}`, inline: true },
      { name: 'Owner', value: `<@${owner.id}>`, inline: true },
      { name: 'Designation', value: designation === 'org' ? 'Org' : 'Personal', inline: true },
      { name: 'Location', value: `${location.name} (${location.location_type_name})\n${catalog.describeLocation(location)}` },
    );
  if (reading !== null) {
    embed.addFields({ name: 'Quality', value: `${reading} → ${tier ? (tier === 'Perfect' ? 'Perfect' : `${tier}-tier`) : 'below published tiers (unknown)'}`, inline: true });
  }
  if (note) embed.addFields({ name: 'Note', value: note });
  embed.setFooter({ text: 'Nothing is saved until you press Confirm. This prompt expires in 10 minutes.' });

  await interaction.reply({ embeds: [embed], components: [confirmRow(pendingId)], flags: EPHEMERAL });
}

async function confirm(interaction, action) {
  requireOfficer(interaction);
  const result = await inventory.addStock({ ...action, actorId: interaction.user.id });

  const amount = shared.formatAmount(action.quantity, action.display.unit, action.display.item);
  const quality = shared.qualityText(action.qualityReading, action.qualityTier);
  const outcome = result.created
    ? 'New record created.'
    : `Merged into an existing record: ${catalog.formatQuantity(result.before)} → ${catalog.formatQuantity(result.after)} ${action.display.unit}.`;

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLORS.add).setTitle('✅ Stock added')
      .setDescription(`${amount}${quality} for **${action.display.owner}** (${action.designation}) at ${action.display.location}.\n${outcome}`)],
    components: [],
  });

  await postLog(
    interaction.client,
    `📥 **${members.displayName(interaction.member)}** added ${amount}${quality} → **${action.display.owner}** · ${action.designation} · ${action.display.location}${shared.noteText(action.note)}`,
  );
}

module.exports = { data, execute, autocomplete, confirm };
