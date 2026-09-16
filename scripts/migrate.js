'use strict';

// Creates/updates all database tables. Safe to run on every deploy.

const fs = require('fs');
const path = require('path');
const { requireConfig } = require('../src/config');
const { getPool, closePool } = require('../src/db');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await getPool().query(sql);
}

if (require.main === module) {
  requireConfig(['databaseUrl']);
  migrate()
    .then(() => console.log('Database schema is up to date.'))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exitCode = 1;
    })
    .finally(closePool);
}

module.exports = { migrate };
