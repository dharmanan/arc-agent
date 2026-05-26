'use strict';
/**
 * ReputationRegistry — ERC-8004 reputation event recorder.
 *
 * Called non-blocking after successful agent transactions.
 * Only fires for agents with reputation_enabled = TRUE.
 * Any on-chain or network failure is logged and silently swallowed —
 * the agent's primary operation is never blocked by this.
 */
const { ethers } = require('ethers');
const db          = require('../db');

// Arc Testnet ReputationRegistry contract
// Address TBD — set REPUTATION_REGISTRY_ADDRESS env once deployed on Arc Testnet.
// If not set, on-chain calls are skipped and only DB record is written.
const REPUTATION_REGISTRY_ADDRESS = process.env.REPUTATION_REGISTRY_ADDRESS || null;

const REPUTATION_REGISTRY_ABI = [
  'function recordEvent(uint256 tokenId, string eventType, int256 scoreDelta) returns (bool)',
  'function getScore(uint256 tokenId) view returns (uint256)',
  'function totalEvents(uint256 tokenId) view returns (uint256)',
  'event ReputationRecorded(uint256 indexed tokenId, string eventType, int256 scoreDelta, uint256 newScore)',
];

// Event types — mirrors Arc reputation standard
const EVENT_TYPES = {
  TX_COMPLETED:       'TRANSACTION_COMPLETED',
  ARB_EXECUTED:       'ARB_EXECUTED',
  DEFI_LOOP:          'DEFI_LOOP_COMPLETED',
  ORACLE_QUERY:       'ORACLE_QUERY_COMPLETED',
  DAILY_TASK:         'DAILY_TASK_COMPLETED',
  PAID_TASK:          'PAID_TASK_COMPLETED',
  JOB_REVIEW_TIMEOUT: 'JOB_REVIEW_TIMEOUT',
};

// Score deltas per event type
const SCORE_DELTAS = {
  [EVENT_TYPES.TX_COMPLETED]:       1,
  [EVENT_TYPES.ARB_EXECUTED]:       2,
  [EVENT_TYPES.DEFI_LOOP]:          1,
  [EVENT_TYPES.ORACLE_QUERY]:       1,
  [EVENT_TYPES.DAILY_TASK]:         1,
  [EVENT_TYPES.PAID_TASK]:          2,
  [EVENT_TYPES.JOB_REVIEW_TIMEOUT]: -2,
};

const REPUTATION_ONCHAIN_PROOF_DAILY_LIMIT = (() => {
  const numeric = Number(process.env.REPUTATION_ONCHAIN_PROOF_DAILY_LIMIT || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
})();

function getUtcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function reserveReputationProofReadBudget(agentId) {
  if (!(REPUTATION_ONCHAIN_PROOF_DAILY_LIMIT > 0)) {
    return {
      allowLiveRead: true,
      dailyLimit: 0,
      dailyCount: 0,
    };
  }

  const today = getUtcDateKey();
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const { rows: [row] } = await client.query(
      `SELECT reputation_proof_last_read_day, reputation_proof_daily_read_count
       FROM agents
       WHERE id = $1
       FOR UPDATE`,
      [agentId],
    );

    const currentCount = row?.reputation_proof_last_read_day === today
      ? Number(row?.reputation_proof_daily_read_count || 0)
      : 0;

    if (currentCount >= REPUTATION_ONCHAIN_PROOF_DAILY_LIMIT) {
      await client.query('COMMIT');
      return {
        allowLiveRead: false,
        dailyLimit: REPUTATION_ONCHAIN_PROOF_DAILY_LIMIT,
        dailyCount: currentCount,
      };
    }

    const nextCount = currentCount + 1;
    await client.query(
      `UPDATE agents
       SET reputation_proof_last_read_day = $2,
           reputation_proof_daily_read_count = $3
       WHERE id = $1`,
      [agentId, today, nextCount],
    );

    await client.query('COMMIT');
    return {
      allowLiveRead: true,
      dailyLimit: REPUTATION_ONCHAIN_PROOF_DAILY_LIMIT,
      dailyCount: nextCount,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[REPUTATION] proof budget error agent=${agentId}:`, error.message);
    return {
      allowLiveRead: true,
      dailyLimit: REPUTATION_ONCHAIN_PROOF_DAILY_LIMIT,
      dailyCount: 0,
    };
  } finally {
    client.release();
  }
}

async function setReputationState(agentId, status) {
  await db.query(
    `UPDATE agents
     SET reputation_last_run_at = NOW(), reputation_last_status = $1
     WHERE id = $2`,
    [status, agentId],
  ).catch(() => {});
}

/**
 * Record a reputation event for an agent.
 * Non-blocking — call with .catch(() => {}) or fire-and-forget.
 *
 * @param {string} agentId     - UUID of the agent
 * @param {string} eventType   - one of EVENT_TYPES values
 */
async function recordReputationEvent(agentId, eventType) {
  // 1. Load agent — check reputation_enabled flag and get erc8004_token_id
  let agent;
  try {
    const { rows } = await db.query(
      `SELECT id, reputation_enabled, erc8004_token_id, erc8004_status
       FROM agents WHERE id = $1`,
      [agentId],
    );
    agent = rows[0];
  } catch (err) {
    console.error(`[REPUTATION] DB read error agent=${agentId}:`, err.message);
    return;
  }

  if (!agent)                       return;
  if (!agent.reputation_enabled)    return;  // opt-in guard

  await setReputationState(agentId, 'running');

  const scoreDelta = SCORE_DELTAS[eventType] ?? 1;
  let finalStatus = 'success';

  // 2. Write to local DB regardless of on-chain status (always record)
  try {
    await db.query(
      `INSERT INTO agent_reputation_events (agent_id, event_type, score_delta)
       VALUES ($1, $2, $3)`,
      [agentId, eventType, scoreDelta],
    );
  } catch (err) {
    // Table may not exist yet if migration hasn't run — non-fatal
    console.error(`[REPUTATION] DB insert error agent=${agentId}:`, err.message);
    finalStatus = 'db_error';
  }

  // 3. On-chain call — only if contract address configured and agent has a tokenId
  if (!REPUTATION_REGISTRY_ADDRESS || agent.erc8004_status !== 'registered' || !agent.erc8004_token_id) {
    if (finalStatus === 'success') finalStatus = 'db_only';
    await setReputationState(agentId, finalStatus);
    return;  // silently skip — not blocking
  }

  const relayerKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerKey) {
    if (finalStatus === 'success') finalStatus = 'db_only';
    await setReputationState(agentId, finalStatus);
    return;
  }

  try {
    const rpc      = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
    const provider = new ethers.JsonRpcProvider(rpc, { chainId: 5042002, name: 'Arc Testnet' });
    const relayer  = new ethers.Wallet(relayerKey, provider);
    const registry = new ethers.Contract(REPUTATION_REGISTRY_ADDRESS, REPUTATION_REGISTRY_ABI, relayer);

    const tx = await registry.recordEvent(
      BigInt(agent.erc8004_token_id),
      eventType,
      BigInt(scoreDelta),
    );
    await tx.wait(1);
    console.log(`[REPUTATION] Recorded on-chain agent=${agentId} event=${eventType} delta=+${scoreDelta}`);
  } catch (err) {
    // On-chain failure is non-fatal — already wrote to DB above
    console.error(`[REPUTATION] On-chain error agent=${agentId} event=${eventType}:`, err.message);
    if (finalStatus === 'success') finalStatus = 'chain_error';
  }

  await setReputationState(agentId, finalStatus);
}

async function getReputationOverview(agentId, userId, limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));

  const { rows: [agent] } = await db.query(
    `SELECT id, name, reputation_enabled, erc8004_status, erc8004_token_id
     FROM agents
     WHERE id = $1 AND user_id = $2`,
    [agentId, userId],
  );

  if (!agent) return null;

  const [summaryResult, breakdownResult, recentResult] = await Promise.all([
    db.query(
      `SELECT COALESCE(SUM(score_delta), 0)::int AS local_score,
              COUNT(*)::int AS total_events
       FROM agent_reputation_events
       WHERE agent_id = $1`,
      [agentId],
    ),
    db.query(
      `SELECT event_type,
              COUNT(*)::int AS event_count,
              COALESCE(SUM(score_delta), 0)::int AS score_total
       FROM agent_reputation_events
       WHERE agent_id = $1
       GROUP BY event_type
       ORDER BY score_total DESC, event_count DESC, event_type ASC`,
      [agentId],
    ),
    db.query(
      `SELECT event_type, score_delta, created_at
       FROM agent_reputation_events
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [agentId, safeLimit],
    ),
  ]);

  const summaryRow = summaryResult.rows[0] || { local_score: 0, total_events: 0 };
  const onchain = {
    configured: Boolean(REPUTATION_REGISTRY_ADDRESS),
    contractAddress: REPUTATION_REGISTRY_ADDRESS,
    tokenId: agent.erc8004_token_id || null,
    identityRegistered: agent.erc8004_status === 'registered',
    score: null,
    status: 'not_configured',
  };

  if (onchain.configured && onchain.identityRegistered && onchain.tokenId) {
    try {
      const rpc = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
      const provider = new ethers.JsonRpcProvider(rpc, { chainId: 5042002, name: 'Arc Testnet' });
      const registry = new ethers.Contract(REPUTATION_REGISTRY_ADDRESS, REPUTATION_REGISTRY_ABI, provider);
      const score = await registry.getScore(BigInt(onchain.tokenId));
      onchain.score = Number(score);
      onchain.status = 'live';
    } catch (err) {
      console.error(`[REPUTATION] On-chain read error agent=${agentId}:`, err.message);
      onchain.status = 'read_error';
    }
  } else if (onchain.configured && !onchain.identityRegistered) {
    onchain.status = 'identity_required';
  } else if (onchain.configured && !onchain.tokenId) {
    onchain.status = 'token_missing';
  }

  return {
    agentId,
    agentName: agent.name,
    reputationEnabled: Boolean(agent.reputation_enabled),
    localScore: Number(summaryRow.local_score || 0),
    totalEvents: Number(summaryRow.total_events || 0),
    mode: onchain.status === 'live' ? 'hybrid' : 'local_only',
    onchain,
    breakdown: breakdownResult.rows.map(row => ({
      eventType: row.event_type,
      count: Number(row.event_count || 0),
      score: Number(row.score_total || 0),
    })),
    recentEvents: recentResult.rows.map(row => ({
      eventType: row.event_type,
      scoreDelta: Number(row.score_delta || 0),
      createdAt: row.created_at,
    })),
  };
}

/**
 * Fetch on-chain ReputationRecorded event history for a given agent.
 * Phase 1 (fast): getScore + totalEvents via view call.
 * Phase 2 (best-effort): paginated event log scan — errors here do NOT
 *   downgrade the status; they just result in fewer visible events.
 *
 * SCAN_DEPTH is kept small (50 000 blocks) so the endpoint completes
 * well inside the 30-second Railway response timeout.
 *
 * @returns {{ score, totalEvents, events, eventsStatus, contractAddress, tokenId, status }}
 */
async function getReputationProof(agentId, userId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, erc8004_status, erc8004_token_id
     FROM agents
     WHERE id = $1 AND user_id = $2`,
    [agentId, userId],
  );

  if (!agent) return null;

  const result = {
    contractAddress: REPUTATION_REGISTRY_ADDRESS,
    tokenId: agent.erc8004_token_id || null,
    score: null,
    totalEvents: null,
    events: [],
    eventsStatus: 'not_scanned',
    status: 'not_configured',
    dailyReadLimit: REPUTATION_ONCHAIN_PROOF_DAILY_LIMIT,
    dailyReadCount: 0,
  };

  if (!REPUTATION_REGISTRY_ADDRESS || agent.erc8004_status !== 'registered' || !result.tokenId) {
    result.status = agent.erc8004_status !== 'registered' ? 'identity_required' : 'not_configured';
    return result;
  }

  const budget = await reserveReputationProofReadBudget(agentId);
  result.dailyReadCount = budget.dailyCount;

  if (!budget.allowLiveRead) {
    result.status = 'rate_limited';
    return result;
  }

  const rpc      = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
  const provider = new ethers.JsonRpcProvider(rpc, { chainId: 5042002, name: 'Arc Testnet' });
  const registry = new ethers.Contract(REPUTATION_REGISTRY_ADDRESS, REPUTATION_REGISTRY_ABI, provider);

  // ── Phase 1: score read (fast view calls) ────────────────────────────────
  let blockNumber;
  try {
    const [scoreRaw, totalRaw, bn] = await Promise.all([
      registry.getScore(BigInt(result.tokenId)),
      registry.totalEvents(BigInt(result.tokenId)),
      provider.getBlockNumber(),
    ]);
    result.score       = Number(scoreRaw);
    result.totalEvents = Number(totalRaw);
    result.status      = 'live';
    blockNumber        = bn;
  } catch (err) {
    console.error(`[REPUTATION] proof score read error agent=${agentId}:`, err.message);
    result.status = 'read_error';
    return result;   // return early — still has contractAddress + tokenId for display
  }

  // ── Phase 2: event log scan (best-effort, non-fatal) ─────────────────────
  try {
    const CHUNK      = 9999;
    const SCAN_DEPTH = 50000; // ~last 12 hours on Arc Testnet, fits well within timeout
    const scanFrom   = Math.max(0, blockNumber - SCAN_DEPTH);
    const filter     = registry.filters.ReputationRecorded(BigInt(result.tokenId));
    let logs         = [];
    let chunkEnd     = blockNumber;

    while (chunkEnd >= scanFrom) {
      const chunkStart = Math.max(scanFrom, chunkEnd - CHUNK + 1);
      try {
        const chunk = await registry.queryFilter(filter, chunkStart, chunkEnd);
        logs = [...chunk, ...logs];
      } catch (_) { /* skip erroring chunk, keep going */ }
      chunkEnd = chunkStart - 1;
    }

    result.events = logs.map(ev => ({
      blockNumber: ev.blockNumber,
      txHash:      ev.transactionHash,
      eventType:   ev.args.eventType,
      scoreDelta:  Number(ev.args.scoreDelta),
      newScore:    Number(ev.args.newScore),
    }));
    result.eventsStatus = 'ok';
  } catch (err) {
    console.error(`[REPUTATION] proof event scan error agent=${agentId}:`, err.message);
    result.eventsStatus = 'error';
  }

  return result;
}

module.exports = { recordReputationEvent, getReputationOverview, getReputationProof, EVENT_TYPES };
