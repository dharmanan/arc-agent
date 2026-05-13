// @ts-nocheck
'use strict';
/**
 * Agent Queue — Bull (Redis-backed)
 *
 * Job types:
 *  - INCOMING_TRANSFER   → notify agent, optionally run LLM analysis
 *  - MARKET_ANALYSIS     → scheduled or triggered by indexer price events
 *  - AGENT_TX            → autonomous tx execution (smart mode only)
 *  - ORACLE_QUERY        → oracle data fetch + decision (oracle_enabled agents only)
 *
 * Concurrency: 5 workers. Failed jobs retry 3× with exponential backoff.
 */
const Bull        = require('bull');
const db          = require('../db');
const llmService  = require('../services/llmService');
const ruleEngine  = require('../services/ruleEngine');
const oracle      = require('../services/oracle');
const protocols   = require('../services/protocols');
const { recordReputationEvent, EVENT_TYPES } = require('../services/reputationService');
const agentWalletService = require('../services/agentWalletService');
const { ethers }         = require('ethers');

// Dev-only: wallet addresses that bypass all daily task limits (comma-separated env var)
const DEV_BYPASS_ADDRS = new Set(
  (process.env.DEV_BYPASS_AGENT_ADDRESSES || '')
    .split(',').map(a => a.trim().toLowerCase()).filter(Boolean),
);

// Upstash Redis: connect via URL (rediss://...)
// Local Docker: connect via host/port
const redisConnection = process.env.REDIS_URL
  ? process.env.REDIS_URL
  : {
      host:     process.env.REDIS_HOST || 'localhost',
      port:     parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
    };

const queue = new Bull('agent-jobs', redisConnection, {
  defaultJobOptions: {
    attempts:    3,
    backoff:     { type: 'exponential', delay: 2000 },
    removeOnComplete: 50,
    removeOnFail:     20,
  },
  settings: {
    // Default stalledInterval=5s = 864k Redis cmds/month → over Upstash free limit.
    // At 300s: ~17k cmds/month from stall checks alone — safe for 500k/month budget.
    stalledInterval:  300_000, // check stalled jobs every 5 min
    lockDuration:     300_000, // job lock TTL must be >= stalledInterval
    lockRenewTime:    150_000, // renew lock at half lockDuration
    maxStalledCount:  2,
  },
});

// ── Engine selector — use LLM when key is available, fall back to rule engine ──
async function resolveEngine(agent) {
  if (!agent?.llm_api_key_encrypted) return { engine: ruleEngine, apiKey: null };
  try {
    const { decrypt } = require('../services/cryptoService');
    const apiKey = decrypt(agent.llm_api_key_encrypted);
    return apiKey ? { engine: llmService, apiKey } : { engine: ruleEngine, apiKey: null };
  } catch {
    return { engine: ruleEngine, apiKey: null };
  }
}

// ── Job processor ─────────────────────────────────────────────────────────────
queue.process('INCOMING_TRANSFER', 5, async (job) => {
  const { agentId, chain, amountUsdc, from, isSmartMode, eventId, skipTransactionRecord } = job.data;
  console.log(`[QUEUE] INCOMING_TRANSFER agent=${agentId} amount=${amountUsdc} chain=${chain}`);

  const { rows: [senderAgent] } = await db.query(
    `SELECT id, name
       FROM agents
      WHERE LOWER(wallet_address) = LOWER($1)
      LIMIT 1`,
    [from],
  );
  const senderMeta = senderAgent
    ? { senderAgentId: senderAgent.id, senderAgentName: senderAgent.name }
    : {};

  // Mark event as processed
  if (eventId) {
    await db.query('UPDATE chain_events SET processed = TRUE WHERE id = $1', [eventId]);
  }

  if (!skipTransactionRecord) {
    let txHash = null;
    let toAddress = null;

    if (eventId) {
      const { rows: [event] } = await db.query(
        'SELECT tx_hash, data FROM chain_events WHERE id = $1',
        [eventId],
      );
      txHash = event?.tx_hash || null;
      toAddress = event?.data?.to || null;
    }

    if (txHash) {
      const { rows: existing } = await db.query(
        `SELECT id
           FROM transactions
          WHERE agent_id = $1
            AND type = 'receive'
            AND tx_hash = $2
          LIMIT 1`,
        [agentId, txHash],
      );
      if (existing.length === 0) {
        await db.query(
          `INSERT INTO transactions (agent_id, type, from_chain, to_chain, token, amount_usdc, from_address, to_address, tx_hash, status, meta)
           VALUES ($1, 'receive', $2, $2, 'USDC', $3, $4, $5, $6, 'confirmed', $7)`,
          [agentId, chain, amountUsdc, from, toAddress, txHash, JSON.stringify(senderMeta)],
        );
      }
    } else {
      await db.query(
        `INSERT INTO transactions (agent_id, type, from_chain, to_chain, token, amount_usdc, from_address, status, meta)
         VALUES ($1, 'receive', $2, $2, 'USDC', $3, $4, 'confirmed', $5)`,
        [agentId, chain, amountUsdc, from, JSON.stringify(senderMeta)],
      );
    }
  }

  if (!isSmartMode) {
    // Base mode — transaction is already recorded for the frontend poller
    return { ok: true, action: 'recorded' };
  }

  // Smart mode — run market analysis (LLM if key present, rule engine otherwise)
  const { rows: [agent] } = await db.query(
    'SELECT id, llm_model, llm_api_key_encrypted FROM agents WHERE id = $1',
    [agentId],
  );

  try {
    const { engine, apiKey } = await resolveEngine(agent);
    const { decision, engine: usedEngine } = await engine.analyzeMarket({
      chain, token: 'USDC', model: agent?.llm_model, apiKey, agentId,
    });
    console.log(`[QUEUE] INCOMING_TRANSFER decision (${usedEngine || 'llm'}) for agent ${agentId}:`, decision.slice(0, 100));
    return { ok: true, action: 'analyzed', engine: usedEngine || 'llm', decision };
  } catch (err) {
    console.error('[QUEUE] Analysis error:', err.message);
    return { ok: true, action: 'analysis_failed', error: err.message };
  }
});

queue.process('MARKET_ANALYSIS', 2, async (job) => {
  const { agentId, chain, token } = job.data;
  console.log(`[QUEUE] MARKET_ANALYSIS agent=${agentId}`);

  const { rows: [agent] } = await db.query(
    'SELECT llm_model, llm_api_key_encrypted FROM agents WHERE id = $1 AND is_smart_mode = TRUE',
    [agentId],
  );
  if (!agent) return { ok: false, reason: 'agent not in smart mode' };

  const { engine, apiKey } = await resolveEngine(agent);
  const result = await engine.analyzeMarket({ chain, token, model: agent.llm_model, apiKey, agentId });
  console.log(`[QUEUE] MARKET_ANALYSIS (${result.engine || 'llm'}) for agent ${agentId}`);
  return result;
});

// ── ORACLE_QUERY ───────────────────────────────────────────────────────────────
// Runs for agents with oracle_enabled = TRUE only.
// Fetches forex + pool data, builds an arb signal, then runs it through the
// rule engine (or LLM when key present). Decision is logged to the DB.
// Schedule: external caller (e.g. cron in server.js bootstrap) enqueues this
// every ORACLE_LOOP_INTERVAL_MS (default 30 min) per eligible agent.
const ORACLE_LOOP_INTERVAL_MS = parseInt(process.env.ORACLE_LOOP_INTERVAL_MS || '1800000', 10);
const CURVE_USDC_EURC_POOL    = process.env.CURVE_USDC_EURC_POOL || null;
const DEFI_LOOP_INTERVAL_MS   = parseInt(process.env.DEFI_LOOP_INTERVAL_MS   || '3600000',  10); // default 1h
const DAILY_DEFI_LOOP_CAP     = 10;

queue.process('ORACLE_QUERY', 2, async (job) => {
  const { agentId } = job.data;
  console.log(`[QUEUE] ORACLE_QUERY agent=${agentId}`);

  // Reload agent — double-check flag (may have been toggled off since job was queued)
  const { rows: [agent] } = await db.query(
    `SELECT id, llm_model, llm_api_key_encrypted, oracle_enabled,
            daily_market_analysis_count, daily_limit_reset_at,
            daily_tasks_enabled
     FROM agents WHERE id = $1`,
    [agentId],
  );

  if (!agent)                  return { ok: false, reason: 'agent_not_found' };
  if (!agent.oracle_enabled)   return { ok: false, reason: 'oracle_disabled' };

  // Reset daily counter if it's a new day
  const resetAt   = new Date(agent.daily_limit_reset_at);
  const nowUtc    = new Date();
  const newDay    = (nowUtc - resetAt) >= 86_400_000; // 24 h
  if (newDay) {
    await db.query(
      `UPDATE agents
       SET daily_market_analysis_count = 0,
           daily_free_task_count       = 0,
           daily_limit_reset_at        = NOW()
       WHERE id = $1`,
      [agentId],
    );
    agent.daily_market_analysis_count = 0;
  }

  // Daily cap: max 48 oracle queries per agent (every 30 min × 24h)
  const DAILY_ORACLE_CAP = 48;
  if (agent.daily_market_analysis_count >= DAILY_ORACLE_CAP) {
    console.log(`[QUEUE] ORACLE_QUERY agent=${agentId} daily cap reached`);
    return { ok: false, reason: 'daily_cap_reached', count: agent.daily_market_analysis_count };
  }

  // ── Fetch oracle data ──────────────────────────────────────────────────────
  let forexRate, poolState;
  try {
    forexRate = await oracle.getForexRate('EURC', 'USDC');
    poolState  = CURVE_USDC_EURC_POOL
      ? await oracle.getCurvePoolState('USDC-EURC', CURVE_USDC_EURC_POOL)
      : oracle.getMockPoolState('USDC-EURC', forexRate.rate);
  } catch (err) {
    console.error(`[QUEUE] ORACLE_QUERY fetch error agent=${agentId}:`, err.message);
    return { ok: false, reason: 'oracle_fetch_error', error: err.message };
  }

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

  // ── Run through engine ─────────────────────────────────────────────────────
  const { engine, apiKey } = await resolveEngine(agent);
  let decision = null;
  try {
    const result = await engine.analyzeMarket({
      chain: 'arc-testnet', token: 'USDC',
      model: agent.llm_model, apiKey, agentId,
      context: { signal, forexRate, poolState },
    });
    decision = result.decision;
    console.log(`[QUEUE] ORACLE_QUERY decision (${result.engine || 'llm'}) agent=${agentId}:`, String(decision).slice(0, 120));
  } catch (err) {
    console.error(`[QUEUE] ORACLE_QUERY engine error agent=${agentId}:`, err.message);
  }

  // ── Increment counter + log ────────────────────────────────────────────────
  await db.query(
    'UPDATE agents SET daily_market_analysis_count = daily_market_analysis_count + 1 WHERE id = $1',
    [agentId],
  );

  // Log the signal + decision to transactions table as an 'oracle_signal' record
  if (signal.opportunity.found) {
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, 'oracle_signal', 'arc-testnet', 'arc-testnet', 'USDC', $2, 'pending', $3::jsonb)`,
      [
        agentId,
        signal.opportunity.expectedProfitUsdc,
        JSON.stringify({ signal, decision }),
      ],
    );
  }

  // Reputation hook — fire-and-forget, never blocks
  recordReputationEvent(agentId, EVENT_TYPES.ORACLE_QUERY).catch(() => {});

  return { ok: true, found: signal.opportunity.found, confidence: signal.opportunity.confidence, decision };
});

// ── Schedule oracle queries for all eligible agents ──────────────────────────
// Called from server.js bootstrap once DB is ready.
async function scheduleOracleLoop() {
  if (!ORACLE_LOOP_INTERVAL_MS || ORACLE_LOOP_INTERVAL_MS < 60_000) return;

  setInterval(async () => {
    try {
      const { rows } = await db.query(
        `SELECT id FROM agents
         WHERE oracle_enabled = TRUE
           AND status NOT IN ('locked', 'inactive')`,
      );
      for (const { id } of rows) {
        await queue.add('ORACLE_QUERY', { agentId: id }, { jobId: `oracle-${id}-${Date.now()}` });
      }
      if (rows.length > 0) {
        console.log(`[ORACLE_LOOP] Queued ${rows.length} oracle job(s)`);
      }
    } catch (err) {
      console.error('[ORACLE_LOOP] Schedule error:', err.message);
    }
  }, ORACLE_LOOP_INTERVAL_MS);

  console.log(`[ORACLE_LOOP] Started — interval ${ORACLE_LOOP_INTERVAL_MS / 60000} min`);
}

// ── DEFI_LOOP ─────────────────────────────────────────────────────────────────
// Runs for agents with defi_loop_enabled = TRUE only.
// Flow: oracle fetch → arb signal → engine decision → protocol tx (unless DRY_RUN).
// Hard cap: 10 runs per agent per day (daily_defi_loop_count).
const DRY_RUN   = process.env.DRY_RUN === 'true';

queue.process('DEFI_LOOP', 2, async (job) => {
  const { agentId } = job.data;
  console.log(`[QUEUE] DEFI_LOOP agent=${agentId} dry=${DRY_RUN}`);

  // Reload agent — verify flag still on + fetch encrypted key
  const { rows: [agent] } = await db.query(
    `SELECT id, llm_model, llm_api_key_encrypted,
            defi_loop_enabled, oracle_enabled,
            daily_defi_loop_count, daily_limit_reset_at,
            daily_limit_usdc, max_trade_usdc, slippage_percent,
            wallet_address, encrypted_private_key
     FROM agents WHERE id = $1`,
    [agentId],
  );

  if (!agent)                   return { ok: false, reason: 'agent_not_found' };
  if (!agent.defi_loop_enabled) return { ok: false, reason: 'defi_loop_disabled' };

  // Reset daily counters if new day
  const resetAt = new Date(agent.daily_limit_reset_at);
  const nowUtc  = new Date();
  if ((nowUtc - resetAt) >= 86_400_000) {
    await db.query(
      `UPDATE agents
       SET daily_defi_loop_count       = 0,
           daily_auto_tx_count         = 0,
           daily_limit_reset_at        = NOW()
       WHERE id = $1`,
      [agentId],
    );
    agent.daily_defi_loop_count = 0;
  }

  // Daily cap check
  if (agent.daily_defi_loop_count >= DAILY_DEFI_LOOP_CAP) {
    console.log(`[QUEUE] DEFI_LOOP agent=${agentId} daily cap reached (${DAILY_DEFI_LOOP_CAP})`);
    return { ok: false, reason: 'daily_cap_reached', count: agent.daily_defi_loop_count };
  }

  // ── Oracle data ────────────────────────────────────────────────────────────
  let forexRate, poolState;
  try {
    forexRate = await oracle.getForexRate('EURC', 'USDC');
    poolState  = CURVE_USDC_EURC_POOL
      ? await oracle.getCurvePoolState('USDC-EURC', CURVE_USDC_EURC_POOL)
      : oracle.getMockPoolState('USDC-EURC', forexRate.rate);
  } catch (err) {
    console.error(`[QUEUE] DEFI_LOOP oracle error agent=${agentId}:`, err.message);
    return { ok: false, reason: 'oracle_fetch_error', error: err.message };
  }

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

  // ── Engine decision ────────────────────────────────────────────────────────
  const { engine, apiKey } = await resolveEngine(agent);
  let decision = null;
  try {
    const result = await engine.analyzeMarket({
      chain: 'arc-testnet', token: 'USDC',
      model: agent.llm_model, apiKey, agentId,
      context: { signal, forexRate, poolState },
    });
    decision = result.decision;
  } catch (err) {
    console.error(`[QUEUE] DEFI_LOOP engine error agent=${agentId}:`, err.message);
    // Non-fatal — still increment counter and log
  }

  // Increment loop counter regardless of outcome
  await db.query(
    'UPDATE agents SET daily_defi_loop_count = daily_defi_loop_count + 1 WHERE id = $1',
    [agentId],
  );

  // No opportunity or engine said hold → stop here
  if (!signal.opportunity.found || signal.opportunity.confidence === 'LOW') {
    return { ok: true, action: 'hold', reason: 'no_opportunity', confidence: signal.opportunity.confidence };
  }

  // ── Execute swap ──────────────────────────────────────────────────────────
  const swapAmountUsdc = Math.min(
    signal.opportunity.steps?.[0]?.amountUsdc ?? 1000,
    parseFloat(agent.max_trade_usdc) || 200,
  );

  if (DRY_RUN) {
    console.log(`[QUEUE] DEFI_LOOP DRY_RUN agent=${agentId} — would swap ${swapAmountUsdc} USDC→EURC`);
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, 'defi_loop_dry', 'arc-testnet', 'arc-testnet', 'USDC', $2, 'dry_run', $3::jsonb)`,
      [agentId, swapAmountUsdc, JSON.stringify({ signal, decision, dryRun: true })],
    );
    return { ok: true, action: 'dry_run', amountUsdc: swapAmountUsdc };
  }

  // Real swap — requires decrypted private key
  if (!agent.encrypted_private_key) {
    return { ok: false, reason: 'no_private_key' };
  }

  let txResult;
  try {
    const { decrypt } = require('../services/cryptoService');
    const privateKey  = decrypt(agent.encrypted_private_key);

    const EURC_ADDRESS       = process.env.EURC_ADDRESS || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
    const USDC_ADDRESS       = process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
    const poolAddress        = CURVE_USDC_EURC_POOL;

    if (!poolAddress) {
      return { ok: false, reason: 'pool_address_not_configured' };
    }

    txResult = await protocols.executeCurveSwap({
      poolAddress,
      tokenInAddress: USDC_ADDRESS,
      indexIn:        0,
      indexOut:       1,
      amountIn:       String(swapAmountUsdc),
      slippagePct:    parseFloat(agent.slippage_percent) || 0.5,
      agentPrivateKey: privateKey,
    });

    // Increment auto-tx counter
    await db.query(
      'UPDATE agents SET daily_auto_tx_count = daily_auto_tx_count + 1 WHERE id = $1',
      [agentId],
    );

    // Log transaction
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, tx_hash, meta)
       VALUES ($1, 'defi_loop_swap', 'arc-testnet', 'arc-testnet', 'EURC', $2, 'confirmed', $3, $4::jsonb)`,
      [agentId, swapAmountUsdc, txResult.txHash, JSON.stringify({ signal, decision, amountOut: txResult.amountOut })],
    );

    console.log(`[QUEUE] DEFI_LOOP swap OK agent=${agentId} tx=${txResult.txHash}`);
    recordReputationEvent(agentId, EVENT_TYPES.DEFI_LOOP).catch(() => {});
    return { ok: true, action: 'swap_executed', txHash: txResult.txHash, amountOut: txResult.amountOut };

  } catch (err) {
    console.error(`[QUEUE] DEFI_LOOP swap error agent=${agentId}:`, err.message);
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, 'defi_loop_swap', 'arc-testnet', 'arc-testnet', 'USDC', $2, 'failed', $3::jsonb)`,
      [agentId, swapAmountUsdc, JSON.stringify({ error: err.message, signal })],
    );
    return { ok: false, reason: 'swap_error', error: err.message };
  }
});

// ── Schedule DeFi loop for all eligible agents ────────────────────────────────
async function scheduleDefiLoop() {
  if (!DEFI_LOOP_INTERVAL_MS || DEFI_LOOP_INTERVAL_MS < 60_000) return;

  setInterval(async () => {
    try {
      const { rows } = await db.query(
        `SELECT id FROM agents
         WHERE defi_loop_enabled = TRUE
           AND status NOT IN ('locked', 'inactive')`,
      );
      for (const { id } of rows) {
        await queue.add('DEFI_LOOP', { agentId: id }, { jobId: `defi-${id}-${Date.now()}` });
      }
      if (rows.length > 0) {
        console.log(`[DEFI_LOOP] Queued ${rows.length} defi loop job(s)`);
      }
    } catch (err) {
      console.error('[DEFI_LOOP] Schedule error:', err.message);
    }
  }, DEFI_LOOP_INTERVAL_MS);

  console.log(`[DEFI_LOOP] Started — interval ${DEFI_LOOP_INTERVAL_MS / 60000} min, DRY_RUN=${DRY_RUN}`);
}

// ── DAILY FREE TASKS (Tier 1) ──────────────────────────────────────────────────
// Built-in deterministic tasks only.
// Users see 5 featured tasks per UTC day and explicitly run the ones they want.
// No LLM key required — pure HTTP + onchain reads / DB summaries.

const DAILY_FREE_TASK_CAP = parseInt(process.env.DAILY_FREE_TASK_CAP || '5', 10);
const BUILTIN_DAILY_TASKS = [
  {
    id: 'DAILY_PRICE_REPORT',
    title: 'FX Price Report',
    description: 'EURC/USDC + BRLA/USDC live rates via Frankfurter',
  },
  {
    id: 'DAILY_POOL_HEALTH',
    title: 'Pool Health Check',
    description: 'Curve pool spread%, virtual_price and coin balances',
  },
  {
    id: 'DAILY_YIELD_RANK',
    title: 'Yield Ranking',
    description: 'Top 3 APY opportunities across USDC/EURC pools',
  },
  {
    id: 'DAILY_ARB_SCAN',
    title: 'Arb Signal Scan',
    description: 'Stablecoin spread arbitrage opportunity detector',
  },
  {
    id: 'DAILY_WALLET_DIGEST',
    title: 'Wallet Digest',
    description: '24h activity summary and agent wallet balance snapshot',
  },
  {
    id: 'DAILY_FOREX_MATRIX',
    title: 'FX Matrix',
    description: 'EURC, BRLA, MXNB and JPYC snapshots against USDC',
  },
  {
    id: 'DAILY_USDC_PEG_CHECK',
    title: 'USDC Peg Check',
    description: 'USDC/USD peg deviation and depeg risk snapshot',
  },
  {
    id: 'DAILY_MARKET_TAPE',
    title: 'Market Tape',
    description: 'USDC, EURC, ETH and BTC prices with 24h move summary',
  },
  {
    id: 'DAILY_PROTOCOL_TVL',
    title: 'Protocol TVL Monitor',
    description: 'Aave, Morpho and Maple TVL change snapshot',
  },
  {
    id: 'DAILY_ACTIVITY_RECAP',
    title: 'Activity Recap',
    description: 'Recent transaction mix and latest activity recap',
  },
];
const DAILY_TASK_TYPES = BUILTIN_DAILY_TASKS.map(task => task.id);

const PAID_TASK_FEE_USDC = parseFloat(process.env.PAID_TASK_FEE_USDC || '0.10');

// ── TIER-2 PAID TASK CATALOG ───────────────────────────────────────────────────
const BUILTIN_TIER2_TASKS = [
  {
    id:          'EXEC_CURVE_SWAP',
    title:       'Curve Swap',
    description: 'Execute a Curve stablecoin pool swap (e.g. USDC → EURC)',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_CCTP_BRIDGE',
    title:       'CCTP Bridge',
    description: 'Agent auto-bridges USDC cross-chain via Circle CCTP V2 (free, no platform fee)',
    tier:        1,
    fee_usdc:    0,
  },
  {
    id:          'EXEC_YIELD_MOVE',
    title:       'Yield Move',
    description: 'Supply or withdraw USDC from Aave for yield optimization',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_ARB',
    title:       'Arb Execution',
    description: 'Execute a stablecoin arbitrage trade based on oracle arb signal',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_REBALANCE',
    title:       'Portfolio Rebalance',
    description: 'Swap to rebalance USDC/EURC portfolio to a target ratio',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
];

// Combined seed list for task_catalog (Tier-1 free + Tier-2 paid)
const _ALL_SEEDED_TASKS = [
  ...BUILTIN_DAILY_TASKS.map(t => ({ ...t, tier: 1, fee_usdc: 0 })),
  ...BUILTIN_TIER2_TASKS,
];

async function ensureTaskCatalogSeeded() {
  const placeholders = _ALL_SEEDED_TASKS
    .map((_, index) => {
      const offset = index * 5;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, TRUE)`;
    })
    .join(', ');

  const params = [];
  for (const task of _ALL_SEEDED_TASKS) {
    params.push(task.id, task.title, task.description, task.tier, task.fee_usdc);
  }

  await db.query(
    `INSERT INTO task_catalog (id, title, description, tier, fee_usdc, enabled)
     VALUES ${placeholders}
     ON CONFLICT (id) DO UPDATE
     SET title = EXCLUDED.title,
         description = EXCLUDED.description,
         tier = EXCLUDED.tier,
         fee_usdc = EXCLUDED.fee_usdc,
         enabled = TRUE`,
    params,
  );
}

// Helper: guard + day reset shared by all DAILY_* jobs
async function _dailyTaskGuard(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, daily_tasks_enabled, daily_free_task_count, daily_limit_reset_at,
            wallet_address
     FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!agent)                       return { ok: false, reason: 'agent_not_found' };
  // Dev bypass: skip all limit checks for test addresses
  if (DEV_BYPASS_ADDRS.size > 0 && DEV_BYPASS_ADDRS.has((agent.wallet_address || '').toLowerCase())) {
    return { ok: true, agent };
  }
  if (!agent.daily_tasks_enabled)   return { ok: false, reason: 'daily_tasks_disabled' };

  // Daily reset
  if ((new Date() - new Date(agent.daily_limit_reset_at)) >= 86_400_000) {
    await db.query(
      `UPDATE agents SET daily_free_task_count = 0, daily_limit_reset_at = NOW() WHERE id = $1`,
      [agentId],
    );
    agent.daily_free_task_count = 0;
  }
  if (agent.daily_free_task_count >= DAILY_FREE_TASK_CAP) {
    return { ok: false, reason: 'daily_task_cap_reached', count: agent.daily_free_task_count };
  }
  return { ok: true, agent };
}

// Helper: write result + increment counter + reputation (fire-and-forget)
async function _saveTaskResult(agentId, taskId, payload) {
  await db.query(
    `INSERT INTO agent_task_results (agent_id, task_id, payload) VALUES ($1, $2, $3::jsonb)`,
    [agentId, taskId, JSON.stringify(payload)],
  );
  await db.query(
    `UPDATE agents SET daily_free_task_count = daily_free_task_count + 1 WHERE id = $1`,
    [agentId],
  );
  recordReputationEvent(agentId, EVENT_TYPES.DAILY_TASK).catch(() => {});
}

// ── TIER-2 PAID TASK HELPERS ──────────────────────────────────────────────────

const DAILY_PAID_TASK_CAP  = parseInt(process.env.DAILY_PAID_TASK_CAP || '5', 10);
const _REVENUE_POOL_ADDR   = process.env.REVENUE_POOL_ADDRESS;
const _POOL_ABI            = ['function depositFee(uint256 amount) external'];
const _USDC_POOL_ABI       = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
];
const _PAID_FEE_UNITS = BigInt(Math.round(PAID_TASK_FEE_USDC * 1_000_000)); // 6 decimals

// Check daily paid cap; reset if a new UTC day has started
async function _paidTaskGuard(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, daily_tasks_enabled, daily_paid_task_count, daily_limit_reset_at,
            wallet_address, encrypted_private_key
     FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!agent)                     return { ok: false, reason: 'agent_not_found' };
  // Dev bypass: skip all limit checks for test addresses
  if (DEV_BYPASS_ADDRS.size > 0 && DEV_BYPASS_ADDRS.has((agent.wallet_address || '').toLowerCase())) {
    return { ok: true, agent };
  }
  if (!agent.daily_tasks_enabled) return { ok: false, reason: 'daily_tasks_disabled' };

  if ((new Date() - new Date(agent.daily_limit_reset_at)) >= 86_400_000) {
    await db.query(
      `UPDATE agents SET daily_paid_task_count = 0, daily_limit_reset_at = NOW() WHERE id = $1`,
      [agentId],
    );
    agent.daily_paid_task_count = 0;
  }
  if (agent.daily_paid_task_count >= DAILY_PAID_TASK_CAP) {
    return { ok: false, reason: 'daily_paid_cap_reached', count: agent.daily_paid_task_count };
  }
  return { ok: true, agent };
}

// Deposit 0.10 USDC from relayer into ArcRevenuePool (best-effort, fire-and-forget)
async function _depositPlatformFee() {
  if (DRY_RUN || !_REVENUE_POOL_ADDR || !process.env.RELAYER_PRIVATE_KEY) return;
  try {
    const rpc      = process.env.ARC_TESTNET_RPC || 'https://rpc.arc-testnet.io';
    const provider = new ethers.JsonRpcProvider(rpc);
    const relayer  = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
    const usdcAddr = process.env.USDC_ADDRESS_ARC || '0x3600000000000000000000000000000000000000';
    const usdcCtr  = new ethers.Contract(usdcAddr, _USDC_POOL_ABI, relayer);
    const bal      = await usdcCtr.balanceOf(relayer.address);
    if (bal < _PAID_FEE_UNITS) {
      console.warn(`[PAID_TASK] Relayer USDC=${bal} < fee=${_PAID_FEE_UNITS} — deposit skipped`);
      return;
    }
    await (await usdcCtr.approve(_REVENUE_POOL_ADDR, _PAID_FEE_UNITS)).wait(1);
    const pool = new ethers.Contract(_REVENUE_POOL_ADDR, _POOL_ABI, relayer);
    await (await pool.depositFee(_PAID_FEE_UNITS)).wait(1);
    console.log(`[PAID_TASK] depositFee(${_PAID_FEE_UNITS}) → ArcRevenuePool OK`);
  } catch (err) {
    console.warn('[PAID_TASK] fee deposit failed (non-fatal):', err.message);
  }
}

// Write result only — no cap increment, no fee deposit (used for free execution tasks)
async function _saveResultOnly(agentId, taskId, payload) {
  await db.query(
    `INSERT INTO agent_task_results (agent_id, task_id, payload) VALUES ($1, $2, $3::jsonb)`,
    [agentId, taskId, JSON.stringify(payload)],
  );
  recordReputationEvent(agentId, EVENT_TYPES.DAILY_TASK).catch(() => {});
}

// Guard for free execution tasks (no daily cap check, only tasks_enabled flag)
async function _freeExecGuard(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, daily_tasks_enabled, wallet_address, private_key_encrypted,
            daily_limit_usdc, max_trade_usdc, slippage_percent
     FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!agent) return { ok: false, reason: 'agent_not_found' };
  if (DEV_BYPASS_ADDRS.size > 0 && DEV_BYPASS_ADDRS.has((agent.wallet_address || '').toLowerCase())) {
    return { ok: true, agent };
  }
  if (!agent.daily_tasks_enabled) return { ok: false, reason: 'daily_tasks_disabled' };
  return { ok: true, agent };
}

// Write result + increment daily_paid_task_count + fire-and-forget fee deposit
async function _savePaidTaskResult(agentId, taskId, payload) {
  await db.query(
    `INSERT INTO agent_task_results (agent_id, task_id, payload) VALUES ($1, $2, $3::jsonb)`,
    [agentId, taskId, JSON.stringify(payload)],
  );
  await db.query(
    `UPDATE agents SET daily_paid_task_count = daily_paid_task_count + 1 WHERE id = $1`,
    [agentId],
  );
  recordReputationEvent(agentId, EVENT_TYPES.DAILY_TASK).catch(() => {});
  _depositPlatformFee().catch(() => {}); // non-blocking
}

// ── DAILY_PRICE_REPORT ────────────────────────────────────────────────────────
queue.process('DAILY_PRICE_REPORT', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const [eurc, brla] = await Promise.allSettled([
    oracle.getForexRate('EURC', 'USDC'),
    oracle.getForexRate('BRLA', 'USDC'),
  ]);
  const payload = {
    EURC_USDC: eurc.status === 'fulfilled' ? eurc.value : null,
    BRLA_USDC: brla.status === 'fulfilled' ? brla.value : null,
    summary:   [
      eurc.status === 'fulfilled' ? `EURC/USDC ${eurc.value.rate}` : null,
      brla.status === 'fulfilled' ? `BRLA/USDC ${brla.value.rate}` : null,
    ].filter(Boolean).join(' · ') || 'FX snapshot captured for EURC and BRLA.',
    fetchedAt:  new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_PRICE_REPORT', payload);
  return { ok: true, payload };
});

// ── DAILY_POOL_HEALTH ─────────────────────────────────────────────────────────
queue.process('DAILY_POOL_HEALTH', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const forexRate = await oracle.getForexRate('EURC', 'USDC');
  const poolState  = CURVE_USDC_EURC_POOL
    ? await oracle.getCurvePoolState('USDC-EURC', CURVE_USDC_EURC_POOL)
    : oracle.getMockPoolState('USDC-EURC', forexRate.rate);

  const spread = Math.abs(poolState.impliedRate - forexRate.rate) / forexRate.rate;
  const health  = spread > 0.02 ? 'alert' : spread > 0.005 ? 'opportunity' : 'healthy';

  const payload = {
    spread,
    health,
    poolState,
    summary: `Pool health ${health} with ${(spread * 100).toFixed(2)}% spread versus forex.`,
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_POOL_HEALTH', payload);
  return { ok: true, payload };
});

// ── DAILY_YIELD_RANK ──────────────────────────────────────────────────────────
queue.process('DAILY_YIELD_RANK', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const opportunities = await oracle.getYieldOpportunities();
  const top3 = (opportunities || []).slice(0, 3);

  const payload = {
    top3,
    summary: top3.length
      ? `Top yield venues: ${top3.map(item => `${item.name} ${item.apy}%`).join(' · ')}`
      : 'Yield ranking completed with no eligible pools.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_YIELD_RANK', payload);
  return { ok: true, payload };
});

// ── DAILY_ARB_SCAN ────────────────────────────────────────────────────────────
queue.process('DAILY_ARB_SCAN', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const forexRate = await oracle.getForexRate('EURC', 'USDC');
  const poolState  = CURVE_USDC_EURC_POOL
    ? await oracle.getCurvePoolState('USDC-EURC', CURVE_USDC_EURC_POOL)
    : oracle.getMockPoolState('USDC-EURC', forexRate.rate);

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

  const payload = {
    signal: signal.opportunity.found ? signal : null,
    summary: signal.opportunity.found
      ? `Arbitrage signal ${signal.opportunity.confidence} confidence, est. ${Number(signal.opportunity.expectedProfitUsdc || 0).toFixed(2)} USDC profit.`
      : 'No profitable arbitrage setup was found in the latest scan.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_ARB_SCAN', payload);
  return { ok: true, payload };
});

// ── DAILY_WALLET_DIGEST ───────────────────────────────────────────────────────
queue.process('DAILY_WALLET_DIGEST', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const [agentRow, taskCount] = await Promise.all([
    db.query(`SELECT wallet_address, daily_free_task_count, daily_auto_tx_count FROM agents WHERE id = $1`, [agentId]),
    db.query(
      `SELECT COUNT(*) AS cnt FROM agent_task_results WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [agentId],
    ),
  ]);
  const a = agentRow.rows[0] || {};
  const payload = {
    walletAddress:    a.wallet_address,
    tasksToday:       parseInt(taskCount.rows[0]?.cnt || '0', 10),
    dailyFreeCount:   a.daily_free_task_count ?? 0,
    dailyAutoTxCount: a.daily_auto_tx_count   ?? 0,
    summary:          `Wallet digest captured with ${parseInt(taskCount.rows[0]?.cnt || '0', 10)} task records and ${a.daily_auto_tx_count ?? 0} auto tx in the last 24h.`,
    fetchedAt:        new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_WALLET_DIGEST', payload);
  return { ok: true, payload };
});

// ── DAILY_FOREX_MATRIX ───────────────────────────────────────────────────────
queue.process('DAILY_FOREX_MATRIX', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const rates = await oracle.getAllForexRates();
  const pairs = Object.entries(rates || {});
  const strongest = pairs.sort((left, right) => (right[1]?.rate ?? 0) - (left[1]?.rate ?? 0))[0];

  const payload = {
    rates,
    summary: strongest
      ? `Tracked ${pairs.length} fiat-backed pairs. Highest quote: ${strongest[0]} ${strongest[1].rate}.`
      : 'Tracked fiat-backed stablecoin pairs for the daily matrix.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_FOREX_MATRIX', payload);
  return { ok: true, payload };
});

// ── DAILY_USDC_PEG_CHECK ─────────────────────────────────────────────────────
queue.process('DAILY_USDC_PEG_CHECK', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const peg = await oracle.getUsdcPegDeviation();
  const payload = {
    ...peg,
    summary: peg.isDepegRisk
      ? `USDC peg deviation is ${peg.deviationPct}% — depeg risk flagged.`
      : `USDC peg deviation is ${peg.deviationPct}% — no depeg risk detected.`,
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_USDC_PEG_CHECK', payload);
  return { ok: true, payload };
});

// ── DAILY_MARKET_TAPE ────────────────────────────────────────────────────────
queue.process('DAILY_MARKET_TAPE', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const prices = await oracle.getMultipleTokenPrices(['USDC', 'EURC', 'ETH', 'BTC']);
  const movers = Object.values(prices || {}).sort((left, right) => Math.abs(right.change24h || 0) - Math.abs(left.change24h || 0));
  const leadMover = movers[0];

  const payload = {
    prices,
    summary: leadMover
      ? `Tracked ${movers.length} assets. Largest 24h move: ${leadMover.symbol} ${Number(leadMover.change24h || 0).toFixed(2)}%.`
      : 'Market tape snapshot completed for tracked assets.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_MARKET_TAPE', payload);
  return { ok: true, payload };
});

// ── DAILY_PROTOCOL_TVL ───────────────────────────────────────────────────────
queue.process('DAILY_PROTOCOL_TVL', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const protocolIds = ['aave', 'morpho', 'maple'];
  const snapshots = await Promise.allSettled(
    protocolIds.map(async (protocolId) => ({
      protocolId,
      snapshot: await oracle.getProtocolTvl(protocolId),
    })),
  );

  const protocols = snapshots
    .filter(result => result.status === 'fulfilled' && result.value.snapshot)
    .map(result => result.value);
  const largest = protocols.slice().sort((left, right) => (right.snapshot.tvl ?? 0) - (left.snapshot.tvl ?? 0))[0];

  const payload = {
    protocols,
    summary: largest
      ? `Largest TVL snapshot: ${largest.protocolId} at ${Math.round((largest.snapshot.tvl || 0) / 1_000_000)}M USD.`
      : 'Protocol TVL snapshot completed, but no live TVL data was available.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_PROTOCOL_TVL', payload);
  return { ok: true, payload };
});

// ── DAILY_ACTIVITY_RECAP ─────────────────────────────────────────────────────
queue.process('DAILY_ACTIVITY_RECAP', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const [countsResult, recentResult] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_count,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
         COUNT(*) FILTER (WHERE type = 'receive') AS receive_count,
         COUNT(*) FILTER (WHERE type = 'bridge') AS bridge_count,
         COUNT(*) FILTER (WHERE type = 'swap') AS swap_count
       FROM transactions
       WHERE agent_id = $1
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [agentId],
    ),
    db.query(
      `SELECT type, status, token, amount_usdc, created_at
       FROM transactions
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT 3`,
      [agentId],
    ),
  ]);

  const counts = countsResult.rows[0] || {};
  const payload = {
    counts,
    recent: recentResult.rows,
    summary: `Recent activity: ${parseInt(counts.total || '0', 10)} total, ${parseInt(counts.confirmed_count || '0', 10)} confirmed, ${parseInt(counts.receive_count || '0', 10)} receive events in the last 24h.`,
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_ACTIVITY_RECAP', payload);
  return { ok: true, payload };
});

// ── TIER-2 PAID TASK PROCESSORS ───────────────────────────────────────────────
// Each processor: guard → execute DeFi op → save result + fee deposit (fire-and-forget)

// ── EXEC_CURVE_SWAP ───────────────────────────────────────────────────────────
queue.process('EXEC_CURVE_SWAP', 2, async (job) => {
  const { agentId, params = {} } = job.data;
  const guard = await _paidTaskGuard(agentId);
  if (!guard.ok) return guard;
  const { agent } = guard;

  const poolAddress = params.poolAddress || process.env.CURVE_USDC_EURC_POOL || null;
  if (!poolAddress) return { ok: false, reason: 'curve_pool_not_configured' };

  const indexIn   = params.indexIn  ?? 0;                   // 0 = USDC
  const indexOut  = params.indexOut ?? 1;                   // 1 = EURC
  const amountIn  = String(params.amountIn ?? '1');         // 1 USDC default
  const tokenIn   = params.tokenInAddress
    || (indexIn === 0 ? (process.env.USDC_ADDRESS_ARC || '0x3600000000000000000000000000000000000000')
                      : process.env.EURC_ADDRESS_ARC || '');

  if (DRY_RUN) {
    const payload = { dryRun: true, poolAddress, indexIn, indexOut, amountIn, executedAt: new Date().toISOString() };
    await _savePaidTaskResult(agentId, 'EXEC_CURVE_SWAP', payload);
    return { ok: true, payload };
  }

  const { decrypt } = require('../services/cryptoService');
  const result = await protocols.executeCurveSwap({
    poolAddress,
    tokenInAddress: tokenIn,
    indexIn,
    indexOut,
    amountIn,
    agentPrivateKey: decrypt(agent.encrypted_private_key),
  });

  const payload = { ...result, poolAddress, indexIn, indexOut, amountIn, executedAt: new Date().toISOString() };
  await _savePaidTaskResult(agentId, 'EXEC_CURVE_SWAP', payload);
  return { ok: true, payload };
});

// ── EXEC_CCTP_BRIDGE ──────────────────────────────────────────────────────────
// Free (Tier-1) — no platform fee charged.
queue.process('EXEC_CCTP_BRIDGE', 1, async (job) => {
  const { agentId, params = {} } = job.data;
  const guard = await _freeExecGuard(agentId);
  if (!guard.ok) return guard;
  const { agent } = guard;

  const fromChain  = params.fromChain  || 'arc';
  const toChain    = params.toChain    || 'base';
  const amountUsdc = params.amountUsdc || 1;

  if (DRY_RUN) {
    const payload = { dryRun: true, fromChain, toChain, amountUsdc, executedAt: new Date().toISOString() };
    await _saveResultOnly(agentId, 'EXEC_CCTP_BRIDGE', payload);
    return { ok: true, payload };
  }

  const result = await agentWalletService.agentBridgeFull({
    agent,
    fromChain,
    toChain,
    amountUsdc,
    onStep: (step) => console.log(`[EXEC_CCTP_BRIDGE] agent=${agentId} step=${step}`),
  });

  const payload = { ...result, fromChain, toChain, amountUsdc, executedAt: new Date().toISOString() };
  await _saveResultOnly(agentId, 'EXEC_CCTP_BRIDGE', payload);
  return { ok: true, payload };
});

// ── EXEC_YIELD_MOVE ───────────────────────────────────────────────────────────
queue.process('EXEC_YIELD_MOVE', 2, async (job) => {
  const { agentId, params = {} } = job.data;
  const guard = await _paidTaskGuard(agentId);
  if (!guard.ok) return guard;
  const { agent } = guard;

  const assetAddress = params.assetAddress
    || process.env.USDC_ADDRESS_ARC
    || '0x3600000000000000000000000000000000000000';
  const amount = String(params.amount ?? '1');  // 1 USDC default
  const action = params.action || 'supply';     // 'supply' | 'withdraw'

  if (DRY_RUN) {
    const payload = { dryRun: true, assetAddress, amount, action, executedAt: new Date().toISOString() };
    await _savePaidTaskResult(agentId, 'EXEC_YIELD_MOVE', payload);
    return { ok: true, payload };
  }

  const { decrypt } = require('../services/cryptoService');
  const privateKey  = decrypt(agent.encrypted_private_key);
  const result = action === 'withdraw'
    ? await protocols.executeAaveWithdraw({ assetAddress, amount, agentPrivateKey: privateKey })
    : await protocols.executeAaveSupply({ assetAddress, amount, agentPrivateKey: privateKey });

  const payload = { ...result, assetAddress, amount, action, executedAt: new Date().toISOString() };
  await _savePaidTaskResult(agentId, 'EXEC_YIELD_MOVE', payload);
  return { ok: true, payload };
});

// ── EXEC_ARB ──────────────────────────────────────────────────────────────────
queue.process('EXEC_ARB', 2, async (job) => {
  const { agentId, params = {} } = job.data;
  const guard = await _paidTaskGuard(agentId);
  if (!guard.ok) return guard;
  const { agent } = guard;

  const poolAddress = params.poolAddress || process.env.CURVE_USDC_EURC_POOL || null;
  const amountIn    = String(params.amountIn ?? '1');

  // Fetch oracle arb signal
  const [forexRate] = await Promise.all([oracle.getForexRate('EURC', 'USDC')]);
  const arbSignal   = oracle.buildArbSignal({
    strategy:      'stablecoin_fx',
    forexRate:     forexRate.rate,
    poolRate:      forexRate.rate,
    poolFee:       0.0004,
    baseToken:     'EURC',
    quoteToken:    'USDC',
    poolLiquidity: 0,
    priceImpacts:  {},
  });

  const payload = { signal: arbSignal, poolAddress, amountIn, executedAt: new Date().toISOString() };

  if (DRY_RUN || !poolAddress || arbSignal.confidence === 'LOW') {
    payload.dryRun  = DRY_RUN || !poolAddress;
    payload.skipped = !DRY_RUN && !!poolAddress && arbSignal.confidence === 'LOW';
    await _savePaidTaskResult(agentId, 'EXEC_ARB', payload);
    return { ok: true, payload };
  }

  const { decrypt } = require('../services/cryptoService');
  const privateKey  = decrypt(agent.encrypted_private_key);
  const indexIn     = arbSignal.action === 'buy_eurc' ? 0 : 1;
  const indexOut    = arbSignal.action === 'buy_eurc' ? 1 : 0;
  const tokenIn     = indexIn === 0
    ? (process.env.USDC_ADDRESS_ARC || '0x3600000000000000000000000000000000000000')
    : (process.env.EURC_ADDRESS_ARC || '');

  const swapResult = await protocols.executeCurveSwap({
    poolAddress,
    tokenInAddress: tokenIn,
    indexIn,
    indexOut,
    amountIn,
    agentPrivateKey: privateKey,
  });
  payload.swap = swapResult;
  await _savePaidTaskResult(agentId, 'EXEC_ARB', payload);
  return { ok: true, payload };
});

// ── EXEC_REBALANCE ────────────────────────────────────────────────────────────
queue.process('EXEC_REBALANCE', 2, async (job) => {
  const { agentId, params = {} } = job.data;
  const guard = await _paidTaskGuard(agentId);
  if (!guard.ok) return guard;
  const { agent } = guard;

  const fromToken = params.fromToken || 'USDC';
  const toToken   = params.toToken   || 'EURC';
  const amountIn  = params.amountIn  || 1;
  const slippage  = params.slippage  || 0.5;

  if (DRY_RUN) {
    const payload = { dryRun: true, fromToken, toToken, amountIn, executedAt: new Date().toISOString() };
    await _savePaidTaskResult(agentId, 'EXEC_REBALANCE', payload);
    return { ok: true, payload };
  }

  const result = await agentWalletService.agentSwap({
    agent,
    fromToken,
    toToken,
    amountIn,
    slippagePct: slippage,
  });

  const payload = { ...result, fromToken, toToken, amountIn, executedAt: new Date().toISOString() };
  await _savePaidTaskResult(agentId, 'EXEC_REBALANCE', payload);
  return { ok: true, payload };
});

async function scheduleDailyTasks() {
  await ensureTaskCatalogSeeded();
  console.log(`[DAILY_TASKS] Catalog ready — ${DAILY_TASK_TYPES.length} Tier-1 free tasks + ${BUILTIN_TIER2_TASKS.length} Tier-2 paid tasks`);
}

// ── Event listeners ────────────────────────────────────────────────────────────
queue.on('failed',    (job, err) => console.error(`[QUEUE] Job ${job.id} failed:`, err.message));
queue.on('completed', (job)      => console.log(`[QUEUE] Job ${job.id} completed`));

// ── Export the queue for use in indexerService ─────────────────────────────────
module.exports = queue;
module.exports.scheduleOracleLoop = scheduleOracleLoop;
module.exports.scheduleDefiLoop   = scheduleDefiLoop;
module.exports.scheduleDailyTasks = scheduleDailyTasks;
