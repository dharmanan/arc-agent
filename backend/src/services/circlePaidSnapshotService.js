'use strict';

const db = require('../db');
const taskEconomyService = require('./agenticEconomy/taskEconomyService');

const DEFAULT_PREVIEW_TTL_MINUTES = Number.parseInt(process.env.CIRCLE_PAID_PREVIEW_TTL_MINUTES || '15', 10);
const SNAPSHOT_LIST_LIMIT = 20;
const SNAPSHOT_STATUS = Object.freeze({
  PREVIEW_READY: 'preview_ready',
  UNLOCKED: 'unlocked',
  EXPIRED: 'expired',
  PAYMENT_FAILED: 'payment_failed',
});
const ALLOWED_LIST_STATUSES = new Set([
  SNAPSHOT_STATUS.PREVIEW_READY,
  SNAPSHOT_STATUS.UNLOCKED,
  SNAPSHOT_STATUS.EXPIRED,
  SNAPSHOT_STATUS.PAYMENT_FAILED,
]);

function normalizePreviewTtlMinutes() {
  return Number.isInteger(DEFAULT_PREVIEW_TTL_MINUTES) && DEFAULT_PREVIEW_TTL_MINUTES > 0
    ? DEFAULT_PREVIEW_TTL_MINUTES
    : 15;
}

function normalizeJsonObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : fallback;
}

function normalizeListLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return SNAPSHOT_LIST_LIMIT;
  return Math.min(parsed, 100);
}

function isPreviewExpired(snapshot) {
  if (!snapshot || snapshot.status !== SNAPSHOT_STATUS.PREVIEW_READY) return false;
  const previewExpiresAt = snapshot.preview_expires_at || snapshot.previewExpiresAt;
  if (!previewExpiresAt) return false;
  const expiresAtMs = new Date(previewExpiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function buildPredictionMarketPreviewPayload(fullPayload = {}) {
  const liveResult = normalizeJsonObject(fullPayload);

  if (liveResult.walletAddress && Array.isArray(liveResult.balances)) {
    return {
      provider: 'arc_wallet_snapshot',
      summary: liveResult.summary || 'Wallet snapshot preview is ready.',
      status: liveResult.status || 'preview_ready',
      walletAddress: liveResult.walletAddress || null,
      posture: liveResult.posture || null,
      recommendedTaskId: liveResult.recommendedTaskId || null,
      metrics: {
        liquidUsd: liveResult.metrics?.liquidUsd ?? null,
        positionUsd: liveResult.metrics?.positionUsd ?? null,
        totalWalletUsd: liveResult.metrics?.totalWalletUsd ?? null,
        positionCount: liveResult.metrics?.positionCount ?? null,
        warningCount: liveResult.metrics?.warningCount ?? null,
      },
      balances: liveResult.balances.slice(0, 3).map((balance) => ({
        symbol: balance.symbol,
        amount: balance.amount ?? null,
        usdValue: balance.usdValue ?? null,
        exposurePct: balance.exposurePct ?? null,
      })),
      positions: Array.isArray(liveResult.positions)
        ? liveResult.positions.slice(0, 3).map((position) => ({
            poolKey: position.poolKey,
            protocol: position.protocol,
            totalUsd: position.totalUsd ?? null,
            sharePct: position.sharePct ?? null,
          }))
        : [],
      dailySummary: liveResult.dailySummary
        ? {
            status: liveResult.dailySummary.status || 'unknown',
            summary: liveResult.dailySummary.summary || null,
            counts: {
              lpAdds: liveResult.dailySummary.counts?.lpAdds ?? null,
              lpRemoves: liveResult.dailySummary.counts?.lpRemoves ?? null,
              swaps: liveResult.dailySummary.counts?.swaps ?? null,
              rebalances: liveResult.dailySummary.counts?.rebalances ?? null,
              lendingBorrows: liveResult.dailySummary.counts?.lendingBorrows ?? null,
              arbSignalsFound: liveResult.dailySummary.counts?.arbSignalsFound ?? null,
            },
          }
        : null,
      fetchedAt: liveResult.fetchedAt || new Date().toISOString(),
    };
  }

  const metrics = normalizeJsonObject(liveResult.metrics);
  const comparison = normalizeJsonObject(liveResult.comparison, null);
  const primaryComparison = normalizeJsonObject(comparison?.primary, null);
  const secondaryComparison = normalizeJsonObject(comparison?.secondary, null);

  return {
    provider: liveResult.provider || 'polymarket',
    summary: liveResult.summary || 'Prediction market preview is ready.',
    regime: liveResult.regime || 'UNKNOWN',
    confidence: liveResult.confidence || 'LOW',
    status: liveResult.status || 'preview_ready',
    primaryTopic: liveResult.primaryTopic || null,
    secondaryTopic: liveResult.secondaryTopic || null,
    metrics: {
      matchingMarkets: metrics.matchingMarkets ?? null,
      averageOneDayMovePct: metrics.averageOneDayMovePct ?? null,
      averageLiquidityUsd: metrics.averageLiquidityUsd ?? null,
      totalVolume24hrUsd: metrics.totalVolume24hrUsd ?? null,
      movementGapPct: metrics.movementGapPct ?? null,
      liquidityGapUsd: metrics.liquidityGapUsd ?? null,
      primaryMatchingMarkets: metrics.primaryMatchingMarkets ?? null,
      secondaryMatchingMarkets: metrics.secondaryMatchingMarkets ?? null,
    },
    comparison: comparison && primaryComparison && secondaryComparison
      ? {
          state: comparison.state || 'aligned',
          dominantTopic: comparison.dominantTopic || null,
          movementGapPct: comparison.movementGapPct ?? metrics.movementGapPct ?? null,
          liquidityGapUsd: comparison.liquidityGapUsd ?? metrics.liquidityGapUsd ?? null,
          primary: {
            topic: primaryComparison.topic || liveResult.primaryTopic || null,
            regime: primaryComparison.regime || 'UNKNOWN',
            matchingMarkets: primaryComparison.matchingMarkets ?? null,
            averageOneDayMovePct: primaryComparison.averageOneDayMovePct ?? null,
            averageLiquidityUsd: primaryComparison.averageLiquidityUsd ?? null,
            topMarketQuestion: primaryComparison.topMarket?.question || null,
          },
          secondary: {
            topic: secondaryComparison.topic || liveResult.secondaryTopic || null,
            regime: secondaryComparison.regime || 'UNKNOWN',
            matchingMarkets: secondaryComparison.matchingMarkets ?? null,
            averageOneDayMovePct: secondaryComparison.averageOneDayMovePct ?? null,
            averageLiquidityUsd: secondaryComparison.averageLiquidityUsd ?? null,
            topMarketQuestion: secondaryComparison.topMarket?.question || null,
          },
        }
      : null,
    fetchedAt: liveResult.fetchedAt || new Date().toISOString(),
  };
}

function buildCirclePaidPricingSnapshot(item = {}) {
  const pricing = normalizeJsonObject(item.pricing);

  return {
    providerFeeUsdc: Number(pricing.providerFeeUsdc || 0),
    arcFeeUsdc: Number(pricing.arcFeeUsdc || 0),
    totalFeeUsdc: Number(pricing.totalFeeUsdc || 0),
  };
}

function getCirclePaidPreviewExpiryDate() {
  return new Date(Date.now() + normalizePreviewTtlMinutes() * 60_000);
}

async function createCirclePaidPreviewSnapshot({
  agentId,
  itemId,
  params = {},
  previewPayload = {},
  fullPayload = {},
  pricing = {},
}) {
  const previewExpiresAt = getCirclePaidPreviewExpiryDate();
  const { rows: [row] } = await db.query(
    `INSERT INTO circle_paid_snapshots (
       agent_id,
       item_id,
       status,
       params,
       preview_payload,
       full_payload,
       pricing,
       economy,
       preview_expires_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, '{}'::jsonb, $8)
     RETURNING *`,
    [
      agentId,
      itemId,
      SNAPSHOT_STATUS.PREVIEW_READY,
      JSON.stringify(normalizeJsonObject(params)),
      JSON.stringify(normalizeJsonObject(previewPayload)),
      JSON.stringify(normalizeJsonObject(fullPayload)),
      JSON.stringify(normalizeJsonObject(pricing)),
      previewExpiresAt.toISOString(),
    ],
  );

  return row;
}

async function markCirclePaidSnapshotExpired(snapshotId) {
  const { rows: [row] } = await db.query(
    `UPDATE circle_paid_snapshots
        SET status = $2,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [snapshotId, SNAPSHOT_STATUS.EXPIRED],
  );

  return row || null;
}

async function recordCirclePaidPaymentFailure(snapshotId, payload = {}) {
  const { rows: [row] } = await db.query(
    `UPDATE circle_paid_snapshots
        SET status = $2,
            economy = $3::jsonb,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [snapshotId, SNAPSHOT_STATUS.PAYMENT_FAILED, JSON.stringify(normalizeJsonObject(payload))],
  );

  return row || null;
}

async function getCirclePaidSnapshotForAgent(agentId, snapshotId) {
  const { rows: [row] } = await db.query(
    `SELECT *
       FROM circle_paid_snapshots
      WHERE id = $1
        AND agent_id = $2
      LIMIT 1`,
    [snapshotId, agentId],
  );

  if (!row) return null;
  if (!isPreviewExpired(row)) return row;
  return markCirclePaidSnapshotExpired(row.id);
}

async function listCirclePaidSnapshots(agentId, { itemId = '', status = 'unlocked', limit = SNAPSHOT_LIST_LIMIT } = {}) {
  const conditions = ['agent_id = $1'];
  const values = [agentId];

  if (itemId) {
    values.push(String(itemId).trim().toUpperCase());
    conditions.push(`item_id = $${values.length}`);
  }

  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (ALLOWED_LIST_STATUSES.has(normalizedStatus)) {
    values.push(normalizedStatus);
    conditions.push(`status = $${values.length}`);
  }

  values.push(normalizeListLimit(limit));

  const { rows } = await db.query(
    `SELECT *
       FROM circle_paid_snapshots
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${values.length}`,
    values,
  );

  return Promise.all(rows.map(async (row) => {
    if (!isPreviewExpired(row)) return row;
    return markCirclePaidSnapshotExpired(row.id);
  }));
}

function isUnlockEconomySettled(economy) {
  return economy?.status === 'confirmed' || economy?.reason === 'dry_run';
}

function buildCirclePaidUnlockPaymentError(code, statusCode, payload = {}) {
  const error = new Error(code);
  error.status = statusCode;
  error.code = code;
  error.details = payload;
  return error;
}

async function unlockCirclePaidSnapshot({ agent, snapshot }) {
  if (!agent?.id) {
    throw buildCirclePaidUnlockPaymentError('agent_not_found', 404);
  }

  if (!snapshot) {
    throw buildCirclePaidUnlockPaymentError('preview_not_found', 404);
  }

  if (snapshot.status === SNAPSHOT_STATUS.UNLOCKED) {
    throw buildCirclePaidUnlockPaymentError('preview_already_unlocked', 409);
  }

  if (snapshot.status === SNAPSHOT_STATUS.EXPIRED || isPreviewExpired(snapshot)) {
    await markCirclePaidSnapshotExpired(snapshot.id);
    throw buildCirclePaidUnlockPaymentError('preview_expired', 422);
  }

  const pricing = normalizeJsonObject(snapshot.pricing);
  const totalFeeUsdc = Number(pricing.totalFeeUsdc || 0);
  if (!(totalFeeUsdc > 0)) {
    throw buildCirclePaidUnlockPaymentError('circle_paid_pricing_missing', 500, { snapshotId: snapshot.id });
  }

  let economy;
  try {
    economy = await taskEconomyService.settleExecutionFee({
      agent,
      referenceId: snapshot.id,
      referenceType: 'circle_paid_unlock',
      feeUsdc: totalFeeUsdc,
      mode: 'circle_paid_information_unlock',
      rail: 'circle_paid_info_unlock',
    });
  } catch (error) {
    await recordCirclePaidPaymentFailure(snapshot.id, {
      status: 'failed',
      error: error.message || 'payment_settlement_failed',
    });

    if (error?.statusCode === 400 && error?.message === 'insufficient_wallet_balance_for_gateway_deposit') {
      throw buildCirclePaidUnlockPaymentError('insufficient_wallet_balance_for_gateway_deposit', 400, error.details || {});
    }

    throw buildCirclePaidUnlockPaymentError('payment_settlement_failed', 502, {
      reason: error.message || 'payment_settlement_failed',
    });
  }

  if (!isUnlockEconomySettled(economy)) {
    await recordCirclePaidPaymentFailure(snapshot.id, economy);
    throw buildCirclePaidUnlockPaymentError('payment_settlement_failed', 502, economy);
  }

  const { rows: [row] } = await db.query(
    `UPDATE circle_paid_snapshots
        SET status = $2,
            economy = $3::jsonb,
            unlocked_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [snapshot.id, SNAPSHOT_STATUS.UNLOCKED, JSON.stringify(normalizeJsonObject(economy))],
  );

  return row;
}

module.exports = {
  SNAPSHOT_STATUS,
  buildCirclePaidPricingSnapshot,
  buildPredictionMarketPreviewPayload,
  createCirclePaidPreviewSnapshot,
  getCirclePaidPreviewExpiryDate,
  getCirclePaidSnapshotForAgent,
  isPreviewExpired,
  listCirclePaidSnapshots,
  unlockCirclePaidSnapshot,
};