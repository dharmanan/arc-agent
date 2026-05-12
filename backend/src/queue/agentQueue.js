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
  const { agentId, chain, amountUsdc, from, isSmartMode } = job.data;
  console.log(`[QUEUE] INCOMING_TRANSFER agent=${agentId} amount=${amountUsdc} chain=${chain}`);

  // Mark event as processed
  if (job.data.eventId) {
    await db.query('UPDATE chain_events SET processed = TRUE WHERE id = $1', [job.data.eventId]);
  }

  if (!isSmartMode) {
    // Base mode — just log the event (frontend polls /status)
    await db.query(
      `INSERT INTO transactions (agent_id, type, from_chain, to_chain, token, amount_usdc, from_address, status)
       VALUES ($1, 'receive', $2, $2, 'USDC', $3, $4, 'confirmed')`,
      [agentId, chain, amountUsdc, from],
    );
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
// All 5 tasks share: defi_loop_enabled OR daily_tasks_enabled check,
// daily_free_task_count cap (5/day), agent_task_results write.
// No LLM key required — pure HTTP + onchain reads.

const DAILY_FREE_TASK_CAP = parseInt(process.env.DAILY_FREE_TASK_CAP || '5', 10);

// Helper: guard + day reset shared by all DAILY_* jobs
async function _dailyTaskGuard(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, daily_tasks_enabled, daily_free_task_count, daily_limit_reset_at
     FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!agent)                       return { ok: false, reason: 'agent_not_found' };
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

  const payload = { spread, health, poolState, fetchedAt: new Date().toISOString() };
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

  const payload = { top3, fetchedAt: new Date().toISOString() };
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

  const payload = { signal: signal.opportunity.found ? signal : null, fetchedAt: new Date().toISOString() };
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
    fetchedAt:        new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_WALLET_DIGEST', payload);
  return { ok: true, payload };
});

// ── Schedule daily tasks for all eligible agents ──────────────────────────────
// Called from server.js bootstrap.  Each task type is queued once per day.
const DAILY_TASK_INTERVAL_MS = parseInt(process.env.DAILY_TASK_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);
const DAILY_TASK_TYPES = [
  'DAILY_PRICE_REPORT',
  'DAILY_POOL_HEALTH',
  'DAILY_YIELD_RANK',
  'DAILY_ARB_SCAN',
  'DAILY_WALLET_DIGEST',
];

async function scheduleDailyTasks() {
  if (!DAILY_TASK_INTERVAL_MS || DAILY_TASK_INTERVAL_MS < 60_000) return;

  const enqueue = async () => {
    try {
      const { rows } = await db.query(
        `SELECT id FROM agents
         WHERE daily_tasks_enabled = TRUE
           AND status NOT IN ('locked', 'inactive')`,
      );
      for (const { id } of rows) {
        for (const taskType of DAILY_TASK_TYPES) {
          await queue.add(taskType, { agentId: id }, {
            jobId: `${taskType.toLowerCase()}-${id}-${new Date().toISOString().slice(0, 10)}`,
            removeOnComplete: 200,
          });
        }
      }
      if (rows.length > 0) {
        console.log(`[DAILY_TASKS] Queued ${DAILY_TASK_TYPES.length} tasks × ${rows.length} agent(s)`);
      }
    } catch (err) {
      console.error('[DAILY_TASKS] Schedule error:', err.message);
    }
  };

  await enqueue(); // run immediately on startup
  setInterval(enqueue, DAILY_TASK_INTERVAL_MS);
  console.log(`[DAILY_TASKS] Started — interval ${DAILY_TASK_INTERVAL_MS / 3600000}h`);
}

// ── Event listeners ────────────────────────────────────────────────────────────
queue.on('failed',    (job, err) => console.error(`[QUEUE] Job ${job.id} failed:`, err.message));
queue.on('completed', (job)      => console.log(`[QUEUE] Job ${job.id} completed`));

// ── Export the queue for use in indexerService ─────────────────────────────────
module.exports = queue;
module.exports.scheduleOracleLoop = scheduleOracleLoop;
module.exports.scheduleDefiLoop   = scheduleDefiLoop;
module.exports.scheduleDailyTasks = scheduleDailyTasks;
