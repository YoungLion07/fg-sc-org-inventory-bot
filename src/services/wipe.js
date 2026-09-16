'use strict';

// Resets after a Star Citizen wipe. Three kinds of wipe:
//  - items:      one group of items (e.g. only ores). The stock is removed and each removed
//                record is written to history as a 'wipe' entry; history and #logs are kept.
//                Pending tickets for those items are cancelled.
//  - full:       all inventory, its history and all tickets (optionally every member's
//                blueprint list too). #logs is swapped for a fresh channel by the command.
//  - blueprints: only members' blueprint lists.
// Always kept: members + gamertags, the item/location catalog, the blueprint pool, settings.
//
// Nothing is deleted for good: removed rows are moved into archived_* tables under a numbered
// row in `wipes` (with its date), so /wipe-revert can put them back.

const { toCsv } = require('../lib/csv');

// Category IDs come from db/seed-data.json and never change.
const ORE = 'EXISTS (SELECT 1 FROM ore_mineral_quality q WHERE q.item_id = i.item_id)';
const inCategory = (id) => `sc.parent_category_id = '${id}'`;

const TYPES = {
  ores: { kind: 'items', label: 'Ores & minerals', filter: ORE, hint: 'mined materials that have a quality reading' },
  commodities: { kind: 'items', label: 'Other commodities', filter: `${inCategory('C5')} AND NOT ${ORE}`, hint: 'gases, processed goods, medical supplies, scrap, fuel…' },
  components: { kind: 'items', label: 'Ship components', filter: inCategory('C2'), hint: 'power plants, shields, quantum drives, ship weapons…' },
  ships: { kind: 'items', label: 'Ships & vehicles', filter: inCategory('C1') },
  fps: { kind: 'items', label: 'FPS weapons', filter: inCategory('C3'), hint: 'guns, grenades, melee, attachments' },
  armor: { kind: 'items', label: 'Armor & clothing', filter: inCategory('C4') },
  tools: { kind: 'items', label: 'Tools, gadgets & consumables', filter: inCategory('C6') },
  full: { kind: 'full', label: 'Full wipe (keep blueprints)', blueprints: false, hint: 'all inventory, history, tickets and #logs' },
  full_blueprints: { kind: 'full', label: 'Full wipe + blueprints', blueprints: true, hint: 'everything, including members\' blueprint lists' },
  blueprints: { kind: 'blueprints', label: 'Blueprints only', hint: 'members\' blueprint lists; inventory untouched' },
};

// Order shown in the Discord option list.
const TYPE_CHOICES = [
  'ores', 'components', 'commodities', 'ships', 'fps', 'armor', 'tools', 'full', 'full_blueprints', 'blueprints',
].map((value) => {
  const { label, hint } = TYPES[value];
  return { value, name: (hint ? `${label} — ${hint}` : label).slice(0, 100) };
});

function getType(value) {
  const type = TYPES[value];
  return type ? { value, ...type } : null;
}

const itemSet = (filter) => `
  SELECT i.item_id FROM items i
    JOIN subcategories sc ON sc.subcategory_id = i.subcategory_id
   WHERE ${filter}`;

const LOCATION_JOINS = (alias) => `
  JOIN locations l ON l.location_id = ${alias}.location_id
  JOIN location_types lt ON lt.location_type_id = l.parent_location_type_id
  JOIN systems s ON s.system_id = lt.parent_system_id
  JOIN planets p ON p.planet_id = l.parent_planet_id`;
const PLANET = `CASE WHEN p.planet_id = 'PLNONE' THEN NULL ELSE p.name END`;

const BACKUPS = {
  inventory: {
    sql: (where) => `
      SELECT inv.id AS record_id, c.name AS category, sc.name AS subcategory, i.name AS item, i.unit,
             inv.quantity, inv.quality_reading, inv.quality_tier, inv.designation,
             o.discord_username AS owner, o.rsi_handle AS owner_gamertag, inv.owner_member_id AS owner_discord_id,
             s.name AS system, ${PLANET} AS planet, lt.name AS location_type, l.name AS location,
             lb.discord_username AS logged_by, inv.logged_at, inv.item_id, inv.location_id
        FROM inventory inv
        JOIN items i ON i.item_id = inv.item_id
        JOIN subcategories sc ON sc.subcategory_id = i.subcategory_id
        JOIN categories c ON c.category_id = sc.parent_category_id
        JOIN members o ON o.member_id = inv.owner_member_id
        JOIN members lb ON lb.member_id = inv.logged_by
        ${LOCATION_JOINS('inv')}
       ${where ? `WHERE inv.item_id IN (${itemSet(where)})` : ''}
       ORDER BY c.name, sc.name, i.name, o.discord_username, inv.id`,
    columns: ['record_id', 'category', 'subcategory', 'item', 'unit', 'quantity', 'quality_reading', 'quality_tier',
      'designation', 'owner', 'owner_gamertag', 'owner_discord_id', 'system', 'planet', 'location_type', 'location',
      'logged_by', 'logged_at', 'item_id', 'location_id'],
  },
  history: {
    sql: () => `
      SELECT t.id, t."timestamp", a.discord_username AS officer, t.action_type, i.name AS item, i.unit,
             t.quantity_delta, t.quality_reading, t.quality_tier,
             o.discord_username AS owner, o.rsi_handle AS owner_gamertag, t.designation,
             s.name AS system, ${PLANET} AS planet, l.name AS location,
             t.transfer_group_id, t.request_id, t.note, t.actor_id, t.owner_member_id, t.item_id, t.location_id
        FROM transactions t
        JOIN items i ON i.item_id = t.item_id
        JOIN members a ON a.member_id = t.actor_id
        JOIN members o ON o.member_id = t.owner_member_id
        ${LOCATION_JOINS('t')}
       ORDER BY t."timestamp", t.id`,
    columns: ['id', 'timestamp', 'officer', 'action_type', 'item', 'unit', 'quantity_delta', 'quality_reading',
      'quality_tier', 'owner', 'owner_gamertag', 'designation', 'system', 'planet', 'location',
      'transfer_group_id', 'request_id', 'note', 'actor_id', 'owner_member_id', 'item_id', 'location_id'],
  },
  blueprints: {
    sql: () => `
      SELECT m.discord_username AS member, m.rsi_handle AS gamertag, mb.member_id,
             bc.name AS category, bs.name AS subcategory, b.name AS blueprint, b.size, b.grade,
             b.game_key, mb.blueprint_id, mb.added_at
        FROM member_blueprints mb
        JOIN members m ON m.member_id = mb.member_id
        JOIN blueprints b ON b.blueprint_id = mb.blueprint_id
        JOIN blueprint_subcategories bs ON bs.subcategory_id = b.subcategory_id
        JOIN blueprint_categories bc ON bc.category_id = bs.parent_category_id
       ORDER BY m.discord_username, bc.name, bs.name, b.name`,
    columns: ['member', 'gamertag', 'member_id', 'category', 'subcategory', 'blueprint', 'size', 'grade',
      'game_key', 'blueprint_id', 'added_at'],
  },
  tickets: {
    sql: () => 'SELECT * FROM requests ORDER BY id',
    columns: ['id', 'created_at', 'requester_member_id', 'request_type', 'item_id', 'quantity', 'quality_reading',
      'source_inventory_id', 'source_owner_member_id', 'source_location_id', 'source_designation',
      'destination_owner_member_id', 'destination_location_id', 'destination_designation', 'note', 'status',
      'reviewed_by', 'reviewed_at', 'rejection_reason', 'transfer_group_id', 'message_id'],
  },
};

function backupParts(type) {
  if (type.kind === 'items') return ['inventory'];
  if (type.kind === 'blueprints') return ['blueprints'];
  return type.blueprints ? ['inventory', 'history', 'blueprints', 'tickets'] : ['inventory', 'history', 'tickets'];
}

function tablesFor(type) {
  if (type.kind === 'items') return ['inventory', 'transactions', 'requests'];
  if (type.kind === 'blueprints') return ['member_blueprints'];
  return type.blueprints
    ? ['inventory', 'transactions', 'requests', 'member_blueprints']
    : ['inventory', 'transactions', 'requests'];
}

/** How many rows this wipe would remove (used to refuse a wipe that has nothing to do). */
async function countTargets(db, type) {
  if (type.kind === 'items') {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM inventory WHERE item_id IN (${itemSet(type.filter)})`);
    return rows[0].n;
  }
  if (type.kind === 'blueprints') {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM member_blueprints');
    return rows[0].n;
  }
  return null; // a full wipe always runs (it also resets #logs)
}

/**
 * Locks the affected tables against writes (reads still work) so nothing can change
 * between the backup and the wipe. Must run inside a transaction.
 */
async function lockForWipe(client, type) {
  await client.query(`LOCK TABLE ${tablesFor(type).join(', ')} IN EXCLUSIVE MODE`);
}

/** Builds the backup CSVs. Returns { files: [{name, content, rows}], counts: {part: rows} }. */
async function buildBackup(client, type, stamp) {
  const files = [];
  const counts = {};
  const where = type.kind === 'items' ? type.filter : null;
  for (const part of backupParts(type)) {
    const { sql, columns } = BACKUPS[part];
    const { rows } = await client.query(sql(where));
    counts[part] = rows.length;
    files.push({ name: `backup-${stamp}-${type.value}-${part}.csv`, content: toCsv(rows, columns), rows: rows.length });
  }
  return { files, counts };
}


// ---------------------------------------------------------------------------
// Wipe and revert
// ---------------------------------------------------------------------------

// Explicit column lists, so archive tables keep working if the live tables gain columns later.
const COLS = {
  inventory: 'id, item_id, owner_member_id, designation, quantity, location_id, quality_reading, quality_tier, logged_by, logged_at',
  transactions: 'id, "timestamp", actor_id, action_type, item_id, owner_member_id, designation, location_id, quantity_delta, quality_reading, quality_tier, transfer_group_id, request_id, note',
  requests: 'id, requester_member_id, request_type, item_id, quantity, quality_reading, source_inventory_id, source_owner_member_id, source_location_id, source_designation, destination_owner_member_id, destination_location_id, destination_designation, note, status, reviewed_by, reviewed_at, rejection_reason, transfer_group_id, message_id, created_at',
  member_blueprints: 'member_id, blueprint_id, added_at',
};
const withoutId = (cols) => cols.split(', ').filter((c) => c !== 'id').join(', ');

async function archive(client, table, wipeId, where = '', params = []) {
  const { rowCount } = await client.query(
    `INSERT INTO archived_${table} (wipe_id, ${COLS[table]})
     SELECT $1, ${COLS[table]} FROM ${table} ${where}`,
    [wipeId, ...params],
  );
  return rowCount;
}

const wipeNote = (wipeId, type) => `Game wipe #${wipeId}: ${type.label}`;

/**
 * Performs the wipe: records it in `wipes`, moves the affected rows into the archive, and
 * removes them from the live tables. Returns { wipeId, wipedAt, counts }.
 */
async function performWipe(client, type, actorId) {
  const { rows: [w] } = await client.query(
    'INSERT INTO wipes (wipe_type, wiped_by) VALUES ($1, $2) RETURNING wipe_id, wiped_at',
    [type.value, actorId],
  );
  const wipeId = w.wipe_id;
  const counts = {};

  if (type.kind === 'blueprints') {
    counts.blueprints = await archive(client, 'member_blueprints', wipeId);
    await client.query('DELETE FROM member_blueprints');
  } else if (type.kind === 'full') {
    counts.inventory = await archive(client, 'inventory', wipeId);
    counts.history = await archive(client, 'transactions', wipeId);
    counts.tickets = await archive(client, 'requests', wipeId);
    const tables = ['inventory', 'transactions', 'requests'];
    if (type.blueprints) {
      counts.blueprints = await archive(client, 'member_blueprints', wipeId);
      tables.push('member_blueprints');
    }
    // IDs are not restarted, so archived rows can always go back without clashing.
    await client.query(`TRUNCATE ${tables.join(', ')}`);
  } else {
    // One group of items: archive, record each removal in history, then remove.
    const note = wipeNote(wipeId, type);
    const items = `WHERE item_id IN (${itemSet(type.filter)})`;
    counts.inventory = await archive(client, 'inventory', wipeId, items);
    await client.query(
      `INSERT INTO transactions (actor_id, action_type, item_id, owner_member_id, designation, location_id,
                                 quantity_delta, quality_reading, quality_tier, note)
       SELECT $1, 'wipe', item_id, owner_member_id, designation, location_id,
              -quantity, quality_reading, quality_tier, $2
         FROM inventory ${items}
        ORDER BY id`,
      [actorId, note],
    );
    await client.query(`DELETE FROM inventory ${items}`);
    // Keep the tickets' previous state so a revert can reopen them.
    counts.cancelledTickets = await archive(client, 'requests', wipeId, `${items} AND status = 'pending'`);
    await client.query(
      `UPDATE requests SET status = 'cancelled', reviewed_by = $1, reviewed_at = now(), rejection_reason = $2
        ${items} AND status = 'pending'`,
      [actorId, note],
    );
  }

  await client.query('UPDATE wipes SET counts = $2 WHERE wipe_id = $1', [wipeId, JSON.stringify(counts)]);
  return { wipeId: Number(wipeId), wipedAt: w.wiped_at, counts };
}

const WIPE_SELECT = `
  SELECT w.*, wb.discord_username AS wiped_by_name, rb.discord_username AS reverted_by_name
    FROM wipes w
    JOIN members wb ON wb.member_id = w.wiped_by
    LEFT JOIN members rb ON rb.member_id = w.reverted_by`;

function decorate(row) {
  if (!row) return null;
  return { ...row, wipe_id: Number(row.wipe_id), type: getType(row.wipe_type) };
}

async function getWipe(db, wipeId) {
  if (!/^\d+$/.test(String(wipeId))) return null;
  const { rows } = await db.query(`${WIPE_SELECT} WHERE w.wipe_id = $1`, [wipeId]);
  return decorate(rows[0]);
}

async function listWipes(db, { onlyRevertable = false, limit = 25 } = {}) {
  const { rows } = await db.query(
    `${WIPE_SELECT} ${onlyRevertable ? 'WHERE w.reverted_at IS NULL' : ''} ORDER BY w.wipe_id DESC LIMIT $1`,
    [limit],
  );
  return rows.map(decorate);
}

/** "2026-09-16 14:05 UTC" — plain text, for places where Discord timestamps don't render. */
function formatDate(date) {
  return `${new Date(date).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const PHRASES = {
  inventory: ['inventory record', 'inventory records'],
  history: ['history entry', 'history entries'],
  blueprints: ['blueprint entry', 'blueprint entries'],
  tickets: ['ticket', 'tickets'],
  cancelledTickets: ['cancelled ticket', 'cancelled tickets'],
  reopenedTickets: ['reopened ticket', 'reopened tickets'],
};
const plural = (v, one, many) => `${v} ${v === 1 ? one : many}`;

function describeCounts(counts, { skipZeroTickets = true } = {}) {
  return Object.keys(PHRASES)
    .filter((k) => counts[k] !== undefined
      && !(['cancelledTickets', 'reopenedTickets'].includes(k) && skipZeroTickets && !counts[k]))
    .map((k) => plural(counts[k], ...PHRASES[k]))
    .join(', ');
}

/** Short line for pickers (max 100 chars): "#3 · 2026-09-16 14:05 UTC · Ores & minerals · Kane · 12 records". */
function wipeLabel(w) {
  const label = w.type ? w.type.label : w.wipe_type;
  const c = w.counts || {};
  const size = w.type && w.type.kind === 'blueprints'
    ? plural(c.blueprints || 0, 'blueprint', 'blueprints')
    : plural(c.inventory || 0, 'record', 'records');
  return `#${w.wipe_id} · ${formatDate(w.wiped_at)} · ${label} · ${w.wiped_by_name} · ${size}`;
}

/**
 * Puts a wipe's archived rows back. Stock that was added since the wipe is kept; matching
 * records are merged (quantities added together). Returns what was restored.
 * Must run inside a transaction; locks the wipe row so it can't be reverted twice.
 */
async function revertWipe(client, wipeId, actorId) {
  const { rows: [w] } = await client.query('SELECT * FROM wipes WHERE wipe_id = $1 FOR UPDATE', [wipeId]);
  if (!w) return { status: 'missing' };
  if (w.reverted_at) return { status: 'already' };
  const type = getType(w.wipe_type);
  await client.query('LOCK TABLE inventory, transactions, requests, member_blueprints IN EXCLUSIVE MODE');

  const restored = {};
  const has = async (table) => (await client.query(`SELECT 1 FROM archived_${table} WHERE wipe_id = $1 LIMIT 1`, [wipeId])).rowCount > 0;

  if (await has('inventory')) {
    const invCols = withoutId(COLS.inventory);
    const { rowCount } = await client.query(
      `INSERT INTO inventory (${invCols})
       SELECT ${invCols} FROM archived_inventory WHERE wipe_id = $1 ORDER BY id
       ON CONFLICT (item_id, owner_member_id, designation, location_id, (COALESCE(quality_reading, -1)))
       DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity`,
      [wipeId],
    );
    restored.inventory = rowCount;
    if (type.kind === 'items') {
      await client.query(
        `INSERT INTO transactions (actor_id, action_type, item_id, owner_member_id, designation, location_id,
                                   quantity_delta, quality_reading, quality_tier, note)
         SELECT $2, 'wipe_revert', item_id, owner_member_id, designation, location_id,
                quantity, quality_reading, quality_tier, $3
           FROM archived_inventory WHERE wipe_id = $1 ORDER BY id`,
        [wipeId, actorId, `Game wipe #${wipeId} reverted`],
      );
    }
  }

  if (type.kind === 'full') {
    const txCols = withoutId(COLS.transactions);
    const tx = await client.query(
      `INSERT INTO transactions (${txCols})
       SELECT ${txCols} FROM archived_transactions WHERE wipe_id = $1 ORDER BY "timestamp", id`,
      [wipeId],
    );
    restored.history = tx.rowCount;
    const rq = await client.query(
      `INSERT INTO requests (${COLS.requests})
       SELECT ${COLS.requests} FROM archived_requests WHERE wipe_id = $1
       ON CONFLICT (id) DO NOTHING`,
      [wipeId],
    );
    restored.tickets = rq.rowCount; // tickets keep their IDs; wipes never restart ID counters
  } else if (type.kind === 'items') {
    const rq = await client.query(
      `UPDATE requests r
          SET status = a.status, reviewed_by = a.reviewed_by, reviewed_at = a.reviewed_at, rejection_reason = a.rejection_reason
         FROM archived_requests a
        WHERE a.wipe_id = $1 AND a.id = r.id AND r.status = 'cancelled'`,
      [wipeId],
    );
    restored.reopenedTickets = rq.rowCount;
  }

  if (await has('member_blueprints')) {
    const bp = await client.query(
      `INSERT INTO member_blueprints (${COLS.member_blueprints})
       SELECT ${COLS.member_blueprints} FROM archived_member_blueprints WHERE wipe_id = $1
       ON CONFLICT DO NOTHING`,
      [wipeId],
    );
    restored.blueprints = bp.rowCount;
  }

  await client.query('UPDATE wipes SET reverted_by = $2, reverted_at = now() WHERE wipe_id = $1', [wipeId, actorId]);
  return { status: 'reverted', type, restored };
}

async function setWipeChannels(db, wipeId, { logsArchiveChannelId, revertLogsChannelId }) {
  if (logsArchiveChannelId !== undefined) {
    await db.query('UPDATE wipes SET logs_archive_channel_id = $2 WHERE wipe_id = $1', [wipeId, logsArchiveChannelId]);
  }
  if (revertLogsChannelId !== undefined) {
    await db.query('UPDATE wipes SET revert_logs_channel_id = $2 WHERE wipe_id = $1', [wipeId, revertLogsChannelId]);
  }
}

module.exports = {
  TYPES,
  TYPE_CHOICES,
  getType,
  countTargets,
  lockForWipe,
  buildBackup,
  performWipe,
  revertWipe,
  getWipe,
  listWipes,
  wipeLabel,
  formatDate,
  describeCounts,
  plural,
  setWipeChannels,
};
