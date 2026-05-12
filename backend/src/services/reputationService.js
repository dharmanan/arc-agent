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

  const scoreDelta = SCORE_DELTAS[eventType] ?? 1;

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
  }

  // 3. On-chain call — only if contract address configured and agent has a tokenId
  if (!REPUTATION_REGISTRY_ADDRESS || agent.erc8004_status !== 'registered' || !agent.erc8004_token_id) {
    return;  // silently skip — not blocking
  }

  const relayerKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerKey) return;

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
  }
}

module.exports = { recordReputationEvent, EVENT_TYPES };
