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
    for (const t of ['categories', 'subcategories', 'items', 'ore_mineral_quality', 'systems', 'planets', 'location_types', 'locations',
      'blueprint_categories', 'blueprint_subcategories', 'blueprints']) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${t}`);
      counts[t] = rows[0].n;
    }
    assert.deepEqual(counts, {
      categories: 6, subcategories: 86, items: 291, ore_mineral_quality: 36, systems: 4, planets: 13, location_types: 10, locations: 108,
      blueprint_categories: 8, blueprint_subcategories: 35, blueprints: 1606,
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

    test('register panel: officers pick a member and set their gamertag', async () => {
      const registerMember = require('../src/commands/registerMember');
      const members = require('../src/services/members');
      const logs = [];

      const clickAs = (gm) => {
        const i = fakeInteraction({ user: { id: gm.id }, member: gm, guildMembers, channelId: 'chan-register', logSink: logs });
        i.customId = 'register:open';
        i.isButton = () => true;
        i.isModalSubmit = () => false;
        i.modals = [];
        i.showModal = async (m) => { i.modals.push(m.toJSON()); };
        return i;
      };
      const submitAs = (gm, memberId, handle) => {
        const i = fakeInteraction({ user: { id: gm.id }, member: gm, guildMembers, channelId: 'chan-register', logSink: logs });
        i.customId = 'register:submit';
        i.isButton = () => false;
        i.isModalSubmit = () => true;
        i.fields = {
          getSelectedUsers: () => new (require('discord.js').Collection)([[memberId, { id: memberId, bot: false }]]),
          getTextInputValue: () => handle,
        };
        return i;
      };

      // Non-officers can't even open the form.
      await assert.rejects(registerMember.handleInteraction(clickAs(aliceGm)), /officer-sc/);

      const click = clickAs(officerGm);
      assert.equal(await registerMember.handleInteraction(click), true);
      assert.equal(click.modals[0].custom_id, 'register:submit');

      // First registration.
      const first = submitAs(officerGm, ALICE, '  Nightfall_77 ');
      await registerMember.handleInteraction(first);
      assert.match(first.calls.reply[0].content, /Alice\*\* is now registered as \*\*Nightfall_77/);
      assert.equal((await members.getMember(ALICE)).rsi_handle, 'Nightfall_77');
      assert.match(logs.at(-1), /Officer Sagi\*\* registered \*\*Alice\*\* as \*\*Nightfall_77/);

      // Same value again: nothing changes and nothing is logged.
      const logCount = logs.length;
      const same = submitAs(officerGm, ALICE, 'Nightfall_77');
      await registerMember.handleInteraction(same);
      assert.match(same.calls.reply[0].content, /already registered/);
      assert.equal(logs.length, logCount);

      // Changing it records old -> new.
      await registerMember.handleInteraction(submitAs(officerGm, ALICE, 'Nightfall_78'));
      assert.match(logs.at(-1), /changed \*\*Alice\*\*'s gamertag: Nightfall_77 → \*\*Nightfall_78/);

      // Guards: taken handle (any capitals), non-member, bad characters, non-officer submit.
      await assert.rejects(registerMember.handleInteraction(submitAs(officerGm, BOB, 'nightfall_78')), /already registered to \*\*Alice/);
      await assert.rejects(registerMember.handleInteraction(submitAs(officerGm, GUEST, 'Guesty')), /isn't an org member/);
      await assert.rejects(registerMember.handleInteraction(submitAs(officerGm, BOB, 'bad name!')), /only contain letters/);
      await assert.rejects(registerMember.handleInteraction(submitAs(aliceGm, BOB, 'Sneaky')), /officer-sc/);

      // Other interactions are left alone.
      const other = clickAs(officerGm);
      other.customId = 'confirm:abc';
      assert.equal(await registerMember.handleInteraction(other), false);
    });

    test('/set-handle: members set only their own, with the same rules', async () => {
      const setHandle = require('../src/commands/setHandle');
      const members = require('../src/services/members');
      const run = (gm, handle) => {
        const i = fakeInteraction({ user: { id: gm.id }, member: gm, guildMembers, channelId: 'anywhere', options: { handle } });
        return setHandle.execute(i).then(() => i);
      };
      const ok = await run(plainGm, 'BobInSpace');
      assert.match(ok.calls.reply[0].content, /BobInSpace/);
      assert.equal((await members.getMember(BOB)).rsi_handle, 'BobInSpace');
      await assert.rejects(run(plainGm, 'NIGHTFALL_78'), /already registered to \*\*Alice/);
      await assert.rejects(run(guestGm, 'Guesty'), /Only org members/);
    });

    test('/blueprint: members record their own blueprints and anyone in the org can look them up', async () => {
      const blueprint = require('../src/commands/blueprint');
      const bps = require('../src/services/blueprints');

      const run = async (gm, sub, options = {}) => {
        const i = fakeInteraction({ user: { id: gm.id }, member: gm, guildMembers, channelId: 'anywhere', options });
        i.options.getSubcommand = () => sub;
        await blueprint.execute(i);
        return i;
      };
      const complete = async (gm, sub, focusedName, value, options = {}) => {
        let out;
        const i = fakeInteraction({ user: { id: gm.id }, member: gm, guildMembers, channelId: 'anywhere', options });
        i.options.getSubcommand = () => sub;
        i.options.getFocused = () => ({ name: focusedName, value });
        i.respond = async (choices) => { out = choices; };
        await blueprint.autocomplete(i);
        return out;
      };

      // Pool search, optionally narrowed by category; ship components show size and grade.
      const js400 = (await complete(aliceGm, 'add', 'blueprint', 'JS-400')).find((c) => c.name.startsWith('JS-400'));
      assert.equal(js400.name, 'JS-400 · S2 · Grade 1 · Power Plants');
      const pistols = await complete(aliceGm, 'add', 'blueprint', 'Arclight', { category: 'BS401' });
      assert.ok(pistols.length >= 7 && pistols.every((c) => c.name.includes('Pistols')));
      const serac = await complete(aliceGm, 'add', 'blueprint', 'Serac');
      assert.equal(serac.length, 2);
      assert.notEqual(serac[0].name, serac[1].name, 'repeated names are told apart');

      // Add, add again (no duplicate), list.
      const added = await run(aliceGm, 'add', { blueprint: js400.value });
      assert.match(added.calls.reply[0].content, /Added to your blueprint list/);
      assert.match(added.calls.reply[0].content, /materials: Beryl, Savrilium, Stileron/);
      const again = await run(aliceGm, 'add', { blueprint: js400.value });
      assert.match(again.calls.reply[0].content, /already on your list/);
      await run(aliceGm, 'add', { blueprint: pistols[0].value, category: 'BS401' });

      const mine = await run(aliceGm, 'list');
      const listEmbed = mine.calls.reply[0].embeds[0].toJSON();
      assert.match(listEmbed.title, /Your blueprints \(2\)/);
      assert.match(listEmbed.description, /\*\*Ship Components › Power Plants\*\*\n• JS-400 · S2 · Grade 1/);

      // Who can craft it — visible to other members, with gamertags.
      const whoRes = await run(plainGm, 'who', { blueprint: js400.value });
      const whoText = whoRes.calls.reply[0].embeds[0].toJSON().description;
      assert.match(whoText, /1 member can craft it/);
      assert.match(whoText, /Alice — Nightfall_78/);

      // Remove only offers your own list.
      const removable = await complete(aliceGm, 'remove', 'blueprint', '');
      assert.equal(removable.length, 2);
      const bobRemovable = await complete(plainGm, 'remove', 'blueprint', '');
      assert.equal(bobRemovable[0].value, '__none__');
      await assert.rejects(run(plainGm, 'remove', { blueprint: js400.value }), /isn't on your list/);
      await run(aliceGm, 'remove', { blueprint: js400.value });
      const nobody = await run(plainGm, 'who', { blueprint: js400.value });
      assert.match(nobody.calls.reply[0].content, /Nobody in the org/);

      // Guards: non-members are kept out, and picks must come from the list.
      await assert.rejects(run(guestGm, 'list'), /only for org members/);
      await assert.rejects(run(aliceGm, 'add', { blueprint: 'made-up' }), /suggestion list/);
      await assert.rejects(run(aliceGm, 'add', { blueprint: js400.value, category: 'nope' }), /category from the suggestion list/);

      // Long lists come back as an attached file.
      const many = await bps.searchBlueprints('ORC-mkV', null);
      for (const b of (await require('../src/db').query(`SELECT blueprint_id FROM blueprints WHERE subcategory_id LIKE 'BS6%'`)).rows) {
        await bps.addMemberBlueprint(ALICE, b.blueprint_id);
      }
      assert.ok(many.length > 0);
      const big = await run(aliceGm, 'list');
      assert.equal(big.calls.reply[0].files.length, 1);
      assert.match(big.calls.reply[0].embeds[0].toJSON().description, /full list is in the attached file/);
    });

    test('/wipe-inventory, /wipe-revert, /wipe-history: typed, dated, reversible wipes', async () => {
      const wipeInventory = require('../src/commands/wipeInventory');
      const wipeRevert = require('../src/commands/wipeRevert');
      const wipeHistory = require('../src/commands/wipeHistory');
      const members = require('../src/services/members');
      const ADMIRAL = '100000000000000005';
      const admiralGm = fakeGuildMember(ADMIRAL, 'Admiral Kane', ['Admiral of Combat']);
      const allMembers = { ...guildMembers, [ADMIRAL]: admiralGm };
      const count = async (t, where = '') => (await db.query(`SELECT count(*)::int AS n FROM ${t} ${where}`)).rows[0].n;
      const oreWhere = 'WHERE item_id IN (SELECT item_id FROM ore_mineral_quality)';
      const sumQty = async () => Number((await db.query('SELECT COALESCE(sum(quantity), 0) AS q FROM inventory')).rows[0].q);

      // Make sure there's something of every kind to wipe: ores, a ship, blueprints, tickets.
      await inventory.addStock({
        itemId: ids.gladius, ownerId: BOB, designation: 'org', quantity: 1, locationId: ids.lorville, actorId: OFFICER,
      });
      await db.query(`INSERT INTO requests (requester_member_id, request_type, item_id, quantity) VALUES
        ($1, 'add', $2, 1), ($1, 'add', $3, 1)`, [ALICE, ids.titanium, ids.gladius]);
      await db.query(`UPDATE transactions SET note = '=HYPERLINK("x")' WHERE id = (SELECT min(id) FROM transactions)`);
      const start = {
        inventory: await count('inventory'),
        quantity: await sumQty(),
        ores: await count('inventory', oreWhere),
        transactions: await count('transactions'),
        member_blueprints: await count('member_blueprints'),
      };
      assert.ok(start.ores > 0 && start.inventory > start.ores && start.member_blueprints > 0);
      const handleBefore = (await members.getMember(ALICE)).rsi_handle;
      assert.ok(handleBefore);

      // --- Fake Discord: channels that remember edits, roles, DMs ------------------
      await settings.setChannelId('logs', 'chan-logs-old');
      const channels = {};
      const channelEvents = [];
      const posted = [];
      const state = { cloneFails: false };
      const makeChannel = (id, name) => {
        channels[id] = {
          id,
          name,
          parentId: 'cat-inventory',
          rawPosition: 3,
          permissionOverwrites: { cache: [{ id: 'role-officer', allow: 'read' }] },
          clone: async ({ reason }) => {
            if (state.cloneFails) throw new Error('Missing Permissions');
            channelEvents.push(['clone', id, reason]);
            return makeChannel('chan-logs-new', channels[id].name);
          },
          edit: async (opts) => {
            channelEvents.push(['edit', id, opts.name, opts]);
            channels[id].name = opts.name;
          },
          delete: async () => channelEvents.push(['delete', id]),
        };
        return channels[id];
      };
      makeChannel('chan-logs-old', 'logs');

      const make = (gm, opts = {}) => {
        const {
          typeValue, wipeValue, word = 'WIPE', channelId = 'chan-admin', editFails = false, dmFails = false,
        } = opts;
        const i = fakeInteraction({
          user: { id: gm.id }, member: gm, guildMembers: allMembers, channelId, options: { type: typeValue, wipe: wipeValue },
        });
        i.customId = wipeValue ? `wipe-revert:submit:${wipeValue}` : `wipe:submit:${typeValue}`;
        i.isModalSubmit = () => true;
        i.fields = { getTextInputValue: () => word };
        i.modals = [];
        i.showModal = async (m) => { i.modals.push(m.toJSON()); };
        i.deferReply = async () => { i.deferred = true; };
        i.calls.followUp = [];
        i.followUp = async (payload) => { i.calls.followUp.push(payload); };
        i.calls.dm = [];
        i.user.send = async (payload) => {
          if (dmFails) throw new Error('Cannot send messages to this user');
          i.calls.dm.push(payload);
        };
        if (editFails) i.editReply = async () => { throw new Error('Request entity too large'); };
        i.client.channels.fetch = async (id) => ({
          isTextBased: () => true,
          send: async (msg) => { posted.push({ id, ...msg }); },
        });
        i.guild.channels = {
          fetch: async (id) => {
            if (!channels[id]) throw new Error('Unknown Channel');
            return channels[id];
          },
        };
        i.guild.roles = {
          fetch: async () => {},
          everyone: { id: 'role-everyone' },
          cache: { find: (fn) => [{ id: 'role-admiral', name: 'Admiral of Combat' }].find(fn) },
        };
        i.guild.client = { user: { id: 'bot' } };
        return i;
      };
      const wipeAs = (gm, typeValue, opts = {}) => make(gm, { typeValue, ...opts });
      const revertAs = (gm, wipeValue, opts = {}) => make(gm, { wipeValue, word: 'REVERT', ...opts });
      const csvFiles = (reply) => Object.fromEntries(reply.files.map(
        (f) => [f.name.replace(/^backup-[\d-]+_\d{4}-/, ''), f.attachment.toString('utf8')],
      ));
      const dataLines = (csv) => csv.trim().split('\r\n').length - 1;

      // --- Guards ----------------------------------------------------------------
      // Only the Admiral role: officers are refused, both on the command and on the pop-up.
      await assert.rejects(wipeInventory.execute(wipeAs(officerGm, 'ores')), /Admiral of Combat/);
      await assert.rejects(wipeInventory.handleInteraction(wipeAs(officerGm, 'ores')), /Admiral of Combat/);
      await assert.rejects(wipeInventory.execute(wipeAs(admiralGm, 'everything')), /pick a wipe type/);
      // A full wipe can't be run from inside #logs (it's swapped); a partial one can.
      await assert.rejects(wipeInventory.execute(wipeAs(admiralGm, 'full', { channelId: 'chan-logs-old' })), /another channel/);
      const opened = wipeAs(admiralGm, 'ores', { channelId: 'chan-logs-old' });
      await wipeInventory.execute(opened);
      assert.equal(opened.modals[0].custom_id, 'wipe:submit:ores');
      assert.equal(opened.modals[0].title, 'Wipe: Ores & minerals');
      // Nothing of that type in stock: refused before the pop-up.
      await assert.rejects(wipeInventory.execute(wipeAs(admiralGm, 'armor')), /no \*\*armor & clothing\*\* in the inventory/);
      // Wrong word, or a backup that can't be delivered: nothing is wiped.
      await assert.rejects(wipeInventory.handleInteraction(wipeAs(admiralGm, 'full_blueprints', { word: 'yes' })), /type \*\*WIPE\*\*/);
      await assert.rejects(wipeInventory.handleInteraction(wipeAs(admiralGm, 'full_blueprints', { editFails: true })), /nothing was wiped/);
      assert.equal(await count('inventory'), start.inventory);
      assert.equal(await count('transactions'), start.transactions);
      assert.equal(await count('wipes'), 0, 'a rolled-back wipe leaves no record');
      assert.equal(posted.length, 0);

      // --- Wipe #1: ores only ----------------------------------------------------
      const ores = wipeAs(admiralGm, 'ores', { word: ' wipe ' });
      assert.equal(await wipeInventory.handleInteraction(ores), true);
      const oreFiles = csvFiles(ores.calls.editReply[0]);
      assert.deepEqual(Object.keys(oreFiles), ['ores-inventory.csv']);
      assert.equal(dataLines(oreFiles['ores-inventory.csv']), start.ores);
      assert.match(oreFiles['ores-inventory.csv'], /Titanium/);
      assert.doesNotMatch(oreFiles['ores-inventory.csv'], /Gladius/);
      assert.equal(await count('inventory', oreWhere), 0, 'ores are gone');
      assert.equal(await count('inventory'), start.inventory - start.ores, 'everything else stays');
      assert.equal(await count('archived_inventory', 'WHERE wipe_id = 1'), start.ores, 'ores are archived');
      assert.equal(await count('transactions'), start.transactions + start.ores, 'history kept, one wipe entry per record');
      const wipeRows = (await db.query(`SELECT * FROM transactions WHERE action_type = 'wipe'`)).rows;
      assert.ok(wipeRows.every((r) => Number(r.quantity_delta) < 0 && r.actor_id === ADMIRAL && r.note === 'Game wipe #1: Ores & minerals'));
      const tickets = (await db.query('SELECT status FROM requests ORDER BY id')).rows;
      assert.deepEqual(tickets.map((t) => t.status), ['cancelled', 'pending'], 'only the ore ticket is cancelled');
      assert.deepEqual(channelEvents, [], '#logs is not swapped for a partial wipe');
      assert.equal(posted.at(-1).id, 'chan-logs-old');
      assert.match(posted.at(-1).content, /🧹 \*\*Wipe #1 — Ores & minerals were wiped by Admiral Kane\*\* on <t:\d+:f>\.\nRemoved \d+ inventory records?; each removal is recorded in history as a wipe\. 1 pending ticket for these items was cancelled/);
      assert.deepEqual(posted.at(-1).allowedMentions, { parse: [] });
      assert.match(ores.calls.followUp[0].content, /Wipe #1 done — Ores & minerals\*\* \(<t:\d+:f>\)/);
      assert.match(ores.calls.followUp[0].content, /Undo with `\/wipe-revert` \(Wipe #1\)/);
      assert.match(ores.calls.followUp[0].content, /recorded in <#chan-logs-old>/);
      await assert.rejects(wipeInventory.execute(wipeAs(admiralGm, 'ores')), /Nothing to wipe/);

      // --- Wipe #2: full, blueprints kept -----------------------------------------
      const beforeFull = { inventory: await count('inventory'), transactions: await count('transactions'), quantity: await sumQty() };
      const full = wipeAs(admiralGm, 'full');
      await wipeInventory.handleInteraction(full);
      const backup = full.calls.editReply[0];
      assert.match(backup.content, new RegExp(`Backup before the wipe — Full wipe \\(keep blueprints\\)\\*\\* \\(${beforeFull.inventory} inventory records?, ${beforeFull.transactions} history entries, 2 tickets\\)`));
      const files = csvFiles(backup);
      assert.deepEqual(Object.keys(files).sort(), ['full-history.csv', 'full-inventory.csv', 'full-tickets.csv']);
      assert.equal(dataLines(files['full-history.csv']), beforeFull.transactions);
      assert.match(files['full-inventory.csv'], /^\uFEFFrecord_id,category,subcategory,item/);
      assert.match(files['full-history.csv'], /"'=HYPERLINK\(""x""\)"/, 'formula text is neutralized and quoted');
      assert.match(files['full-history.csv'], /,wipe,Titanium,/);
      assert.equal(full.calls.dm[0].files.length, 3);
      for (const t of ['inventory', 'transactions', 'requests']) assert.equal(await count(t), 0, `${t} is empty`);
      assert.equal(await count('archived_transactions', 'WHERE wipe_id = 2'), beforeFull.transactions);
      assert.equal(await count('member_blueprints'), start.member_blueprints, 'blueprint lists kept');
      assert.equal((await members.getMember(ALICE)).rsi_handle, handleBefore);
      assert.equal(await count('blueprints'), 1606);
      assert.equal(await count('items'), 291);
      assert.equal(await settings.getChannelId('input'), 'chan-input');
      // Stock can be added straight away.
      await inventory.addStock({
        itemId: ids.titanium, ownerId: ALICE, designation: 'org', quantity: 1, locationId: ids.everus, actorId: OFFICER,
      });
      // #logs: a copy takes over; the old channel is renamed with the date and hidden (Admiral only).
      const today = new Date().toISOString().slice(0, 10);
      assert.deepEqual(channelEvents.map((e) => e.slice(0, 3)), [
        ['clone', 'chan-logs-old', 'Wipe #2 by Admiral Kane'],
        ['edit', 'chan-logs-old', `logs-archive-${today}`],
      ]);
      const hidden = channelEvents[1][3].permissionOverwrites;
      assert.deepEqual(hidden.map((o) => o.id), ['role-everyone', 'bot', 'role-admiral']);
      assert.equal(await settings.getChannelId('logs'), 'chan-logs-new');
      assert.equal((await db.query('SELECT logs_archive_channel_id FROM wipes WHERE wipe_id = 2')).rows[0].logs_archive_channel_id, 'chan-logs-old');
      assert.equal(posted.at(-1).id, 'chan-logs-new');
      assert.match(posted.at(-1).content, /Wipe #2 — the inventory system was wiped by Admiral Kane\*\* \(full wipe \(keep blueprints\)\) on <t:\d+:f>\. This is a fresh log; the earlier one was archived/);
      assert.match(posted.at(-1).content, /members' blueprint lists, the item catalog and the blueprint pool were kept/);
      assert.match(full.calls.followUp[0].content, /#logs starts fresh in <#chan-logs-new>.*kept as <#chan-logs-old>, visible only to the Admiral of Combat role/);

      // --- Wipe #3: blueprints only -----------------------------------------------
      channelEvents.length = 0;
      const bps = wipeAs(admiralGm, 'blueprints');
      await wipeInventory.handleInteraction(bps);
      const bpFiles = csvFiles(bps.calls.editReply[0]);
      assert.deepEqual(Object.keys(bpFiles), ['blueprints-blueprints.csv']);
      assert.equal(dataLines(bpFiles['blueprints-blueprints.csv']), start.member_blueprints);
      assert.match(bpFiles['blueprints-blueprints.csv'], /Alice,Nightfall_78/);
      assert.equal(await count('member_blueprints'), 0);
      assert.equal(await count('inventory'), 1, 'inventory untouched');
      assert.deepEqual(channelEvents, []);
      assert.match(posted.at(-1).content, /Wipe #3 — all member blueprint lists were wiped by Admiral Kane\*\*[^]*Removed \d+ blueprint entries/);
      await assert.rejects(wipeInventory.execute(wipeAs(admiralGm, 'blueprints')), /no member has any blueprints/);

      // --- Wipe #4: full + blueprints, when Discord won't let the bot swap #logs ----
      await require('../src/services/blueprints').addMemberBlueprint(ALICE, 'BP0001');
      state.cloneFails = true;
      const again = wipeAs(admiralGm, 'full_blueprints', { dmFails: true });
      await wipeInventory.handleInteraction(again);
      state.cloneFails = false;
      assert.ok(csvFiles(again.calls.editReply[0])['full_blueprints-blueprints.csv'].includes('BP0001'));
      assert.equal(await count('member_blueprints'), 0);
      assert.equal(await count('inventory'), 0);
      assert.equal(await settings.getChannelId('logs'), 'chan-logs-new');
      assert.equal(posted.at(-1).id, 'chan-logs-new');
      assert.match(posted.at(-1).content, /Wipe #4 — the inventory system was wiped by Admiral Kane\*\* \(full wipe \+ blueprints\)[^]*Messages above this line are from before the wipe/);
      assert.match(again.calls.followUp[0].content, /couldn't clear the #logs history/);
      assert.match(again.calls.followUp[0].content, /couldn't DM you/);

      // --- /wipe-history: dated list for officers and the Admiral -----------------
      await assert.rejects(wipeHistory.execute(make(plainGm, {})), /Only officers/);
      const hist = make(officerGm, {});
      await wipeHistory.execute(hist);
      const histText = hist.calls.reply[0].embeds[0].toJSON().description;
      assert.match(histText, /^\*\*#4\*\* · <t:\d+:f> · \*\*Full wipe \+ blueprints\*\* · by Admiral Kane/);
      assert.match(histText, /\*\*#1\*\* · <t:\d+:f> · \*\*Ores & minerals\*\* · by Admiral Kane\n {2}Removed: \d+ inventory records?, 1 cancelled ticket\n {2}Not reverted/);

      // --- /wipe-revert guards ------------------------------------------------------
      const complete = async (gm, text = '') => {
        const i = make(gm, {});
        i.options.getFocused = () => text;
        let out;
        i.respond = async (choices) => { out = choices; };
        await wipeRevert.autocomplete(i);
        return out;
      };
      assert.match((await complete(officerGm))[0].name, /Only the Admiral of Combat role/);
      const picks = await complete(admiralGm);
      assert.deepEqual(picks.map((p) => p.value), ['4', '3', '2', '1'], 'newest first');
      assert.match(picks[3].name, /^#1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · Ores & minerals · Admiral Kane · \d+ records?$/);
      assert.deepEqual((await complete(admiralGm, 'blueprints only')).map((p) => p.value), ['3']);
      await assert.rejects(wipeRevert.execute(revertAs(officerGm, '1')), /Admiral of Combat/);
      await assert.rejects(wipeRevert.execute(revertAs(admiralGm, '99')), /pick a wipe/);
      await assert.rejects(wipeRevert.execute(revertAs(admiralGm, '2', { channelId: 'chan-logs-new' })), /another channel/);
      const revertModal = revertAs(admiralGm, '1');
      await wipeRevert.execute(revertModal);
      assert.equal(revertModal.modals[0].custom_id, 'wipe-revert:submit:1');
      assert.match(revertModal.modals[0].components[0].description, /^Ores & minerals from \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
      await assert.rejects(wipeRevert.handleInteraction(revertAs(admiralGm, '1', { word: 'WIPE' })), /type \*\*REVERT\*\*/);
      await assert.rejects(wipeRevert.handleInteraction(revertAs(officerGm, '1')), /Admiral of Combat/);

      // --- Revert #2 (full): everything from before it comes back, #logs swaps back --
      const r2 = revertAs(admiralGm, '2');
      assert.equal(await wipeRevert.handleInteraction(r2), true);
      assert.equal(await count('inventory'), beforeFull.inventory);
      assert.equal(await sumQty(), beforeFull.quantity);
      assert.equal(await count('transactions'), beforeFull.transactions);
      assert.equal(await count('requests'), 2);
      assert.equal(await settings.getChannelId('logs'), 'chan-logs-old');
      assert.equal(channels['chan-logs-old'].name, 'logs', 'archived channel takes the live name back');
      assert.equal(channels['chan-logs-new'].name, `logs-after-wipe-${today}`);
      const swap = channelEvents.filter((e) => e[0] === 'edit').map((e) => e[3]);
      assert.equal(swap[0].parent, 'cat-inventory');
      assert.deepEqual(swap[0].permissionOverwrites, [{ id: 'role-officer', allow: 'read' }], 'copies the live channel\'s permissions');
      assert.deepEqual(swap[1].permissionOverwrites.map((o) => o.id), ['role-everyone', 'bot', 'role-admiral']);
      assert.equal(posted.at(-1).id, 'chan-logs-old');
      assert.match(posted.at(-1).content, /↩️ \*\*Wipe #2 \(Full wipe \(keep blueprints\), from <t:\d+:f>\) was reverted by Admiral Kane\*\* on <t:\d+:f>\.\nRestored: \d+ inventory records, \d+ history entries, 2 tickets\. Anything added since the wipe was kept\.\nThe log from before the wipe is back in this channel\. Lines written between the wipe and now are kept in <#chan-logs-new>/);
      assert.match(r2.calls.editReply[0].content, /Wipe #2 reverted[^]*old #logs is back as <#chan-logs-old>/);
      await assert.rejects(wipeRevert.execute(revertAs(admiralGm, '2')), /already reverted by \*\*Admiral Kane\*\* on <t:\d+:f>/);
      await assert.rejects(wipeRevert.handleInteraction(revertAs(admiralGm, '2')), /already reverted/);

      // --- Revert #1 (ores): ores return, recorded in history, ticket reopened -------
      const txBefore = await count('transactions');
      await wipeRevert.handleInteraction(revertAs(admiralGm, '1'));
      assert.equal(await count('inventory', oreWhere), start.ores);
      assert.equal(await count('inventory'), start.inventory);
      assert.equal(await sumQty(), start.quantity);
      assert.equal(await count('transactions', `WHERE action_type = 'wipe_revert'`), start.ores);
      assert.equal(await count('transactions'), txBefore + start.ores);
      assert.deepEqual((await db.query('SELECT status FROM requests ORDER BY id')).rows.map((t) => t.status), ['pending', 'pending']);
      assert.match(posted.at(-1).content, /Wipe #1 \(Ores & minerals[^]*Restored: \d+ inventory records?, 1 reopened ticket\./);

      // --- Revert #4 and #3: stock added later merges; blueprint lists come back -----
      await wipeRevert.handleInteraction(revertAs(admiralGm, '4'));
      assert.equal(await sumQty(), start.quantity + 1, 'the Titanium added after wipe #2 merges back in');
      assert.equal(await count('member_blueprints'), 1);
      await wipeRevert.handleInteraction(revertAs(admiralGm, '3'));
      assert.equal(await count('member_blueprints'), start.member_blueprints + 1);
      assert.deepEqual((await complete(admiralGm)).map((p) => p.value), ['__none__'], 'nothing left to revert');

      const hist2 = make(admiralGm, {});
      await wipeHistory.execute(hist2);
      assert.equal((hist2.calls.reply[0].embeds[0].toJSON().description.match(/↩️ Reverted by Admiral Kane on <t:\d+:f>/g) || []).length, 4);
    });

    test('Star Citizen, Organization-SC and Organization all count as members', async () => {
      const members = require('../src/services/members');
      const { requireActiveMember } = require('../src/lib/discord');
      for (const role of ['Star Citizen', 'Organization-SC', 'Organization']) {
        assert.equal(members.isOrgMember(fakeGuildMember('1', 'A', [role])), true, role);
      }
      assert.equal(members.isOrgMember(fakeGuildMember('2', 'B', ['Organization-Guest'])), false, 'names must match exactly');
      const NEWBIE = '100000000000000009';
      const newbie = fakeGuildMember(NEWBIE, 'Newbie', ['Organization']);
      const gm = await requireActiveMember({ members: { fetch: async () => newbie } }, { id: NEWBIE, bot: false }, 'That member');
      assert.equal(gm, newbie);
      assert.equal((await members.getMember(NEWBIE)).active, true);
      const nobody = fakeGuildMember('100000000000000010', 'Nobody', []);
      await assert.rejects(
        requireActiveMember({ members: { fetch: async () => nobody } }, { id: nobody.id, bot: false }, 'You'),
        /you need the Star Citizen, Organization-SC or Organization role/,
      );
    });

    test('officer-sc and officer both count as officers', async () => {
      const members = require('../src/services/members');
      const { requireOfficer } = require('../src/lib/discord');
      assert.equal(members.isOfficer(fakeGuildMember('1', 'A', ['officer'])), true);
      assert.equal(members.isOfficer(fakeGuildMember('2', 'B', ['officer-sc'])), true);
      assert.equal(members.isOfficer(fakeGuildMember('3', 'C', ['Star Citizen'])), false);
      assert.throws(() => requireOfficer({ member: fakeGuildMember('3', 'C', []) }), /\*\*officer-sc\*\* or \*\*officer\*\*/);
      const addItem = require('../src/commands/addItem');
      const i = fakeInteraction({
        user: { id: '9' }, member: fakeGuildMember('9', 'New Officer', ['officer']), guildMembers, channelId: 'chan-other',
      });
      await assert.rejects(addItem.execute(i), /run this command in <#chan-input>/, 'passes the officer check');
    });

    test('csv writer quotes and neutralizes cells', () => {
      const { toCsv } = require('../src/lib/csv');
      const out = toCsv([{ a: 'x,y', b: -5, c: '-rm', d: null, e: 'say "hi"', f: '+1' }], ['a', 'b', 'c', 'd', 'e', 'f']);
      assert.equal(out, '\uFEFFa,b,c,d,e,f\r\n"x,y",-5,\'-rm,,"say ""hi""",\'+1\r\n');
    });
  });
});
