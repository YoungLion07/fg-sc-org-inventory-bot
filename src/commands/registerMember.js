'use strict';

// #register-member: a pinned panel with a "Register member" button. Officers click it, pick a
// Discord member and type their in-game gamertag (RSI handle) in one small form.

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
} = require('discord.js');
const { config, formatRoles } = require('../config');
const members = require('../services/members');
const { postLog } = require('../services/logs');
const { getSetting, setSetting } = require('../services/settings');
const { UserError } = require('../lib/errors');
const { EPHEMERAL, COLORS, requireOfficer, requireActiveMember } = require('../lib/discord');

const OPEN_ID = 'register:open';
const SUBMIT_ID = 'register:submit';
const PANEL_KEY = 'panel.register';

function panelMessage() {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🪪 Register a member\'s gamertag')
    .setDescription(
      'Link a Discord member to their Star Citizen in-game name (RSI handle).\n\n'
      + '**1.** Click **Register member**\n'
      + '**2.** Pick the member from the list\n'
      + '**3.** Type their gamertag and submit\n\n'
      + `The member needs one of these roles: ${formatRoles(config.memberRoleNames, (r) => `**${r}**`)}. `
      + 'Registering someone who already has a gamertag replaces it. Every change is recorded in the logs.',
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(OPEN_ID).setLabel('Register member').setEmoji('🪪').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

/** Posts the panel in the channel, or refreshes it if it's already there. */
async function ensurePanel(channel) {
  const payload = panelMessage();
  const storedId = await getSetting(PANEL_KEY);
  if (storedId) {
    const existing = await channel.messages.fetch(storedId).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      return existing;
    }
  }
  const message = await channel.send(payload);
  await message.pin().catch((err) => console.warn('Could not pin the register panel:', err.message));
  await setSetting(PANEL_KEY, message.id);
  return message;
}

function buildModal() {
  return new ModalBuilder()
    .setCustomId(SUBMIT_ID)
    .setTitle('Register member gamertag')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Discord member')
        .setDescription(`Must have the ${formatRoles(config.memberRoleNames)} role`.slice(0, 100))
        .setUserSelectMenuComponent(
          new UserSelectMenuBuilder().setCustomId('member').setMinValues(1).setMaxValues(1).setRequired(true),
        ),
      new LabelBuilder()
        .setLabel('In-game gamertag (RSI handle)')
        .setDescription('Letters, numbers, dashes and underscores only')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('handle').setStyle(TextInputStyle.Short)
            .setMinLength(2).setMaxLength(60).setRequired(true).setPlaceholder('e.g. Nightfall_77'),
        ),
    );
}

async function handleButton(interaction) {
  requireOfficer(interaction);
  await interaction.showModal(buildModal());
}

async function handleModal(interaction) {
  requireOfficer(interaction);

  const user = interaction.fields.getSelectedUsers('member')?.first();
  if (!user) throw new UserError('Please pick a member.');
  const handle = members.normalizeHandle(interaction.fields.getTextInputValue('handle'));

  const target = await requireActiveMember(interaction.guild, user, 'That member');
  await members.upsertMember(interaction.member);

  const { previous } = await members.setRsiHandle(user.id, handle);
  const name = members.displayName(target);

  let text;
  if (previous && previous === handle) {
    text = `ℹ️ **${name}** is already registered as **${handle}** — nothing changed.`;
  } else if (previous) {
    text = `✅ **${name}**'s gamertag changed from **${previous}** to **${handle}**.`;
  } else {
    text = `✅ **${name}** is now registered as **${handle}**.`;
  }
  await interaction.reply({ content: text, flags: EPHEMERAL });

  if (previous !== handle) {
    const officer = members.displayName(interaction.member);
    await postLog(
      interaction.client,
      previous
        ? `🪪 **${officer}** changed **${name}**'s gamertag: ${previous} → **${handle}**`
        : `🪪 **${officer}** registered **${name}** as **${handle}**`,
    );
  }
}

/** Routes any component/modal whose customId starts with "register:". Returns true if handled. */
async function handleInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === OPEN_ID) {
    await handleButton(interaction);
    return true;
  }
  if (interaction.isModalSubmit() && interaction.customId === SUBMIT_ID) {
    await handleModal(interaction);
    return true;
  }
  return false;
}

module.exports = { ensurePanel, handleInteraction, buildModal, panelMessage };
