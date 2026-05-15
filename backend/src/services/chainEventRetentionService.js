'use strict';

const db = require('../db');

const DEFAULT_RETENTION_DAYS = 1;
const DEFAULT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PRUNE_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES_PER_RUN = 25;

let pruneInFlight = false;
let pruneTimer = null;

function readIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function readPositiveIntegerEnv(name, fallback) {
  const parsed = readIntegerEnv(name, fallback);
  return parsed > 0 ? parsed : fallback;
}

function formatInterval(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

const CHAIN_EVENTS_RETENTION_DAYS = readIntegerEnv(
  'CHAIN_EVENTS_RETENTION_DAYS',
  DEFAULT_RETENTION_DAYS,
);
const CHAIN_EVENTS_PRUNE_INTERVAL_MS = readIntegerEnv(
  'CHAIN_EVENTS_PRUNE_INTERVAL_MS',
  DEFAULT_PRUNE_INTERVAL_MS,
);
const CHAIN_EVENTS_PRUNE_BATCH_SIZE = readPositiveIntegerEnv(
  'CHAIN_EVENTS_PRUNE_BATCH_SIZE',
  DEFAULT_PRUNE_BATCH_SIZE,
);
const CHAIN_EVENTS_PRUNE_MAX_BATCHES_PER_RUN = readPositiveIntegerEnv(
  'CHAIN_EVENTS_PRUNE_MAX_BATCHES_PER_RUN',
  DEFAULT_MAX_BATCHES_PER_RUN,
);

async function pruneProcessedChainEvents() {
  if (CHAIN_EVENTS_RETENTION_DAYS < 1) {
    return { enabled: false, deletedCount: 0 };
  }

  if (pruneInFlight) {
    return { enabled: true, skipped: 'in_flight', deletedCount: 0 };
  }

  pruneInFlight = true;

  try {
    let deletedCount = 0;

    for (let batch = 0; batch < CHAIN_EVENTS_PRUNE_MAX_BATCHES_PER_RUN; batch += 1) {
      const { rows: [row] } = await db.query(
        `WITH doomed AS (
           SELECT id
             FROM chain_events
            WHERE processed = TRUE
              AND created_at < NOW() - ($1::int * INTERVAL '1 day')
            ORDER BY created_at ASC
            LIMIT $2
         ), deleted AS (
           DELETE FROM chain_events ce
           USING doomed
           WHERE ce.id = doomed.id
           RETURNING 1
         )
         SELECT COUNT(*)::int AS deleted_count
           FROM deleted`,
        [CHAIN_EVENTS_RETENTION_DAYS, CHAIN_EVENTS_PRUNE_BATCH_SIZE],
      );

      const batchDeletedCount = Number(row?.deleted_count || 0);
      deletedCount += batchDeletedCount;

      if (batchDeletedCount < CHAIN_EVENTS_PRUNE_BATCH_SIZE) {
        break;
      }
    }

    if (deletedCount > 0) {
      console.log(
        `[CHAIN_EVENTS] Pruned ${deletedCount} processed row(s) older than ${CHAIN_EVENTS_RETENTION_DAYS} day(s)`,
      );
    }

    return { enabled: true, deletedCount };
  } finally {
    pruneInFlight = false;
  }
}

function startChainEventRetention() {
  if (pruneTimer) return;

  if (CHAIN_EVENTS_RETENTION_DAYS < 1) {
    console.log('[CHAIN_EVENTS] Retention disabled (CHAIN_EVENTS_RETENTION_DAYS < 1)');
    return;
  }

  if (CHAIN_EVENTS_PRUNE_INTERVAL_MS < 60_000) {
    console.log('[CHAIN_EVENTS] Retention disabled (CHAIN_EVENTS_PRUNE_INTERVAL_MS < 60000)');
    return;
  }

  console.log(
    `[CHAIN_EVENTS] Retention enabled — keep processed rows ${CHAIN_EVENTS_RETENTION_DAYS} day(s), interval ${formatInterval(CHAIN_EVENTS_PRUNE_INTERVAL_MS)}, batch ${CHAIN_EVENTS_PRUNE_BATCH_SIZE} x ${CHAIN_EVENTS_PRUNE_MAX_BATCHES_PER_RUN}`,
  );

  pruneProcessedChainEvents().catch((err) => {
    console.error('[CHAIN_EVENTS] Initial prune error:', err.message);
  });

  pruneTimer = setInterval(() => {
    pruneProcessedChainEvents().catch((err) => {
      console.error('[CHAIN_EVENTS] Scheduled prune error:', err.message);
    });
  }, CHAIN_EVENTS_PRUNE_INTERVAL_MS);
}

module.exports = {
  pruneProcessedChainEvents,
  startChainEventRetention,
};