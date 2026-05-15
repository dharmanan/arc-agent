'use strict';
const { Pool } = require('pg');

function sanitizeDatabaseUrl(connectionString) {
  if (!connectionString) return connectionString;

  try {
    const parsed = new URL(connectionString);

    // We enforce TLS policy via the explicit `ssl` option below, so remove
    // libpq-style sslmode aliases from the URL to avoid pg parser warnings.
    parsed.searchParams.delete('sslmode');

    return parsed.toString();
  } catch {
    return connectionString;
  }
}

const pool = new Pool({
  connectionString: sanitizeDatabaseUrl(process.env.DATABASE_URL),
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
