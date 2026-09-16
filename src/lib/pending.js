'use strict';

// Short-lived store for "are you sure?" prompts. The Confirm/Cancel buttons carry only an
// ID; the validated action waits here until the same officer clicks one of them.

const crypto = require('crypto');
const { config } = require('../config');

const store = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id);
  }
}

function createPending(userId, action) {
  sweep();
  const id = crypto.randomBytes(8).toString('hex');
  store.set(id, { userId, action, expiresAt: Date.now() + config.pendingActionTtlMs });
  return id;
}

/** Removes and returns the pending action, or null if it expired / never existed. */
function takePending(id) {
  sweep();
  const entry = store.get(id);
  if (!entry) return null;
  store.delete(id);
  return entry;
}

function peekPending(id) {
  sweep();
  return store.get(id) || null;
}

module.exports = { createPending, takePending, peekPending };
