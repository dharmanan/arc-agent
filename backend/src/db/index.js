'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
});

pool.on('error', (err) => console.error('[DB] Unexpected pool error', err));

module.exports = {
  /** Run a parameterised query. Throws on error. */
  query: (text, params) => pool.query(text, params),

  /** Get a dedicated client (for transactions). Remember to release(). */
  getClient: () => pool.connect(),
};
