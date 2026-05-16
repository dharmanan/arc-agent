'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const SUPPORTED_TASK_IDS = [
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
];

function loadEnvFiles() {
  const candidates = [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env.local'),
    path.resolve(__dirname, '../../.env'),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false });
    }
  }
}

function parseArgs(argv) {
  const args = {
    agentId: process.env.AGENT_ID || '',
    all: false,
    dryRun: process.env.DRY_RUN === '1',
    limit: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--agent-id') {
      args.agentId = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (current === '--all') {
      args.all = true;
      continue;
    }

    if (current === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (current === '--limit') {
      const parsed = Number.parseInt(argv[index + 1] || '', 10);
      args.limit = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      index += 1;
    }
  }

  return args;
}

function toIsoString(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toTaskTxAmount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getCurveStableTaskToken(index) {
  return Number(index) === 1 ? 'EURC' : 'USDC';
}

function getPaidTaskActivityStatus(payload) {
  if (payload?.dryRun) return 'dry_run';
  if (payload?.skipped) return 'skipped';
  return 'confirmed';
}

function buildExecutionMeta(result) {
  const payload = result.payload || {};

  return {
    taskId: result.task_id,
    taskResultId: result.id,
    taskResultCreatedAt: toIsoString(result.created_at),
    txHash: payload.txHash || payload.hash || payload.swapTxHash || null,
    fromToken: payload.fromToken || getCurveStableTaskToken(payload.indexIn),
    toToken: payload.toToken || getCurveStableTaskToken(payload.indexOut),
    executionRail: payload.executionRail || null,
    swapExecutionRail: payload.swapExecutionRail || null,
    swapRouteStrategy: payload.swapRouteStrategy || null,
    swapRouteReason: payload.swapRouteReason || null,
    poolAddress: payload.poolAddress || null,
    poolSource: payload.poolSource || null,
    indexIn: payload.indexIn ?? null,
    indexOut: payload.indexOut ?? null,
    minDy: payload.minDy || payload.swap?.minDy || null,
    minLpAmount: payload.minLpAmount || null,
    minAmountOut: payload.minAmountOut || null,
    stableToken: payload.stableToken || null,
    volatileToken: payload.volatileToken || null,
    amountIn: payload.amountIn || null,
    requestedAmountIn: payload.requestedAmountIn || payload.amountIn || null,
    amountUsdc: payload.amountUsdc || null,
    amountEth: payload.amountEth || null,
    swappedAmountIn: payload.swappedAmountIn || null,
    remainingAmountIn: payload.remainingAmountIn || null,
    amountOut: payload.amountOut || null,
    lpAmount: payload.lpAmount || null,
    fromChain: payload.fromChain || null,
    toChain: payload.toChain || null,
    direction: payload.direction || null,
    bridgeType: payload.bridgeType || null,
    kind: payload.kind || null,
    targets: Array.isArray(payload.targets) ? payload.targets : null,
    signalOpportunity: payload.signal?.opportunity || null,
    liquidityStableAmountUsed: payload.liquidityStableAmountUsed || null,
    liquidityStableAmountRemaining: payload.liquidityStableAmountRemaining || null,
    liquidityVolatileAmountUsed: payload.liquidityVolatileAmountUsed || null,
    liquidityVolatileAmountRemaining: payload.liquidityVolatileAmountRemaining || null,
    withdrawPct: payload.withdrawPct || null,
    token0Amount: payload.token0Amount || null,
    token1Amount: payload.token1Amount || null,
    token0Symbol: payload.token0Symbol || null,
    token1Symbol: payload.token1Symbol || null,
    swapTxHash: payload.swapTxHash || null,
    swapPoolAddress: payload.swapPoolAddress || null,
    swapPoolSource: payload.swapPoolSource || null,
    mintTxHash: payload.mintTxHash || null,
    burnTxHash: payload.burnTxHash || null,
    summary: payload.summary || null,
    economy: payload.economy || null,
  };
}

function buildTaskActivityRecord(taskId, payload, executionMeta) {
  const status = getPaidTaskActivityStatus(payload);

  if (taskId === 'EXEC_CIRBTC_USDC_ZAP_IN' || taskId === 'EXEC_CIRBTC_EURC_ZAP_IN') {
    return {
      type: 'direct_lp_add',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.stableToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.mintTxHash || payload?.txHash || null,
      status,
      meta: executionMeta,
    };
  }

  if (taskId === 'EXEC_CIRBTC_USDC_LP_REMOVE' || taskId === 'EXEC_CIRBTC_EURC_LP_REMOVE') {
    return {
      type: 'direct_lp_remove',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.stableToken || 'USDC',
      amount: payload?.lpAmount || 0,
      txHash: payload?.burnTxHash || payload?.txHash || null,
      status,
      meta: executionMeta,
    };
  }

  if (taskId === 'EXEC_CURVE_SWAP') {
    return {
      type: 'swap',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: executionMeta.fromToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    };
  }

  if (taskId === 'EXEC_CURVE_LIQUIDITY_ADD') {
    return {
      type: 'curve_lp_add',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.tokenIn || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    };
  }

  if (taskId === 'EXEC_CURVE_LIQUIDITY_REMOVE') {
    return {
      type: 'curve_lp_remove',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.tokenOut || 'USDC',
      amount: payload?.amountOut || 0,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    };
  }

  if (taskId === 'EXEC_CCTP_BRIDGE') {
    return {
      type: 'bridge',
      fromChain: payload?.fromChain || 'Arc Testnet',
      toChain: payload?.toChain || 'Arc Testnet',
      token: 'USDC',
      amount: payload?.amountUsdc,
      txHash: payload?.burnTxHash || payload?.txHash || null,
      status,
      meta: executionMeta,
    };
  }

  if (taskId === 'EXEC_SEPOLIA_GAS_FANOUT') {
    return {
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
    };
  }

  if (taskId === 'EXEC_ARB') {
    return {
      type: 'task_arb',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: executionMeta.fromToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.swapTxHash || payload?.swap?.txHash || payload?.swap?.hash || null,
      status,
      meta: executionMeta,
    };
  }

  if (taskId === 'EXEC_REBALANCE') {
    return {
      type: 'rebalance',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.fromToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    };
  }

  return null;
}

async function insertTaskActivityRecord(client, agentId, record, createdAt) {
  await client.query(
    `INSERT INTO transactions
       (agent_id, type, from_chain, to_chain, token, amount_usdc, tx_hash, status, meta, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz)`,
    [
      agentId,
      record.type,
      record.fromChain || null,
      record.toChain || null,
      record.token || 'USDC',
      toTaskTxAmount(record.amount),
      record.txHash || null,
      record.status || 'confirmed',
      JSON.stringify(record.meta || {}),
      createdAt || new Date().toISOString(),
    ],
  );
}

async function findExistingEquivalentActivity(client, agentId, record) {
  if (!record.txHash) return null;

  const { rows: [row] } = await client.query(
    `SELECT id, meta->>'taskResultId' AS task_result_id
       FROM transactions
      WHERE agent_id = $1
        AND type = $2
        AND tx_hash = $3
      ORDER BY (meta->>'taskResultId' IS NOT NULL) DESC, created_at DESC
      LIMIT 1`,
    [agentId, record.type, record.txHash],
  );

  return row || null;
}

async function updateTaskActivityRecord(client, id, record, createdAt) {
  await client.query(
    `UPDATE transactions
        SET from_chain = $2,
            to_chain = $3,
            token = $4,
            amount_usdc = $5,
            tx_hash = $6,
            status = $7,
            meta = COALESCE(meta, '{}'::jsonb) || $8::jsonb,
            created_at = $9::timestamptz
      WHERE id = $1`,
    [
      id,
      record.fromChain || null,
      record.toChain || null,
      record.token || 'USDC',
      toTaskTxAmount(record.amount),
      record.txHash || null,
      record.status || 'confirmed',
      JSON.stringify(record.meta || {}),
      createdAt || new Date().toISOString(),
    ],
  );
}

function printUsage() {
  console.log([
    'Usage: node scripts/backfillTaskActivities.js --agent-id <uuid> [--dry-run] [--limit <n>]',
    '       node scripts/backfillTaskActivities.js --all [--dry-run] [--limit <n>]',
  ].join('\n'));
}

async function main() {
  loadEnvFiles();

  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  if (!args.all && !args.agentId) {
    printUsage();
    throw new Error('Pass --agent-id <uuid> or --all');
  }

  const db = require('../src/db');
  const queryParams = [SUPPORTED_TASK_IDS];
  const conditions = ['r.task_id = ANY($1::text[])'];

  if (!args.all) {
    queryParams.push(args.agentId);
    conditions.push(`r.agent_id = $${queryParams.length}`);
  }

  const limitClause = args.limit ? `LIMIT ${args.limit}` : '';
  const { rows } = await db.query(
    `SELECT r.id, r.agent_id, r.task_id, r.payload, r.created_at
       FROM agent_task_results r
      WHERE ${conditions.join(' AND ')}
        AND NOT EXISTS (
          SELECT 1
            FROM transactions t
           WHERE t.agent_id = r.agent_id
             AND t.meta->>'taskResultId' = r.id::text
        )
      ORDER BY r.created_at ASC
      ${limitClause}`,
    queryParams,
  );

  if (rows.length === 0) {
    console.log('No missing task activity rows found.');
    return;
  }

  const prepared = rows.map((result) => {
    const executionMeta = buildExecutionMeta(result);
    const record = buildTaskActivityRecord(result.task_id, result.payload || {}, executionMeta);
    if (!record) {
      throw new Error(`Unsupported task activity mapping: ${result.task_id}`);
    }

    return {
      resultId: result.id,
      agentId: result.agent_id,
      taskId: result.task_id,
      createdAt: toIsoString(result.created_at),
      record,
    };
  });

  console.log(`Prepared ${prepared.length} missing task activity row(s).`);
  for (const item of prepared) {
    console.log(`${item.createdAt} ${item.agentId} ${item.taskId} -> ${item.record.type} (${item.record.status})`);
  }

  if (args.dryRun) {
    console.log('Dry run only. No rows inserted.');
    return;
  }

  const client = await db.getClient();
  let insertedCount = 0;
  let updatedCount = 0;
  try {
    await client.query('BEGIN');

    for (const item of prepared) {
      const existing = await findExistingEquivalentActivity(client, item.agentId, item.record);

      if (existing && !existing.task_result_id) {
        await updateTaskActivityRecord(client, existing.id, item.record, item.createdAt);
        updatedCount += 1;
        continue;
      }

      if (existing && existing.task_result_id === item.resultId) {
        continue;
      }

      await insertTaskActivityRecord(client, item.agentId, item.record, item.createdAt);
      insertedCount += 1;
    }

    await client.query('COMMIT');
    console.log(`Inserted ${insertedCount} task activity row(s).`);
    console.log(`Updated ${updatedCount} existing task activity row(s).`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});