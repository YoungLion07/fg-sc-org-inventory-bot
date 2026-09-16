'use strict';

// Blueprint pool lookups and the member blueprint registry ("who knows which blueprint").

const { query } = require('../db');

const LIMIT = 25;

function likePattern(text) {
  const escaped = String(text || '').trim().replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${escaped}%`;
}

/** "Arrowhead Sniper Rifle", "JS-400 · S2 · Grade 1" */
function blueprintLabel(b, { withCategory = true } = {}) {
  const bits = [b.name];
  if (b.size !== null && b.size !== undefined && b.size !== '') bits.push(`S${b.size}`);
  if (b.grade && b.subcategory_id && b.subcategory_id.startsWith('BS2')) bits.push(`Grade ${b.grade}`);
  if (withCategory && b.subcategory_name) bits.push(b.subcategory_name);
  // A few names repeat in the game data (e.g. the same cooler for two ships) - show the game key to tell them apart.
  if (Number(b.dupes) > 1) bits.push(b.game_key);
  return bits.join(' · ');
}

const SELECT = `
  SELECT b.*, s.name AS subcategory_name, c.name AS category_name,
         (SELECT count(*) FROM blueprints b2
           WHERE b2.name = b.name AND b2.subcategory_id = b.subcategory_id
             AND b2.size IS NOT DISTINCT FROM b.size) AS dupes
    FROM blueprints b
    JOIN blueprint_subcategories s ON s.subcategory_id = b.subcategory_id
    JOIN blueprint_categories c ON c.category_id = s.parent_category_id`;

async function searchSubcategories(text) {
  const { rows } = await query(
    `SELECT s.subcategory_id AS id, c.name || ' › ' || s.name AS label
       FROM blueprint_subcategories s
       JOIN blueprint_categories c ON c.category_id = s.parent_category_id
      WHERE (c.name || ' ' || s.name) ILIKE $1
      ORDER BY s.subcategory_id
      LIMIT ${LIMIT}`,
    [likePattern(text)],
  );
  return rows;
}

async function getSubcategory(id) {
  const { rows } = await query(`SELECT * FROM blueprint_subcategories WHERE subcategory_id = $1`, [id]);
  return rows[0] || null;
}

/** Search the whole pool, optionally within one subcategory. */
async function searchBlueprints(text, subcategoryId = null) {
  const { rows } = await query(
    `${SELECT}
      WHERE b.name ILIKE $1
        AND ($2::text IS NULL OR b.subcategory_id = $2)
      ORDER BY b.name, b.size NULLS FIRST, b.blueprint_id
      LIMIT ${LIMIT}`,
    [likePattern(text), subcategoryId || null],
  );
  return rows.map((b) => ({ id: b.blueprint_id, label: blueprintLabel(b) }));
}

/** Search only the blueprints this member has registered. */
async function searchMemberBlueprints(memberId, text) {
  const { rows } = await query(
    `${SELECT}
       JOIN member_blueprints mb ON mb.blueprint_id = b.blueprint_id
      WHERE mb.member_id = $1 AND b.name ILIKE $2
      ORDER BY b.name, b.size NULLS FIRST
      LIMIT ${LIMIT}`,
    [memberId, likePattern(text)],
  );
  return rows.map((b) => ({ id: b.blueprint_id, label: blueprintLabel(b) }));
}

async function getBlueprint(id) {
  const { rows } = await query(`${SELECT} WHERE b.blueprint_id = $1`, [id]);
  return rows[0] || null;
}

/** Returns true if newly added, false if the member already had it. */
async function addMemberBlueprint(memberId, blueprintId) {
  const { rowCount } = await query(
    `INSERT INTO member_blueprints (member_id, blueprint_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [memberId, blueprintId],
  );
  return rowCount > 0;
}

/** Returns true if removed, false if the member didn't have it. */
async function removeMemberBlueprint(memberId, blueprintId) {
  const { rowCount } = await query(
    `DELETE FROM member_blueprints WHERE member_id = $1 AND blueprint_id = $2`,
    [memberId, blueprintId],
  );
  return rowCount > 0;
}

async function listMemberBlueprints(memberId) {
  const { rows } = await query(
    `${SELECT}
       JOIN member_blueprints mb ON mb.blueprint_id = b.blueprint_id
      WHERE mb.member_id = $1
      ORDER BY c.category_id, s.subcategory_id, b.name, b.size NULLS FIRST`,
    [memberId],
  );
  return rows;
}

/** Active org members who have this blueprint. */
async function whoHas(blueprintId) {
  const { rows } = await query(
    `SELECT m.member_id, m.discord_username, m.rsi_handle, mb.added_at
       FROM member_blueprints mb
       JOIN members m ON m.member_id = mb.member_id
      WHERE mb.blueprint_id = $1 AND m.active = true
      ORDER BY lower(m.discord_username)`,
    [blueprintId],
  );
  return rows;
}

module.exports = {
  blueprintLabel,
  searchSubcategories,
  getSubcategory,
  searchBlueprints,
  searchMemberBlueprints,
  getBlueprint,
  addMemberBlueprint,
  removeMemberBlueprint,
  listMemberBlueprints,
  whoHas,
};
