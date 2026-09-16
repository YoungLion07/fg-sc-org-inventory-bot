'use strict';

// /wipe-revert wipe:<…> — undo a wipe made with /wipe-inventory. Admiral of Combat only.
// Archived rows go back; anything added since the wipe is kept (matching records merge).
// Full wipes also swap the archived #logs back in.

const {
  SlashCommandBuilder, InteractionContextType, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { config } = require('../config');
const { query, withTransaction } = require('../db');
const members = require('../services/members');
const wipe = require('../services/wipe');
const { postLog } = require('../services/logs');
const { getChannelId } = require('../services/settings');
const { restoreLogs } = require('../services/logsChannel');
const { UserError } = require('../lib/errors');
const { EPHEMERAL, requireAdmiral, truncate } = require('../lib/discord');

const SUBMIT_PREFIX = 'wipe-revert:submit:';
const CONFIRM_WORD = 'REVERT';
const db = { query };

const data = new SlashCommandBuilder()
  .setName('wipe-revert')
  .setDescription(`${config.admiralRoleName} only: undo an earlier wipe`)
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('wipe').setDescription('Which wipe to undo (newest first)')
    .setRequired(true).setAutocomplete(true));

const unixOf = (date) => Math.floor(new Date(date).getTime() / 1000);

async function autocomplete(interaction) {
  if (!interaction.member || !members.isAdmiral(interaction.member)) {
    await interaction.respond([{ name: `Only the ${config.admiralRoleName} role can revert wipes`, value: '__none__' }]);
    return;
  }
  const text = interaction.options.getFocused().toLowerCase();
  const rows = (await wipe.listWipes(db, { onlyRevertable: true, limit: 100 }))
    .map((w) => ({ name: truncate(wipe.wipeLabel(w)), value: String(w.wipe_id) }))
    .filter((c) => !text || c.name.toLowerCase().includes(text))
    .slice(0, 25);
  await interaction.respond(rows.length ? rows : [{ name: 'No wipes to revert', value: '__none__' }]);
}

async function loadRevertable(value) {
  const w = await wipe.getWipe(db, value);
  if (!w || !w.type) throw new UserError('Please pick a wipe from the suggestion list.');
  if (w.reverted_at) {
    throw new UserError(`Wipe #${w.wipe_id} was already reverted by **${w.reverted_by_name}** on <t:${unixOf(w.reverted_at)}:f>.`);
  }
  return w;
}

function buildModal(w) {
  return new ModalBuilder()
    .setCustomId(`${SUBMIT_PREFIX}${w.wipe_id}`)
    .setTitle(`Revert wipe #${w.wipe_id}?`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(`Type ${CONFIRM_WORD} to confirm`)
        .setDescription(truncate(`${w.type.label} from ${wipe.formatDate(w.wiped_at)} — puts everything it removed back.`))
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('confirm').setStyle(TextInputStyle.Short)
            .setMinLength(1).setMaxLength(20).setRequired(true).setPlaceholder(CONFIRM_WORD),
        ),
    );
}

async function execute(interaction) {
  requireAdmiral(interaction);
  const w = await loadRevertable(interaction.options.getString('wipe', true));
  if (w.type.kind === 'full') {
    const logsId = await getChannelId('logs');
    if (logsId && interaction.channelId === logsId) {
      throw new UserError('Please run this from another channel — #logs gets swapped back during this revert.');
    }
  }
  await interaction.showModal(buildModal(w));
}

async function handleModal(interaction, wipeId) {
  requireAdmiral(interaction);
  const typed = interaction.fields.getTextInputValue('confirm').trim();
  if (typed.toUpperCase() !== CONFIRM_WORD) {
    throw new UserError(`Nothing was changed — you need to type **${CONFIRM_WORD}** to confirm.`);
  }
  const w = await loadRevertable(wipeId);
  await interaction.deferReply({ flags: EPHEMERAL });
  await members.upsertMember(interaction.member);
  const admiral = members.displayName(interaction.member);

  const result = await withTransaction((client) => wipe.revertWipe(client, w.wipe_id, interaction.user.id));
  if (result.status === 'already') throw new UserError(`Wipe #${w.wipe_id} was just reverted by someone else.`);
  if (result.status !== 'reverted') throw new UserError('That wipe no longer exists.');

  let logs = null;
  if (w.type.kind === 'full' && w.logs_archive_channel_id) {
    logs = await restoreLogs(interaction.guild, {
      archiveChannelId: w.logs_archive_channel_id,
      wipeDate: w.wiped_at,
      reason: `Wipe #${w.wipe_id} reverted by ${admiral}`,
    });
    if (logs.between) await wipe.setWipeChannels(db, w.wipe_id, { revertLogsChannelId: logs.between.id });
  }

  const restored = wipe.describeCounts(result.restored) || 'nothing (it was already empty)';
  const lines = [
    `↩️ **Wipe #${w.wipe_id} (${w.type.label}, from <t:${unixOf(w.wiped_at)}:f>) was reverted by ${admiral}** on <t:${Math.floor(Date.now() / 1000)}:f>.`,
    `Restored: ${restored}. Anything added since the wipe was kept.`,
  ];
  if (logs?.status === 'restored') {
    lines.push(logs.between
      ? `The log from before the wipe is back in this channel. Lines written between the wipe and now are kept in <#${logs.between.id}> (${config.admiralRoleName} only).`
      : 'The log from before the wipe is back in this channel.');
  }
  await postLog(interaction.client, lines.join('\n'));

  const reply = [`✅ **Wipe #${w.wipe_id} reverted.**`, `• Restored: ${restored}. Anything added since the wipe was kept.`];
  if (logs?.status === 'restored') {
    reply.push(`• The old #logs is back as <#${logs.channel.id}>.${logs.between ? ` The log used since the wipe is now <#${logs.between.id}> (hidden, ${config.admiralRoleName} only).` : ''}`);
    if (logs.needsSetup) reply.push('• Run **/setup-server** to repair its permissions.');
  } else if (logs?.status === 'no-archive') {
    reply.push('• The archived #logs channel no longer exists, so the old log couldn\'t be brought back. The revert is recorded in the current #logs.');
  } else if (logs?.status === 'failed') {
    reply.push('• I couldn\'t swap the old #logs back (the bot needs **Manage Channels** and **Manage Roles**). The revert is recorded in the current #logs.');
  } else if (logs?.status === 'missing') {
    reply.push('• No #logs channel is set up, so the revert wasn\'t announced. Run **/setup-server** to create it.');
  }
  await interaction.editReply({ content: reply.join('\n') });
}

/** Routes the confirmation pop-up. Returns true if handled. */
async function handleInteraction(interaction) {
  if (interaction.isModalSubmit() && interaction.customId.startsWith(SUBMIT_PREFIX)) {
    await handleModal(interaction, interaction.customId.slice(SUBMIT_PREFIX.length));
    return true;
  }
  return false;
}

module.exports = { data, execute, autocomplete, handleInteraction, buildModal };
