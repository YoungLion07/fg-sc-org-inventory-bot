'use strict';

// Loads the item catalog and locations pool from db/seed-data.json.
// Safe to run on every deploy: existing rows are updated in place, nothing is deleted,
// so items/locations referenced by real inventory are never removed.

const fs = require('fs');
const path = require('path');
const { requireConfig } = require('../src/config');
const { withTransaction, closePool } = require('../src/db');

// Order matters: parents before children.
const TABLES = [
  { name: 'categories', key: 'category_id', cols: ['category_id', 'name', 'description'] },
  { name: 'subcategories', key: 'subcategory_id', cols: ['subcategory_id', 'parent_category_id', 'name'] },
  { name: 'items', key: 'item_id', cols: ['item_id', 'subcategory_id', 'name', 'manufacturer', 'unit', 'grade', 'class', 'notes'] },
  {
    name: 'ore_mineral_quality',
    key: 'item_id',
    cols: ['item_id', 'material_type', 'tier_f_min', 'tier_e_min', 'tier_d_min', 'tier_c_min',
      'tier_b_min', 'tier_a_min', 'tier_s_min', 'tier_perfect', 'notes'],
  },
  { name: 'systems', key: 'system_id', cols: ['system_id', 'name', 'status', 'notes'] },
  { name: 'planets', key: 'planet_id', cols: ['planet_id', 'parent_system_id', 'name'] },
  { name: 'location_types', key: 'location_type_id', cols: ['location_type_id', 'parent_system_id', 'name'] },
  {
    name: 'locations',
    key: 'location_id',
    cols: ['location_id', 'parent_location_type_id', 'parent_planet_id', 'name', 'planet_or_body', 'notes'],
  },
];

async function seed(dataPath = path.join(__dirname, '..', 'db', 'seed-data.json')) {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const counts = {};

  await withTransaction(async (client) => {
    for (const table of TABLES) {
      const rows = data[table.name] || [];
      const placeholders = table.cols.map((_, i) => `$${i + 1}`).join(', ');
      const updates = table.cols
        .filter((c) => c !== table.key)
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(', ');
      const sql =
        `INSERT INTO ${table.name} (${table.cols.map((c) => `"${c}"`).join(', ')}) ` +
        `VALUES (${placeholders}) ON CONFLICT ("${table.key}") DO UPDATE SET ${updates}`;
      for (const row of rows) {
        await client.query(sql, table.cols.map((c) => (row[c] === undefined ? null : row[c])));
      }
      counts[table.name] = rows.length;
    }
  });

  return counts;
}

if (require.main === module) {
  requireConfig(['databaseUrl']);
  seed()
    .then((counts) => {
      const summary = Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join(', ');
      console.log(`Seed data loaded (${summary}).`);
    })
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exitCode = 1;
    })
    .finally(closePool);
}

module.exports = { seed };
