'use strict';

// Read-only lookups over the catalog, locations pool, and current holdings.
// Used by autocomplete (search*) and by final validation before anything is committed (get*).

const { query } = require('../db');

const LIMIT = 25; // Discord's maximum number of autocomplete suggestions

function likePattern(text) {
  const escaped = String(text || '').trim().replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${escaped}%`;
}

function formatQuantity(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

// ---------------------------------------------------------------------------
// Categories & items
// ---------------------------------------------------------------------------

async function searchSubcategories(text) {
  const { rows } = await query(
    `SELECT s.subcategory_id AS id, c.name || ' › ' || s.name AS label
       FROM subcategories s JOIN categories c ON c.category_id = s.parent_category_id
      WHERE (c.name || ' ' || s.name) ILIKE $1
      ORDER BY c.category_id, s.subcategory_id
      LIMIT ${LIMIT}`,
    [likePattern(text)],
  );
  return rows;
}

async function getSubcategory(id) {
  const { rows } = await query(
    `SELECT s.*, c.name AS category_name
       FROM subcategories s JOIN categories c ON c.category_id = s.parent_category_id
      WHERE s.subcategory_id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function searchItems(text, subcategoryId) {
  const { rows } = await query(
    `SELECT i.item_id AS id,
            i.name || COALESCE(' (' || i.manufacturer || ')', '') || ' · ' || s.name AS label
       FROM items i JOIN subcategories s ON s.subcategory_id = i.subcategory_id
      WHERE i.name ILIKE $1
        AND ($2::text IS NULL OR i.subcategory_id = $2)
      ORDER BY i.name
      LIMIT ${LIMIT}`,
    [likePattern(text), subcategoryId || null],
  );
  return rows;
}

async function getItem(id) {
  const { rows } = await query(
    `SELECT i.*, s.name AS subcategory_name, c.name AS category_name,
            q.item_id IS NOT NULL AS has_quality,
            q.tier_f_min, q.tier_e_min, q.tier_d_min, q.tier_c_min,
            q.tier_b_min, q.tier_a_min, q.tier_s_min, q.tier_perfect
       FROM items i
       JOIN subcategories s ON s.subcategory_id = i.subcategory_id
       JOIN categories c ON c.category_id = s.parent_category_id
       LEFT JOIN ore_mineral_quality q ON q.item_id = i.item_id
      WHERE i.item_id = $1`,
    [id],
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Locations pool: System -> Planet -> Location Type -> Location
// ---------------------------------------------------------------------------

async function searchSystems(text) {
  const { rows } = await query(
    `SELECT system_id AS id, name AS label FROM systems
      WHERE status = 'Live' AND name ILIKE $1
      ORDER BY system_id LIMIT ${LIMIT}`,
    [likePattern(text)],
  );
  return rows;
}

async function getSystem(id) {
  const { rows } = await query(`SELECT * FROM systems WHERE system_id = $1`, [id]);
  return rows[0] || null;
}

async function searchPlanets(text, systemId) {
  const { rows } = await query(
    `SELECT p.planet_id AS id,
            CASE WHEN p.parent_system_id IS NULL THEN p.name ELSE p.name || ' · ' || s.name END AS label
       FROM planets p LEFT JOIN systems s ON s.system_id = p.parent_system_id
      WHERE p.name ILIKE $1
        AND (p.parent_system_id IS NULL
             OR (s.status = 'Live' AND ($2::text IS NULL OR p.parent_system_id = $2)))
      ORDER BY (p.parent_system_id IS NULL), p.parent_system_id, p.planet_id
      LIMIT ${LIMIT}`,
    [likePattern(text), systemId || null],
  );
  return rows;
}

async function getPlanet(id) {
  const { rows } = await query(`SELECT * FROM planets WHERE planet_id = $1`, [id]);
  return rows[0] || null;
}

// Only offers location types that actually have at least one location for the chosen
// system/planet, so an officer never lands on an empty dropdown at the next step.
async function searchLocationTypes(text, systemId, planetId) {
  const { rows } = await query(
    `SELECT lt.location_type_id AS id, lt.name || ' · ' || s.name AS label
       FROM location_types lt JOIN systems s ON s.system_id = lt.parent_system_id
      WHERE lt.name ILIKE $1
        AND s.status = 'Live'
        AND ($2::text IS NULL OR lt.parent_system_id = $2)
        AND EXISTS (SELECT 1 FROM locations l
                     WHERE l.parent_location_type_id = lt.location_type_id
                       AND ($3::text IS NULL OR l.parent_planet_id = $3))
      ORDER BY lt.location_type_id
      LIMIT ${LIMIT}`,
    [likePattern(text), systemId || null, planetId || null],
  );
  return rows;
}

async function getLocationType(id) {
  const { rows } = await query(`SELECT * FROM location_types WHERE location_type_id = $1`, [id]);
  return rows[0] || null;
}

async function searchLocations(text, { systemId, planetId, locationTypeId } = {}) {
  const { rows } = await query(
    `SELECT l.location_id AS id,
            l.name || ' · ' || lt.name || COALESCE(' · ' || NULLIF(l.planet_or_body, ''), '') AS label
       FROM locations l
       JOIN location_types lt ON lt.location_type_id = l.parent_location_type_id
       JOIN systems s ON s.system_id = lt.parent_system_id
      WHERE l.name ILIKE $1
        AND s.status = 'Live'
        AND ($2::text IS NULL OR lt.parent_system_id = $2)
        AND ($3::text IS NULL OR l.parent_planet_id = $3)
        AND ($4::text IS NULL OR l.parent_location_type_id = $4)
      ORDER BY l.name
      LIMIT ${LIMIT}`,
    [likePattern(text), systemId || null, planetId || null, locationTypeId || null],
  );
  return rows;
}

async function getLocation(id) {
  const { rows } = await query(
    `SELECT l.*, lt.name AS location_type_name, lt.parent_system_id AS system_id,
            s.name AS system_name, s.status AS system_status, p.name AS planet_name
       FROM locations l
       JOIN location_types lt ON lt.location_type_id = l.parent_location_type_id
       JOIN systems s ON s.system_id = lt.parent_system_id
       JOIN planets p ON p.planet_id = l.parent_planet_id
      WHERE l.location_id = $1`,
    [id],
  );
  return rows[0] || null;
}

function describeLocation(loc) {
  const planet = loc.parent_planet_id === 'PLNONE' ? null : loc.planet_name;
  return [loc.name, planet, loc.system_name].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// Current holdings (what's actually in the pool, not the catalog)
// ---------------------------------------------------------------------------

const HOLDING_SELECT = `
  SELECT inv.*, i.name AS item_name, i.unit, l.name AS location_name,
         l.parent_planet_id, p.name AS planet_name, s.name AS system_name,
         m.discord_username AS owner_name
    FROM inventory inv
    JOIN items i ON i.item_id = inv.item_id
    JOIN locations l ON l.location_id = inv.location_id
    JOIN location_types lt ON lt.location_type_id = l.parent_location_type_id
    JOIN systems s ON s.system_id = lt.parent_system_id
    JOIN planets p ON p.planet_id = l.parent_planet_id
    JOIN members m ON m.member_id = inv.owner_member_id`;

function holdingLabel(h) {
  const tier = h.quality_tier ? ` [${h.quality_tier}]` : '';
  const q = formatQuantity(h.quantity);
  const amount = !h.unit || h.unit === 'each' || h.unit === 'unit' ? `${q}× ${h.item_name}` : `${q} ${h.unit} ${h.item_name}`;
  return `${amount}${tier} · ${h.location_name} · ${h.designation}`;
}

async function searchHoldings(ownerId, text) {
  const { rows } = await query(
    `${HOLDING_SELECT}
      WHERE inv.owner_member_id = $1 AND inv.quantity > 0
        AND (i.name || ' ' || l.name) ILIKE $2
      ORDER BY i.name, l.name
      LIMIT ${LIMIT}`,
    [ownerId, likePattern(text)],
  );
  return rows.map((h) => ({ id: String(h.id), label: holdingLabel(h) }));
}

async function getHolding(id, client = null) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(`${HOLDING_SELECT} WHERE inv.id = $1`, [id]);
  return rows[0] || null;
}

/** The existing record a transfer/add would merge into, if any (for previews only). */
async function findMergeTarget({ itemId, ownerId, designation, locationId, qualityReading }) {
  const { rows } = await query(
    `SELECT id, quantity FROM inventory
      WHERE item_id = $1 AND owner_member_id = $2 AND designation = $3 AND location_id = $4
        AND quality_reading IS NOT DISTINCT FROM $5::integer`,
    [itemId, ownerId, designation, locationId, qualityReading ?? null],
  );
  return rows[0] || null;
}

module.exports = {
  findMergeTarget,
  formatQuantity,
  searchSubcategories,
  getSubcategory,
  searchItems,
  getItem,
  searchSystems,
  getSystem,
  searchPlanets,
  getPlanet,
  searchLocationTypes,
  getLocationType,
  searchLocations,
  getLocation,
  describeLocation,
  searchHoldings,
  getHolding,
  holdingLabel,
};
