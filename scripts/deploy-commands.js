'use strict';

// Registers the slash commands with your Discord server. Safe to run on every deploy.

const { REST, Routes } = require('discord.js');
const { config, requireConfig } = require('../src/config');
const commands = require('../src/commands');

async function deployCommands() {
  const body = commands.all.map((c) => c.data.toJSON());
  const rest = new REST().setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
  return body.map((c) => `/${c.name}`);
}

if (require.main === module) {
  requireConfig(['token', 'clientId', 'guildId']);
  deployCommands()
    .then((names) => console.log(`Registered ${names.length} commands: ${names.join(', ')}`))
    .catch((err) => {
      console.error('Registering commands failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { deployCommands };
