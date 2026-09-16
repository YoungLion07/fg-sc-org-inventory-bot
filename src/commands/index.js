'use strict';

const addItem = require('./addItem');
const removeItem = require('./removeItem');
const transferItem = require('./transferItem');
const setupServer = require('./setupServer');
const setHandle = require('./setHandle');

const all = [setupServer, addItem, removeItem, transferItem, setHandle];

const byName = new Map(all.map((c) => [c.data.name, c]));

module.exports = { all, byName };
