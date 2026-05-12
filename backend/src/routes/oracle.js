'use strict';
/**
 * GET /api/oracle/stablecoin-fx?pair=EURC/USDC   — forex rate vs pool rate comparison
 * GET /api/oracle/pool-state?pool=USDC-EURC       — Curve pool on-chain state
 * GET /api/oracle/yield-rank?asset=USDC           — DeFi yield ranking
 * GET /api/oracle/arb-signal?strategy=stablecoin_fx — arbitrage opportunity signal
 * GET /api/oracle/status                          — service health + cache stats
 *
 * All endpoints require authentication.
 * oracle_enabled flag is checked only for /arb-signal (heavier, opt-in).
 * Other endpoints are informational (read-only, low cost).
 */
const router          = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const oracle          = require('../services/oracle');
const agentService    = require('../services/agentService');

router.use(requireAuth);

// Pool address lookup — from env (mirrors .env.example from oracle source)
const CURVE_POOLS = {
  'USDC-EURC':  process.env.CURVE_USDC_EURC_POOL  || null,
  'EURC-USDC':  process.env.CURVE_USDC_EURC_POOL  || null,
  'WUSDC-USDC': process.env.CURVE_WUSDC_USDC_POOL || null,
  'USDC-USYC':  process.env.CURVE_USDC_USYC_POOL  || null,
};

// ── GET /api/oracle/status ────────────────────────────────────────────────────
router.get('/status', (_req, res) => {
  res.json({
    service:    'ARC DeFi Oracle',
    network:    'arc-testnet',
    timestamp:  new Date().toISOString(),
    cache:      oracle.getCacheStats(),
  });
});

// ── GET /api/oracle/stablecoin-fx ─────────────────────────────────────────────
// ?pair=EURC/USDC   (default)
router.get('/stablecoin-fx', async (req, res, next) => {
  try {
    const pairParam = (req.query.pair || 'EURC/USDC').toString().toUpperCase();
    const [base, quote = 'USDC'] = pairParam.split('/');

    const [forexRate, usdcPeg] = await Promise.all([
      oracle.getForexRate(base, quote),
      oracle.getUsdcPegDeviation(),
    ]);

    res.json({
      pair:       `${base}/${quote}`,
      forex:      forexRate,
      usdcPeg,
      fetchedAt:  new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── GET /api/oracle/pool-state ────────────────────────────────────────────────
// ?pool=USDC-EURC   (default)
router.get('/pool-state', async (req, res, next) => {
  try {
    const poolKey     = (req.query.pool || 'USDC-EURC').toString().toUpperCase();
    const poolAddress = CURVE_POOLS[poolKey];

    if (!poolAddress) {
      // No on-chain address yet → return mock state with note
      const [base] = poolKey.split('-');
      const mockRate = base === 'WUSDC' ? 1.001 : 1.0912; // EURC fallback
      return res.json({
        note:      'Pool address not configured — returning mock state',
        poolKey,
        state:     oracle.getMockPoolState(poolKey, mockRate),
      });
    }

    const state = await oracle.getCurvePoolState(poolKey, poolAddress);
    res.json({ poolKey, state });
  } catch (err) { next(err); }
});

// ── GET /api/oracle/yield-rank ────────────────────────────────────────────────
// ?asset=USDC&minApy=1.0   (defaults)
router.get('/yield-rank', async (req, res, next) => {
  try {
    const asset  = (req.query.asset  || 'USDC').toString().toUpperCase();
    const minApy = parseFloat(req.query.minApy || '1.0');

    const protocols = await oracle.getYieldOpportunities(asset, isNaN(minApy) ? 1.0 : minApy);

    const recommendation = protocols[0]
      ? {
          protocol:  protocols[0].name,
          apy:       protocols[0].apy,
          reasoning: `Highest APY among known ARC testnet protocols for ${asset}`,
        }
      : null;

    res.json({
      asset,
      timestamp:      new Date().toISOString(),
      protocols,
      recommendation,
    });
  } catch (err) { next(err); }
});

// ── GET /api/oracle/arb-signal ────────────────────────────────────────────────
// ?strategy=stablecoin_fx&agentId=<id>
// Requires oracle_enabled = true on the agent (opt-in guard)
router.get('/arb-signal', async (req, res, next) => {
  try {
    const strategy = (req.query.strategy || 'stablecoin_fx').toString();
    const agentId  = req.query.agentId?.toString();

    // Opt-in guard — only if agentId provided and oracle_enabled check requested
    if (agentId) {
      const agent = await agentService.getAgent(agentId, req.user.userId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      if (!agent.features?.oracleEnabled) {
        return res.status(403).json({
          error:   'oracle_disabled',
          message: 'Enable the Oracle Data Feed feature on your agent first.',
        });
      }
    }

    if (strategy === 'stablecoin_fx') {
      // Fetch forex + pool in parallel
      const [forexRate, poolState] = await Promise.all([
        oracle.getForexRate('EURC', 'USDC'),
        oracle.getForexRate('EURC', 'USDC').then(fx => {
          const poolAddress = CURVE_POOLS['USDC-EURC'];
          if (!poolAddress) return oracle.getMockPoolState('USDC-EURC', fx.rate);
          return oracle.getCurvePoolState('USDC-EURC', poolAddress);
        }),
      ]);

      const signal = oracle.buildArbSignal({
        strategy:      'stablecoin_fx',
        forexRate:     forexRate.rate,
        poolRate:      poolState.impliedRate,
        poolFee:       poolState.fee,
        poolLiquidity: (poolState.reserves?.token0 ?? 0) + (poolState.reserves?.token1 ?? 0),
        priceImpacts:  poolState.priceImpact,
        baseToken:     'EURC',
        quoteToken:    'USDC',
      });

      return res.json(signal);
    }

    res.status(400).json({ error: `Unknown strategy: ${strategy}`, supported: ['stablecoin_fx'] });
  } catch (err) { next(err); }
});

// ── PUBLIC endpoints (x402 nanopayment — no JWT required) ────────────────────
// These are accessible by anyone on the internet; payment is the only gate.
// oraclePayment(endpointKey) middleware returns 402 if X-Payment-Tx is absent or invalid.
const oraclePayment = require('../middleware/oraclePayment');

const publicRouter = require('express').Router();  // no requireAuth

// GET /api/oracle/public/stablecoin-fx
publicRouter.get('/stablecoin-fx', oraclePayment('stablecoin-fx'), async (req, res, next) => {
  try {
    const pairParam = (req.query.pair || 'EURC/USDC').toString().toUpperCase();
    const [base, quote = 'USDC'] = pairParam.split('/');
    const [forexRate, usdcPeg] = await Promise.all([
      oracle.getForexRate(base, quote),
      oracle.getUsdcPegDeviation(),
    ]);
    res.json({ pair: `${base}/${quote}`, forex: forexRate, usdcPeg, fetchedAt: new Date().toISOString() });
  } catch (err) { next(err); }
});

// GET /api/oracle/public/pool-state
publicRouter.get('/pool-state', oraclePayment('pool-state'), async (req, res, next) => {
  try {
    const poolKey     = (req.query.pool || 'USDC-EURC').toString().toUpperCase();
    const poolAddress = CURVE_POOLS[poolKey];
    if (!poolAddress) {
      const mockRate = 1.0912;
      return res.json({ note: 'Pool address not configured — returning mock state', poolKey, state: oracle.getMockPoolState(poolKey, mockRate) });
    }
    const state = await oracle.getCurvePoolState(poolKey, poolAddress);
    res.json({ poolKey, state });
  } catch (err) { next(err); }
});

// GET /api/oracle/public/yield-rank
publicRouter.get('/yield-rank', oraclePayment('yield-rank'), async (req, res, next) => {
  try {
    const asset     = (req.query.asset || 'USDC').toString().toUpperCase();
    const minApy    = parseFloat(req.query.minApy || '1.0');
    const protocols = await oracle.getYieldOpportunities(asset, isNaN(minApy) ? 1.0 : minApy);
    res.json({ asset, protocols: protocols.slice(0, 5), fetchedAt: new Date().toISOString() });
  } catch (err) { next(err); }
});

// GET /api/oracle/public/arb-signal
// Redacted: confidence=LOW results only return summary; HIGH returns full signal (higher price)
publicRouter.get('/arb-signal', oraclePayment('arb-signal'), async (req, res, next) => {
  try {
    const [forexRate, poolState] = await Promise.all([
      oracle.getForexRate('EURC', 'USDC'),
      oracle.getForexRate('EURC', 'USDC').then(fx => {
        const poolAddress = CURVE_POOLS['USDC-EURC'];
        return poolAddress
          ? oracle.getCurvePoolState('USDC-EURC', poolAddress)
          : oracle.getMockPoolState('USDC-EURC', fx.rate);
      }),
    ]);
    const signal = oracle.buildArbSignal({
      strategy: 'stablecoin_fx', forexRate: forexRate.rate, poolRate: poolState.impliedRate,
      poolFee: poolState.fee, baseToken: 'EURC', quoteToken: 'USDC',
      poolLiquidity: (poolState.reserves?.token0 ?? 0) + (poolState.reserves?.token1 ?? 0),
      priceImpacts: poolState.priceImpact,
    });
    res.json(signal);
  } catch (err) { next(err); }
});

// GET /api/oracle/public/revenue — total collected fees (public, no auth, transparency)
publicRouter.get('/revenue', async (_req, res, next) => {
  try {
    const db = require('../db');
    const { rows: [row] } = await db.query(
      `SELECT COALESCE(SUM(amount_usdc),0)::float AS total_usdc,
              COUNT(*)::int AS request_count
       FROM oracle_payments`,
    );
    res.json({ totalUsdc: row.total_usdc, requestCount: row.request_count });
  } catch (err) { next(err); }
});

router.use('/public', publicRouter);

module.exports = router;

