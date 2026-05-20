'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

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
const db                   = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust proxy headers (needed for rate limiter behind Codespace/nginx proxy)
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

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
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
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
  res.json({ name: 'Arc Machina API', version: '1.0.0', status: 'running', docs: '/health' });
});

// ── Health probe ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const health = { status: 'ok', db: 'ok', redis: 'ok', ts: new Date().toISOString() };
  let httpStatus = 200;

  try {
    await db.query('SELECT 1');
  } catch (err) {
    health.db = 'error';
    health.dbError = err.message;
    health.status = 'degraded';
    httpStatus = 503;
  }

  try {
    const redisClient = await ensureRedisReady();
    await redisClient.ping();
  } catch (err) {
    health.redis = 'error';
    health.redisError = err.message;
    health.status = 'degraded';
    httpStatus = 503;
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
  if (status >= 500) console.error('[ERROR]', err);
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

  startChainEventRetention();
  startJobRetention();
  startLpRewardEpochSnapshotWriter();

  // Start blockchain event indexer (non-blocking)
  startIndexer().catch(err => console.error('[INDEXER] startup error', err));

  // Inject cctpMint + agentFetch into bridge activity poller (circular dep'i kır)
  bridgeActivityService.setMintInjection(
    agentWalletService.cctpMint,
    (agentId) => agentService.getAgentWithKeyById(agentId),
  );
  bridgeActivityService.startPoller();

  // Start oracle query loop (only runs for agents with oracle_enabled = TRUE)
  agentQueue.scheduleOracleLoop().catch(err => console.error('[ORACLE_LOOP] startup error', err));

  // Start DeFi loop (only runs for agents with defi_loop_enabled = TRUE)
  agentQueue.scheduleDefiLoop().catch(err => console.error('[DEFI_LOOP] startup error', err));

  // Start daily free task scheduler (only for agents with daily_tasks_enabled = TRUE)
  agentQueue.scheduleDailyTasks().catch(err => console.error('[DAILY_TASKS] startup error', err));

  app.listen(PORT, () =>
    console.log(`[SERVER] Arc Machina backend running on port ${PORT} (${process.env.NODE_ENV})`),
  );
}

bootstrap().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

module.exports = app; // for testing
