'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  skip, resetDatabase, addMember, fakeGuildMember, fakeInteraction,
} = require('./helpers');

const OFFICER = '100000000000000001';
const ALICE = '100000000000000002';
const BOB = '100000000000000003';
const GUEST = '100000000000000004';

let db; let inventory; let catalog; let quality; let settings;
const ids = {};

async function idOf(table, idCol, name) {
  const { rows } = await db.query(`SELECT ${idCol} AS id FROM ${table} WHERE name = $1 ORDER BY ${idCol} LIMIT 1`, [name]);
  assert.ok(rows[0], `${name} should exist in ${table}`);
  return rows[0].id;
}

async function qty(id) {
  const { rows } = await db.query('SELECT quantity FROM inventory WHERE id = $1', [id]);
  return rows[0] ? Number(rows[0].quantity) : null;
}

describe('inventory bot (database)', { skip }, () => {
  before(async () => {
    db = require('../src/db');
    inventory = require('../src/services/inventory');
    catalog = require('../src/services/catalog');
    quality = require('../src/lib/quality');
    settings = require('../src/services/settings');
    await resetDatabase();
    await addMember(OFFICER, 'Officer Sagi');
    await addMember(ALICE, 'Alice');
    await addMember(BOB, 'Bob');
    ids.titanium = await idOf('items', 'item_id', 'Titanium');
    ids.carinite = await idOf('items', 'item_id', 'Carinite');
    ids.gladius = await idOf('items', 'item_id', 'Gladius');
    ids.everus = await idOf('locations', 'location_id', 'Everus Harbor');
    ids.lorville = await idOf('locations', 'location_id', 'Lorville');
    ids.levski = await idOf('locations', 'location_id', 'Levski');
  });

  after(async () => {
    await db.closePool();
  });

  test('seed loaded the full catalog and locations pool', async () => {
    const counts = {};
    for (const t of ['categories', 'subcategories', 'items', 'ore_mineral_quality', 'systems', 'planets', 'location_types', 'locations']) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${t}`);
      counts[t] = rows[0].n;
    }
    assert.deepEqual(counts, {
      categories: 6, subcategories: 86, items: 291, ore_mineral_quality: 36, systems: 4, planets: 13, location_types: 10, locations: 108,
    });
  });

  test('quality tier is derived from each material\'s own thresholds', async () => {
    const ti = await catalog.getItem(ids.titanium); // Titanium: F295 E516 D622 C784 B866 A916 S959
    assert.equal(quality.deriveQualityTier(1000, ti), 'Perfect');
    assert.equal(quality.deriveQualityTier(959, ti), 'S');
    assert.equal(quality.deriveQualityTier(958, ti), 'A');
    assert.equal(quality.deriveQualityTier(784, ti), 'C');
    assert.equal(quality.deriveQualityTier(783, ti), 'D');
    assert.equal(quality.deriveQualityTier(295, ti), 'F');
    assert.equal(quality.deriveQualityTier(294, ti), null);
    const car = await catalog.getItem(ids.carinite); // no published F minimum; E starts at 554
    assert.equal(quality.deriveQualityTier(554, car), 'E');
    assert.equal(quality.deriveQualityTier(400, car), null);
    const glad = await catalog.getItem(ids.gladius);
    assert.equal(glad.has_quality, false);
    assert.throws(() => quality.deriveQualityTier(0, ti), RangeError);
  });

  test('location cascade only offers options that lead somewhere', async () => {
    const systems = await catalog.searchSystems('');
    assert.deepEqual(systems.map((s) => s.label).sort(), ['Nyx', 'Pyro', 'Stanton']); // Terra is not live

    const stantonPlanets = await catalog.searchPlanets('', 'SYS1');
    assert.ok(stantonPlanets.some((p) => p.id === 'PLNONE'), 'No Planet is always offered');
    assert.ok(!stantonPlanets.some((p) => p.label.includes('Pyro')), 'only Stanton planets');

    const hurstonTypes = await catalog.searchLocationTypes('', 'SYS1', 'PL03');
    assert.ok(hurstonTypes.some((t) => t.label.startsWith('City')));
    const nyxTypesOnNyxI = await catalog.searchLocationTypes('', 'SYS3', 'PL10');
    assert.equal(nyxTypesOnNyxI.length, 0, 'no dead-end types for a planet with no locations');

    const hurstonCities = await catalog.searchLocations('', { systemId: 'SYS1', planetId: 'PL03', locationTypeId: 'LT102' });
    assert.deepEqual(hurstonCities.map((l) => l.id), [ids.lorville]);
  });

  test('add merges identical records and keeps different quality batches apart', async () => {
    const a = await inventory.addStock({
      itemId: ids.titanium, ownerId: ALICE, designation: 'org', locationId: ids.everus,
      quantity: 40, qualityReading: 960, qualityTier: 'S', actorId: OFFICER,
    });
    assert.equal(a.created, true);
    assert.equal(a.after, 40);

    const b = await inventory.addStock({
      itemId: ids.titanium, ownerId: ALICE, designation: 'org', locationId: ids.everus,
      quantity: 2.5, qualityReading: 960, qualityTier: 'S', actorId: OFFICER,
    });
    assert.equal(b.created, false);
    assert.equal(b.record.id, a.record.id);
    assert.equal(b.before, 40);
    assert.equal(b.after, 42.5);

    const c = await inventory.addStock({
      itemId: ids.titanium, ownerId: ALICE, designation: 'org', locationId: ids.everus,
      quantity: 10, qualityReading: 700, qualityTier: 'D', actorId: OFFICER,
    });
    assert.equal(c.created, true, 'a different quality reading is a separate batch');

    const d = await inventory.addStock({
      itemId: ids.titanium, ownerId: ALICE, designation: 'org', locationId: ids.everus,
      quantity: 1, actorId: OFFICER,
    });
    assert.equal(d.created, true, 'no reading is separate from any reading');

    const { rows } = await db.query(`SELECT count(*)::int AS n FROM transactions WHERE action_type = 'add'`);
    assert.equal(rows[0].n, 4, 'every add is logged, merged or not');
    ids.aliceTitaniumS = a.record.id;
  });

  test('holdings search only shows what that owner actually has', async () => {
    const alice = await catalog.searchHoldings(ALICE, '');
    assert.equal(alice.length, 3);
    assert.ok(alice.every((h) => h.label.includes('Titanium')));
    const bob = await catalog.searchHoldings(BOB, '');
    assert.equal(bob.length, 0);
  });

  test('remove rejects over-removal and deletes a record that hits zero', async () => {
    await assert.rejects(
      inventory.removeStock({ inventoryId: ids.aliceTitaniumS, quantity: 50, actorId: OFFICER }),
      /Only 42.5 available/,
    );
    assert.equal(await qty(ids.aliceTitaniumS), 42.5, 'failed removal changed nothing');

    await assert.rejects(
      inventory.removeStock({ inventoryId: ids.aliceTitaniumS, quantity: 1, actorId: OFFICER, expectedOwnerId: BOB }),
      /no longer belongs/,
    );

    const r1 = await inventory.removeStock({ inventoryId: ids.aliceTitaniumS, quantity: 0.1, actorId: OFFICER });
    assert.equal(r1.after, 42.4, 'fractional math is exact');
    assert.equal(r1.deleted, false);

    const r2 = await inventory.removeStock({ inventoryId: ids.aliceTitaniumS, quantity: 42.4, actorId: OFFICER });
    assert.equal(r2.deleted, true);
    assert.equal(await qty(ids.aliceTitaniumS), null, 'row is gone from the pool');

    const { rows } = await db.query(
      `SELECT quantity_delta FROM transactions WHERE action_type = 'remove' ORDER BY id`,
    );
    assert.deepEqual(rows.map((r) => Number(r.quantity_delta)), [-0.1, -42.4], 'history survives the deleted row');
  });

  test('two officers removing the last units at the same time cannot overdraw', async () => {
    const rec = await inventory.addStock({
      itemId: ids.gladius, ownerId: BOB, designation: 'org', locationId: ids.lorville, quantity: 1, actorId: OFFICER,
    });
    const results = await Promise.allSettled([
      inventory.removeStock({ inventoryId: rec.record.id, quantity: 1, actorId: OFFICER }),
      inventory.removeStock({ inventoryId: rec.record.id, quantity: 1, actorId: OFFICER }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /no longer exists/);
  });

  test('transfer moves stock, merges at the destination, and logs a linked pair', async () => {
    const src = await inventory.addStock({
      itemId: ids.gladius, ownerId: ALICE, designation: 'personal', locationId: ids.lorville, quantity: 3, actorId: OFFICER,
    });
    const existing = await inventory.addStock({
      itemId: ids.gladius, ownerId: BOB, designation: 'org', locationId: ids.levski, quantity: 2, actorId: OFFICER,
    });

    const t = await inventory.transferStock({
      inventoryId: src.record.id, quantity: 1, actorId: OFFICER, expectedOwnerId: ALICE,
      toOwnerId: BOB, toDesignation: 'org', toLocationId: ids.levski,
    });
    assert.equal(t.sourceAfter, 2);
    assert.equal(t.destination.id, existing.record.id, 'merged into Bob\'s existing org record');
    assert.equal(t.destinationBefore, 2);
    assert.equal(t.destinationAfter, 3);
    assert.equal(t.touchesOrg, true);

    const { rows } = await db.query(
      `SELECT action_type, owner_member_id::text AS owner, designation, quantity_delta
         FROM transactions WHERE transfer_group_id = $1 ORDER BY id`,
      [t.transferGroupId],
    );
    assert.deepEqual(rows.map((r) => [r.action_type, r.owner, r.designation, Number(r.quantity_delta)]), [
      ['transfer_out', ALICE, 'personal', -1],
      ['transfer_in', BOB, 'org', 1],
    ]);

    // Designation-only change (donate to org): same owner, same place.
    const donate = await inventory.transferStock({
      inventoryId: src.record.id, quantity: 2, actorId: OFFICER, toDesignation: 'org',
    });
    assert.equal(donate.sourceDeleted, true);
    assert.equal(donate.destinationCreated, true);
    assert.equal(String(donate.destination.owner_member_id), ALICE);
    assert.equal(donate.destination.designation, 'org');
  });

  test('transfer rejects a no-op and keeps quality with the batch', async () => {
    const batch = await inventory.addStock({
      itemId: ids.titanium, ownerId: BOB, designation: 'personal', locationId: ids.everus,
      quantity: 5, qualityReading: 900, qualityTier: 'B', actorId: OFFICER,
    });
    await assert.rejects(
      inventory.transferStock({ inventoryId: batch.record.id, quantity: 1, actorId: OFFICER, toOwnerId: BOB }),
      /Nothing would change/,
    );
    const moved = await inventory.transferStock({
      inventoryId: batch.record.id, quantity: 5, actorId: OFFICER, toLocationId: ids.lorville,
    });
    assert.equal(moved.destination.quality_reading, 900);
    assert.equal(moved.destination.quality_tier, 'B');
  });

  describe('command handlers (with fake Discord objects)', () => {
    const officerGm = fakeGuildMember(OFFICER, 'Officer Sagi', ['officer-sc', 'Star Citizen']);
    const aliceGm = fakeGuildMember(ALICE, 'Alice', ['Organization-SC']);
    const guestGm = fakeGuildMember(GUEST, 'Guest', []);
    const plainGm = fakeGuildMember(BOB, 'Bob', ['Star Citizen', 'Organization-SC']);
    const guildMembers = { [OFFICER]: officerGm, [ALICE]: aliceGm, [GUEST]: guestGm, [BOB]: plainGm };

    before(async () => {
      await settings.setChannelId('input', 'chan-input');
      await settings.setChannelId('output', 'chan-output');
      await settings.setChannelId('logs', 'chan-logs');
    });

    const addOptions = () => ({
      owner: ALICE, category: 'S501', item: ids.titanium, quantity: 12,
      system: 'SYS1', planet: 'PL03', location_type: 'LT101', location: ids.everus,
      designation: 'org', quality: 930,
    });

    test('/add-item: full flow from command to confirmed stock and a #logs line', async () => {
      const addItem = require('../src/commands/addItem');
      const logs = [];
      const cmd = fakeInteraction({
        user: { id: OFFICER }, member: officerGm, guildMembers, channelId: 'chan-input', options: addOptions(), logSink: logs,
      });
      await addItem.execute(cmd);
      assert.equal(cmd.calls.reply.length, 1);
      const prompt = cmd.calls.reply[0];
      const qualityField = prompt.embeds[0].toJSON().fields.find((f) => f.name === 'Quality');
      assert.equal(qualityField.value, '930 → A-tier');

      const customId = prompt.components[0].toJSON().components[0].custom_id;
      const { takePending } = require('../src/lib/pending');
      const pending = takePending(customId.split(':')[1]);
      assert.equal(pending.userId, OFFICER);

      const btn = fakeInteraction({
        user: { id: OFFICER }, member: officerGm, guildMembers, channelId: 'chan-input', logSink: logs,
      });
      await addItem.confirm(btn, pending.action);
      assert.match(btn.calls.editReply[0].embeds[0].toJSON().title, /Stock added/);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /Officer Sagi\*\* added 12 SCU Titanium \(A-tier, 930\) → \*\*Alice\*\* · org · Everus Harbor, Hurston, Stanton/);
    });

    test('/add-item: guards (officer role, channel, member role, category, location, quality)', async () => {
      const addItem = require('../src/commands/addItem');
      const run = (overrides, who = officerGm, channelId = 'chan-input') => addItem.execute(fakeInteraction({
        user: { id: who.id }, member: who, guildMembers, channelId, options: { ...addOptions(), ...overrides },
      }));
      await assert.rejects(run({}, aliceGm), /officer-sc/);
      await assert.rejects(run({}, officerGm, 'chan-output'), /<#chan-input>/);
      await assert.rejects(run({ owner: GUEST }), /isn't an org member/);
      await assert.rejects(run({ category: 'S502' }), /not the category you picked/);
      await assert.rejects(run({ location: ids.lorville }), /is a City \(Landing Zone\), not the location type/);
      await assert.rejects(run({ planet: 'PL01' }), /isn't listed under the planet/);
      await assert.rejects(run({ item: ids.gladius, category: 'S102', quality: 900 }), /doesn't have an ore\/mineral quality/);
      await assert.rejects(run({ quantity: 0 }), /greater than zero/);
    });

    test('/remove-item and /transfer-item: pickers are scoped to real holdings', async () => {
      const removeItem = require('../src/commands/removeItem');
      const transferItem = require('../src/commands/transferItem');
      const { rows } = await db.query(
        `SELECT id FROM inventory WHERE owner_member_id = $1 AND item_id = $2 AND quality_reading = 930`,
        [ALICE, ids.titanium],
      );
      const recordId = String(rows[0].id);

      // Record belongs to Alice, so picking it under Bob fails.
      await assert.rejects(removeItem.execute(fakeInteraction({
        user: { id: OFFICER }, member: officerGm, guildMembers, channelId: 'chan-output',
        options: { owner: BOB, record: recordId, quantity: 1 },
      })), /isn't held by the owner you picked/);

      // Over-removal is blocked before the confirmation prompt.
      await assert.rejects(removeItem.execute(fakeInteraction({
        user: { id: OFFICER }, member: officerGm, guildMembers, channelId: 'chan-output',
        options: { owner: ALICE, record: recordId, quantity: 13 },
      })), /only has 12 SCU/);

      // Transfer with nothing changing is blocked.
      await assert.rejects(transferItem.execute(fakeInteraction({
        user: { id: OFFICER }, member: officerGm, guildMembers, channelId: 'chan-output',
        options: { owner: ALICE, record: recordId, quantity: 1, to_designation: 'org' },
      })), /Nothing would change/);

      // A partial new location is rejected rather than guessed.
      await assert.rejects(transferItem.execute(fakeInteraction({
        user: { id: OFFICER }, member: officerGm, guildMembers, channelId: 'chan-output',
        options: { owner: ALICE, record: recordId, quantity: 1, to_system: 'SYS1' },
      })), /didn't choose the exact location/);

      // Valid transfer to Bob produces a prompt showing both sides.
      const logs = [];
      const cmd = fakeInteraction({
        user: { id: OFFICER }, member: officerGm, guildMembers, channelId: 'chan-output', logSink: logs,
        options: { owner: ALICE, record: recordId, quantity: 2, to_owner: BOB, to_designation: 'personal' },
      });
      await transferItem.execute(cmd);
      const fields = cmd.calls.reply[0].embeds[0].toJSON().fields;
      assert.match(fields.find((f) => f.name === 'From').value, /12 → 10 SCU/);
      assert.match(fields.find((f) => f.name === 'To').value, /0 → 2 SCU \(new record\)/);

      const { takePending } = require('../src/lib/pending');
      const id = cmd.calls.reply[0].components[0].toJSON().components[0].custom_id.split(':')[1];
      const pending = takePending(id);
      const btn = fakeInteraction({ user: { id: OFFICER }, member: officerGm, guildMembers, channelId: 'chan-output', logSink: logs });
      await transferItem.confirm(btn, pending.action);
      assert.match(logs[0], /moved 2 SCU Titanium \(A-tier, 930\): \*\*Alice\*\* → \*\*Bob\*\* · org → personal/);
    });
  });
});
