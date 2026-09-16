'use strict';

// /blueprint — the member blueprint registry. Self-service: any org member records which
// blueprints they've unlocked, and anyone in the org can look up who can craft what.

const {
  SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, InteractionContextType,
} = require('discord.js');
const blueprints = require('../services/blueprints');
const members = require('../services/members');
const { UserError } = require('../lib/errors');
const {
  EPHEMERAL, COLORS, requireActiveMember, toChoices,
} = require('../lib/discord');

const EMBED_TEXT_LIMIT = 3800;

const data = new SlashCommandBuilder()
  .setName('blueprint')
  .setDescription('Record the crafting blueprints you own, and find who can craft what')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sc) => sc.setName('add').setDescription('Add a blueprint you have unlocked to your list')
    .addStringOption((o) => o.setName('blueprint').setDescription('Start typing the blueprint name')
      .setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('category').setDescription('Optional: narrow the blueprint list to one category')
      .setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('remove').setDescription('Remove a blueprint from your list')
    .addStringOption((o) => o.setName('blueprint').setDescription('One of the blueprints on your list')
      .setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('list').setDescription('Show the blueprints a member has recorded')
    .addUserOption((o) => o.setName('member').setDescription('Whose list to show (leave empty for your own)')))
  .addSubcommand((sc) => sc.setName('who').setDescription('Find which org members can craft a blueprint')
    .addStringOption((o) => o.setName('blueprint').setDescription('Start typing the blueprint name')
      .setRequired(true).setAutocomplete(true)));

async function autocomplete(interaction) {
  const sub = interaction.options.getSubcommand();
  const focused = interaction.options.getFocused(true);

  if (focused.name === 'category') {
    await interaction.respond(toChoices(await blueprints.searchSubcategories(focused.value)));
    return;
  }
  if (sub === 'remove') {
    const rows = await blueprints.searchMemberBlueprints(interaction.user.id, focused.value);
    await interaction.respond(rows.length ? toChoices(rows)
      : [{ name: focused.value ? 'No matching blueprints on your list' : 'Your blueprint list is empty', value: '__none__' }]);
    return;
  }
  const category = sub === 'add' ? interaction.options.getString('category') : null;
  const rows = await blueprints.searchBlueprints(focused.value, category);
  await interaction.respond(rows.length ? toChoices(rows)
    : [{ name: 'No matching blueprints — try a shorter name or another category', value: '__none__' }]);
}

async function resolveBlueprint(interaction) {
  const id = interaction.options.getString('blueprint', true);
  const bp = await blueprints.getBlueprint(id);
  if (!bp) throw new UserError('Please pick the blueprint from the suggestion list.');
  return bp;
}

function describe(bp) {
  const lines = [`**${blueprints.blueprintLabel(bp, { withCategory: false })}**`, `${bp.category_name} › ${bp.subcategory_name}`];
  const extra = [];
  if (bp.craft_minutes) extra.push(`${bp.craft_minutes} min to craft`);
  if (bp.materials) extra.push(`materials: ${bp.materials}`);
  if (extra.length) lines.push(extra.join(' · '));
  return lines.join('\n');
}

/** Sends text as an embed, or as an attached .txt when it's too long for Discord. */
async function replyWithList(interaction, title, text, filename) {
  if (text.length <= EMBED_TEXT_LIMIT) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(title).setDescription(text)],
      allowedMentions: { parse: [] },
      flags: EPHEMERAL,
    });
    return;
  }
  const preview = `${text.slice(0, EMBED_TEXT_LIMIT - 200).replace(/\n[^\n]*$/, '')}\n\n…the full list is in the attached file.`;
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(title).setDescription(preview)],
    files: [new AttachmentBuilder(Buffer.from(text.replace(/\*\*/g, ''), 'utf8'), { name: filename })],
    allowedMentions: { parse: [] },
    flags: EPHEMERAL,
  });
}

async function add(interaction) {
  const category = interaction.options.getString('category');
  if (category && !(await blueprints.getSubcategory(category))) {
    throw new UserError('Please pick the category from the suggestion list, or leave it empty.');
  }
  const bp = await resolveBlueprint(interaction);
  const created = await blueprints.addMemberBlueprint(interaction.user.id, bp.blueprint_id);
  await interaction.reply({
    content: created
      ? `✅ Added to your blueprint list:\n${describe(bp)}`
      : `ℹ️ That blueprint is already on your list:\n${describe(bp)}`,
    flags: EPHEMERAL,
  });
}

async function remove(interaction) {
  const bp = await resolveBlueprint(interaction);
  const removed = await blueprints.removeMemberBlueprint(interaction.user.id, bp.blueprint_id);
  if (!removed) throw new UserError('That blueprint isn\'t on your list.');
  await interaction.reply({ content: `🗑️ Removed from your blueprint list: **${blueprints.blueprintLabel(bp, { withCategory: false })}**`, flags: EPHEMERAL });
}

async function list(interaction) {
  const user = interaction.options.getUser('member') || interaction.user;
  const self = user.id === interaction.user.id;
  const gm = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!gm) throw new UserError('That person isn\'t in this server.');
  await members.upsertMember(gm);
  const member = await members.getMember(user.id);
  const rows = await blueprints.listMemberBlueprints(user.id);
  const name = members.displayName(gm);
  const handle = member && member.rsi_handle ? ` (${member.rsi_handle})` : '';

  if (!rows.length) {
    await interaction.reply({
      content: self
        ? 'Your blueprint list is empty. Add blueprints with `/blueprint add`.'
        : `**${name}**${handle} hasn't recorded any blueprints yet.`,
      flags: EPHEMERAL,
    });
    return;
  }

  const lines = [];
  let group = null;
  for (const bp of rows) {
    const heading = `${bp.category_name} › ${bp.subcategory_name}`;
    if (heading !== group) {
      if (group) lines.push('');
      lines.push(`**${heading}**`);
      group = heading;
    }
    lines.push(`• ${blueprints.blueprintLabel(bp, { withCategory: false })}`);
  }
  await replyWithList(
    interaction,
    `${self ? 'Your' : `${name}${handle}'s`} blueprints (${rows.length})`,
    lines.join('\n'),
    `blueprints-${name.replace(/[^A-Za-z0-9_-]+/g, '_')}.txt`,
  );
}

async function who(interaction) {
  const bp = await resolveBlueprint(interaction);
  const rows = await blueprints.whoHas(bp.blueprint_id);
  if (!rows.length) {
    await interaction.reply({
      content: `Nobody in the org has recorded this blueprint yet:\n${describe(bp)}`,
      flags: EPHEMERAL,
    });
    return;
  }
  const lines = [describe(bp), '', `**${rows.length} member${rows.length === 1 ? '' : 's'} can craft it:**`];
  for (const m of rows) {
    lines.push(`• ${m.discord_username}${m.rsi_handle ? ` — ${m.rsi_handle}` : ''}`);
  }
  await replyWithList(interaction, 'Who can craft this', lines.join('\n'), 'blueprint-crafters.txt');
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  // The registry is org-internal: only org members can add to it or look things up.
  await requireActiveMember(interaction.guild, interaction.user, 'You');
  if (sub === 'add') return add(interaction);
  if (sub === 'remove') return remove(interaction);
  if (sub === 'list') return list(interaction);
  if (sub === 'who') return who(interaction);
  throw new UserError('Unknown option.');
}

module.exports = { data, execute, autocomplete };
