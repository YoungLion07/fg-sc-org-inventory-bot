'use strict';

// The only code that writes to `inventory` and `transactions`. Every function runs in a
// single database transaction, so a stock change and its audit row always land together.

const { withTransaction } = require('../db');
const { UserError } = require('../lib/errors');

const DESIGNATIONS = ['personal', 'org'];

function assertDesignation(value) {
  if (!DESIGNATIONS.includes(value)) throw new UserError('Designation must be "personal" or "org".');
}

function assertPositive(quantity) {
  if (!(typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0)) {
    throw new UserError('Quantity must be greater than zero.');
  }
}

/**
 * Adds stock, merging into an existing record for the same
 * item + owner + designation + location + quality reading.
 */
async function addStock({
  itemId, ownerId, designation, locationId, quantity,
  qualityReading = null, qualityTier = null, actorId, note = null, requestId = null,
}) {
  assertDesignation(designation);
  assertPositive(quantity);

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO inventory (item_id, owner_member_id, designation, quantity, location_id,
                             quality_reading, quality_tier, logged_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (item_id, owner_member_id, designation, location_id, (COALESCE(quality_reading, -1)))
       DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                     logged_by = EXCLUDED.logged_by,
                     logged_at = now()
       RETURNING *, (xmax = 0) AS created, quantity - $4::numeric AS before_qty`,
      [itemId, ownerId, designation, quantity, locationId, qualityReading, qualityTier, actorId],
    );
    const record = rows[0];

    await client.query(
      `INSERT INTO transactions (actor_id, action_type, item_id, owner_member_id, designation,
                                 location_id, quantity_delta, quality_reading, quality_tier, request_id, note)
       VALUES ($1, 'add', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [actorId, itemId, ownerId, designation, locationId, quantity, qualityReading, qualityTier, requestId, note],
    );

    return {
      record,
      created: record.created,
      before: Number(record.before_qty),
      after: Number(record.quantity),
    };
  });
}

async function lockRecord(client, inventoryId) {
  const { rows } = await client.query(`SELECT * FROM inventory WHERE id = $1 FOR UPDATE`, [inventoryId]);
  if (!rows[0]) {
    throw new UserError('That inventory record no longer exists — it may have just been removed or moved by someone else.');
  }
  return rows[0];
}

async function decrementOrDelete(client, record, quantity) {
  // Arithmetic happens in Postgres NUMERIC so fractional SCU never picks up float rounding errors.
  const { rows } = await client.query(
    `SELECT quantity AS before_qty, quantity - $2::numeric AS after_qty FROM inventory WHERE id = $1`,
    [record.id, quantity],
  );
  const before = Number(rows[0].before_qty);
  const after = Number(rows[0].after_qty);
  if (after < 0) {
    throw new UserError(`Only ${before} available on that record — you can't take out ${quantity}.`);
  }
  if (after === 0) {
    await client.query(`DELETE FROM inventory WHERE id = $1`, [record.id]);
  } else {
    await client.query(
      `UPDATE inventory SET quantity = $2::numeric, logged_at = now() WHERE id = $1`,
      [record.id, rows[0].after_qty],
    );
  }
  return { before, after, deleted: after === 0 };
}

/**
 * Removes stock from one specific existing record. The record is deleted when it hits zero.
 * `expectedOwnerId` guards against the record having changed hands since it was picked.
 */
async function removeStock({ inventoryId, quantity, actorId, expectedOwnerId = null, note = null, requestId = null }) {
  assertPositive(quantity);

  return withTransaction(async (client) => {
    const record = await lockRecord(client, inventoryId);
    if (expectedOwnerId && String(record.owner_member_id) !== String(expectedOwnerId)) {
      throw new UserError('That record no longer belongs to the owner you picked. Please run the command again.');
    }
    const change = await decrementOrDelete(client, record, quantity);

    await client.query(
      `INSERT INTO transactions (actor_id, action_type, item_id, owner_member_id, designation,
                                 location_id, quantity_delta, quality_reading, quality_tier, request_id, note)
       VALUES ($1, 'remove', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [actorId, record.item_id, record.owner_member_id, record.designation, record.location_id,
        -quantity, record.quality_reading, record.quality_tier, requestId, note],
    );

    return { record, ...change };
  });
}

/**
 * Moves stock from one existing record to a destination owner/designation/location.
 * Any destination field left null keeps the source's value. Logged as two rows
 * (transfer_out + transfer_in) sharing one transfer_group_id.
 */
async function transferStock({
  inventoryId, quantity, actorId, expectedOwnerId = null,
  toOwnerId = null, toDesignation = null, toLocationId = null, note = null, requestId = null,
}) {
  assertPositive(quantity);
  if (toDesignation !== null) assertDesignation(toDesignation);

  return withTransaction(async (client) => {
    const source = await lockRecord(client, inventoryId);
    if (expectedOwnerId && String(source.owner_member_id) !== String(expectedOwnerId)) {
      throw new UserError('That record no longer belongs to the owner you picked. Please run the command again.');
    }

    const dest = {
      ownerId: toOwnerId !== null ? String(toOwnerId) : String(source.owner_member_id),
      designation: toDesignation !== null ? toDesignation : source.designation,
      locationId: toLocationId !== null ? toLocationId : source.location_id,
    };

    if (
      dest.ownerId === String(source.owner_member_id)
      && dest.designation === source.designation
      && dest.locationId === source.location_id
    ) {
      throw new UserError('Nothing would change — the destination owner, designation, and location are all the same as the source.');
    }

    const sourceChange = await decrementOrDelete(client, source, quantity);

    const { rows } = await client.query(
      `INSERT INTO inventory (item_id, owner_member_id, designation, quantity, location_id,
                             quality_reading, quality_tier, logged_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (item_id, owner_member_id, designation, location_id, (COALESCE(quality_reading, -1)))
       DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                     logged_by = EXCLUDED.logged_by,
                     logged_at = now()
       RETURNING *, (xmax = 0) AS created, quantity - $4::numeric AS before_qty`,
      [source.item_id, dest.ownerId, dest.designation, quantity, dest.locationId,
        source.quality_reading, source.quality_tier, actorId],
    );
    const destination = rows[0];

    const { rows: groupRows } = await client.query(`SELECT gen_random_uuid() AS id`);
    const groupId = groupRows[0].id;

    const txSql = `INSERT INTO transactions (actor_id, action_type, item_id, owner_member_id, designation,
                                 location_id, quantity_delta, quality_reading, quality_tier,
                                 transfer_group_id, request_id, note)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;
    await client.query(txSql, [actorId, 'transfer_out', source.item_id, source.owner_member_id,
      source.designation, source.location_id, -quantity, source.quality_reading, source.quality_tier,
      groupId, requestId, note]);
    await client.query(txSql, [actorId, 'transfer_in', source.item_id, dest.ownerId,
      dest.designation, dest.locationId, quantity, source.quality_reading, source.quality_tier,
      groupId, requestId, note]);

    return {
      source,
      sourceBefore: sourceChange.before,
      sourceAfter: sourceChange.after,
      sourceDeleted: sourceChange.deleted,
      destination,
      destinationCreated: destination.created,
      destinationBefore: Number(destination.before_qty),
      destinationAfter: Number(destination.quantity),
      transferGroupId: groupId,
      touchesOrg: source.designation === 'org' || dest.designation === 'org',
    };
  });
}

module.exports = { DESIGNATIONS, addStock, removeStock, transferStock };
