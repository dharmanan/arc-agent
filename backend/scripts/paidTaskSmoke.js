'use strict';

const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);

const { ethers } = require('ethers');
const db = require('../src/db');
const executionService = require('../src/services/agenticEconomy/agenticTaskExecutionService');
const { resolveCurvePool, resolveDirectSwapFallbackPool, TOKENS } = require('../src/services/oracle/pools');
const { getCurveQuote } = require('../src/services/protocols/curveSwap');

const TOKEN_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const DIRECT_PAIR_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const ARC_RPC_URL = process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);

function formatNumber(value, digits = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toFixed(digits).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

async function getLatestAgentId() {
  const recentRun = await db.query(
    'SELECT agent_id FROM agent_task_runs ORDER BY created_at DESC LIMIT 1',
  );
  if (recentRun.rows[0]?.agent_id) return recentRun.rows[0].agent_id;

  const recentAgent = await db.query(
    'SELECT id FROM agents ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1',
  );
  return recentAgent.rows[0]?.id || null;
}

async function getAgent(agentId) {
  const { rows: [agent] } = await db.query(
    'SELECT id, wallet_address FROM agents WHERE id = $1 LIMIT 1',
    [agentId],
  );
  return agent || null;
}

async function getRecentRuns(agentId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (task_id)
        task_id,
        status,
        stage_label,
        stage_detail,
        error,
        created_at
       FROM agent_task_runs
      WHERE agent_id = $1
      ORDER BY task_id, created_at DESC`,
    [agentId],
  );

  return Object.fromEntries(rows.map((row) => [
    row.task_id,
    {
      status: row.status,
      stageLabel: row.stage_label,
      stageDetail: row.stage_detail,
      error: row.error,
      createdAt: row.created_at,
    },
  ]));
}

async function readTokenBalance(tokenAddress, walletAddress, decimals = 6, abi = TOKEN_BALANCE_ABI) {
  if (!tokenAddress || !walletAddress) return null;

  const contract = new ethers.Contract(tokenAddress, abi, provider);
  const rawBalance = await contract.balanceOf(walletAddress);
  return Number(ethers.formatUnits(rawBalance, decimals));
}

async function readPairState(pairAddress) {
  if (!pairAddress) return null;

  const pair = new ethers.Contract(pairAddress, DIRECT_PAIR_ABI, provider);
  const reserves = await pair.getReserves();

  return {
    reserve0: reserves.reserve0.toString(),
    reserve1: reserves.reserve1.toString(),
    seeded: reserves.reserve0 > 0n && reserves.reserve1 > 0n,
  };
}

async function runSafeCheck(label, fn) {
  try {
    return {
      label,
      ok: true,
      result: await fn(),
    };
  } catch (error) {
    return {
      label,
      ok: false,
      error: error.message,
    };
  }
}

function summarizeFundsGate(balance, required, unit) {
  if (balance == null) return 'unknown';
  if (balance >= required) return `pass:${required} ${unit}`;
  return `insufficient_${String(unit).toLowerCase()}:${formatNumber(balance)}`;
}

async function main() {
  const explicitAgentId = process.argv[2];
  const agentId = explicitAgentId || await getLatestAgentId();

  if (!agentId) {
    throw new Error('No agent found for paid task smoke test.');
  }

  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const recentRuns = await getRecentRuns(agentId);
  const usdcEurcCurvePool = resolveCurvePool('USDC-EURC');
  const eurcUsdcCurvePool = resolveCurvePool('EURC-USDC');
  const usdcCirbtcPair = resolveDirectSwapFallbackPool('USDC-cirBTC');
  const eurcCirbtcPair = resolveDirectSwapFallbackPool('EURC-cirBTC');

  const balances = {
    arcUsdc: await readTokenBalance(process.env.USDC_ADDRESS_ARC || TOKENS.USDC, agent.wallet_address, 6).catch(() => null),
    arcEurc: await readTokenBalance(process.env.EURC_ADDRESS_ARC || TOKENS.EURC, agent.wallet_address, 6).catch(() => null),
    arcCirbtc: await readTokenBalance(process.env.CIRBTC_ADDRESS_ARC || TOKENS.CIRBTC, agent.wallet_address, 8).catch(() => null),
    curveLp: usdcEurcCurvePool?.address
      ? await readTokenBalance(usdcEurcCurvePool.address, agent.wallet_address, 18).catch(() => null)
      : null,
    usdcCirbtcLp: usdcCirbtcPair?.address
      ? await readTokenBalance(usdcCirbtcPair.address, agent.wallet_address, 18, DIRECT_PAIR_ABI).catch(() => null)
      : null,
    eurcCirbtcLp: eurcCirbtcPair?.address
      ? await readTokenBalance(eurcCirbtcPair.address, agent.wallet_address, 18, DIRECT_PAIR_ABI).catch(() => null)
      : null,
  };

  const checks = [];

  checks.push({
    taskId: 'EXEC_CURVE_SWAP',
    recent: recentRuns.EXEC_CURVE_SWAP || null,
    fundsGate: summarizeFundsGate(balances.arcUsdc, 1, 'USDC'),
    preflight: await runSafeCheck('curve_swap', async () => {
      const dryRun = await executionService.executeCurveSwapTask({
        agent,
        params: { amountIn: '1' },
        dryRun: true,
        defaultCurvePool: usdcEurcCurvePool,
      });

      const quote = usdcEurcCurvePool?.address
        ? await getCurveQuote(
          usdcEurcCurvePool.address,
          usdcEurcCurvePool.baseToken.index,
          usdcEurcCurvePool.quoteToken.index,
          '1',
          6,
          6,
        )
        : null;

      return {
        ok: dryRun.ok,
        reason: dryRun.reason || null,
        quoteAmountOut: quote?.amountOut || null,
      };
    }),
  });

  checks.push({
    taskId: 'EXEC_CURVE_LIQUIDITY_ADD',
    recent: recentRuns.EXEC_CURVE_LIQUIDITY_ADD || null,
    fundsGate: summarizeFundsGate(balances.arcUsdc, 1, 'USDC'),
    preflight: await runSafeCheck('curve_liquidity_add', async () => {
      const dryRun = await executionService.executeCurveLiquidityAddTask({
        agent,
        params: { tokenIn: 'USDC', amountIn: '1' },
        dryRun: true,
      });

      return dryRun.ok
        ? {
          ok: true,
          poolAddress: dryRun.payload?.poolAddress || null,
          positionBefore: dryRun.payload?.positionBefore || null,
        }
        : {
          ok: false,
          reason: dryRun.reason || null,
          error: dryRun.error || null,
        };
    }),
  });

  checks.push({
    taskId: 'EXEC_CURVE_LIQUIDITY_REMOVE',
    recent: recentRuns.EXEC_CURVE_LIQUIDITY_REMOVE || null,
    fundsGate: balances.curveLp != null && balances.curveLp > 0
      ? `pass_lp:${formatNumber(balances.curveLp)}`
      : 'no_curve_lp_position',
    preflight: await runSafeCheck('curve_liquidity_remove', async () => {
      const dryRun = await executionService.executeCurveLiquidityRemoveTask({
        agent,
        params: { tokenOut: 'USDC', lpAmount: '1' },
        dryRun: true,
      });

      return dryRun.ok
        ? {
          ok: true,
          poolAddress: dryRun.payload?.poolAddress || null,
          positionBefore: dryRun.payload?.positionBefore || null,
        }
        : {
          ok: false,
          reason: dryRun.reason || null,
          error: dryRun.error || null,
        };
    }),
  });

  checks.push({
    taskId: 'EXEC_CIRBTC_USDC_ZAP_IN',
    recent: recentRuns.EXEC_CIRBTC_USDC_ZAP_IN || null,
    fundsGate: summarizeFundsGate(balances.arcUsdc, 20, 'USDC'),
    preflight: await runSafeCheck('cirbtc_usdc_zap_in', async () => {
      const dryRun = await executionService.executeDirectPairZapInTask({
        agent,
        params: {},
        dryRun: true,
        stableToken: 'USDC',
      });
      const pair = usdcCirbtcPair?.address ? await readPairState(usdcCirbtcPair.address) : null;

      return {
        ok: dryRun.ok,
        reason: dryRun.reason || null,
        pairAddress: dryRun.payload?.poolAddress || usdcCirbtcPair?.address || null,
        pairSeeded: pair?.seeded ?? null,
        swapRouteStrategy: dryRun.payload?.swapRouteStrategy || null,
      };
    }),
  });

  checks.push({
    taskId: 'EXEC_CIRBTC_EURC_ZAP_IN',
    recent: recentRuns.EXEC_CIRBTC_EURC_ZAP_IN || null,
    fundsGate: summarizeFundsGate(balances.arcEurc, 16, 'EURC'),
    preflight: await runSafeCheck('cirbtc_eurc_zap_in', async () => {
      const dryRun = await executionService.executeDirectPairZapInTask({
        agent,
        params: {},
        dryRun: true,
        stableToken: 'EURC',
      });
      const pair = eurcCirbtcPair?.address ? await readPairState(eurcCirbtcPair.address) : null;

      return {
        ok: dryRun.ok,
        reason: dryRun.reason || null,
        pairAddress: dryRun.payload?.poolAddress || eurcCirbtcPair?.address || null,
        pairSeeded: pair?.seeded ?? null,
        swapRouteStrategy: dryRun.payload?.swapRouteStrategy || null,
      };
    }),
  });

  checks.push({
    taskId: 'EXEC_CIRBTC_USDC_LP_REMOVE',
    recent: recentRuns.EXEC_CIRBTC_USDC_LP_REMOVE || null,
    fundsGate: balances.usdcCirbtcLp != null && balances.usdcCirbtcLp > 0
      ? `pass_lp:${formatNumber(balances.usdcCirbtcLp)}`
      : 'no_usdc_cirbtc_lp_position',
    preflight: await runSafeCheck('cirbtc_usdc_lp_remove', async () => {
      const dryRun = await executionService.executeDirectPairRemoveLiquidityTask({
        agent,
        params: { withdrawPct: 100 },
        dryRun: true,
        stableToken: 'USDC',
      });

      return {
        ok: dryRun.ok,
        reason: dryRun.reason || null,
        pairAddress: dryRun.payload?.poolAddress || null,
      };
    }),
  });

  checks.push({
    taskId: 'EXEC_CIRBTC_EURC_LP_REMOVE',
    recent: recentRuns.EXEC_CIRBTC_EURC_LP_REMOVE || null,
    fundsGate: balances.eurcCirbtcLp != null && balances.eurcCirbtcLp > 0
      ? `pass_lp:${formatNumber(balances.eurcCirbtcLp)}`
      : 'no_eurc_cirbtc_lp_position',
    preflight: await runSafeCheck('cirbtc_eurc_lp_remove', async () => {
      const dryRun = await executionService.executeDirectPairRemoveLiquidityTask({
        agent,
        params: { withdrawPct: 100 },
        dryRun: true,
        stableToken: 'EURC',
      });

      return {
        ok: dryRun.ok,
        reason: dryRun.reason || null,
        pairAddress: dryRun.payload?.poolAddress || null,
      };
    }),
  });

  checks.push({
    taskId: 'EXEC_CCTP_BRIDGE',
    recent: recentRuns.EXEC_CCTP_BRIDGE || null,
    fundsGate: summarizeFundsGate(balances.arcUsdc, 1, 'USDC'),
    preflight: await runSafeCheck('cctp_bridge', async () => {
      const dryRun = await executionService.executeBridgeTask({
        agent,
        params: { fromChain: 'Arc Testnet', toChain: 'Base Sepolia', amountUsdc: '1' },
        dryRun: true,
      });

      return {
        ok: dryRun.ok,
        reason: dryRun.reason || null,
        payload: dryRun.payload || null,
      };
    }),
  });

  checks.push({
    taskId: 'EXEC_SEPOLIA_GAS_FANOUT',
    recent: recentRuns.EXEC_SEPOLIA_GAS_FANOUT || null,
    fundsGate: 'requires_sepolia_eth',
    preflight: await runSafeCheck('sepolia_gas_fanout', async () => {
      const dryRun = await executionService.executeSepoliaGasFanoutTask({ agent, dryRun: true });
      return {
        ok: dryRun.ok,
        reason: dryRun.reason || null,
        payload: dryRun.payload || null,
      };
    }),
  });

  checks.push({
    taskId: 'EXEC_YIELD_MOVE',
    recent: recentRuns.EXEC_YIELD_MOVE || null,
    fundsGate: summarizeFundsGate(balances.arcUsdc, 1, 'USDC'),
    preflight: await runSafeCheck('yield_move', async () => {
      const dryRun = await executionService.executeYieldMoveTask({
        agent,
        params: { action: 'supply', amount: '1' },
        dryRun: true,
      });

      return {
        ok: dryRun.ok,
        reason: dryRun.reason || null,
        aavePoolConfigured: Boolean(process.env.AAVE_POOL_ADDRESS),
      };
    }),
  });

  checks.push({
    taskId: 'EXEC_ARB',
    recent: recentRuns.EXEC_ARB || null,
    fundsGate: summarizeFundsGate(balances.arcUsdc, 1, 'USDC'),
    preflight: await runSafeCheck('arb', async () => {
      const dryRun = await executionService.executeArbTask({
        agent,
        params: { amountIn: '1' },
        dryRun: true,
        pricingPool: eurcUsdcCurvePool,
        swapPool: usdcEurcCurvePool,
      });

      return {
        ok: dryRun.ok,
        reason: dryRun.reason || null,
        summary: dryRun.payload?.summary || null,
        confidence: dryRun.payload?.confidence || null,
      };
    }),
  });

  checks.push({
    taskId: 'EXEC_REBALANCE',
    recent: recentRuns.EXEC_REBALANCE || null,
    fundsGate: summarizeFundsGate(balances.arcUsdc, 1, 'USDC'),
    preflight: await runSafeCheck('rebalance', async () => {
      const dryRun = await executionService.executeRebalanceTask({
        agent,
        params: { fromToken: 'USDC', toToken: 'EURC', amountIn: '1' },
        dryRun: true,
      });

      return dryRun.ok
        ? {
          ok: true,
          summary: dryRun.payload?.summary || null,
          positionBefore: dryRun.payload?.positionBefore || null,
        }
        : {
          ok: false,
          reason: dryRun.reason || null,
          error: dryRun.error || null,
        };
    }),
  });

  console.log(JSON.stringify({
    agentId,
    walletAddress: agent.wallet_address,
    balances,
    env: {
      aavePoolConfigured: Boolean(process.env.AAVE_POOL_ADDRESS),
      curveUsdcEurcPool: usdcEurcCurvePool?.address || null,
      curveEurcUsdcPool: eurcUsdcCurvePool?.address || null,
      usdcCirbtcPair: usdcCirbtcPair?.address || null,
      eurcCirbtcPair: eurcCirbtcPair?.address || null,
    },
    checks,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });