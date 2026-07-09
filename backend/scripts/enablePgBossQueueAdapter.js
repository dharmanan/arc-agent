#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const agentQueuePath = path.join(repoRoot, 'src', 'queue', 'agentQueue.js');

function fail(message) {
  console.error(`[enable-pgboss] ${message}`);
  process.exit(1);
}

function replaceOnce(source, from, to, label) {
  if (!source.includes(from)) fail(`Pattern not found: ${label}`);
  const next = source.replace(from, to);
  if (next === source) fail(`Pattern did not change file: ${label}`);
  return next;
}

let source = fs.readFileSync(agentQueuePath, 'utf8');

source = replaceOnce(
  source,
  "const Redis       = require('ioredis');\nconst os          = require('os');",
  "const Redis       = require('ioredis');\nconst os          = require('os');\nconst { createPgBossQueue, shouldUsePgBossQueue } = require('./pgBossQueueAdapter');",
  'add pg-boss adapter require',
);

source = replaceOnce(
  source,
  "const queue = new Bull('agent-jobs', {\n  createClient: createBullRedisClient,\n  defaultJobOptions: {\n    attempts:    QUEUE_DEFAULT_MAX_ATTEMPTS,\n    backoff:     { type: 'exponential', delay: QUEUE_DEFAULT_BACKOFF_DELAY_MS },\n    removeOnComplete: 50,\n    removeOnFail:     20,\n  },\n  settings: {\n    // Default stalledInterval=5s = 864k Redis cmds/month → over Upstash free limit.\n    // At 300s: ~17k cmds/month from stall checks alone — safe for 500k/month budget.\n    stalledInterval:  300_000, // check stalled jobs every 5 min\n    lockDuration:     300_000, // job lock TTL must be >= stalledInterval\n    lockRenewTime:    150_000, // renew lock at half lockDuration\n    maxStalledCount:  2,\n  },\n});",
  "const queueOptions = {\n  defaultJobOptions: {\n    attempts:    QUEUE_DEFAULT_MAX_ATTEMPTS,\n    backoff:     { type: 'exponential', delay: QUEUE_DEFAULT_BACKOFF_DELAY_MS },\n    removeOnComplete: 50,\n    removeOnFail:     20,\n  },\n  settings: {\n    // Default stalledInterval=5s = 864k Redis cmds/month → over Upstash free limit.\n    // At 300s: ~17k cmds/month from stall checks alone — safe for 500k/month budget.\n    stalledInterval:  300_000, // check stalled jobs every 5 min\n    lockDuration:     300_000, // job lock TTL must be >= stalledInterval\n    lockRenewTime:    150_000, // renew lock at half lockDuration\n    maxStalledCount:  2,\n  },\n};\n\nconst queue = shouldUsePgBossQueue()\n  ? createPgBossQueue('agent-jobs', queueOptions)\n  : new Bull('agent-jobs', {\n      createClient: createBullRedisClient,\n      ...queueOptions,\n    });\n\nconsole.log(`[QUEUE] Backend=${shouldUsePgBossQueue() ? 'pgboss' : 'redis'}`);",
  'replace Bull queue construction with feature-flag backend',
);

source = replaceOnce(
  source,
  "// Guards against the same Bull job being delivered to more than one concurrent\n// worker at once. Observed in production: an entire just-enqueued scheduler\n// batch (e.g. ORACLE_QUERY + MARKET_ANALYSIS for every agent) can occasionally\n// get dispatched twice within milliseconds — not a retry, a genuine duplicate\n// delivery. This is a cheap short-lived Redis lock keyed by job.id: the first\n// delivery wins the lock and proceeds, the duplicate delivery is skipped\n// without side effects (no duplicate on-chain writes, no duplicate reputation\n// events).",
  "// Guards against the same job being delivered to more than one concurrent\n// worker at once. On Redis/Bull this uses Redis locks; on pg-boss it uses a\n// tiny Postgres-backed lock table exposed through the adapter's compatible\n// queue.client surface. The first delivery wins and duplicate delivery is\n// skipped without side effects.",
  'update dispatch lock comment',
);

source = replaceOnce(
  source,
  "const registeredQueueHandlers = Object.keys(queue.handlers || {}).sort();\nconsole.log(`[QUEUE] Registered Bull handlers (${registeredQueueHandlers.length})`);\nif (VERBOSE_QUEUE_LOGS) {\n  console.log(`[QUEUE] Registered Bull handler names: ${registeredQueueHandlers.join(', ')}`);\n}\nsyncBullRedisListenerCaps(registeredQueueHandlers.length);",
  "const registeredQueueHandlers = Object.keys(queue.handlers || {}).sort();\nconsole.log(`[QUEUE] Registered handlers (${registeredQueueHandlers.length}) backend=${shouldUsePgBossQueue() ? 'pgboss' : 'redis'}`);\nif (VERBOSE_QUEUE_LOGS) {\n  console.log(`[QUEUE] Registered handler names: ${registeredQueueHandlers.join(', ')}`);\n}\nif (!shouldUsePgBossQueue()) {\n  syncBullRedisListenerCaps(registeredQueueHandlers.length);\n}",
  'make handler logging backend-neutral',
);

fs.writeFileSync(agentQueuePath, source);
console.log('[enable-pgboss] agentQueue.js patched successfully');
console.log('[enable-pgboss] Next: git diff -- backend/src/queue/agentQueue.js');
