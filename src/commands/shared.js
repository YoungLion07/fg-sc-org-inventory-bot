'use strict';

// Pieces shared by several commands: the System -> Planet -> Location Type -> Location
// option cascade, the holdings picker, and plain-language formatting.

const catalog = require('../services/catalog');
const { UserError } = require('../lib/errors');
const { toChoices } = require('../lib/discord');

const NONE = '__none__';

function hint(text) {
  return [{ name: text, value: NONE }];
}

/** Adds system/planet/location_type/location options (optionally with a name prefix). */
function addLocationOptions(builder, { prefix = '', required = true, label = '' } = {}) {
  const pre = label ? `${label} ` : '';
  return builder
    .addStringOption((o) => o.setName(`${prefix}system`).setDescription(`${pre}Star system`)
      .setRequired(required).setAutocomplete(true))
    .addStringOption((o) => o.setName(`${prefix}planet`).setDescription(`${pre}Planet it's at or orbiting ("No Planet" if none)`)
      .setRequired(required).setAutocomplete(true))
    .addStringOption((o) => o.setName(`${prefix}location_type`).setDescription(`${pre}Station, city, outpost...`)
      .setRequired(required).setAutocomplete(true))
    .addStringOption((o) => o.setName(`${prefix}location`).setDescription(`${pre}Exact location`)
      .setRequired(required).setAutocomplete(true));
}

/**
 * Handles autocomplete for the location cascade. Returns true if the focused option was
 * one of them. Each step narrows by whatever earlier steps are already filled in.
 */
async function autocompleteLocation(interaction, focused, prefix = '') {
  const name = focused.name.startsWith(prefix) ? focused.name.slice(prefix.length) : null;
  if (!['system', 'planet', 'location_type', 'location'].includes(name)) return false;

  const opt = (n) => {
    const v = interaction.options.getString(`${prefix}${n}`);
    return v && v !== NONE ? v : null;
  };
  const systemId = opt('system');
  const planetId = opt('planet');
  const typeId = opt('location_type');
  let rows;

  if (name === 'system') rows = await catalog.searchSystems(focused.value);
  if (name === 'planet') rows = await catalog.searchPlanets(focused.value, systemId);
  if (name === 'location_type') {
    rows = await catalog.searchLocationTypes(focused.value, systemId, planetId);
    if (!rows.length) {
      await interaction.respond(hint('No locations on record for that planet — try another planet or "No Planet"'));
      return true;
    }
  }
  if (name === 'location') {
    rows = await catalog.searchLocations(focused.value, { systemId, planetId, locationTypeId: typeId });
    if (!rows.length) {
      await interaction.respond(hint('No matching locations — adjust the system, planet, or location type'));
      return true;
    }
  }
  await interaction.respond(toChoices(rows));
  return true;
}

/**
 * Validates the location cascade and returns the full location row.
 * Returns null when every location option is empty and `required` is false.
 */
async function resolveLocation(interaction, { prefix = '', required = true } = {}) {
  const get = (n) => {
    const v = interaction.options.getString(`${prefix}${n}`);
    return v && v !== NONE ? v : null;
  };
  const systemId = get('system');
  const planetId = get('planet');
  const typeId = get('location_type');
  const locationId = get('location');

  if (!systemId && !planetId && !typeId && !locationId) {
    if (required) throw new UserError('Please pick a location.');
    return null;
  }
  if (!locationId) {
    throw new UserError('You started picking a new location but didn\'t choose the exact location. Pick one from the list, or leave all location fields empty to keep it where it is.');
  }

  if (systemId) {
    const system = await catalog.getSystem(systemId);
    if (!system || system.status !== 'Live') throw new UserError('Please pick the system from the suggestion list.');
  }
  if (planetId) {
    const planet = await catalog.getPlanet(planetId);
    if (!planet) throw new UserError('Please pick the planet from the suggestion list.');
    if (systemId && planet.parent_system_id && planet.parent_system_id !== systemId) {
      throw new UserError(`${planet.name} isn't in the system you picked.`);
    }
  }
  if (typeId) {
    const type = await catalog.getLocationType(typeId);
    if (!type) throw new UserError('Please pick the location type from the suggestion list.');
    if (systemId && type.parent_system_id !== systemId) {
      throw new UserError('That location type doesn\'t belong to the system you picked.');
    }
  }

  const loc = await catalog.getLocation(locationId);
  if (!loc || loc.system_status !== 'Live') throw new UserError('Please pick the location from the suggestion list.');
  if (systemId && loc.system_id !== systemId) throw new UserError(`${loc.name} is in ${loc.system_name}, not the system you picked.`);
  if (planetId && loc.parent_planet_id !== planetId) {
    throw new UserError(`${loc.name} isn't listed under the planet you picked (it's under ${loc.planet_name}).`);
  }
  if (typeId && loc.parent_location_type_id !== typeId) {
    throw new UserError(`${loc.name} is a ${loc.location_type_name}, not the location type you picked.`);
  }
  return loc;
}

/** Autocomplete for a "record" option: only what the chosen owner actually holds. */
async function autocompleteHoldings(interaction, focused, ownerOption = 'owner') {
  const ownerId = interaction.options.get(ownerOption)?.value;
  if (!ownerId) {
    await interaction.respond(hint('Pick the owner first, then come back to this field'));
    return;
  }
  const rows = await catalog.searchHoldings(ownerId, focused.value);
  if (!rows.length) {
    await interaction.respond(hint(focused.value ? 'No matching items for this owner' : 'This member has no items on record'));
    return;
  }
  await interaction.respond(toChoices(rows));
}

/** Validates a "record" option value against the chosen owner. */
async function resolveHolding(recordValue, ownerId) {
  if (!recordValue || !/^\d+$/.test(recordValue)) {
    throw new UserError('Please pick the item from the suggestion list (it only shows what that member actually holds).');
  }
  const holding = await catalog.getHolding(recordValue);
  if (!holding) throw new UserError('That record no longer exists — it may have just been removed or moved.');
  if (String(holding.owner_member_id) !== String(ownerId)) {
    throw new UserError('That item isn\'t held by the owner you picked. Pick the owner first, then the item.');
  }
  return holding;
}

/** "40 SCU Titanium" / "3× Gladius" */
function formatAmount(quantity, unit, itemName) {
  const q = catalog.formatQuantity(quantity);
  if (!unit || unit === 'each' || unit === 'unit') return `${q}× ${itemName}`;
  return `${q} ${unit} ${itemName}`;
}

function qualityText(reading, tier) {
  if (!reading) return '';
  return tier ? ` (${tier === 'Perfect' ? 'Perfect' : `${tier}-tier`}, ${reading})` : ` (quality ${reading}, tier unknown)`;
}

function noteText(note) {
  return note ? ` — "${note}"` : '';
}

module.exports = {
  NONE,
  addLocationOptions,
  autocompleteLocation,
  resolveLocation,
  autocompleteHoldings,
  resolveHolding,
  formatAmount,
  qualityText,
  noteText,
};
