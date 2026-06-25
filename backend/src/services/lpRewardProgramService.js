'use strict';

const { ethers } = require('ethers');
const db = require('../db');
const oracle = require('./oracle');
const { resolveCurvePool, resolveDirectSwapFallbackPool } = require('./oracle/pools');
const { createArcRpcProvider } = require('./arcProvider');

const DEFAULT_EPOCH_DURATION_MINUTES = 60;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const LP_TOTAL_SUPPLY_ABI = ['function totalSupply() view returns (uint256)'];

let writerInFlight = false;
let writerTimer = null;

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getProvider() {
  return createArcRpcProvider();
}

function toNumericString(value, fallback = '0') {
  if (value == null || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : fallback;
}

function getEpochDurationMinutes(program) {
  const candidate = Number.parseInt(program?.metadata?.epochDurationMinutes, 10);
  if (Number.isInteger(candidate) && candidate > 0) return candidate;
  return readPositiveIntegerEnv('LP_REWARD_EPOCH_DURATION_MINUTES', DEFAULT_EPOCH_DURATION_MINUTES);
}

function formatInterval(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

function getDefaultSeedPrograms() {
  const nowIso = new Date().toISOString();
  const status = String(process.env.STABLE_REWARD_PROGRAM_STATUS || 'paused').trim().toLowerCase();

  return [
    {
      seedKey: 'stable_usdc_eurc_claimable_v1',
      poolKey: 'USDC-EURC',
      rewardToken: process.env.STABLE_REWARD_TOKEN || 'USDC',
      rewardSourceType: 'protocol_revenue',
      emissionMode: 'epoch_budget',
      emissionRate: process.env.STABLE_REWARD_EPOCH_BUDGET || '0',
      startAt: nowIso,
      endAt: null,
      status: ['draft', 'scheduled', 'live', 'paused', 'ended'].includes(status) ? status : 'paused',
      metadata: {
        seedKey: 'stable_usdc_eurc_claimable_v1',
        autoSeeded: true,
        displayName: 'USDC/EURC Stable Rewards v1',
        description: 'Seeded stable reward program for the verified Curve lane. Claimable rewards remain separate from fee-only LP yield.',
        epochDurationMinutes: readPositiveIntegerEnv('LP_REWARD_EPOCH_DURATION_MINUTES', DEFAULT_EPOCH_DURATION_MINUTES),
        autoAccrualEnabled: false,
        rewardFundingLive: false,
        fundingNote: 'Program seeded for ledger wiring. Separate claimable emissions are still paused until a real reward source is funded.',
      },
    },
  ];
}

async function ensureLpRewardProgramsSeeded() {
  const seededPrograms = getDefaultSeedPrograms();
  const seededRows = [];

  for (const program of seededPrograms) {
    const { rows: existingRows } = await db.query(
      `SELECT id
         FROM lp_reward_programs
        WHERE pool_key = $1
          AND reward_token = $2
          AND COALESCE(metadata->>'seedKey', '') = $3
        LIMIT 1`,
      [program.poolKey, program.rewardToken, program.seedKey],
    );

    if (existingRows.length > 0) {
      const { rows: updatedRows } = await db.query(
        `UPDATE lp_reward_programs
            SET reward_source_type = $2,
                emission_mode = $3,
                emission_rate = $4,
                start_at = $5,
                end_at = $6,
                status = $7,
                metadata = $8::jsonb,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [
          existingRows[0].id,
          program.rewardSourceType,
          program.emissionMode,
          program.emissionRate,
          program.startAt,
          program.endAt,
          program.status,
          JSON.stringify(program.metadata),
        ],
      );
      seededRows.push(updatedRows[0]);
      continue;
    }

    const { rows: insertedRows } = await db.query(
      `INSERT INTO lp_reward_programs (
         pool_key,
         reward_token,
         reward_source_type,
         emission_mode,
         emission_rate,
         start_at,
         end_at,
         status,
         metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [
        program.poolKey,
        program.rewardToken,
        program.rewardSourceType,
        program.emissionMode,
        program.emissionRate,
        program.startAt,
        program.endAt,
        program.status,
        JSON.stringify(program.metadata),
      ],
    );
    seededRows.push(insertedRows[0]);
  }

  if (seededRows.length > 0) {
    console.log(`[LP_REWARDS] Seeded/updated ${seededRows.length} reward program definition(s)`);
  }

  return seededRows;
}

function buildEpochWindow(program, now = new Date()) {
  const durationMinutes = getEpochDurationMinutes(program);
  const durationMs = durationMinutes * 60 * 1000;
  const nowMs = now.getTime();
  const anchorMs = program.start_at ? new Date(program.start_at).getTime() : 0;

  if (Number.isFinite(anchorMs) && nowMs < anchorMs) {
    return {
      epochStart: new Date(anchorMs).toISOString(),
      epochEnd: new Date(anchorMs + durationMs).toISOString(),
      durationMinutes,
    };
  }

  const baseAnchor = Number.isFinite(anchorMs) ? anchorMs : 0;
  const epochIndex = Math.floor(Math.max(0, nowMs - baseAnchor) / durationMs);
  const epochStartMs = baseAnchor + (epochIndex * durationMs);
  const epochEndMs = epochStartMs + durationMs;

  return {
    epochStart: new Date(epochStartMs).toISOString(),
    epochEnd: new Date(epochEndMs).toISOString(),
    durationMinutes,
  };
}

function resolveSnapshotStatus(program, now = new Date()) {
  const nowMs = now.getTime();
  const startAtMs = program.start_at ? new Date(program.start_at).getTime() : null;
  const endAtMs = program.end_at ? new Date(program.end_at).getTime() : null;

  if (program.status === 'ended') return 'cancelled';
  if (Number.isFinite(endAtMs) && nowMs >= endAtMs) return 'cancelled';
  if (program.status === 'live') return 'finalized';
  if (Number.isFinite(startAtMs) && nowMs < startAtMs) return 'pending';
  if (program.status === 'scheduled') return 'pending';
  return 'pending';
}

function computeRewardBudget(program, durationMinutes) {
  const emissionRate = Number(program.emission_rate || 0);
  if (!Number.isFinite(emissionRate) || emissionRate <= 0) return '0';

  if (program.emission_mode === 'fixed_rate') {
    const intervalMinutes = Number.parseInt(program?.metadata?.emissionIntervalMinutes, 10);
    const normalizedIntervalMinutes = Number.isInteger(intervalMinutes) && intervalMinutes > 0
      ? intervalMinutes
      : durationMinutes;
    return String((emissionRate * durationMinutes) / normalizedIntervalMinutes);
  }

  return String(emissionRate);
}

async function loadPoolSnapshot(program) {
  const curvePool = resolveCurvePool(program.pool_key);
  const fallbackPool = resolveDirectSwapFallbackPool(program.pool_key);

  try {
    const provider = getProvider();

    if (curvePool?.address) {
      const [state, totalSupplyRaw, blockNumber] = await Promise.all([
        oracle.getCurvePoolState(curvePool),
        new ethers.Contract(curvePool.address, LP_TOTAL_SUPPLY_ABI, provider).totalSupply(),
        provider.getBlockNumber(),
      ]);

      const poolLpSupply = ethers.formatUnits(totalSupplyRaw, 18);
      const isEligible = program.status === 'live' && state?.liquidityState !== 'empty';

      return {
        poolLpSupply,
        eligibleLpSupply: isEligible ? poolLpSupply : '0',
        sourceBlockNumber: blockNumber,
        snapshotPayload: {
          protocol: 'curve',
          poolAddress: curvePool.address,
          source: curvePool.source,
          liquidityState: state?.liquidityState || curvePool.liquidityState || 'unknown',
          impliedRate: state?.impliedRate ?? null,
          feePct: state?.fee ?? null,
          priceImpact10kPct: state?.priceImpact?.swap10k ?? null,
          reserves: state?.reserves || null,
          rewardFundingLive: program.status === 'live',
          accrualEligible: isEligible,
        },
      };
    }

    if (fallbackPool?.address) {
      const [state, totalSupplyRaw, blockNumber] = await Promise.all([
        oracle.getConstantProductPoolState(fallbackPool),
        new ethers.Contract(fallbackPool.address, LP_TOTAL_SUPPLY_ABI, provider).totalSupply(),
        provider.getBlockNumber(),
      ]);

      const poolLpSupply = ethers.formatUnits(totalSupplyRaw, 18);
      const isEligible = program.status === 'live' && state?.liquidityState !== 'empty';

      return {
        poolLpSupply,
        eligibleLpSupply: isEligible ? poolLpSupply : '0',
        sourceBlockNumber: blockNumber,
        snapshotPayload: {
          protocol: fallbackPool.protocol || 'constant_product',
          poolAddress: fallbackPool.address,
          source: fallbackPool.source,
          liquidityState: state?.liquidityState || fallbackPool.liquidityState || 'unknown',
          impliedRate: state?.impliedRate ?? null,
          feePct: state?.fee ?? null,
          priceImpact10kPct: state?.priceImpact?.swap10k ?? null,
          reserves: state?.reserves || null,
          rewardFundingLive: program.status === 'live',
          accrualEligible: isEligible,
        },
      };
    }
  } catch (error) {
    return {
      poolLpSupply: '0',
      eligibleLpSupply: '0',
      sourceBlockNumber: null,
      snapshotPayload: {
        protocol: curvePool?.address ? 'curve' : (fallbackPool?.protocol || 'unknown'),
        poolAddress: curvePool?.address || fallbackPool?.address || null,
        source: 'snapshot_writer_fallback',
        liquidityState: 'unknown',
        rewardFundingLive: program.status === 'live',
        accrualEligible: false,
        note: error.message || 'Pool snapshot writer fell back because live RPC data was unavailable.',
      },
    };
  }

  return {
    poolLpSupply: '0',
    eligibleLpSupply: '0',
    sourceBlockNumber: null,
    snapshotPayload: {
      protocol: 'unknown',
      poolAddress: null,
      source: 'unresolved',
      liquidityState: 'unknown',
      rewardFundingLive: false,
      accrualEligible: false,
      note: 'Pool configuration could not be resolved for snapshot writing.',
    },
  };
}

async function upsertEpochSnapshotForProgram(program, now = new Date()) {
  const { epochStart, epochEnd, durationMinutes } = buildEpochWindow(program, now);
  const poolSnapshot = await loadPoolSnapshot(program);
  const rewardBudget = computeRewardBudget(program, durationMinutes);
  const snapshotStatus = resolveSnapshotStatus(program, now);
  const snapshotPayload = {
    ...(poolSnapshot.snapshotPayload || {}),
    epochDurationMinutes: durationMinutes,
    programStatus: program.status,
    rewardSourceType: program.reward_source_type,
    emissionMode: program.emission_mode,
    emissionRate: toNumericString(program.emission_rate),
    rewardFundingLive: program.status === 'live',
    accrualEligible: snapshotStatus === 'finalized' && poolSnapshot.snapshotPayload?.accrualEligible === true,
  };

  const { rows: [row] } = await db.query(
    `INSERT INTO lp_reward_epoch_snapshots (
       program_id,
       epoch_start,
       epoch_end,
       pool_lp_supply,
       eligible_lp_supply,
       reward_budget,
       source_block_number,
       status,
       snapshot_payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (program_id, epoch_start, epoch_end)
     DO UPDATE SET
       pool_lp_supply = EXCLUDED.pool_lp_supply,
       eligible_lp_supply = EXCLUDED.eligible_lp_supply,
       reward_budget = EXCLUDED.reward_budget,
       source_block_number = EXCLUDED.source_block_number,
       status = EXCLUDED.status,
       snapshot_payload = EXCLUDED.snapshot_payload,
       updated_at = NOW()
     RETURNING *`,
    [
      program.id,
      epochStart,
      epochEnd,
      poolSnapshot.poolLpSupply,
      poolSnapshot.eligibleLpSupply,
      rewardBudget,
      poolSnapshot.sourceBlockNumber,
      snapshotStatus,
      JSON.stringify(snapshotPayload),
    ],
  );

  return row;
}

async function writeLpRewardEpochSnapshots({ now = new Date() } = {}) {
  if (writerInFlight) {
    return { enabled: true, skipped: 'in_flight', processed: 0, written: 0 };
  }

  writerInFlight = true;

  try {
    await ensureLpRewardProgramsSeeded();

    const { rows: programs } = await db.query(
      `SELECT *
         FROM lp_reward_programs
        WHERE status IN ('scheduled', 'live', 'paused')
        ORDER BY start_at ASC NULLS LAST, created_at ASC`,
    );

    let written = 0;
    for (const program of programs) {
      await upsertEpochSnapshotForProgram(program, now);
      written += 1;
    }

    if (written > 0) {
      console.log(`[LP_REWARDS] Wrote ${written} epoch snapshot(s)`);
    }

    return {
      enabled: true,
      processed: programs.length,
      written,
    };
  } finally {
    writerInFlight = false;
  }
}

function startLpRewardEpochSnapshotWriter() {
  if (writerTimer) return;

  const intervalMs = readPositiveIntegerEnv('LP_REWARD_SNAPSHOT_INTERVAL_MS', DEFAULT_SNAPSHOT_INTERVAL_MS);
  if (intervalMs < 60_000) {
    console.log('[LP_REWARDS] Snapshot writer disabled (LP_REWARD_SNAPSHOT_INTERVAL_MS < 60000)');
    return;
  }

  console.log(`[LP_REWARDS] Snapshot writer enabled — interval ${formatInterval(intervalMs)}`);

  writeLpRewardEpochSnapshots().catch((err) => {
    console.error('[LP_REWARDS] Initial snapshot write error:', err.message);
  });

  writerTimer = setInterval(() => {
    writeLpRewardEpochSnapshots().catch((err) => {
      console.error('[LP_REWARDS] Scheduled snapshot write error:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  ensureLpRewardProgramsSeeded,
  writeLpRewardEpochSnapshots,
  startLpRewardEpochSnapshotWriter,
};