'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const morgan       = require('morgan');
const authRoutes         = require('./routes/auth');
const agentRoutes        = require('./routes/agents');
const transactionRoutes  = require('./routes/transactions');
const bridgeRoutes       = require('./routes/bridge');
const { globalRateLimit }  = require('./middleware/rateLimit');
const { startIndexer }     = require('./services/indexerService');
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

// ── Root info ─────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ name: 'Arc Machina API', version: '1.0.0', status: 'running', docs: '/health' });
});

// ── Health probe ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
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
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  // Verify DB connectivity
  await db.query('SELECT 1');
  console.log('[DB] PostgreSQL connected');

  // Start blockchain event indexer (non-blocking)
  startIndexer().catch(err => console.error('[INDEXER] startup error', err));

  // Inject cctpMint + agentFetch into bridge activity poller (circular dep'i kır)
  bridgeActivityService.setMintInjection(
    agentWalletService.cctpMint,
    (agentId) => agentService.getAgentWithKeyById(agentId),
  );
  bridgeActivityService.startPoller();

  app.listen(PORT, () =>
    console.log(`[SERVER] Arc Machina backend running on port ${PORT} (${process.env.NODE_ENV})`),
  );
}

bootstrap().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

module.exports = app; // for testing
