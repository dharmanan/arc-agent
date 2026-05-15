'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });

const fs = require('fs');
const path = require('path');
const db = require('./index');

async function runMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await db.getClient();

  try {
    await client.query(sql);
    console.log('[DB] Schema migrations applied');
  } finally {
    client.release();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[DB] Migration error:', err.message);
      process.exit(1);
    });
}

module.exports = { runMigrations };