'use strict';

const { Client, Events, GatewayIntentBits } = require('discord.js');
const { config, requireConfig } = require('./config');
const { closePool } = require('./db');
const commands = require('./commands');
const members = require('./services/members');
const { peekPending, takePending } = require('./lib/pending');
const { UserError } = require('./lib/errors');
const { EPHEMERAL, replyWithError } = require('./lib/discord');

requireConfig(['token', 'guildId', 'databaseUrl']);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: must be enabled in the Developer Portal
  ],
});

function isOurGuild(guildId) {
  return guildId === config.guildId;
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    const guild = await c.guilds.fetch(config.guildId);
    const result = await members.syncAllMembers(guild);
    console.log(`Roster synced: ${result.active} active members, ${result.deactivated} marked inactive.`);
  } catch (err) {
    console.error('Initial roster sync failed (is the Server Members Intent enabled?):', err);
  }
});

// Keep the roster in step with role changes, joins, and leaves.
client.on(Events.GuildMemberUpdate, (_old, member) => {
  if (!isOurGuild(member.guild.id)) return;
  members.syncMember(member).catch((err) => console.error('Member sync failed:', err));
});
client.on(Events.GuildMemberAdd, (member) => {
  if (!isOurGuild(member.guild.id)) return;
  members.syncMember(member).catch((err) => console.error('Member sync failed:', err));
});
client.on(Events.GuildMemberRemove, (member) => {
  if (!isOurGuild(member.guild.id)) return;
  members.deactivateMember(member.id).catch((err) => console.error('Member deactivate failed:', err));
});

async function handleButton(interaction) {
  const [kind, pendingId] = interaction.customId.split(':');
  if (kind !== 'confirm' && kind !== 'cancel') return;

  const entry = peekPending(pendingId);
  if (!entry) {
    await interaction.update({
      content: '⌛ This confirmation expired or was already used — nothing was changed. Run the command again.',
      embeds: [],
      components: [],
    });
    return;
  }
  if (entry.userId !== interaction.user.id) {
    throw new UserError('Only the officer who started this action can confirm or cancel it.');
  }
  takePending(pendingId); // one use only, so a double-click can't apply the change twice

  if (kind === 'cancel') {
    await interaction.update({ content: 'Cancelled — nothing was changed.', embeds: [], components: [] });
    return;
  }

  const command = commands.byName.get(entry.action.command);
  await interaction.deferUpdate();
  await command.confirm(interaction, entry.action);
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      if (!isOurGuild(interaction.guildId)) return;
      const command = commands.byName.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
    } catch (err) {
      console.error(`Autocomplete failed for /${interaction.commandName}:`, err);
      if (!interaction.responded) await interaction.respond([]).catch(() => {});
    }
    return;
  }

  try {
    if (!interaction.inGuild() || !isOurGuild(interaction.guildId)) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'This bot only works inside the org\'s Discord server.', flags: EPHEMERAL });
      }
      return;
    }
    if (interaction.isChatInputCommand()) {
      const command = commands.byName.get(interaction.commandName);
      if (!command) throw new UserError('Unknown command — it may have been removed. Try again in a minute.');
      await command.execute(interaction);
      return;
    }
    if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (err) {
    await replyWithError(interaction, err);
  }
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  await client.destroy().catch(() => {});
  await closePool().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection:', err));

client.login(config.token).catch((err) => {
  console.error('Could not log in to Discord. Check DISCORD_TOKEN, and that the Server Members Intent is enabled for the bot:', err.message);
  closePool().finally(() => process.exit(1));
});
