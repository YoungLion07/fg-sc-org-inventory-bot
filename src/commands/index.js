'use strict';

const addItem = require('./addItem');
const removeItem = require('./removeItem');
const transferItem = require('./transferItem');
const setupServer = require('./setupServer');
const setHandle = require('./setHandle');
const blueprint = require('./blueprint');
const wipeInventory = require('./wipeInventory');
const wipeRevert = require('./wipeRevert');
const wipeHistory = require('./wipeHistory');

const all = [setupServer, addItem, removeItem, transferItem, setHandle, blueprint, wipeInventory, wipeRevert, wipeHistory];

const byName = new Map(all.map((c) => [c.data.name, c]));

module.exports = { all, byName };
