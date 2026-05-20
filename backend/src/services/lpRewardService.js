'use strict';

const db = require('../db');

const DEFAULT_LIMIT = 25;

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, 100);
}

function toInt(value, fallback = 0) {
  const numeric = Number.parseInt(value, 10);
  return Number.isInteger(numeric) ? numeric : fallback;
}

function toAmountString(value) {
  if (value == null) return '0';
  return String(value);
}

function mapProgram(row) {
  return {
    id: row.id,
    poolKey: row.pool_key,
    rewardToken: row.reward_token,
    rewardSourceType: row.reward_source_type,
    emissionMode: row.emission_mode,
    emissionRate: toAmountString(row.emission_rate),
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    metadata: row.metadata || {},
    accrualCount: toInt(row.accrual_count),
    totalEarned: toAmountString(row.total_earned),
    totalClaimed: toAmountString(row.total_claimed),
    totalUnclaimed: toAmountString(row.total_unclaimed),
    snapshotCount: toInt(row.snapshot_count),
    latestEpochEnd: row.latest_epoch_end,
    latestSnapshotStatus: row.latest_snapshot_status,
    latestRewardBudget: toAmountString(row.latest_reward_budget),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSnapshot(row) {
  return {
    id: row.id,
    programId: row.program_id,
    poolKey: row.pool_key,
    rewardToken: row.reward_token,
    programStatus: row.program_status,
    epochStart: row.epoch_start,
    epochEnd: row.epoch_end,
    poolLpSupply: toAmountString(row.pool_lp_supply),
    eligibleLpSupply: toAmountString(row.eligible_lp_supply),
    rewardBudget: toAmountString(row.reward_budget),
    sourceBlockNumber: row.source_block_number == null ? null : toInt(row.source_block_number),
    status: row.status,
    snapshotPayload: row.snapshot_payload || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAccrual(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    programId: row.program_id,
    snapshotId: row.snapshot_id,
    poolKey: row.pool_key,
    rewardToken: row.reward_token,
    programStatus: row.program_status,
    epochStart: row.epoch_start,
    epochEnd: row.epoch_end,
    avgLpBalance: toAmountString(row.avg_lp_balance),
    shareBps: row.share_bps == null ? null : toInt(row.share_bps),
    rewardEarned: toAmountString(row.reward_earned),
    rewardClaimed: toAmountString(row.reward_claimed),
    rewardUnclaimed: toAmountString(row.reward_unclaimed),
    status: row.status,
    lastCompoundAt: row.last_compound_at,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapClaim(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    programId: row.program_id,
    accrualId: row.accrual_id,
    poolKey: row.pool_key,
    rewardToken: row.reward_token,
    claimMode: row.claim_mode,
    amount: toAmountString(row.amount),
    txHash: row.tx_hash,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

async function getAgentRewardOverview(agentId, userId, {
  programLimit = DEFAULT_LIMIT,
  accrualLimit = DEFAULT_LIMIT,
  claimLimit = DEFAULT_LIMIT,
  snapshotLimit = DEFAULT_LIMIT,
} = {}) {
  const { rows: agentRows } = await db.query(
    'SELECT id, wallet_address FROM agents WHERE id = $1 AND user_id = $2',
    [agentId, userId],
  );

  if (!agentRows.length) return null;

  const agent = agentRows[0];
  const normalizedProgramLimit = normalizeLimit(programLimit);
  const normalizedAccrualLimit = normalizeLimit(accrualLimit);
  const normalizedClaimLimit = normalizeLimit(claimLimit);
  const normalizedSnapshotLimit = normalizeLimit(snapshotLimit);

  const [summaryResult, programResult, accrualResult, claimResult, snapshotResult] = await Promise.all([
    db.query(
      `SELECT
         COUNT(DISTINCT program_id)::int AS tracked_programs,
         COUNT(*) FILTER (WHERE status IN ('accrued', 'partially_claimed'))::int AS open_accruals,
         COALESCE(SUM(reward_earned), 0)::text AS total_earned,
         COALESCE(SUM(reward_claimed), 0)::text AS total_claimed,
         COALESCE(SUM(reward_unclaimed), 0)::text AS total_unclaimed,
         MAX(created_at) AS last_accrual_at,
         MAX(last_compound_at) AS last_compound_at
       FROM agent_lp_reward_accruals
      WHERE agent_id = $1`,
      [agent.id],
    ),
    db.query(
      `SELECT
         p.id,
         p.pool_key,
         p.reward_token,
         p.reward_source_type,
         p.emission_mode,
         p.emission_rate,
         p.start_at,
         p.end_at,
         p.status,
         p.metadata,
         p.created_at,
         p.updated_at,
         COUNT(a.id)::int AS accrual_count,
         COALESCE(SUM(a.reward_earned), 0)::text AS total_earned,
         COALESCE(SUM(a.reward_claimed), 0)::text AS total_claimed,
         COALESCE(SUM(a.reward_unclaimed), 0)::text AS total_unclaimed,
         COALESCE(sc.snapshot_count, 0)::int AS snapshot_count,
         ls.latest_epoch_end,
         ls.latest_snapshot_status,
         ls.latest_reward_budget
       FROM lp_reward_programs p
       LEFT JOIN agent_lp_reward_accruals a
         ON a.program_id = p.id
        AND a.agent_id = $1
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS snapshot_count
           FROM lp_reward_epoch_snapshots
          WHERE program_id = p.id
       ) sc ON true
       LEFT JOIN LATERAL (
         SELECT
           epoch_end AS latest_epoch_end,
           status AS latest_snapshot_status,
           COALESCE(reward_budget, 0)::text AS latest_reward_budget
         FROM lp_reward_epoch_snapshots
         WHERE program_id = p.id
         ORDER BY epoch_end DESC, created_at DESC
         LIMIT 1
       ) ls ON true
      WHERE p.status IN ('scheduled', 'live', 'paused')
         OR EXISTS (
           SELECT 1
             FROM agent_lp_reward_accruals ax
            WHERE ax.program_id = p.id
              AND ax.agent_id = $1
         )
      GROUP BY p.id, sc.snapshot_count, ls.latest_epoch_end, ls.latest_snapshot_status, ls.latest_reward_budget
      ORDER BY
        CASE p.status
          WHEN 'live' THEN 0
          WHEN 'scheduled' THEN 1
          WHEN 'paused' THEN 2
          WHEN 'ended' THEN 3
          ELSE 4
        END,
        p.start_at DESC NULLS LAST,
        p.created_at DESC
      LIMIT $2`,
      [agent.id, normalizedProgramLimit],
    ),
    db.query(
      `SELECT
         a.id,
         a.agent_id,
         a.program_id,
         a.snapshot_id,
         a.avg_lp_balance,
         a.share_bps,
         a.reward_earned,
         a.reward_claimed,
         a.reward_unclaimed,
         a.status,
         a.last_compound_at,
         a.metadata,
         a.created_at,
         a.updated_at,
         p.pool_key,
         p.reward_token,
         p.status AS program_status,
         s.epoch_start,
         s.epoch_end
       FROM agent_lp_reward_accruals a
       INNER JOIN lp_reward_programs p
         ON p.id = a.program_id
       INNER JOIN lp_reward_epoch_snapshots s
         ON s.id = a.snapshot_id
      WHERE a.agent_id = $1
      ORDER BY s.epoch_end DESC, a.created_at DESC
      LIMIT $2`,
      [agent.id, normalizedAccrualLimit],
    ),
    db.query(
      `SELECT
         c.id,
         c.agent_id,
         c.program_id,
         c.accrual_id,
         c.claim_mode,
         c.amount,
         c.tx_hash,
         c.metadata,
         c.created_at,
         p.pool_key,
         p.reward_token
       FROM agent_lp_reward_claims c
       INNER JOIN lp_reward_programs p
         ON p.id = c.program_id
      WHERE c.agent_id = $1
      ORDER BY c.created_at DESC
      LIMIT $2`,
      [agent.id, normalizedClaimLimit],
    ),
    db.query(
      `SELECT
         s.id,
         s.program_id,
         s.epoch_start,
         s.epoch_end,
         s.pool_lp_supply,
         s.eligible_lp_supply,
         s.reward_budget,
         s.source_block_number,
         s.status,
         s.snapshot_payload,
         s.created_at,
         s.updated_at,
         p.pool_key,
         p.reward_token,
         p.status AS program_status
       FROM lp_reward_epoch_snapshots s
       INNER JOIN lp_reward_programs p
         ON p.id = s.program_id
      WHERE p.status IN ('scheduled', 'live', 'paused')
         OR EXISTS (
           SELECT 1
             FROM agent_lp_reward_accruals a
            WHERE a.program_id = s.program_id
              AND a.agent_id = $1
         )
      ORDER BY s.epoch_end DESC, s.created_at DESC
      LIMIT $2`,
      [agent.id, normalizedSnapshotLimit],
    ),
  ]);

  const summaryRow = summaryResult.rows[0] || {};
  const hasLivePrograms = programResult.rows.some((row) => row.status === 'live');
  const hasUnclaimedRewards = Number(summaryRow.total_unclaimed || 0) > 0;
  const latestSnapshot = snapshotResult.rows[0] || null;

  return {
    agentId: agent.id,
    walletAddress: agent.wallet_address,
    summary: {
      trackedPrograms: toInt(summaryRow.tracked_programs),
      openAccruals: toInt(summaryRow.open_accruals),
      totalEarned: toAmountString(summaryRow.total_earned),
      totalClaimed: toAmountString(summaryRow.total_claimed),
      totalUnclaimed: toAmountString(summaryRow.total_unclaimed),
      lastAccrualAt: summaryRow.last_accrual_at || null,
      lastCompoundAt: summaryRow.last_compound_at || null,
      latestSnapshotAt: latestSnapshot?.epoch_end || null,
      claimableRewardsEnabled: hasLivePrograms || toInt(summaryRow.open_accruals) > 0 || hasUnclaimedRewards,
      note: 'Claimable rewards stay separate from fee-only LP yield. Seeded paused programs can publish snapshots before any funded live emissions or accruals exist.',
    },
    programs: programResult.rows.map(mapProgram),
    snapshots: snapshotResult.rows.map(mapSnapshot),
    accruals: accrualResult.rows.map(mapAccrual),
    claims: claimResult.rows.map(mapClaim),
  };
}

module.exports = {
  getAgentRewardOverview,
};