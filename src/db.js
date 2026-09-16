'use strict';

const { Pool } = require('pg');
const { config } = require('./config');

let pool;

function getPool(connectionString = config.databaseUrl) {
  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
    pool.on('error', (err) => console.error('Postgres pool error:', err));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Runs fn(client) inside BEGIN/COMMIT. Any thrown error rolls everything back,
 * so an inventory change and its transactions row always succeed or fail together.
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, query, withTransaction, closePool };
