'use strict';

// Posts one plain-language line per change to #logs. Mentions are disabled on purpose:
// the log should name people without pinging them every time something is recorded.

const { getChannelId } = require('./settings');

async function postLog(client, text) {
  try {
    const channelId = await getChannelId('logs');
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    await channel.send({ content: text, allowedMentions: { parse: [] } });
  } catch (err) {
    // A failed log post must never undo or block an inventory change that already committed.
    console.error('Could not post to #logs:', err);
  }
}

module.exports = { postLog };
