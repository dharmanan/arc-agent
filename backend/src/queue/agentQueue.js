'use strict';
/**
 * Agent Queue — Bull (Redis-backed)
 *
 * Job types:
 *  - INCOMING_TRANSFER   → notify agent, optionally run LLM analysis
 *  - MARKET_ANALYSIS     → scheduled or triggered by indexer price events
 *  - AGENT_TX            → autonomous tx execution (smart mode only)
 *
 * Concurrency: 5 workers. Failed jobs retry 3× with exponential backoff.
 */
const Bull       = require('bull');
const db         = require('../db');
const llmService = require('../services/llmService');

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

  // Smart mode — run LLM analysis of incoming payment
  const { rows: [agent] } = await db.query(
    'SELECT id, llm_model, llm_api_key_encrypted FROM agents WHERE id = $1',
    [agentId],
  );
  if (!agent?.llm_api_key_encrypted) return { ok: true, action: 'no_llm_key' };

  try {
    const apiKey = llmService.resolveApiKey ? await (async() => {
      const { decrypt } = require('../services/cryptoService');
      return decrypt(agent.llm_api_key_encrypted);
    })() : null;

    if (!apiKey) return { ok: true, action: 'no_api_key' };

    const { decision } = await llmService.analyzeMarket({
      chain, token: 'USDC', model: agent.llm_model, apiKey, agentId,
    });

    console.log(`[QUEUE] LLM decision for agent ${agentId}:`, decision.slice(0, 100));
    return { ok: true, action: 'llm_analyzed', decision };
  } catch (err) {
    console.error('[QUEUE] LLM error:', err.message);
    return { ok: true, action: 'llm_failed', error: err.message };
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

  const { decrypt } = require('../services/cryptoService');
  const apiKey = decrypt(agent.llm_api_key_encrypted);

  const result = await llmService.analyzeMarket({ chain, token, model: agent.llm_model, apiKey, agentId });
  return result;
});

// ── Event listeners ────────────────────────────────────────────────────────────
queue.on('failed',    (job, err) => console.error(`[QUEUE] Job ${job.id} failed:`, err.message));
queue.on('completed', (job)      => console.log(`[QUEUE] Job ${job.id} completed`));

// ── Export the queue for use in indexerService ─────────────────────────────────
module.exports = queue;
