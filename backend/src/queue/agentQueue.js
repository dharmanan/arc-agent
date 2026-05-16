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
const Redis       = require('ioredis');
const { ethers }  = require('ethers');
const db          = require('../db');
const llmService  = require('../services/llmService');
const ruleEngine  = require('../services/ruleEngine');
const oracle      = require('../services/oracle');
const protocols   = require('../services/protocols');
const { recordReputationEvent, EVENT_TYPES } = require('../services/reputationService');
const taskEconomyService = require('../services/agenticEconomy/taskEconomyService');
const agenticTaskExecutionService = require('../services/agenticEconomy/agenticTaskExecutionService');
const { getDailyLimitBypass, isDailyLimitBypassed } = require('../services/dailyLimitBypass');
const taskRunService = require('../services/taskRunService');

const ARC_RPC_URL = process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const ARC_USDC_ADDRESS = process.env.USDC_ADDRESS_ARC || process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const ERC20_BALANCE_ABI = ['function balanceOf(address account) view returns (uint256)'];

function shouldUseDryRun(agent) {
  return GLOBAL_DRY_RUN;
}

function normalizeUsdcAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric * 1_000_000) / 1_000_000;
}

async function getArcUsdcBalance(walletAddress) {
  if (!walletAddress) return 0;

  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
  const contract = new ethers.Contract(ARC_USDC_ADDRESS, ERC20_BALANCE_ABI, provider);
  const rawBalance = await contract.balanceOf(walletAddress);
  return normalizeUsdcAmount(ethers.formatUnits(rawBalance, 6));
}

async function getAgentPermissionMap(agentId) {
  if (!agentId) return {};

  const { rows } = await db.query(
    'SELECT permission_key, is_enabled FROM agent_permissions WHERE agent_id = $1',
    [agentId],
  );

  return Object.fromEntries(rows.map(row => [row.permission_key, row.is_enabled]));
}

function getErrorText(value) {
  return value == null ? '' : String(value).trim();
}

function buildExecutionErrorDetails(err) {
  const rawMessage = getErrorText(err?.message || err);
  const reason = getErrorText(err?.reason);
  const providerMessage = getErrorText(err?.info?.error?.message);
  const shortMessage = getErrorText(err?.shortMessage);
  const code = getErrorText(err?.code);
  const haystack = [rawMessage, reason, providerMessage, shortMessage, code].filter(Boolean).join(' ');

  let summary = reason || providerMessage || shortMessage || rawMessage || 'Transaction failed before confirmation.';
  if (/ERC20:\s*transfer amount exceeds balance/i.test(haystack)) {
    summary = 'Agent wallet balance was too low for this trade.';
  } else if (/nonce too low|nonce has already been used|NONCE_EXPIRED/i.test(haystack)) {
    summary = 'Another transaction already used this wallet nonce before this swap was submitted.';
  } else if (/insufficient funds/i.test(haystack)) {
    summary = 'Agent wallet did not have enough native gas token for this transaction.';
  } else if ((/transaction execution reverted/i.test(rawMessage) || code === 'CALL_EXCEPTION') && !reason) {
    summary = 'The on-chain swap reverted, but the RPC node did not return a decoded contract reason.';
  }

  return {
    error: rawMessage || providerMessage || shortMessage || 'Unknown execution error',
    errorSummary: summary,
    errorCode: code || null,
    errorReason: reason || null,
    errorProviderMessage: providerMessage || null,
    errorShortMessage: shortMessage || null,
    errorTxHash: err?.receipt?.hash || err?.transactionHash || null,
    errorReceiptStatus: err?.receipt?.status ?? null,
  };
}

// Upstash Redis: connect via URL (rediss://...)
// Local Docker: connect via host/port
const redisConnection = process.env.REDIS_URL
  ? process.env.REDIS_URL
  : {
      host:     process.env.REDIS_HOST || 'localhost',
      port:     parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
    };

function createBullRedisClient(type) {
  const client = typeof redisConnection === 'string'
    ? new Redis(redisConnection, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: false,
      })
    : new Redis({
        ...redisConnection,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: false,
      });

  // Bull attaches a burst of startup listeners to each ioredis client.
  // Keep the cap comfortably above observed production startup usage.
  client.setMaxListeners(50);

  client.on('error', (err) => {
    console.error(`[QUEUE:${type}]`, err.message);
  });

  return client;
}

const queue = new Bull('agent-jobs', {
  createClient: createBullRedisClient,
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

const REGISTERED_MANUAL_TASK_PROCESSORS = new Map();
const REGISTERED_PAID_TASK_PROCESSORS = new Set();
const PAID_TASK_ACTIVITY_SUPPORTED_IDS = new Set([
  'EXEC_CURVE_SWAP',
  'EXEC_CURVE_LIQUIDITY_ADD',
  'EXEC_CURVE_LIQUIDITY_REMOVE',
  'EXEC_CIRBTC_USDC_ZAP_IN',
  'EXEC_CIRBTC_EURC_ZAP_IN',
  'EXEC_CIRBTC_USDC_LP_REMOVE',
  'EXEC_CIRBTC_EURC_LP_REMOVE',
  'EXEC_CCTP_BRIDGE',
  'EXEC_SEPOLIA_GAS_FANOUT',
  'EXEC_ARB',
  'EXEC_REBALANCE',
]);
const MANUAL_TASK_READY_TIMEOUT_MS = parseInt(process.env.MANUAL_TASK_READY_TIMEOUT_MS || '1200', 10);

function registerTaskProcessor(name, concurrency, handler) {
  const wrappedHandler = async (job) => {
    const taskRunId = job?.data?.taskRunId || null;

    if (taskRunId) {
      await taskRunService.markTaskRunRunning(taskRunId, {
        stageKey: 'starting',
        stageLabel: 'Starting',
        stageDetail: 'Worker accepted the task request and is preparing execution.',
      }).catch(() => {});
    }

    try {
      const result = await handler(job);

      if (taskRunId) {
        if (result && result.ok === false) {
          await taskRunService.failTaskRun(taskRunId, {
            error: result.error || result.reason || 'task_run_failed',
            stageDetail: result.errorSummary || result.error || null,
            resultPayload: result.payload || null,
          }).catch(() => {});
        } else {
          await taskRunService.completeTaskRun(taskRunId, {
            resultPayload: result?.payload || result || {},
            stageDetail: result?.payload?.summary || 'Task completed successfully.',
          }).catch(() => {});
        }
      }

      return result;
    } catch (err) {
      if (taskRunId) {
        await taskRunService.failTaskRun(taskRunId, {
          error: err.message,
          stageDetail: err.message,
        }).catch(() => {});
      }
      throw err;
    }
  };

  REGISTERED_MANUAL_TASK_PROCESSORS.set(name, wrappedHandler);
  queue.process(name, concurrency, wrappedHandler);
}

function _withTimeout(promise, timeoutMs, code) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error(code);
        error.code = code;
        reject(error);
      }, timeoutMs);
    }),
  ]);
}

async function canQueueManualTasks(timeoutMs = MANUAL_TASK_READY_TIMEOUT_MS) {
  try {
    await _withTimeout(queue.isReady(), timeoutMs, 'manual_task_queue_timeout');
    return true;
  } catch (err) {
    console.error('[QUEUE] Manual task queue unavailable:', err.message);
    return false;
  }
}

async function runTaskInline(taskName, data) {
  const handler = REGISTERED_MANUAL_TASK_PROCESSORS.get(taskName);
  if (!handler) {
    throw new Error(`manual_task_processor_missing:${taskName}`);
  }

  return handler({
    id: `inline-${taskName}-${Date.now()}`,
    data,
  });
}

async function queueManualTask(taskName, data) {
  const handler = REGISTERED_MANUAL_TASK_PROCESSORS.get(taskName);
  if (!handler) {
    const error = new Error('manual_task_processor_missing');
    error.code = 'manual_task_processor_missing';
    throw error;
  }

  const manualJob = {
    id: `manual-${taskName}-${data?.agentId || 'unknown'}-${Date.now()}`,
    data,
  };

  setImmediate(() => {
    Promise.resolve(handler(manualJob))
      .then((result) => {
        if (result && result.ok === false) {
          console.warn(`[QUEUE] Job ${manualJob.id} finished with local failure:`, result.reason || result.error || 'task_run_failed');
          return;
        }

        console.log(`[QUEUE] Job ${manualJob.id} completed`);
      })
      .catch((err) => {
        console.error(`[QUEUE] Job ${manualJob.id} failed:`, err.message);
      });
  });

  return {
    id: manualJob.id,
    mode: 'in_process_detached',
  };
}

function _shortTxHash(txHash) {
  if (!txHash || typeof txHash !== 'string' || txHash.length < 12) return null;
  return `${txHash.slice(0, 6)}...${txHash.slice(-4)}`;
}

function _buildBridgeStageMeta(step, params = {}, data = {}) {
  const fromChain = params.fromChain || 'the source chain';
  const toChain = params.toChain || 'the destination chain';
  const burnHash = _shortTxHash(data?.burnTxHash);
  const approveHash = _shortTxHash(data?.approveTxHash);
  const mintHash = _shortTxHash(data?.mintTxHash);
  const attestationLagNote = toChain === 'Arbitrum Sepolia'
    ? 'This attestation leg can take up to 10 minutes before Arbitrum Sepolia is ready to mint.'
    : 'This attestation leg can take a few minutes before the destination mint is ready.';

  switch (step) {
    case 'approving':
      return {
        stageKey: 'bridge_approving',
        stageLabel: 'Approving USDC',
        stageDetail: `Submitting USDC approval on ${fromChain}.`,
      };
    case 'approved':
      return {
        stageKey: 'bridge_approved',
        stageLabel: 'Approval Confirmed',
        stageDetail: approveHash
          ? `Approval confirmed on ${fromChain} (${approveHash}). Preparing the Circle burn.`
          : `Approval confirmed on ${fromChain}. Preparing the Circle burn.`,
      };
    case 'burning':
      return {
        stageKey: 'bridge_burning',
        stageLabel: 'Burning On Source',
        stageDetail: `Submitting the Circle burn transaction on ${fromChain}.`,
      };
    case 'burned':
      return {
        stageKey: 'bridge_burned',
        stageLabel: 'Burn Confirmed',
        stageDetail: burnHash
          ? `Burn confirmed on ${fromChain} (${burnHash}). Waiting for Circle attestation before minting on ${toChain}.`
          : `Burn confirmed on ${fromChain}. Waiting for Circle attestation before minting on ${toChain}.`,
      };
    case 'attesting':
      return {
        stageKey: 'bridge_attesting',
        stageLabel: 'Waiting For Attestation',
        stageDetail: `${attestationLagNote} Keep this task locked until the mint step starts.`,
      };
    case 'attested':
      return {
        stageKey: 'bridge_attested',
        stageLabel: 'Attestation Ready',
        stageDetail: `Circle attestation is ready. Preparing the destination mint on ${toChain}.`,
      };
    case 'minting':
      return {
        stageKey: 'bridge_minting',
        stageLabel: 'Minting On Destination',
        stageDetail: `Submitting receiveMessage on ${toChain}.`,
      };
    case 'complete':
      return {
        stageKey: 'bridge_complete',
        stageLabel: 'Bridge Completed',
        stageDetail: mintHash
          ? `Mint confirmed on ${toChain} (${mintHash}).`
          : `Mint confirmed on ${toChain}.`,
      };
    default:
      return {
        stageKey: 'bridge_running',
        stageLabel: 'Bridge Running',
        stageDetail: `Bridge execution is in progress from ${fromChain} to ${toChain}.`,
      };
  }
}

function _buildGasFanoutStageMeta(step, data = {}) {
  const toChain = data.toChain || 'destination chain';
  const topUpHash = _shortTxHash(data?.topUpTxHash);

  switch (step) {
    case 'preparing':
      return {
        stageKey: 'fanout_preparing',
        stageLabel: 'Preparing Fanout',
        stageDetail: 'Preparing the Sepolia gas fanout to all configured destination testnets.',
      };
    case 'bridging':
      return {
        stageKey: 'fanout_bridging',
        stageLabel: `Bridging To ${toChain}`,
        stageDetail: `Submitting the source-chain bridge leg from Sepolia to ${toChain}.`,
      };
    case 'awaiting_arrival':
      return {
        stageKey: 'fanout_awaiting_arrival',
        stageLabel: `Waiting For ${toChain}`,
        stageDetail: toChain === 'Arbitrum Sepolia'
          ? 'Source tx is confirmed. Arbitrum Sepolia credit can take up to 10 minutes before the destination ETH balance updates.'
          : `Source tx is confirmed. Waiting for the destination ETH balance on ${toChain} to update.`,
      };
    case 'arrived':
      return {
        stageKey: 'fanout_arrived',
        stageLabel: `${toChain} Funded`,
        stageDetail: topUpHash
          ? `Destination ETH balance updated for ${toChain}. Source bridge tx: ${topUpHash}.`
          : `Destination ETH balance updated for ${toChain}.`,
      };
    case 'complete':
      return {
        stageKey: 'fanout_complete',
        stageLabel: 'Gas Fanout Completed',
        stageDetail: 'All destination testnets reported the expected ETH top-up.',
      };
    default:
      return {
        stageKey: 'fanout_running',
        stageLabel: 'Gas Fanout Running',
        stageDetail: 'Sepolia gas fanout is currently in progress.',
      };
  }
}

async function _reportTaskRunStage(taskRunId, stageMeta) {
  if (!taskRunId || !stageMeta) return;

  await taskRunService.updateTaskRunStage(taskRunId, {
    status: 'running',
    stageKey: stageMeta.stageKey,
    stageLabel: stageMeta.stageLabel,
    stageDetail: stageMeta.stageDetail,
  }).catch(() => {});
}

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

function parseStructuredDecision(rawDecision) {
  if (!rawDecision) return null;
  if (typeof rawDecision === 'object') return rawDecision;
  if (typeof rawDecision !== 'string') return null;

  const trimmed = rawDecision.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function evaluateExecutionGate(agent, signal, agentId) {
  const { engine, apiKey } = await resolveEngine(agent);
  const opportunity = {
    ...(signal?.opportunity || {}),
    fromChain: signal?.opportunity?.fromChain || 'arc-testnet',
    amountUsdc: signal?.opportunity?.amountUsdc ?? signal?.opportunity?.steps?.[0]?.amountUsdc ?? 0,
  };

  const result = await engine.getArbitrageDecision({
    opportunity,
    model: agent?.llm_model,
    apiKey,
    agentId,
  });
  const parsed = parseStructuredDecision(result?.decision);
  const verdict = parsed && typeof parsed.execute === 'boolean'
    ? parsed
    : {
        execute: false,
        reason: 'Execution gate returned malformed JSON and was treated as HOLD.',
        suggestedAmount: 0,
      };

  return {
    engine: result?.engine || 'rule',
    decision: result?.decision || null,
    verdict,
    opportunity,
  };
}

const AUTOMATION_STATE_COLUMNS = {
  marketAnalysis: {
    lastRunAt: 'market_analysis_last_run_at',
    lastStatus: 'market_analysis_last_status',
  },
  oracle: {
    lastRunAt: 'oracle_last_run_at',
    lastStatus: 'oracle_last_status',
  },
  defiLoop: {
    lastRunAt: 'defi_loop_last_run_at',
    lastStatus: 'defi_loop_last_status',
  },
};

async function _setAutomationState(agentId, automationKey, status) {
  const columns = AUTOMATION_STATE_COLUMNS[automationKey];
  if (!columns || !agentId) return;

  await db.query(
    `UPDATE agents
     SET ${columns.lastRunAt} = NOW(), ${columns.lastStatus} = $1
     WHERE id = $2`,
    [status, agentId],
  ).catch(() => {});
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
  await _setAutomationState(agentId, 'marketAnalysis', 'running');

  const { rows: [agent] } = await db.query(
    'SELECT llm_model, llm_api_key_encrypted FROM agents WHERE id = $1 AND is_smart_mode = TRUE',
    [agentId],
  );
  if (!agent) {
    await _setAutomationState(agentId, 'marketAnalysis', 'disabled');
    return { ok: false, reason: 'agent not in smart mode' };
  }

  const permissions = await getAgentPermissionMap(agentId);
  if (permissions.defi_scan === false) {
    await _setAutomationState(agentId, 'marketAnalysis', 'permission_blocked');
    return {
      ok: true,
      action: 'hold',
      reason: 'permission_blocked',
      permission: 'defi_scan',
    };
  }

  try {
    const { engine, apiKey } = await resolveEngine(agent);
    const result = await engine.analyzeMarket({ chain, token, model: agent.llm_model, apiKey, agentId });
    console.log(`[QUEUE] MARKET_ANALYSIS (${result.engine || 'llm'}) for agent ${agentId}`);
    await _setAutomationState(agentId, 'marketAnalysis', 'success');
    return result;
  } catch (err) {
    await _setAutomationState(agentId, 'marketAnalysis', 'error');
    throw err;
  }
});

// ── ORACLE_QUERY ───────────────────────────────────────────────────────────────
// Runs for agents with oracle_enabled = TRUE only.
// Fetches forex + pool data, builds an arb signal, then runs it through the
// rule engine (or LLM when key present). Decision is logged to the DB.
// Schedule: external caller (e.g. cron in server.js bootstrap) enqueues this
// every ORACLE_LOOP_INTERVAL_MS (default 30 min) per eligible agent.
const ORACLE_LOOP_INTERVAL_MS = parseInt(process.env.ORACLE_LOOP_INTERVAL_MS || '1800000', 10);
const MARKET_ANALYSIS_LOOP_INTERVAL_MS = parseInt(process.env.MARKET_ANALYSIS_LOOP_INTERVAL_MS || '1800000', 10);
const CURVE_USDC_EURC_POOL    = process.env.CURVE_USDC_EURC_POOL || null;
const DEFI_LOOP_INTERVAL_MS   = parseInt(process.env.DEFI_LOOP_INTERVAL_MS   || '3600000',  10); // default 1h
const DAILY_DEFI_LOOP_CAP     = 10;
const GLOBAL_DRY_RUN          = process.env.DRY_RUN === 'true';

function _getUsdcEurcCurvePool() {
  return oracle.resolveCurvePool('USDC-EURC');
}

function _getEurcUsdcCurvePool() {
  return oracle.resolveCurvePool('EURC-USDC');
}

async function _getOracleStablePoolState(forexRate) {
  const pool = _getEurcUsdcCurvePool();

  if (!pool?.address) {
    return oracle.getMockPoolState('EURC-USDC', forexRate.rate);
  }

  return oracle.getCurvePoolState(pool);
}

queue.process('ORACLE_QUERY', 2, async (job) => {
  const { agentId } = job.data;
  console.log(`[QUEUE] ORACLE_QUERY agent=${agentId}`);
  await _setAutomationState(agentId, 'oracle', 'running');
  const finishOracle = async (status, payload) => {
    await _setAutomationState(agentId, 'oracle', status);
    return payload;
  };

  // Reload agent — double-check flag (may have been toggled off since job was queued)
  const { rows: [agent] } = await db.query(
    `SELECT id, llm_model, llm_api_key_encrypted, oracle_enabled,
            daily_market_analysis_count, daily_limit_reset_at,
            daily_tasks_enabled, defi_loop_enabled, daily_defi_loop_count, wallet_address
     FROM agents WHERE id = $1`,
    [agentId],
  );

  if (!agent)                return finishOracle('missing_agent', { ok: false, reason: 'agent_not_found' });
  if (!agent.oracle_enabled) return finishOracle('disabled', { ok: false, reason: 'oracle_disabled' });

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
  if (!isDailyLimitBypassed(agent) && agent.daily_market_analysis_count >= DAILY_ORACLE_CAP) {
    console.log(`[QUEUE] ORACLE_QUERY agent=${agentId} daily cap reached`);
    return finishOracle('cap_reached', { ok: false, reason: 'daily_cap_reached', count: agent.daily_market_analysis_count });
  }

  // ── Fetch oracle data ──────────────────────────────────────────────────────
  let forexRate, poolState;
  try {
    forexRate = await oracle.getForexRate('EURC', 'USDC');
    poolState  = await _getOracleStablePoolState(forexRate);
  } catch (err) {
    console.error(`[QUEUE] ORACLE_QUERY fetch error agent=${agentId}:`, err.message);
    return finishOracle('fetch_error', { ok: false, reason: 'oracle_fetch_error', error: err.message });
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
  let executionGate = null;
  let decisionError = false;
  const permissions = await getAgentPermissionMap(agentId);
  const arbitragePermissionGranted = permissions.arbitrage !== false;
  try {
    executionGate = await evaluateExecutionGate(agent, signal, agentId);
    console.log(`[QUEUE] ORACLE_QUERY gate (${executionGate.engine}) agent=${agentId}:`, String(executionGate.decision).slice(0, 120));
  } catch (err) {
    console.error(`[QUEUE] ORACLE_QUERY engine error agent=${agentId}:`, err.message);
    decisionError = true;
  }

  // ── Increment counter + log ────────────────────────────────────────────────
  await db.query(
    'UPDATE agents SET daily_market_analysis_count = daily_market_analysis_count + 1 WHERE id = $1',
    [agentId],
  );

  // Log the signal + decision to transactions table as an 'oracle_signal' record
  if (signal.opportunity.found) {
    const dailyLimitBypass = getDailyLimitBypass(agent);
    const defiLoopCapReached = !dailyLimitBypass.enabled
      && Number(agent.daily_defi_loop_count || 0) >= DAILY_DEFI_LOOP_CAP;
    const executionPermissionGranted = Boolean(agent.defi_loop_enabled && arbitragePermissionGranted);
    const gateAllowsExecution = executionPermissionGranted
      && executionGate?.verdict?.execute === true
      && !defiLoopCapReached;
    const signalMeta = {
      signal,
      decision: executionGate?.decision || null,
      executionGate,
      permissions: {
        arbitrage: arbitragePermissionGranted,
      },
      dailyLimitBypass,
      dailyCap: DAILY_DEFI_LOOP_CAP,
      dailyCapCount: agent.daily_defi_loop_count ?? 0,
      executionPermissionGranted,
      executionState: !executionPermissionGranted
        ? 'signal_only'
        : defiLoopCapReached
          ? 'daily_cap_reached'
        : gateAllowsExecution
          ? 'eligible_for_defi_loop'
          : 'gate_blocked',
      signalOnlyReason: !arbitragePermissionGranted
        ? 'Signal only — the Arbitrage strategy preference is disabled for this agent, so autonomous oracle strategy execution is blocked.'
        : !agent.defi_loop_enabled
        ? 'Signal only — autonomous DeFi execution is disabled for this agent, so no on-chain trade was submitted.'
        : defiLoopCapReached
        ? `Autonomous DeFi execution is enabled, but no on-chain trade was submitted because this agent already used ${agent.daily_defi_loop_count || 0}/${DAILY_DEFI_LOOP_CAP} daily DeFi loop runs.`
        : executionPermissionGranted
        ? (gateAllowsExecution
          ? 'Autonomous DeFi execution is enabled for this agent and the execution gate currently approves this opportunity.'
          : `Autonomous DeFi execution is enabled, but the execution gate returned HOLD${executionGate?.verdict?.reason ? `: ${executionGate.verdict.reason}` : '.'}`)
        : 'Signal only — autonomous DeFi execution is disabled for this agent, so no on-chain trade was submitted.',
    };

    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, 'oracle_signal', 'arc-testnet', 'arc-testnet', 'USDC', $2, 'pending', $3::jsonb)`,
      [
        agentId,
        signal.opportunity.expectedProfitUsdc,
        JSON.stringify(signalMeta),
      ],
    );
  }

  // Reputation hook — fire-and-forget, never blocks
  recordReputationEvent(agentId, EVENT_TYPES.ORACLE_QUERY).catch(() => {});

  return finishOracle(
    decisionError ? 'decision_error' : signal.opportunity.found ? 'success' : 'no_signal',
    { ok: true, found: signal.opportunity.found, confidence: signal.opportunity.confidence, executionGate },
  );
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

async function scheduleMarketAnalysisLoop() {
  if (!MARKET_ANALYSIS_LOOP_INTERVAL_MS || MARKET_ANALYSIS_LOOP_INTERVAL_MS < 60_000) return;

  setInterval(async () => {
    try {
      const { rows } = await db.query(
        `SELECT id FROM agents
         WHERE market_analysis_enabled = TRUE
           AND is_smart_mode = TRUE
           AND status NOT IN ('locked', 'inactive')`,
      );
      for (const { id } of rows) {
        await queue.add(
          'MARKET_ANALYSIS',
          { agentId: id, chain: 'arc-testnet', token: 'USDC' },
          { jobId: `market-analysis-${id}-${Date.now()}` },
        );
      }
      if (rows.length > 0) {
        console.log(`[MARKET_ANALYSIS_LOOP] Queued ${rows.length} market analysis job(s)`);
      }
    } catch (err) {
      console.error('[MARKET_ANALYSIS_LOOP] Schedule error:', err.message);
    }
  }, MARKET_ANALYSIS_LOOP_INTERVAL_MS);

  console.log(`[MARKET_ANALYSIS_LOOP] Started — interval ${MARKET_ANALYSIS_LOOP_INTERVAL_MS / 60000} min`);
}

// ── DEFI_LOOP ─────────────────────────────────────────────────────────────────
// Runs for agents with defi_loop_enabled = TRUE only.
// Flow: oracle fetch → arb signal → engine decision → protocol tx (unless dry-run stays enabled for this agent).
// Hard cap: 10 runs per agent per day (daily_defi_loop_count).

queue.process('DEFI_LOOP', 1, async (job) => {
  const { agentId } = job.data;
  await _setAutomationState(agentId, 'defiLoop', 'running');
  const finishDefi = async (status, payload) => {
    await _setAutomationState(agentId, 'defiLoop', status);
    return payload;
  };

  // Reload agent — verify flag still on + fetch encrypted key
  const { rows: [agent] } = await db.query(
    `SELECT id, llm_model, llm_api_key_encrypted,
            defi_loop_enabled, oracle_enabled,
            daily_defi_loop_count, daily_limit_reset_at,
            daily_limit_usdc, max_trade_usdc, defi_wallet_reserve_usdc, slippage_percent,
            wallet_address, private_key_encrypted
     FROM agents WHERE id = $1`,
    [agentId],
  );

  if (!agent)                   return finishDefi('missing_agent', { ok: false, reason: 'agent_not_found' });
  if (!agent.defi_loop_enabled) return finishDefi('disabled', { ok: false, reason: 'defi_loop_disabled' });

  const permissions = await getAgentPermissionMap(agentId);
  if (permissions.arbitrage === false) {
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, 'defi_loop_dry', 'arc-testnet', 'arc-testnet', 'USDC', 0, 'dry_run', $2::jsonb)`,
      [agentId, JSON.stringify({
        executionState: 'permission_blocked',
        executionSource: 'oracle_strategy',
        reason: 'Arbitrage strategy preference is disabled for this agent.',
        permission: 'arbitrage',
      })],
    );

    return finishDefi('permission_blocked', {
      ok: true,
      action: 'hold',
      reason: 'permission_blocked',
      permission: 'arbitrage',
    });
  }

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

  const dryRunEnabled = shouldUseDryRun(agent);
  console.log(`[QUEUE] DEFI_LOOP agent=${agentId} dry=${dryRunEnabled}`);

  // Daily cap check
  if (!isDailyLimitBypassed(agent) && agent.daily_defi_loop_count >= DAILY_DEFI_LOOP_CAP) {
    console.log(`[QUEUE] DEFI_LOOP agent=${agentId} daily cap reached (${DAILY_DEFI_LOOP_CAP})`);
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, 'defi_loop_dry', 'arc-testnet', 'arc-testnet', 'USDC', 0, 'failed', $2::jsonb)`,
      [agentId, JSON.stringify({
        executionState: 'daily_cap_reached',
        executionSource: 'oracle_strategy',
        reason: 'daily_cap_reached',
        dailyCap: DAILY_DEFI_LOOP_CAP,
        dailyCapCount: agent.daily_defi_loop_count,
        fromToken: 'USDC',
        toToken: 'EURC',
      })],
    );
    return finishDefi('cap_reached', { ok: false, reason: 'daily_cap_reached', count: agent.daily_defi_loop_count });
  }

  // ── Oracle data ────────────────────────────────────────────────────────────
  let forexRate, poolState;
  try {
    forexRate = await oracle.getForexRate('EURC', 'USDC');
    poolState  = await _getOracleStablePoolState(forexRate);
  } catch (err) {
    console.error(`[QUEUE] DEFI_LOOP oracle error agent=${agentId}:`, err.message);
    return finishDefi('fetch_error', { ok: false, reason: 'oracle_fetch_error', error: err.message });
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
  let executionGate = null;
  try {
    executionGate = await evaluateExecutionGate(agent, signal, agentId);
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
    return finishDefi('no_opportunity', { ok: true, action: 'hold', reason: 'no_opportunity', confidence: signal.opportunity.confidence });
  }

  if (executionGate?.verdict?.execute !== true) {
    return finishDefi('gate_blocked', {
      ok: true,
      action: 'hold',
      reason: 'execution_gate_blocked',
      executionGate,
    });
  }

  // ── Execute swap ──────────────────────────────────────────────────────────
  const desiredSwapAmountUsdc = normalizeUsdcAmount(Math.min(
    Number(executionGate?.verdict?.suggestedAmount || signal.opportunity.steps?.[0]?.amountUsdc || 1000),
    parseFloat(agent.max_trade_usdc) || 200,
  ));

  let availableUsdcBalance = 0;
  try {
    availableUsdcBalance = await getArcUsdcBalance(agent.wallet_address);
  } catch (err) {
    console.error(`[QUEUE] DEFI_LOOP balance check error agent=${agentId}:`, err.message);
    return finishDefi('balance_check_failed', {
      ok: false,
      reason: 'wallet_balance_unavailable',
      error: err.message,
    });
  }

  const walletReserveUsdc = normalizeUsdcAmount(Math.max(Number(agent.defi_wallet_reserve_usdc || 0), 0));
  const availableToTradeUsdc = normalizeUsdcAmount(Math.max(availableUsdcBalance - walletReserveUsdc, 0));
  const swapAmountUsdc = normalizeUsdcAmount(Math.min(desiredSwapAmountUsdc, availableToTradeUsdc));

  if (swapAmountUsdc < 0.01) {
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, 'defi_loop_dry', 'arc-testnet', 'arc-testnet', 'USDC', $2, 'dry_run', $3::jsonb)`,
      [agentId, desiredSwapAmountUsdc, JSON.stringify({
        signal,
        executionGate,
        dryRun: false,
        executionState: 'insufficient_balance',
        executionSource: 'oracle_strategy',
        fromToken: 'USDC',
        toToken: 'EURC',
        requestedAmountIn: desiredSwapAmountUsdc,
        availableBalanceUsdc: availableUsdcBalance,
        walletReserveUsdc,
        availableToTradeUsdc,
        amountIn: 0,
      })],
    );

    return finishDefi('insufficient_balance', {
      ok: true,
      action: 'hold',
      reason: 'insufficient_balance',
      requestedAmountUsdc: desiredSwapAmountUsdc,
      availableBalanceUsdc: availableUsdcBalance,
      walletReserveUsdc,
      availableToTradeUsdc,
    });
  }

  if (dryRunEnabled) {
    console.log(`[QUEUE] DEFI_LOOP DRY_RUN agent=${agentId} — would swap ${swapAmountUsdc} USDC→EURC`);
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, 'defi_loop_dry', 'arc-testnet', 'arc-testnet', 'USDC', $2, 'dry_run', $3::jsonb)`,
      [agentId, swapAmountUsdc, JSON.stringify({
        signal,
        executionGate,
        dryRun: true,
        executionState: 'dry_run',
        executionSource: 'oracle_strategy',
        fromToken: 'USDC',
        toToken: 'EURC',
        amountIn: swapAmountUsdc,
        requestedAmountIn: desiredSwapAmountUsdc,
        availableBalanceUsdc: availableUsdcBalance,
        walletReserveUsdc,
        availableToTradeUsdc,
      })],
    );
    return finishDefi('dry_run', { ok: true, action: 'dry_run', amountUsdc: swapAmountUsdc });
  }

  // Real swap — requires decrypted private key
  if (!agent.private_key_encrypted) {
    return finishDefi('no_private_key', { ok: false, reason: 'no_private_key' });
  }

  let txResult;
  try {
    const { decrypt } = require('../services/cryptoService');
    const privateKey  = decrypt(agent.private_key_encrypted);

    const swapPool           = _getUsdcEurcCurvePool();
    const EURC_ADDRESS       = process.env.EURC_ADDRESS || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
    const USDC_ADDRESS       = process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
    const poolAddress        = swapPool?.address || CURVE_USDC_EURC_POOL;

    if (!poolAddress) {
      return finishDefi('pool_unconfigured', { ok: false, reason: 'pool_address_not_configured' });
    }

    txResult = await protocols.executeCurveSwap({
      poolAddress,
      tokenInAddress: USDC_ADDRESS,
      indexIn:        swapPool?.baseToken.index ?? 0,
      indexOut:       swapPool?.quoteToken.index ?? 1,
      amountIn:       String(swapAmountUsdc),
      slippagePct:    parseFloat(agent.slippage_percent) || 0.5,
      agentPrivateKey: privateKey,
    });

    let economy = null;
    try {
      economy = await taskEconomyService.settleExecutionFee({
        agent,
        referenceId: txResult.txHash || `defi-loop-${agentId}-${Date.now()}`,
        referenceType: 'automation',
        feeUsdc: AUTOMATION_EXECUTION_FEE_USDC,
        fromChain: 'Arc Testnet',
        toChain: 'Arc Testnet',
        mode: 'circle_gateway_automation_fee',
        rail: 'agentic_automation_economy',
      });
    } catch (err) {
      economy = {
        mode: 'circle_gateway_automation_fee',
        rail: 'agentic_automation_economy',
        referenceType: 'automation',
        referenceId: txResult.txHash || null,
        feeUsdc: AUTOMATION_EXECUTION_FEE_USDC,
        sourceChain: 'Arc Testnet',
        destinationChain: 'Arc Testnet',
        status: 'failed',
        error: err.message,
      };
      console.warn('[AUTOMATION_ECONOMY] DEFI_LOOP fee settlement failed:', err.message);
    }

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
      [agentId, swapAmountUsdc, txResult.txHash, JSON.stringify({
        signal,
        executionGate,
        executionState: 'executed',
        executionSource: 'oracle_strategy',
        fromToken: 'USDC',
        toToken: 'EURC',
        amountIn: swapAmountUsdc,
        requestedAmountIn: desiredSwapAmountUsdc,
        availableBalanceUsdc: availableUsdcBalance,
        walletReserveUsdc,
        availableToTradeUsdc,
        amountOut: txResult.amountOut,
        economy,
      })],
    );

    console.log(`[QUEUE] DEFI_LOOP swap OK agent=${agentId} tx=${txResult.txHash}`);
    recordReputationEvent(agentId, EVENT_TYPES.DEFI_LOOP).catch(() => {});
    return finishDefi('executed', {
      ok: true,
      action: 'swap_executed',
      txHash: txResult.txHash,
      amountOut: txResult.amountOut,
      economy,
    });

  } catch (err) {
    const errorDetails = buildExecutionErrorDetails(err);
    console.error(`[QUEUE] DEFI_LOOP swap error agent=${agentId}:`, errorDetails.error);
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, tx_hash, meta)
       VALUES ($1, 'defi_loop_swap', 'arc-testnet', 'arc-testnet', 'USDC', $2, 'failed', $3, $4::jsonb)`,
      [agentId, swapAmountUsdc, errorDetails.errorTxHash, JSON.stringify({
        ...errorDetails,
        signal,
        executionGate,
        executionState: 'failed',
        executionSource: 'oracle_strategy',
        fromToken: 'USDC',
        toToken: 'EURC',
        amountIn: swapAmountUsdc,
        requestedAmountIn: desiredSwapAmountUsdc,
        availableBalanceUsdc: availableUsdcBalance,
        walletReserveUsdc,
        availableToTradeUsdc,
      })],
    );
    return finishDefi('swap_error', {
      ok: false,
      reason: 'swap_error',
      error: errorDetails.error,
      errorSummary: errorDetails.errorSummary,
    });
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

  console.log(`[DEFI_LOOP] Started — interval ${DEFI_LOOP_INTERVAL_MS / 60000} min, GLOBAL_DRY_RUN=${GLOBAL_DRY_RUN}`);
}

// ── DAILY FREE TASKS (Tier 1) ──────────────────────────────────────────────────
// Built-in deterministic tasks only.
// Users see 5 featured tasks per UTC day and explicitly run the ones they want.
// No LLM key required — pure HTTP + onchain reads / DB summaries.

const DAILY_FREE_TASK_CAP = parseInt(process.env.DAILY_FREE_TASK_CAP || '5', 10);
const BUILTIN_DAILY_TASKS = [
  {
    id: 'DAILY_PRICE_REPORT',
    title: 'FX Peg Proxy Report',
    description: 'EURC/USDC + BRLA/USDC fiat peg proxies via Frankfurter',
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
    title: 'FX Peg Proxy Matrix',
    description: 'EURC, BRLA, MXNB and JPYC fiat peg proxies against USDC',
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
const GAS_FANOUT_TASK_FEE_USDC = parseFloat(process.env.GAS_FANOUT_TASK_FEE_USDC || '0.20');
const AUTOMATION_EXECUTION_FEE_USDC = parseFloat(
  process.env.AUTOMATION_EXECUTION_FEE_USDC || String(PAID_TASK_FEE_USDC),
);

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
    id:          'EXEC_CURVE_LIQUIDITY_ADD',
    title:       'Curve Liquidity Add',
    description: 'Add one-sided USDC or EURC liquidity into the verified Curve stable pool',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_CURVE_LIQUIDITY_REMOVE',
    title:       'Curve Liquidity Withdraw',
    description: 'Burn Curve LP into one stable token from the verified Arc pool',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_CIRBTC_USDC_ZAP_IN',
    title:       'cirBTC/USDC LP Bootstrap',
    description: 'Use up to 20 USDC, swap part into cirBTC, then mint LP on the direct cirBTC/USDC pair',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_CIRBTC_EURC_ZAP_IN',
    title:       'cirBTC/EURC LP Bootstrap',
    description: 'Use up to 16 EURC, swap part into cirBTC, then mint LP on the direct cirBTC/EURC pair',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_CIRBTC_USDC_LP_REMOVE',
    title:       'cirBTC/USDC LP Exit',
    description: 'Burn a percentage of the current cirBTC/USDC LP position and return both assets to the agent wallet',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_CIRBTC_EURC_LP_REMOVE',
    title:       'cirBTC/EURC LP Exit',
    description: 'Burn a percentage of the current cirBTC/EURC LP position and return both assets to the agent wallet',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_CCTP_BRIDGE',
    title:       'CCTP Bridge',
    description: 'Bridge USDC from Arc Testnet to one selected EVM testnet via Circle CCTP V2',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_SEPOLIA_GAS_FANOUT',
    title:       'Sepolia Gas Fanout',
    description: 'Bridge 0.01 ETH each from Sepolia to Optimism, Base and Arbitrum Sepolia in one run',
    tier:        2,
    fee_usdc:    GAS_FANOUT_TASK_FEE_USDC,
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
const EXECUTION_TASK_FEE_BY_ID = Object.fromEntries(
  BUILTIN_TIER2_TASKS.map(task => [task.id, Number(task.fee_usdc) || 0]),
);

function getExecutionTaskFeeUsdc(taskId, fallbackFeeUsdc = PAID_TASK_FEE_USDC) {
  const feeUsdc = EXECUTION_TASK_FEE_BY_ID[taskId];
  return Number.isFinite(feeUsdc) && feeUsdc >= 0
    ? feeUsdc
    : fallbackFeeUsdc;
}

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

  await db.query(
    `UPDATE task_catalog
        SET enabled = FALSE
      WHERE id = 'EXEC_YIELD_MOVE'`,
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
  if (isDailyLimitBypassed(agent)) {
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

// Check daily paid cap; reset if a new UTC day has started
async function _paidTaskGuard(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, daily_tasks_enabled, daily_paid_task_count, daily_limit_reset_at,
            wallet_address, private_key_encrypted
     FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!agent)                     return { ok: false, reason: 'agent_not_found' };
  // Dev bypass: skip all limit checks for test addresses
  if (isDailyLimitBypassed(agent)) {
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
  if (isDailyLimitBypassed(agent)) {
    return { ok: true, agent };
  }
  if (!agent.daily_tasks_enabled) return { ok: false, reason: 'daily_tasks_disabled' };
  return { ok: true, agent };
}

function _toTaskTxAmount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function _getCurveStableTaskToken(index) {
  return Number(index) === 1 ? 'EURC' : 'USDC';
}

function _getPaidTaskActivityStatus(payload) {
  if (payload?.dryRun) return 'dry_run';
  if (payload?.skipped) return 'skipped';
  return 'confirmed';
}

async function _insertTaskActivityRecord(agentId, record) {
  await db.query(
    `INSERT INTO transactions
       (agent_id, type, from_chain, to_chain, token, amount_usdc, tx_hash, status, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      agentId,
      record.type,
      record.fromChain || null,
      record.toChain || null,
      record.token || 'USDC',
      _toTaskTxAmount(record.amount),
      record.txHash || null,
      record.status || 'confirmed',
      JSON.stringify(record.meta || {}),
    ],
  );
}

async function _recordPaidTaskActivity(agentId, taskId, payload, executionMeta) {
  const status = _getPaidTaskActivityStatus(payload);

  if (taskId === 'EXEC_CIRBTC_USDC_ZAP_IN' || taskId === 'EXEC_CIRBTC_EURC_ZAP_IN') {
    await _insertTaskActivityRecord(agentId, {
      type: 'direct_lp_add',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.stableToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.mintTxHash || payload?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_CIRBTC_USDC_LP_REMOVE' || taskId === 'EXEC_CIRBTC_EURC_LP_REMOVE') {
    await _insertTaskActivityRecord(agentId, {
      type: 'direct_lp_remove',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.stableToken || 'USDC',
      amount: payload?.lpAmount || 0,
      txHash: payload?.burnTxHash || payload?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_CURVE_SWAP') {
    await _insertTaskActivityRecord(agentId, {
      type: 'swap',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: executionMeta.fromToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_CURVE_LIQUIDITY_ADD') {
    await _insertTaskActivityRecord(agentId, {
      type: 'curve_lp_add',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.tokenIn || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_CURVE_LIQUIDITY_REMOVE') {
    await _insertTaskActivityRecord(agentId, {
      type: 'curve_lp_remove',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.tokenOut || 'USDC',
      amount: payload?.amountOut || 0,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_CCTP_BRIDGE') {
    await _insertTaskActivityRecord(agentId, {
      type: 'bridge',
      fromChain: payload?.fromChain || 'Arc Testnet',
      toChain: payload?.toChain || 'Arc Testnet',
      token: 'USDC',
      amount: payload?.amountUsdc,
      txHash: payload?.burnTxHash || payload?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_SEPOLIA_GAS_FANOUT') {
    await _insertTaskActivityRecord(agentId, {
      type: 'gas_topup',
      fromChain: payload?.fromChain || 'Sepolia',
      toChain: Array.isArray(payload?.targets) && payload.targets.length === 1
        ? payload.targets[0].toChain
        : 'Multiple destinations',
      token: 'ETH',
      amount: 0,
      txHash: payload?.targets?.[0]?.topUpTxHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_ARB') {
    await _insertTaskActivityRecord(agentId, {
      type: 'task_arb',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: executionMeta.fromToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.swapTxHash || payload?.swap?.txHash || payload?.swap?.hash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_REBALANCE') {
    await _insertTaskActivityRecord(agentId, {
      type: 'rebalance',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.fromToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    });
  }
}

// Write result + increment daily_paid_task_count + attach task economy fee metadata
async function _savePaidTaskResult(agentId, taskId, payload, agent, options = {}) {
  const feeUsdc = Number.isFinite(Number(options.feeUsdc))
    ? Number(options.feeUsdc)
    : getExecutionTaskFeeUsdc(taskId);
  const fromChain = options.fromChain || taskEconomyService.getTaskEconomyConfigSummary().chain;
  const toChain = options.toChain || taskEconomyService.getTaskEconomyConfigSummary().chain;
  let economy = null;

  try {
    economy = await taskEconomyService.settleTaskExecutionFee({
      agent,
      taskId,
      feeUsdc,
      fromChain,
      toChain,
    });
  } catch (err) {
    economy = {
      mode: 'circle_gateway_task_fee',
      rail: 'agentic_task_economy',
      taskId,
      feeUsdc,
      sourceChain: fromChain,
      destinationChain: toChain,
      status: 'failed',
      error: err.message,
    };
    console.warn(`[TASK_ECONOMY] ${taskId} fee settlement failed:`, err.message);
  }

  const resultPayload = { ...payload, economy };

  const { rows: [storedResult] } = await db.query(
    `INSERT INTO agent_task_results (agent_id, task_id, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, created_at`,
    [agentId, taskId, JSON.stringify(resultPayload)],
  );

  const executionMeta = {
    taskId,
    taskResultId: storedResult?.id || null,
    taskResultCreatedAt: storedResult?.created_at || null,
    txHash: payload?.txHash || payload?.hash || payload?.swapTxHash || null,
    fromToken: payload?.fromToken || _getCurveStableTaskToken(payload?.indexIn),
    toToken: payload?.toToken || _getCurveStableTaskToken(payload?.indexOut),
    executionRail: payload?.executionRail || null,
    swapExecutionRail: payload?.swapExecutionRail || null,
    swapRouteStrategy: payload?.swapRouteStrategy || null,
    swapRouteReason: payload?.swapRouteReason || null,
    poolAddress: payload?.poolAddress || null,
    poolSource: payload?.poolSource || null,
    indexIn: payload?.indexIn ?? null,
    indexOut: payload?.indexOut ?? null,
    minDy: payload?.minDy || payload?.swap?.minDy || null,
    minLpAmount: payload?.minLpAmount || null,
    minAmountOut: payload?.minAmountOut || null,
    stableToken: payload?.stableToken || null,
    volatileToken: payload?.volatileToken || null,
    amountIn: payload?.amountIn || null,
    requestedAmountIn: payload?.requestedAmountIn || payload?.amountIn || null,
    amountUsdc: payload?.amountUsdc || null,
    amountEth: payload?.amountEth || null,
    swappedAmountIn: payload?.swappedAmountIn || null,
    remainingAmountIn: payload?.remainingAmountIn || null,
    amountOut: payload?.amountOut || null,
    lpAmount: payload?.lpAmount || null,
    fromChain: payload?.fromChain || null,
    toChain: payload?.toChain || null,
    direction: payload?.direction || null,
    bridgeType: payload?.bridgeType || null,
    kind: payload?.kind || null,
    targets: Array.isArray(payload?.targets) ? payload.targets : null,
    signalOpportunity: payload?.signal?.opportunity || null,
    liquidityStableAmountUsed: payload?.liquidityStableAmountUsed || null,
    liquidityStableAmountRemaining: payload?.liquidityStableAmountRemaining || null,
    liquidityVolatileAmountUsed: payload?.liquidityVolatileAmountUsed || null,
    liquidityVolatileAmountRemaining: payload?.liquidityVolatileAmountRemaining || null,
    withdrawPct: payload?.withdrawPct || null,
    token0Amount: payload?.token0Amount || null,
    token1Amount: payload?.token1Amount || null,
    token0Symbol: payload?.token0Symbol || null,
    token1Symbol: payload?.token1Symbol || null,
    swapTxHash: payload?.swapTxHash || null,
    swapPoolAddress: payload?.swapPoolAddress || null,
    swapPoolSource: payload?.swapPoolSource || null,
    mintTxHash: payload?.mintTxHash || null,
    burnTxHash: payload?.burnTxHash || null,
    summary: payload?.summary || null,
    economy,
  };

  await _recordPaidTaskActivity(agentId, taskId, payload, executionMeta);

  await db.query(
    `UPDATE agents SET daily_paid_task_count = daily_paid_task_count + 1 WHERE id = $1`,
    [agentId],
  );
  recordReputationEvent(agentId, EVENT_TYPES.DAILY_TASK).catch(() => {});

  return resultPayload;
}

function registerPaidTaskProcessor(name, concurrency, executePaidTask, resolveEconomyOptions) {
  REGISTERED_PAID_TASK_PROCESSORS.add(name);

  registerTaskProcessor(name, concurrency, async (job) => {
    const { agentId, params = {}, taskRunId = null } = job.data;
    const guard = await _paidTaskGuard(agentId);
    if (!guard.ok) return guard;
    const { agent } = guard;

    const context = {
      job,
      agentId,
      agent,
      params,
      taskRunId,
      dryRun: shouldUseDryRun(agent),
    };

    const result = await executePaidTask(context);
    if (!result.ok) return result;

    const economyOptions = typeof resolveEconomyOptions === 'function'
      ? resolveEconomyOptions({ ...context, result }) || {}
      : {};

    const storedPayload = await _savePaidTaskResult(agentId, name, result.payload, agent, {
      feeUsdc: getExecutionTaskFeeUsdc(name),
      ...economyOptions,
    });

    return { ...result, payload: storedPayload };
  });
}

function assertPaidTaskEconomyCoverage() {
  const missing = BUILTIN_TIER2_TASKS
    .map(task => task.id)
    .filter(taskId => !REGISTERED_PAID_TASK_PROCESSORS.has(taskId));

  if (missing.length > 0) {
    throw new Error(`Missing paid task economy coverage for: ${missing.join(', ')}`);
  }
}

function assertPaidTaskActivityCoverage() {
  const missing = BUILTIN_TIER2_TASKS
    .map(task => task.id)
    .filter(taskId => !PAID_TASK_ACTIVITY_SUPPORTED_IDS.has(taskId));

  if (missing.length > 0) {
    throw new Error(`Missing paid task activity coverage for: ${missing.join(', ')}`);
  }
}

// ── DAILY_PRICE_REPORT ────────────────────────────────────────────────────────
registerTaskProcessor('DAILY_PRICE_REPORT', 3, async (job) => {
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
      eurc.status === 'fulfilled' ? `EURC/USDC peg proxy ${eurc.value.rate}` : null,
      brla.status === 'fulfilled' ? `BRLA/USDC peg proxy ${brla.value.rate}` : null,
    ].filter(Boolean).join(' · ') || 'Fiat peg proxy snapshot captured for EURC and BRLA.',
    fetchedAt:  new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_PRICE_REPORT', payload);
  return { ok: true, payload };
});

// ── DAILY_POOL_HEALTH ─────────────────────────────────────────────────────────
registerTaskProcessor('DAILY_POOL_HEALTH', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const forexRate = await oracle.getForexRate('EURC', 'USDC');
  const poolState  = await _getOracleStablePoolState(forexRate);

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
registerTaskProcessor('DAILY_YIELD_RANK', 3, async (job) => {
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
registerTaskProcessor('DAILY_ARB_SCAN', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const forexRate = await oracle.getForexRate('EURC', 'USDC');
  const poolState  = await _getOracleStablePoolState(forexRate);

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
registerTaskProcessor('DAILY_WALLET_DIGEST', 3, async (job) => {
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
registerTaskProcessor('DAILY_FOREX_MATRIX', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const rates = await oracle.getAllForexRates();
  const pairs = Object.entries(rates || {});
  const strongest = pairs.sort((left, right) => (right[1]?.rate ?? 0) - (left[1]?.rate ?? 0))[0];

  const payload = {
    rates,
    summary: strongest
      ? `Tracked ${pairs.length} fiat peg proxies. Highest proxy: ${strongest[0]} ${strongest[1].rate}.`
      : 'Tracked fiat peg proxies for the daily matrix.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_FOREX_MATRIX', payload);
  return { ok: true, payload };
});

// ── DAILY_USDC_PEG_CHECK ─────────────────────────────────────────────────────
registerTaskProcessor('DAILY_USDC_PEG_CHECK', 3, async (job) => {
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
registerTaskProcessor('DAILY_MARKET_TAPE', 3, async (job) => {
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
registerTaskProcessor('DAILY_PROTOCOL_TVL', 3, async (job) => {
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
registerTaskProcessor('DAILY_ACTIVITY_RECAP', 3, async (job) => {
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
registerPaidTaskProcessor('EXEC_CURVE_SWAP', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveSwapTask({
    agent,
    params,
    dryRun,
    defaultCurvePool: _getUsdcEurcCurvePool(),
  })
));

registerPaidTaskProcessor('EXEC_CURVE_LIQUIDITY_ADD', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveLiquidityAddTask({
    agent,
    params,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_CURVE_LIQUIDITY_REMOVE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveLiquidityRemoveTask({
    agent,
    params,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_CIRBTC_USDC_ZAP_IN', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairZapInTask({
    agent,
    params,
    dryRun,
    stableToken: 'USDC',
  })
));

registerPaidTaskProcessor('EXEC_CIRBTC_EURC_ZAP_IN', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairZapInTask({
    agent,
    params,
    dryRun,
    stableToken: 'EURC',
  })
));

registerPaidTaskProcessor('EXEC_CIRBTC_USDC_LP_REMOVE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairRemoveLiquidityTask({
    agent,
    params,
    dryRun,
    stableToken: 'USDC',
  })
));

registerPaidTaskProcessor('EXEC_CIRBTC_EURC_LP_REMOVE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairRemoveLiquidityTask({
    agent,
    params,
    dryRun,
    stableToken: 'EURC',
  })
));

// ── EXEC_CCTP_BRIDGE ──────────────────────────────────────────────────────────
// Paid (Tier-2) — fee settles back into the shared Arc revenue pool.
registerPaidTaskProcessor('EXEC_CCTP_BRIDGE', 1, async ({ agent, params, dryRun, taskRunId }) => (
  agenticTaskExecutionService.executeBridgeTask({
    agent,
    params,
    dryRun,
    onStep: async (step, data) => {
      await _reportTaskRunStage(taskRunId, _buildBridgeStageMeta(step, params, data));
    },
  })
), ({ result, params }) => ({
    fromChain: result.payload?.fromChain || params.fromChain || 'Arc Testnet',
    toChain: 'Arc Testnet',
}));

// ── EXEC_SEPOLIA_GAS_FANOUT ──────────────────────────────────────────────────
registerPaidTaskProcessor('EXEC_SEPOLIA_GAS_FANOUT', 1, async ({ agent, dryRun, taskRunId }) => (
  agenticTaskExecutionService.executeSepoliaGasFanoutTask({
    agent,
    dryRun,
    onStep: async (step, data) => {
      await _reportTaskRunStage(taskRunId, _buildGasFanoutStageMeta(step, data));
    },
  })
), () => {
  const taskEconomyChain = taskEconomyService.getTaskEconomyConfigSummary().chain;
  return {
    fromChain: taskEconomyChain,
    toChain: taskEconomyChain,
  };
});

// ── EXEC_YIELD_MOVE ───────────────────────────────────────────────────────────
registerTaskProcessor('EXEC_YIELD_MOVE', 2, async (job) => {
  const { agentId, params = {} } = job.data;
  const guard = await _paidTaskGuard(agentId);
  if (!guard.ok) return guard;
  const { agent } = guard;

  const result = await agenticTaskExecutionService.executeYieldMoveTask({
    agent,
    params,
    dryRun: shouldUseDryRun(agent),
  });
  if (!result.ok) return result;

  const storedPayload = await _savePaidTaskResult(agentId, 'EXEC_YIELD_MOVE', result.payload, agent);
  return { ...result, payload: storedPayload };
});

// ── EXEC_ARB ──────────────────────────────────────────────────────────────────
registerPaidTaskProcessor('EXEC_ARB', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeArbTask({
    agent,
    params,
    dryRun,
    pricingPool: _getEurcUsdcCurvePool(),
    swapPool: _getUsdcEurcCurvePool(),
  })
));

// ── EXEC_REBALANCE ────────────────────────────────────────────────────────────
registerPaidTaskProcessor('EXEC_REBALANCE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeRebalanceTask({
    agent,
    params,
    dryRun,
  })
));

assertPaidTaskEconomyCoverage();
assertPaidTaskActivityCoverage();

async function scheduleDailyTasks() {
  await ensureTaskCatalogSeeded();
  console.log(`[DAILY_TASKS] Catalog ready — ${DAILY_TASK_TYPES.length} Tier-1 free tasks + ${BUILTIN_TIER2_TASKS.length} Tier-2 paid tasks`);
}

// ── Event listeners ────────────────────────────────────────────────────────────
queue.on('failed',    (job, err) => console.error(`[QUEUE] Job ${job.id} failed:`, err.message));
queue.on('completed', (job)      => console.log(`[QUEUE] Job ${job.id} completed`));

// ── Export the queue for use in indexerService ─────────────────────────────────
module.exports = queue;
module.exports.scheduleMarketAnalysisLoop = scheduleMarketAnalysisLoop;
module.exports.scheduleOracleLoop = scheduleOracleLoop;
module.exports.scheduleDefiLoop   = scheduleDefiLoop;
module.exports.scheduleDailyTasks = scheduleDailyTasks;
module.exports.canQueueManualTasks = canQueueManualTasks;
module.exports.queueManualTask = queueManualTask;
module.exports.runTaskInline = runTaskInline;
