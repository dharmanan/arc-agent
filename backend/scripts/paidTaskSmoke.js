'use strict';

const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
process.env.ARC_RPC_URL = process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
process.env.ARC_TESTNET_RPC = process.env.ARC_TESTNET_RPC || process.env.ARC_RPC_URL;

const { ethers } = require('ethers');
const db = require('../src/db');
const executionService = require('../src/services/agenticEconomy/agenticTaskExecutionService');
const {
  getRevenuePoolAddress,
  getRevenuePoolSource,
} = require('../src/services/agenticEconomy/revenuePoolConfig');
const { resolveCurvePool, resolveDirectSwapFallbackPool, TOKENS } = require('../src/services/oracle/pools');
const { getCurveQuote } = require('../src/services/protocols/curveSwap');

const TOKEN_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const POOL_VIEW_ABI = ['function getPoolBalance() view returns (uint256)'];
const DIRECT_PAIR_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const ARC_RPC_URL = process.env.ARC_RPC_URL;
const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
const STABLE_TASK_IDS = new Set([
  'EXEC_CURVE_SWAP',
  'EXEC_CURVE_LIQUIDITY_ADD',
  'EXEC_CURVE_LIQUIDITY_REMOVE',
  'EXEC_REBALANCE',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    agentId: '',
    walletAddress: process.env.SMOKE_AGENT_WALLET || '',
    stableOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--stable-only') {
      options.stableOnly = true;
      continue;
    }

    if (arg === '--wallet' || arg === '--wallet-address') {
      options.walletAddress = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }

    if (arg === '--agent' || arg === '--agent-id') {
      options.agentId = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }

    if (!arg.startsWith('--') && !options.agentId) {
      options.agentId = String(arg || '').trim();
    }
  }

  return options;
}

function isDbUnavailable(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === 'ECONNREFUSED'
    || error?.code === 'ENOTFOUND'
    || message.includes('connect econnrefused')
    || message.includes('database')
    || message.includes('connect');
}

function formatNumber(value, digits = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toFixed(digits).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

function getSmokePrivateKey() {
  const candidates = [
    process.env.SMOKE_AGENT_PRIVATE_KEY,
    process.env.ORACLE_BUYER_PRIVATE_KEY,
  ];

  return candidates.find((value) => /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim())) || '';
}

function deriveWalletAddressFromPrivateKey(privateKey) {
  const normalized = String(privateKey || '').trim();
  if (!normalized) return '';

  try {
    return new ethers.Wallet(normalized).address;
  } catch {
    return '';
  }
}

async function getLatestAgentId() {
  try {
    const recentRun = await db.query(
      'SELECT agent_id FROM agent_task_runs ORDER BY created_at DESC LIMIT 1',
    );
    if (recentRun.rows[0]?.agent_id) return recentRun.rows[0].agent_id;

    const recentAgent = await db.query(
      'SELECT id FROM agents ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1',
    );
    return recentAgent.rows[0]?.id || null;
  } catch (error) {
    if (isDbUnavailable(error)) return null;
    throw error;
  }
}

async function getAgent(agentId) {
  if (!agentId) return null;

  try {
    const { rows: [agent] } = await db.query(
      'SELECT id, wallet_address FROM agents WHERE id = $1 LIMIT 1',
      [agentId],
    );
    return agent || null;
  } catch (error) {
    if (isDbUnavailable(error)) return null;
    throw error;
  }
}

async function getRecentRuns(agentId) {
  if (!agentId) return {};

  try {
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
  } catch (error) {
    if (isDbUnavailable(error)) return {};
    throw error;
  }
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

async function readRevenuePoolSnapshot() {
  const address = getRevenuePoolAddress();
  const source = getRevenuePoolSource();

  if (!address) {
    return {
      address: null,
      source,
      balanceUsdc: null,
      error: 'revenue_pool_missing',
    };
  }

  try {
    const contract = new ethers.Contract(address, POOL_VIEW_ABI, provider);
    const rawBalance = await contract.getPoolBalance();

    return {
      address,
      source,
      balanceUsdc: Number(ethers.formatUnits(rawBalance, 6)),
      error: null,
    };
  } catch (error) {
    return {
      address,
      source,
      balanceUsdc: null,
      error: error.message,
    };
  }
}

async function runSafeCheck(label, fn) {
  try {
    const result = await fn();
    const derivedOk = typeof result?.ok === 'boolean' ? result.ok : true;
    return {
      label,
      ok: derivedOk,
      result,
      reason: result?.reason || null,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      reason: error.message,
      error: error.message,
    };
  }
}

function summarizeFundsGate(balance, required, unit) {
  if (balance == null) return 'unknown';
  if (balance >= required) return `pass:${required} ${unit}`;
  return `insufficient_${String(unit).toLowerCase()}:${formatNumber(balance)}`;
}

function deriveCheckBlocker(check) {
  if (check?.preflight?.ok) return null;
  if (check?.preflight?.reason) return check.preflight.reason;
  if (check?.preflight?.error) return check.preflight.error;
  if (typeof check?.fundsGate === 'string' && check.fundsGate !== 'unknown' && !check.fundsGate.startsWith('pass:')) {
    return check.fundsGate;
  }
  return 'preflight_failed';
}

function buildReadinessSummary(checks) {
  const tasks = checks.map((check) => {
    const blocker = deriveCheckBlocker(check);
    return {
      taskId: check.taskId,
      status: blocker ? 'blocked' : 'ready',
      blocker,
      fundsGate: check.fundsGate,
      recentStatus: check.recent?.status || null,
      recentStage: check.recent?.stageLabel || null,
    };
  });

  const readyCount = tasks.filter((task) => task.status === 'ready').length;
  const blockedCount = tasks.length - readyCount;

  return {
    overall: blockedCount === 0 ? 'ready' : 'needs_attention',
    readyCount,
    blockedCount,
    tasks,
  };
}

async function main() {
  const options = parseArgs();
  const agentId = options.agentId || await getLatestAgentId();
  const dbAgent = await getAgent(agentId);
  const fallbackWalletAddress = deriveWalletAddressFromPrivateKey(getSmokePrivateKey());
  const walletAddress = String(dbAgent?.wallet_address || options.walletAddress || fallbackWalletAddress || '').trim();

  if (!walletAddress) {
    throw new Error('No wallet available for paid task smoke test. Pass --wallet <address>, set SMOKE_AGENT_WALLET, or define a valid smoke private key in root .env.');
  }

  const agent = {
    id: dbAgent?.id || agentId || 'wallet-only-smoke',
    wallet_address: walletAddress,
  };

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

  const filteredChecks = options.stableOnly
    ? checks.filter((check) => STABLE_TASK_IDS.has(check.taskId))
    : checks;
  const revenuePool = await readRevenuePoolSnapshot();
  const readiness = buildReadinessSummary(filteredChecks);

  console.log(JSON.stringify({
    agentId,
    walletAddress: agent.wallet_address,
    mode: options.stableOnly ? 'stable_only' : 'full',
    balances,
    env: {
      aavePoolConfigured: Boolean(process.env.AAVE_POOL_ADDRESS),
      curveUsdcEurcPool: usdcEurcCurvePool?.address || null,
      curveEurcUsdcPool: eurcUsdcCurvePool?.address || null,
      usdcCirbtcPair: usdcCirbtcPair?.address || null,
      eurcCirbtcPair: eurcCirbtcPair?.address || null,
    },
    revenuePool,
    readiness,
    checks: filteredChecks,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });