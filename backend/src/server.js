'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { once }   = require('events');
const fs           = require('fs');
const path         = require('path');
const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const morgan       = require('morgan');
const authRoutes         = require('./routes/auth');
const agentRoutes        = require('./routes/agents');
const transactionRoutes  = require('./routes/transactions');
const bridgeRoutes       = require('./routes/bridge');
const oracleRoutes       = require('./routes/oracle');
const tasksRoutes        = require('./routes/tasks');
const jobsRoutes         = require('./routes/jobs');
const publicJobsRoutes   = require('./routes/publicJobs');
const agentQueue         = require('./queue/agentQueue');
const { globalRateLimit }  = require('./middleware/rateLimit');
const { startIndexer }     = require('./services/indexerService');
const { startChainEventRetention } = require('./services/chainEventRetentionService');
const { startJobRetention } = require('./services/jobRetentionService');
const { startLpRewardEpochSnapshotWriter } = require('./services/lpRewardProgramService');
const bridgeActivityService = require('./services/bridgeActivityService');
const agentWalletService    = require('./services/agentWalletService');
const agentService          = require('./services/agentService');
const {
  startSecurityFreezeRecovery,
  stopSecurityFreezeRecovery,
} = require('./services/securityEventService');
const db                   = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

const TRUST_PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function sanitizeLogValue(value, depth = 0) {
  if (depth > 4) return '[Truncated]';
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeLogValue(entry, depth + 1));
  }

  if (value instanceof Error) {
    return sanitizeErrorForLog(value);
  }

  if (typeof value === 'object') {
    const redactedKeys = new Set([
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'api-key',
      'apikey',
      'token',
      'accessToken',
      'refreshToken',
      'idToken',
      'signature',
      'privateKey',
      'private_key',
      'credential',
      'attestationObject',
      'clientDataJSON',
    ]);
    const normalized = {};

    for (const [key, entry] of Object.entries(value)) {
      if (redactedKeys.has(String(key || '').trim())) {
        normalized[key] = '[Redacted]';
      } else {
        normalized[key] = sanitizeLogValue(entry, depth + 1);
      }
    }

    return normalized;
  }

  if (typeof value === 'string' && value.length > 2048) {
    return `${value.slice(0, 2048)}…`;
  }

  return value;
}

function sanitizeErrorForLog(error) {
  if (!error) return error;

  return {
    name: error.name || 'Error',
    message: error.message || 'Unknown error',
    status: error.status || error.statusCode || null,
    code: error.code || null,
    details: sanitizeLogValue(error.details || error.meta || error.data || null),
    stack: process.env.NODE_ENV === 'production'
      ? undefined
      : (typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 8).join('\n') : undefined),
  };
}

function resolveTrustProxySetting() {
  const raw = String(process.env.TRUST_PROXY || process.env.EXPRESS_TRUST_PROXY || '1').trim();
  const normalized = raw.toLowerCase();

  if (!raw) return 1;
  if (['true', 'false'].includes(normalized)) {
    return normalized === 'true';
  }

  if (/^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }

  const list = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (list.length > 0 && list.every((entry) => TRUST_PROXY_PRESETS.has(entry.toLowerCase()))) {
    return list.map((entry) => entry.toLowerCase()).join(', ');
  }

  console.warn(`[SECURITY] Invalid TRUST_PROXY value "${raw}". Falling back to 1.`);
  return 1;
}

function buildContentSecurityPolicyDirectives() {
  return {
    defaultSrc: ["'none'"],
    baseUri: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    scriptSrc: ["'none'"],
    styleSrc: ["'none'"],
    fontSrc: ["'none'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    manifestSrc: ["'self'"],
    frameSrc: ["'none'"],
  };
}

function isEnvEnabled(name, defaultValue = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;

  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function startOptionalBackgroundJob(flagName, label, startFn, defaultValue = true) {
  if (!isEnvEnabled(flagName, defaultValue)) {
    console.log(`[BOOT] ${label} disabled via ${flagName}=false`);
    return false;
  }

  try {
    startFn();
    return true;
  } catch (err) {
    console.error(`[BOOT] ${label} startup error:`, err.message);
    return false;
  }
}

function startOptionalAsyncBackgroundJob(flagName, label, startFn, defaultValue = true) {
  if (!isEnvEnabled(flagName, defaultValue)) {
    console.log(`[BOOT] ${label} disabled via ${flagName}=false`);
    return false;
  }

  Promise.resolve()
    .then(startFn)
    .catch(err => console.error(`[${label}] startup error`, err.message));
  return true;
}

const BACKGROUND_JOBS_ENABLED = isEnvEnabled('BACKGROUND_JOBS_ENABLED', true);
const HEALTHCHECK_DB_PROBE_ENABLED = isEnvEnabled('HEALTHCHECK_DB_PROBE_ENABLED', true);
const HEALTHCHECK_REDIS_PROBE_ENABLED = isEnvEnabled('HEALTHCHECK_REDIS_PROBE_ENABLED', true);
const QUEUE_WORKER_STARTUP_DELAY_MS = parseInt(process.env.QUEUE_WORKER_STARTUP_DELAY_MS || '60000', 10);

function shouldSkipAccessLog(req, res) {
  if (process.env.NODE_ENV !== 'production') return false;

  const statusCode = Number(res?.statusCode || 0);
  const requestPath = req?.path || req?.originalUrl || '';
  if ((requestPath === '/readyz' || requestPath === '/health') && statusCode > 0 && statusCode < 400) {
    return true;
  }

  const userAgent = String(req?.headers?.['user-agent'] || '').toLowerCase();
  if (requestPath === '/readyz' && userAgent.includes('railwayhealthcheck')) {
    return true;
  }

  return false;
}

function readSanitizedPath(req) {
  const requestUrl = String(req?.originalUrl || req?.url || '/');

  try {
    return new URL(requestUrl, 'http://localhost').pathname || '/';
  } catch {
    return requestUrl.split('?')[0] || '/';
  }
}

// Trust proxy headers for Railway / reverse-proxy deployments.
app.set('trust proxy', resolveTrustProxySetting());

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: buildContentSecurityPolicyDirectives(),
  },
  crossOriginEmbedderPolicy: false,
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 15552000, includeSubDomains: true }
    : false,
}));

// ── CORS — only allow the trusted frontend origin ─────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173,http://localhost:5174,http://localhost:5500')
  .split(',').map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, curl, Postman)
    if (!origin) return cb(null, true);
    // Explicit allow list from FRONTEND_URL env var
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Always allow GitHub Codespace and localhost (dev and production both)
    if (
      origin.endsWith('.app.github.dev') ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('https://localhost:')
    ) {
      return cb(null, true);
    }
    console.warn('[CORS] Blocked origin:', origin);
    const err = new Error('CORS: origin not allowed');
    err.status = 403;
    cb(err);
  },
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));

// ── Logging ───────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  morgan.token('safe-path', (req) => readSanitizedPath(req));
  morgan.token('safe-ip', (req) => req.ip || req.socket?.remoteAddress || '-');

  const accessLogFormat = process.env.NODE_ENV === 'production'
    ? ':safe-ip :method :safe-path :status :res[content-length] - :response-time ms'
    : 'dev';

  app.use(morgan(accessLogFormat, {
    skip: shouldSkipAccessLog,
  }));
}

// ── Global rate limit (per IP) ────────────────────────────────────────────────
app.use(globalRateLimit);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/agents',       agentRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/bridge',       bridgeRoutes);
app.use('/api/oracle',       oracleRoutes);
app.use('/api/tasks',        tasksRoutes);
app.use('/api/jobs',         publicJobsRoutes);
// tasks.js also handles /api/tasks/agents/:id/tasks/* routes (mounted at /api/tasks)
app.use('/api/agents/:id/jobs', jobsRoutes);
// jobs.js handles /api/agents/:id/jobs/* routes (ERC-8183 AgenticCommerce)

// ── Root info ─────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'Arc Machina API',
    version: '1.0.0',
    status: 'running',
    readiness: '/readyz',
    diagnostics: '/health',
  });
});

app.get('/readyz', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Health probe ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const health = {
    status: 'ok',
    db: HEALTHCHECK_DB_PROBE_ENABLED ? 'ok' : 'skipped',
    redis: HEALTHCHECK_REDIS_PROBE_ENABLED ? 'ok' : 'skipped',
    ts: new Date().toISOString(),
  };
  let httpStatus = 200;

  if (HEALTHCHECK_DB_PROBE_ENABLED) {
    try {
      await db.query('SELECT 1');
    } catch (err) {
      health.db = 'error';
      health.dbError = err.message;
      health.status = 'degraded';
      httpStatus = 503;
    }
  }

  if (HEALTHCHECK_REDIS_PROBE_ENABLED) {
    try {
      const redisClient = await ensureRedisReady();
      await redisClient.ping();
    } catch (err) {
      health.redis = 'error';
      health.redisError = err.message;
      health.status = 'degraded';
      httpStatus = 503;
    }
  }

  res.status(httpStatus).json(health);
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Zod validation errors → 400
  if (err?.name === 'ZodError') {
    const msg = err.errors?.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    return res.status(400).json({ error: msg || 'Invalid request body' });
  }
  const status = err.status || 500;
  if (status >= 500) console.error('[ERROR]', sanitizeErrorForLog(err));
  // Never leak stack traces or internal messages to clients in production
  const isProd = process.env.NODE_ENV === 'production';
  const message = isProd && status >= 500
    ? 'Internal server error'
    : (err.message || 'Internal server error');
  res.status(status).json({ error: message });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function runMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, 'db/schema.sql'), 'utf8');
  const client = await db.getClient();
  try {
    await client.query(sql);
    console.log('[DB] Schema migrations applied');
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function ensureRedisReady() {
  const redisClient = require('./services/redisClient');

  if (redisClient.status === 'wait') {
    await redisClient.connect();
    return redisClient;
  }

  if (redisClient.status === 'connecting' || redisClient.status === 'reconnecting') {
    await Promise.race([
      once(redisClient, 'ready'),
      once(redisClient, 'end').then(() => {
        throw new Error('Redis connection ended before becoming ready');
      }),
      once(redisClient, 'error').then(([error]) => {
        throw error;
      }),
    ]);
  }

  return redisClient;
}

async function bootstrap() {
  // Run schema migrations (all statements are idempotent — IF NOT EXISTS)
  await runMigrations();

  // Verify DB connectivity
  await db.query('SELECT 1');
  console.log('[DB] PostgreSQL connected');

  try {
    await ensureRedisReady();
    console.log('[REDIS] ready');
  } catch (err) {
    console.error('[REDIS] startup warning:', err.message);
  }

  if (BACKGROUND_JOBS_ENABLED) {
    startOptionalBackgroundJob('CHAIN_EVENT_RETENTION_ENABLED', 'Chain event retention', startChainEventRetention);
    startOptionalBackgroundJob('JOB_RETENTION_ENABLED', 'Job retention', startJobRetention);
    startOptionalBackgroundJob('LP_REWARD_SNAPSHOT_ENABLED', 'LP reward snapshot writer', startLpRewardEpochSnapshotWriter);
    startOptionalBackgroundJob('SECURITY_FREEZE_RECOVERY_ENABLED', 'Security freeze recovery', startSecurityFreezeRecovery);

    // Start blockchain event indexer (non-blocking)
    startOptionalAsyncBackgroundJob('INDEXER_ENABLED', 'INDEXER', startIndexer);

    // Inject cctpMint + agentFetch into bridge activity poller (circular dep'i kır)
    bridgeActivityService.setMintInjection(
      agentWalletService.cctpMint,
      (agentId) => agentService.getAgentWithKeyById(agentId),
    );
    startOptionalBackgroundJob('BRIDGE_POLLER_ENABLED', 'Bridge poller', () => bridgeActivityService.startPoller());

    // Start scheduled loops only when their specific lane is enabled.
    startOptionalAsyncBackgroundJob('ORACLE_LOOP_ENABLED', 'ORACLE_LOOP', () => agentQueue.scheduleOracleLoop());
    startOptionalAsyncBackgroundJob('MARKET_ANALYSIS_LOOP_ENABLED', 'MARKET_ANALYSIS_LOOP', () => agentQueue.scheduleMarketAnalysisLoop());
    startOptionalAsyncBackgroundJob('DEFI_LOOP_ENABLED', 'DEFI_LOOP', () => agentQueue.scheduleDefiLoop());
    startOptionalAsyncBackgroundJob('DAILY_TASKS_ENABLED', 'DAILY_TASKS', () => agentQueue.scheduleDailyTasks());

    if (isEnvEnabled('QUEUE_WORKERS_ENABLED', true)) {
      setTimeout(() => {
        agentQueue.resumeLocalWorkers().catch(err => console.error('[QUEUE] resume startup error', err));
      }, Math.max(QUEUE_WORKER_STARTUP_DELAY_MS, 0));
      console.log(`[BOOT] Queue workers will resume in ${Math.max(QUEUE_WORKER_STARTUP_DELAY_MS, 0) / 1000}s`);
    } else {
      console.log('[BOOT] Queue workers disabled via QUEUE_WORKERS_ENABLED=false');
    }
  } else {
    console.log('[BOOT] Background jobs disabled via BACKGROUND_JOBS_ENABLED=false');
  }

  const server = app.listen(PORT, () =>
    console.log(`[SERVER] Arc Machina backend running on port ${PORT} (${process.env.NODE_ENV})`),
  );

  let shutdownStarted = false;
  const shutdown = async (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;

    console.log(`[BOOT] ${signal} received, shutting down gracefully`);

    stopSecurityFreezeRecovery();

    if (typeof agentQueue.pauseLocalWorkers === 'function') {
      await agentQueue.pauseLocalWorkers(true).catch((err) => {
        console.error('[BOOT] Queue pause before shutdown failed:', err);
      });
    }

    await Promise.allSettled([
      new Promise((resolve) => server.close(resolve)),
      typeof agentQueue.close === 'function' ? agentQueue.close() : Promise.resolve(),
    ]);

    process.exit(0);
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      console.error('[BOOT] Graceful shutdown failed:', err);
      process.exit(1);
    });
  });

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      console.error('[BOOT] Graceful shutdown failed:', err);
      process.exit(1);
    });
  });
}

bootstrap().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

module.exports = app; // for testing
