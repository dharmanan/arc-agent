'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

function loadEnvFiles() {
  const candidates = [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env.local'),
    path.resolve(__dirname, '../../.env'),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false });
    }
  }
}

function sanitizeDatabaseUrl(connectionString) {
  if (!connectionString) return connectionString;

  try {
    const parsed = new URL(connectionString);
    parsed.searchParams.delete('sslmode');
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--json-out') args.jsonOut = argv[index + 1];
    if (current === '--md-out') args.mdOut = argv[index + 1];
    if (current === '--quiet') args.quiet = true;
    if (current === '--json-out' || current === '--md-out') index += 1;
  }

  return args;
}

function readOptionalIntegerEnv(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function toIsoString(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildMarkdown(report) {
  const lines = [
    '# DB Snapshot',
    '',
    `- Generated at: ${report.generatedAt}`,
    `- Status: ${report.status}`,
    `- Database size: ${report.database.dbBytes} bytes (${report.database.dbHuman})`,
    `- chain_events size: ${report.chainEvents.bytes} bytes (${report.chainEvents.human})`,
    `- chain_events rows: ${report.chainEvents.rows}`,
    `- chain_events pending rows: ${report.chainEvents.pendingRows}`,
    `- chain_events processed rows: ${report.chainEvents.processedRows}`,
    `- Pending older than 24h: ${report.chainEvents.pendingRowsOlderThan24h}`,
    `- Pending older than 48h: ${report.chainEvents.pendingRowsOlderThan48h}`,
  ];

  if (report.chainEvents.oldestPendingAt) {
    lines.push(`- Oldest pending row: ${report.chainEvents.oldestPendingAt}`);
  }

  if (report.thresholds.violations.length > 0) {
    lines.push('');
    lines.push('## Threshold Violations');
    lines.push('');
    for (const violation of report.thresholds.violations) {
      lines.push(`- ${violation}`);
    }
  }

  lines.push('');
  lines.push('## Daily Breakdown');
  lines.push('');
  lines.push('| Day | Rows | Bytes | Human |');
  lines.push('| --- | ---: | ---: | --- |');

  for (const row of report.dailyBreakdown) {
    lines.push(`| ${row.day} | ${row.rows} | ${row.bytes} | ${row.human} |`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  loadEnvFiles();

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const args = parseArgs(process.argv.slice(2));

  const pool = new Pool({
    connectionString: sanitizeDatabaseUrl(process.env.DATABASE_URL),
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
  });

  const thresholdConfig = {
    maxDbBytes: readOptionalIntegerEnv('SNAPSHOT_MAX_DB_BYTES'),
    maxChainEventsBytes: readOptionalIntegerEnv('SNAPSHOT_MAX_CHAIN_EVENTS_BYTES'),
    maxPendingRows: readOptionalIntegerEnv('SNAPSHOT_MAX_PENDING_ROWS'),
  };

  try {
    const { rows: [summary] } = await pool.query(
      `SELECT
         pg_database_size(current_database())::bigint AS db_bytes,
         pg_total_relation_size('chain_events')::bigint AS chain_events_bytes,
         COUNT(*)::bigint AS chain_event_rows,
         COUNT(*) FILTER (WHERE processed = FALSE)::bigint AS pending_rows,
         COUNT(*) FILTER (WHERE processed = TRUE)::bigint AS processed_rows,
         COUNT(*) FILTER (WHERE processed = FALSE AND created_at < NOW() - INTERVAL '24 hours')::bigint AS pending_rows_older_than_24h,
         COUNT(*) FILTER (WHERE processed = FALSE AND created_at < NOW() - INTERVAL '48 hours')::bigint AS pending_rows_older_than_48h,
         MIN(created_at) FILTER (WHERE processed = FALSE) AS oldest_pending_at,
         MAX(created_at) FILTER (WHERE processed = FALSE) AS newest_pending_at
       FROM chain_events`,
    );

    const { rows: dailyRows } = await pool.query(
      `SELECT
         DATE(created_at) AS day,
         COUNT(*)::bigint AS rows,
         COALESCE(SUM(pg_column_size(chain_events)), 0)::bigint AS bytes
       FROM chain_events
       GROUP BY 1
       ORDER BY 1 DESC
       LIMIT 14`,
    );

    const violations = [];
    if (thresholdConfig.maxDbBytes != null && Number(summary.db_bytes) > thresholdConfig.maxDbBytes) {
      violations.push(`db_bytes ${summary.db_bytes} > ${thresholdConfig.maxDbBytes}`);
    }
    if (thresholdConfig.maxChainEventsBytes != null && Number(summary.chain_events_bytes) > thresholdConfig.maxChainEventsBytes) {
      violations.push(`chain_events_bytes ${summary.chain_events_bytes} > ${thresholdConfig.maxChainEventsBytes}`);
    }
    if (thresholdConfig.maxPendingRows != null && Number(summary.pending_rows) > thresholdConfig.maxPendingRows) {
      violations.push(`pending_rows ${summary.pending_rows} > ${thresholdConfig.maxPendingRows}`);
    }

    const report = {
      generatedAt: new Date().toISOString(),
      status: violations.length > 0 ? 'threshold_exceeded' : 'ok',
      database: {
        dbBytes: Number(summary.db_bytes),
        dbHuman: formatBytes(summary.db_bytes),
      },
      chainEvents: {
        bytes: Number(summary.chain_events_bytes),
        human: formatBytes(summary.chain_events_bytes),
        rows: Number(summary.chain_event_rows),
        pendingRows: Number(summary.pending_rows),
        processedRows: Number(summary.processed_rows),
        pendingRowsOlderThan24h: Number(summary.pending_rows_older_than_24h),
        pendingRowsOlderThan48h: Number(summary.pending_rows_older_than_48h),
        oldestPendingAt: toIsoString(summary.oldest_pending_at),
        newestPendingAt: toIsoString(summary.newest_pending_at),
      },
      dailyBreakdown: dailyRows.map((row) => ({
        day: toIsoString(row.day)?.slice(0, 10) || String(row.day),
        rows: Number(row.rows),
        bytes: Number(row.bytes),
        human: formatBytes(row.bytes),
      })),
      thresholds: {
        ...thresholdConfig,
        violations,
      },
    };

    const markdown = buildMarkdown(report);
    const json = `${JSON.stringify(report, null, 2)}\n`;

    if (args.jsonOut) {
      fs.mkdirSync(path.dirname(args.jsonOut), { recursive: true });
      fs.writeFileSync(args.jsonOut, json);
    }

    if (args.mdOut) {
      fs.mkdirSync(path.dirname(args.mdOut), { recursive: true });
      fs.writeFileSync(args.mdOut, markdown);
    }

    if (!args.quiet) {
      process.stdout.write(json);
    }

    if (violations.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});