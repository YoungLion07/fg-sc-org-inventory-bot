'use strict';

// /wipe-inventory type:<...> — reset after a Star Citizen wipe. Admiral of Combat only.
//
//  1. The Admiral picks a wipe type and types WIPE in a pop-up to confirm.
//  2. Inside one database transaction: writes are locked, a CSV backup of what's about to go
//     is sent to the Admiral, then the wipe runs. Removed rows are archived under a numbered,
//     dated wipe, so /wipe-revert can undo it. If the backup can't be delivered, nothing
//     is wiped.
//  3. Full wipes give #logs a fresh start: a copy replaces it and the old channel is kept as a
//     hidden archive. Partial wipes keep #logs and history. Either way the wipe is announced
//     in #logs with its number, date and the Admiral's name.

const { gzipSync } = require('node:zlib');
const {
  SlashCommandBuilder, InteractionContextType, AttachmentBuilder, LabelBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { config } = require('../config');
const { query, withTransaction } = require('../db');
const members = require('../services/members');
const wipe = require('../services/wipe');
const { postLog } = require('../services/logs');
const { getChannelId } = require('../services/settings');
const { archiveLogs } = require('../services/logsChannel');
const { UserError } = require('../lib/errors');
const { EPHEMERAL, requireAdmiral } = require('../lib/discord');

const SUBMIT_PREFIX = 'wipe:submit:';
const CONFIRM_WORD = 'WIPE';
// Discord's upload limit for bots is 10 MB per message; stay safely under it.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const data = new SlashCommandBuilder()
  .setName('wipe-inventory')
  .setDescription(`${config.admiralRoleName} only: reset inventory after a game wipe (you get a backup first)`)
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('type').setDescription('What to wipe').setRequired(true)
    .addChoices(...wipe.TYPE_CHOICES));

/** One line (max 100 chars) saying what this type removes, shown in the confirmation pop-up. */
function whatGoes(type) {
  if (type.kind === 'items') return `Removes all ${type.label.toLowerCase()} from inventory. History is kept. Can be reverted.`;
  if (type.kind === 'blueprints') return 'Clears every member\'s blueprint list. Inventory is not touched. Can be reverted.';
  return type.blueprints
    ? 'Clears ALL inventory, history, tickets, blueprint lists and #logs. Can be reverted.'
    : 'Clears ALL inventory, history, tickets and #logs. Blueprint lists stay. Can be reverted.';
}

function buildModal(type) {
  return new ModalBuilder()
    .setCustomId(`${SUBMIT_PREFIX}${type.value}`)
    .setTitle(`Wipe: ${type.label}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(`Type ${CONFIRM_WORD} to confirm`)
        .setDescription(whatGoes(type))
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('confirm').setStyle(TextInputStyle.Short)
            .setMinLength(1).setMaxLength(20).setRequired(true).setPlaceholder(CONFIRM_WORD),
        ),
    );
}

function resolveType(value) {
  const type = wipe.getType(value);
  if (!type) throw new UserError('Please pick a wipe type from the list.');
  return type;
}

async function refuseIfNothingToWipe(type) {
  const n = await wipe.countTargets({ query }, type);
  if (n === 0) {
    throw new UserError(type.kind === 'blueprints'
      ? 'Nothing to wipe — no member has any blueprints recorded.'
      : `Nothing to wipe — there are no **${type.label.toLowerCase()}** in the inventory.`);
  }
}

async function execute(interaction) {
  requireAdmiral(interaction);
  const type = resolveType(interaction.options.getString('type', true));
  if (type.kind === 'full') {
    const logsId = await getChannelId('logs');
    if (logsId && interaction.channelId === logsId) {
      throw new UserError('Please run this from another channel — #logs gets replaced during a full wipe.');
    }
  }
  await refuseIfNothingToWipe(type);
  await interaction.showModal(buildModal(type));
}

function timestamp(date) {
  return date.toISOString().slice(0, 16).replace('T', '_').replace(':', '');
}

/** Turns the backup CSVs into attachments, compressing them if they're too big to upload. */
function toAttachments(files) {
  const total = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  const compress = total > MAX_UPLOAD_BYTES;
  const buffers = files.map((f) => {
    const raw = Buffer.from(f.content, 'utf8');
    return compress ? { name: `${f.name}.gz`, data: gzipSync(raw) } : { name: f.name, data: raw };
  });
  if (buffers.reduce((n, b) => n + b.data.length, 0) > MAX_UPLOAD_BYTES) {
    throw new UserError('The backup is too large for Discord to deliver, so **nothing was wiped**. Ask whoever runs the bot to take a database backup on Railway first.');
  }
  return { compressed: compress, make: () => buffers.map((b) => new AttachmentBuilder(b.data, { name: b.name })) };
}

const { plural, describeCounts } = wipe;

/** The #logs announcement and the "what happened" line for the Admiral. */
function describeResult(type, wiped, admiral, logsStatus) {
  const { counts } = wiped;
  const when = `<t:${Math.floor(new Date(wiped.wipedAt).getTime() / 1000)}:f>`;
  const tag = `Wipe #${wiped.wipeId}`;
  const undo = `Undo with \`/wipe-revert\` (${tag}).`;
  if (type.kind === 'items') {
    const tickets = counts.cancelledTickets
      ? ` ${plural(counts.cancelledTickets, 'pending ticket', 'pending tickets')} for these items ${counts.cancelledTickets === 1 ? 'was' : 'were'} cancelled.`
      : '';
    const done = `Removed ${plural(counts.inventory, 'inventory record', 'inventory records')}; each removal is recorded in history as a wipe.${tickets} Everything else was left alone.`;
    return { log: `🧹 **${tag} — ${type.label} were wiped by ${admiral}** on ${when}.\n${done}`, done: `${done} ${undo}` };
  }
  if (type.kind === 'blueprints') {
    const done = `Removed ${plural(counts.blueprints, 'blueprint entry', 'blueprint entries')} from members' lists. Inventory was not touched.`;
    return { log: `🧹 **${tag} — all member blueprint lists were wiped by ${admiral}** on ${when}.\n${done}`, done: `${done} ${undo}` };
  }
  const kept = type.blueprints
    ? 'Member gamertags, the item catalog and the blueprint pool were kept.'
    : 'Member gamertags, members\' blueprint lists, the item catalog and the blueprint pool were kept.';
  const done = `Cleared: ${describeCounts(counts)}. ${kept}`;
  const head = `🧹 **${tag} — the inventory system was wiped by ${admiral}** (${type.label.toLowerCase()}) on ${when}.`;
  return {
    log: logsStatus === 'cleared'
      ? `${head} This is a fresh log; the earlier one was archived.\n${done}`
      : `${head} Messages above this line are from before the wipe.\n${done}`,
    done: `${done} ${undo}`,
  };
}

async function handleModal(interaction, type) {
  requireAdmiral(interaction);
  const typed = interaction.fields.getTextInputValue('confirm').trim();
  if (typed.toUpperCase() !== CONFIRM_WORD) {
    throw new UserError(`Nothing was wiped — you need to type **${CONFIRM_WORD}** to confirm.`);
  }
  await interaction.deferReply({ flags: EPHEMERAL });
  await members.upsertMember(interaction.member);

  const admiral = members.displayName(interaction.member);
  const now = new Date();
  const unix = Math.floor(now.getTime() / 1000);

  // Backup and wipe happen in one transaction with writes locked, so the backup is exactly
  // what gets removed. If the backup can't be delivered, the transaction rolls back.
  let dmSent = false;
  let backupSent = false;
  let wiped;
  try {
    wiped = await withTransaction(async (client) => {
      await wipe.lockForWipe(client, type);
      if ((await wipe.countTargets(client, type)) === 0) {
        throw new UserError('Nothing to wipe any more — someone may have just removed those items.');
      }
      const backup = await wipe.buildBackup(client, type, timestamp(now));
      const attachments = toAttachments(backup.files);
      const note = attachments.compressed ? ' The files are compressed (.gz) — open them with 7-Zip or similar.' : '';

      try {
        await interaction.editReply({
          content: `📦 **Backup before the wipe — ${type.label}** (${describeCounts(backup.counts)}).${note}\n`
            + 'Download these files now — this message disappears when you dismiss it or restart Discord.',
          files: attachments.make(),
        });
        backupSent = true;
      } catch (err) {
        console.error('Could not deliver the wipe backup:', err);
        throw new UserError('Couldn\'t deliver the backup files, so **nothing was wiped**. Please try again.');
      }

      // A second copy in DMs, so the backup survives this message. Optional: DMs may be closed.
      try {
        await interaction.user.send({
          content: `📦 Backup taken right before you ran **${type.label}** on <t:${unix}:f>.${note}`,
          files: attachments.make(),
        });
        dmSent = true;
      } catch {
        dmSent = false;
      }

      return wipe.performWipe(client, type, interaction.user.id);
    });
  } catch (err) {
    if (!backupSent) throw err;
    // Keep the backup message intact and report the failure separately.
    console.error('Wipe failed after the backup was sent:', err);
    await interaction.followUp({
      content: '⚠️ The wipe failed, so **nothing was deleted** — everything is still in place. Please try again later.',
      flags: EPHEMERAL,
    });
    return;
  }

  let logs;
  if (type.kind === 'full') {
    logs = await archiveLogs(interaction.guild, { date: wiped.wipedAt, reason: `Wipe #${wiped.wipeId} by ${admiral}` });
    if (logs.archive) await wipe.setWipeChannels({ query }, wiped.wipeId, { logsArchiveChannelId: logs.archive.id });
  } else {
    const id = await getChannelId('logs');
    logs = id ? { status: 'unchanged', channel: { id } } : { status: 'missing' };
  }
  const text = describeResult(type, wiped, admiral, logs.status);
  await postLog(interaction.client, text.log);

  const lines = [
    `✅ **Wipe #${wiped.wipeId} done — ${type.label}** (<t:${unix}:f>).`,
    `• ${text.done}`,
    dmSent ? '• A copy of the backup was also sent to your DMs.' : '• I couldn\'t DM you a copy of the backup (your DMs may be closed) — save the files above.',
  ];
  if (logs.status === 'cleared') {
    lines.push(`• #logs starts fresh in <#${logs.channel.id}>, and the wipe is recorded there. The old log was kept as <#${logs.archive.id}>, visible only to the ${config.admiralRoleName} role.`);
  } else if (logs.status === 'kept') {
    lines.push(`• I couldn't clear the #logs history (the bot needs **Manage Channels**), so the wipe notice was posted under the old messages in <#${logs.channel.id}>.`);
  } else if (logs.status === 'unchanged') {
    lines.push(`• The wipe is recorded in <#${logs.channel.id}>.`);
  } else {
    lines.push('• No #logs channel is set up, so the wipe wasn\'t announced. Run **/setup-server** to create it.');
  }
  await interaction.followUp({ content: lines.join('\n'), flags: EPHEMERAL });
}

/** Routes the confirmation pop-up. Returns true if handled. */
async function handleInteraction(interaction) {
  if (interaction.isModalSubmit() && interaction.customId.startsWith(SUBMIT_PREFIX)) {
    await handleModal(interaction, resolveType(interaction.customId.slice(SUBMIT_PREFIX.length)));
    return true;
  }
  return false;
}

module.exports = { data, execute, handleInteraction, buildModal };
