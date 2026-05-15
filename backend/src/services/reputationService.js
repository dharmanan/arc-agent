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
  'event ReputationRecorded(uint256 indexed tokenId, string eventType, int256 scoreDelta, uint256 newScore)',
];

// Event types — mirrors Arc reputation standard
const EVENT_TYPES = {
  TX_COMPLETED:   'TRANSACTION_COMPLETED',
  ARB_EXECUTED:   'ARB_EXECUTED',
  DEFI_LOOP:      'DEFI_LOOP_COMPLETED',
  ORACLE_QUERY:   'ORACLE_QUERY_COMPLETED',
  DAILY_TASK:     'DAILY_TASK_COMPLETED',
};

// Score deltas per event type
const SCORE_DELTAS = {
  [EVENT_TYPES.TX_COMPLETED]:  1,
  [EVENT_TYPES.ARB_EXECUTED]:  2,
  [EVENT_TYPES.DEFI_LOOP]:     1,
  [EVENT_TYPES.ORACLE_QUERY]:  1,
  [EVENT_TYPES.DAILY_TASK]:    1,
};

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

module.exports = { recordReputationEvent, getReputationOverview, EVENT_TYPES };
