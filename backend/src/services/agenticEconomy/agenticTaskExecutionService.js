'use strict';

const { ethers } = require('ethers');
const oracle = require('../oracle');
const protocols = require('../protocols');
const agentWalletService = require('../agentWalletService');
const positionsService = require('../positionsService');
const { decrypt } = require('../cryptoService');
const nativeLendingRiskService = require('../nativeLendingRiskService');
const { readOracleEntryCooldown } = require('../agentService');
const { resolveDirectSwapFallbackPool } = require('../oracle/pools');
const { evaluateOracleStrategyPolicy } = require('../oracleStrategyPolicy');

const DEFAULT_USDC_ADDRESS = process.env.USDC_ADDRESS_ARC || '0x3600000000000000000000000000000000000000';
const DEFAULT_EURC_ADDRESS = process.env.EURC_ADDRESS_ARC || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const ARC_RPC_URL = process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const ERC20_BALANCE_ABI = ['function balanceOf(address account) view returns (uint256)'];
const SEPOLIA_GAS_FANOUT_AMOUNT_ETH = String(process.env.SEPOLIA_GAS_FANOUT_AMOUNT_ETH || '0.01');
const SEPOLIA_GAS_FANOUT_CHAINS = ['Optimism Sepolia', 'Base Sepolia', 'Arbitrum Sepolia'];
const NATIVE_TOPUP_POLL_MS = parseInt(process.env.NATIVE_TOPUP_POLL_MS || '5000', 10);
const NATIVE_TOPUP_WAIT_MS = parseInt(process.env.NATIVE_TOPUP_WAIT_MS || '600000', 10);
const DIRECT_PAIR_ZAP_LIMIT_DEFAULTS = {
  USDC: {
    pairKey: 'USDC-cirBTC',
    recommendedAmountIn: '20',
    maxTotalAmountIn: 20,
    maxSwapAmountIn: '10',
  },
  EURC: {
    pairKey: 'EURC-cirBTC',
    recommendedAmountIn: '16',
    maxTotalAmountIn: 16,
    maxSwapAmountIn: '8',
  },
};

let _arcProvider = null;

function _getArcProvider() {
  if (!_arcProvider) {
    _arcProvider = new ethers.JsonRpcProvider(ARC_RPC_URL);
  }

  return _arcProvider;
}

async function _getArcTokenBalance(walletAddress, tokenAddress, decimals = 6) {
  if (!walletAddress || !tokenAddress) return 0;
  const contract = new ethers.Contract(tokenAddress, ERC20_BALANCE_ABI, _getArcProvider());
  const rawBalance = await contract.balanceOf(walletAddress);
  return Number(ethers.formatUnits(rawBalance, decimals));
}

async function _getArbTaskWalletBalances(walletAddress) {
  const [usdc, eurc] = await Promise.all([
    _getArcTokenBalance(walletAddress, DEFAULT_USDC_ADDRESS, 6),
    _getArcTokenBalance(walletAddress, DEFAULT_EURC_ADDRESS, 6),
  ]);

  return { usdc, eurc };
}

function _readPositiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function _resolveDirectPairZapLimits(stableToken = 'USDC') {
  const normalizedStableToken = String(stableToken || 'USDC').toUpperCase();
  const defaults = DIRECT_PAIR_ZAP_LIMIT_DEFAULTS[normalizedStableToken];

  if (!defaults) {
    return null;
  }

  const envPrefix = `DIRECT_PAIR_ZAP_${normalizedStableToken}`;
  return {
    pairKey: defaults.pairKey,
    recommendedAmountIn: String(_readPositiveNumberEnv(
      `${envPrefix}_RECOMMENDED_AMOUNT_IN`,
      Number(defaults.recommendedAmountIn),
    )),
    maxTotalAmountIn: _readPositiveNumberEnv(
      `${envPrefix}_MAX_TOTAL_AMOUNT_IN`,
      defaults.maxTotalAmountIn,
    ),
    maxSwapAmountIn: String(_readPositiveNumberEnv(
      `${envPrefix}_MAX_SWAP_AMOUNT_IN`,
      Number(defaults.maxSwapAmountIn),
    )),
  };
}

function _timestamped(payload) {
  return {
    ...payload,
    executedAt: new Date().toISOString(),
  };
}

function _delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function _waitForNativeTopUpArrival({ chainName, address, balanceBeforeWei }) {
  const deadline = Date.now() + NATIVE_TOPUP_WAIT_MS;

  while (Date.now() < deadline) {
    const currentBalanceWei = await agentWalletService.getNativeBalance(chainName, address);
    if (currentBalanceWei > balanceBeforeWei) {
      return currentBalanceWei;
    }

    await _delay(NATIVE_TOPUP_POLL_MS);
  }

  throw new Error(`Destination native top-up timed out on ${chainName}`);
}

function _resolveCurveTokenInAddress(indexIn, pool) {
  if (Number(indexIn) === Number(pool?.baseToken?.index ?? 0)) {
    return pool?.baseToken?.address || DEFAULT_USDC_ADDRESS;
  }

  return pool?.quoteToken?.address || DEFAULT_EURC_ADDRESS;
}

function _resolveCurvePool(poolKey) {
  const pool = oracle.resolveCurvePool(poolKey);
  return pool ? { key: poolKey, ...pool } : null;
}

function _resolveStableCurvePoolForToken(tokenSymbol = 'USDC') {
  return _resolveCurvePool(tokenSymbol === 'EURC' ? 'EURC-USDC' : 'USDC-EURC');
}

function _resolveCurveCoin(pool, tokenSymbol = 'USDC') {
  const normalizedSymbol = String(tokenSymbol || '').toUpperCase();

  if (String(pool?.baseToken?.symbol || '').toUpperCase() === normalizedSymbol) {
    return pool.baseToken;
  }

  if (String(pool?.quoteToken?.symbol || '').toUpperCase() === normalizedSymbol) {
    return pool.quoteToken;
  }

  return normalizedSymbol === 'EURC'
    ? (pool?.quoteToken || pool?.baseToken)
    : (pool?.baseToken || pool?.quoteToken);
}

function _findPoolPosition(snapshot, poolAddress) {
  if (!snapshot || !poolAddress) return null;

  return snapshot.positions.find(
    position => String(position.poolAddress || '').toLowerCase() === String(poolAddress).toLowerCase(),
  ) || null;
}

function _summarizePoolPosition(position) {
  if (!position) return null;

  return {
    poolKey: position.poolKey,
    poolAddress: position.poolAddress,
    lpBalance: position.lpToken?.balance || '0',
    sharePct: position.sharePct,
    underlying: position.underlying || [],
  };
}

const CURVE_LP_DECIMALS = 18;
const CURVE_LP_ROUNDING_TOLERANCE_WEI = 1_000_000n;

function _resolveRequestedCurveLpAmount(requestedLpAmount, currentLpBalance) {
  const requestedText = String(requestedLpAmount ?? '').trim();
  const currentText = String(currentLpBalance ?? '').trim();

  if (!requestedText || !currentText) {
    return { ok: false, reason: 'curve_liquidity_remove_amount_required' };
  }

  let requestedRaw;
  let currentRaw;

  try {
    requestedRaw = ethers.parseUnits(requestedText, CURVE_LP_DECIMALS);
    currentRaw = ethers.parseUnits(currentText, CURVE_LP_DECIMALS);
  } catch {
    return { ok: false, reason: 'curve_liquidity_remove_amount_required' };
  }

  if (requestedRaw <= 0n || currentRaw <= 0n) {
    return { ok: false, reason: 'curve_liquidity_remove_amount_required' };
  }

  if (requestedRaw > currentRaw) {
    const overshootRaw = requestedRaw - currentRaw;
    if (overshootRaw > CURVE_LP_ROUNDING_TOLERANCE_WEI) {
      return {
        ok: false,
        reason: 'insufficient_lp_position',
        error: `available_lp_balance:${currentText}`,
      };
    }

    return {
      ok: true,
      lpAmount: currentText,
      lpAmountRaw: currentRaw,
      clampedToCurrentBalance: true,
    };
  }

  return {
    ok: true,
    lpAmount: requestedText,
    lpAmountRaw: requestedRaw,
    clampedToCurrentBalance: false,
  };
}

function _resolveDirectPairConfig(stableToken = 'USDC') {
  const normalizedStableToken = String(stableToken || 'USDC').toUpperCase();
  const config = _resolveDirectPairZapLimits(normalizedStableToken);
  const directPair = resolveDirectSwapFallbackPool(config?.pairKey || `${normalizedStableToken}-cirBTC`);

  return {
    normalizedStableToken,
    config,
    directPair,
  };
}

function _findDirectPairToken(directPair, symbolOrAddress) {
  const normalizedValue = String(symbolOrAddress || '').toLowerCase();
  if (!directPair) return null;

  const candidates = [directPair.baseToken, directPair.quoteToken].filter(Boolean);
  return candidates.find((token) => (
    String(token?.symbol || '').toLowerCase() === normalizedValue
      || String(token?.address || '').toLowerCase() === normalizedValue
  )) || null;
}

function _getOtherDirectPairToken(directPair, symbolOrAddress) {
  const current = _findDirectPairToken(directPair, symbolOrAddress);
  if (!current) return null;

  return [directPair.baseToken, directPair.quoteToken].find(
    token => String(token?.address || '').toLowerCase() !== String(current.address || '').toLowerCase(),
  ) || null;
}

function _getDirectPairDecimalsMap(directPair) {
  return {
    [String(directPair?.baseToken?.address || '').toLowerCase()]: directPair?.baseToken?.decimals || 6,
    [String(directPair?.quoteToken?.address || '').toLowerCase()]: directPair?.quoteToken?.decimals || 8,
  };
}

async function _readCurvePositionGuard(agent, curvePool) {
  const snapshot = await positionsService.getWalletPositions(agent?.wallet_address, {
    poolKeys: [curvePool?.key].filter(Boolean),
  });

  const warning = snapshot.warnings.find(
    item => !curvePool?.key || item.poolKey === curvePool.key || item.poolKey === 'wallet',
  );
  if (warning) {
    return {
      ok: false,
      reason: 'position_guard_unavailable',
      error: warning.message,
    };
  }

  return {
    ok: true,
    snapshot,
    position: _findPoolPosition(snapshot, curvePool?.address),
  };
}

async function executeCurveSwapTask({ agent, params = {}, dryRun = false, defaultCurvePool }) {
  const poolAddress = params.poolAddress || defaultCurvePool?.address || process.env.CURVE_USDC_EURC_POOL || null;
  if (!poolAddress) {
    return { ok: false, reason: 'curve_pool_not_configured' };
  }

  const indexIn = params.indexIn ?? defaultCurvePool?.baseToken?.index ?? 0;
  const indexOut = params.indexOut ?? defaultCurvePool?.quoteToken?.index ?? 1;
  const amountIn = String(params.amountIn ?? '1');
  const tokenInAddress = params.tokenInAddress || _resolveCurveTokenInAddress(indexIn, defaultCurvePool);

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({ dryRun: true, poolAddress, indexIn, indexOut, amountIn }),
    };
  }

  const result = await protocols.executeCurveSwap({
    poolAddress,
    tokenInAddress,
    indexIn,
    indexOut,
    amountIn,
    agentPrivateKey: decrypt(agent.private_key_encrypted),
  });

  return {
    ok: true,
    payload: _timestamped({ ...result, poolAddress, indexIn, indexOut, amountIn }),
  };
}

async function executeCurveLiquidityAddTask({ agent, params = {}, dryRun = false }) {
  const tokenIn = params.tokenIn || 'USDC';
  const amountIn = String(params.amountIn ?? '1');
  const curvePool = _resolveStableCurvePoolForToken(tokenIn);
  const poolCoin = _resolveCurveCoin(curvePool, tokenIn);

  if (!curvePool?.address) {
    return { ok: false, reason: 'curve_pool_not_configured' };
  }

  const positionGuard = await _readCurvePositionGuard(agent, curvePool);
  if (!positionGuard.ok) return positionGuard;

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        tokenIn,
        amountIn,
        poolAddress: curvePool.address,
        poolSource: curvePool.source || 'verified_default',
        positionBefore: _summarizePoolPosition(positionGuard.position),
      }),
    };
  }

  const result = await protocols.executeCurveAddLiquidity({
    poolAddress: curvePool.address,
    tokenInAddress: poolCoin?.address || _resolveCurveTokenInAddress(poolCoin?.index, curvePool),
    indexIn: poolCoin?.index,
    amountIn,
    agentPrivateKey: decrypt(agent.private_key_encrypted),
    decimalsIn: poolCoin?.decimals || 6,
  });

  return {
    ok: true,
    payload: _timestamped({
      ...result,
      tokenIn,
      amountIn,
      poolAddress: curvePool.address,
      poolSource: curvePool.source || 'verified_default',
      executionRail: 'curve_liquidity_add',
      summary: `Added ${amountIn} ${tokenIn} as Curve liquidity.`,
    }),
  };
}

async function executeCurveLiquidityAddBalancedTask({ agent, params = {}, dryRun = false }) {
  const amountUsdc = String(params.amountUsdc ?? params.amount0 ?? '0');
  const amountEurc = String(params.amountEurc ?? params.amount1 ?? '0');
  const curvePool = _resolveStableCurvePoolForToken('USDC');

  if (!(Number(amountUsdc) > 0) || !(Number(amountEurc) > 0)) {
    return { ok: false, reason: 'curve_liquidity_add_dual_amounts_required' };
  }

  if (!curvePool?.address) {
    return { ok: false, reason: 'curve_pool_not_configured' };
  }

  const positionGuard = await _readCurvePositionGuard(agent, curvePool);
  if (!positionGuard.ok) return positionGuard;

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        amountUsdc,
        amountEurc,
        poolAddress: curvePool.address,
        poolSource: curvePool.source || 'verified_default',
        positionBefore: _summarizePoolPosition(positionGuard.position),
      }),
    };
  }

  const result = await protocols.executeCurveAddLiquidityBalanced({
    poolAddress: curvePool.address,
    token0Address: curvePool.baseToken.address,
    token1Address: curvePool.quoteToken.address,
    amount0: amountUsdc,
    amount1: amountEurc,
    agentPrivateKey: decrypt(agent.private_key_encrypted),
    decimals0: curvePool.baseToken.decimals || 6,
    decimals1: curvePool.quoteToken.decimals || 6,
  });

  return {
    ok: true,
    payload: _timestamped({
      ...result,
      amountUsdc,
      amountEurc,
      poolAddress: curvePool.address,
      poolSource: curvePool.source || 'verified_default',
      executionRail: 'curve_liquidity_add_dual',
      summary: `Added dual-sided Curve liquidity with ${amountUsdc} USDC and ${amountEurc} EURC.`,
    }),
  };
}

async function executeCurveLiquidityRemoveTask({ agent, params = {}, dryRun = false }) {
  const tokenOut = params.tokenOut || 'USDC';
  const requestedLpAmount = String(params.lpAmount ?? '1');
  const curvePool = _resolveStableCurvePoolForToken(tokenOut);
  const poolCoin = _resolveCurveCoin(curvePool, tokenOut);

  if (!curvePool?.address) {
    return { ok: false, reason: 'curve_pool_not_configured' };
  }

  const positionGuard = await _readCurvePositionGuard(agent, curvePool);
  if (!positionGuard.ok) return positionGuard;

  const currentLpBalance = positionGuard.position?.lpToken?.balance || '0';
  if (!positionGuard.position || !(Number(currentLpBalance) > 0)) {
    return { ok: false, reason: 'lp_position_not_found' };
  }

  const resolvedLpAmount = _resolveRequestedCurveLpAmount(requestedLpAmount, currentLpBalance);
  if (!resolvedLpAmount.ok) return resolvedLpAmount;

  const lpAmount = resolvedLpAmount.lpAmount;

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        tokenOut,
        lpAmount,
        poolAddress: curvePool.address,
        poolSource: curvePool.source || 'verified_default',
        positionBefore: _summarizePoolPosition(positionGuard.position),
      }),
    };
  }

  const result = await protocols.executeCurveRemoveLiquidityOneCoin({
    poolAddress: curvePool.address,
    indexOut: poolCoin?.index,
    lpAmount,
    agentPrivateKey: decrypt(agent.private_key_encrypted),
    decimalsOut: poolCoin?.decimals || 6,
  });

  return {
    ok: true,
    payload: _timestamped({
      ...result,
      tokenOut,
      lpAmount,
      poolAddress: curvePool.address,
      poolSource: curvePool.source || 'verified_default',
      executionRail: 'curve_liquidity_remove',
      summary: `Removed ${lpAmount} Curve LP into ${tokenOut}.`,
    }),
  };
}

async function executeCurveLiquidityRemoveBalancedTask({ agent, params = {}, dryRun = false }) {
  const requestedLpAmount = String(params.lpAmount ?? '0');
  const curvePool = _resolveStableCurvePoolForToken('USDC');

  if (!(Number(requestedLpAmount) > 0)) {
    return { ok: false, reason: 'curve_liquidity_remove_amount_required' };
  }

  if (!curvePool?.address) {
    return { ok: false, reason: 'curve_pool_not_configured' };
  }

  const positionGuard = await _readCurvePositionGuard(agent, curvePool);
  if (!positionGuard.ok) return positionGuard;

  const currentLpBalance = positionGuard.position?.lpToken?.balance || '0';
  if (!positionGuard.position || !(Number(currentLpBalance) > 0)) {
    return { ok: false, reason: 'lp_position_not_found' };
  }

  const resolvedLpAmount = _resolveRequestedCurveLpAmount(requestedLpAmount, currentLpBalance);
  if (!resolvedLpAmount.ok) return resolvedLpAmount;

  const lpAmount = resolvedLpAmount.lpAmount;

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        lpAmount,
        poolAddress: curvePool.address,
        poolSource: curvePool.source || 'verified_default',
        positionBefore: _summarizePoolPosition(positionGuard.position),
      }),
    };
  }

  const result = await protocols.executeCurveRemoveLiquidity({
    poolAddress: curvePool.address,
    lpAmount,
    agentPrivateKey: decrypt(agent.private_key_encrypted),
    token0Address: curvePool.baseToken.address,
    token1Address: curvePool.quoteToken.address,
    decimals0: curvePool.baseToken.decimals || 6,
    decimals1: curvePool.quoteToken.decimals || 6,
  });

  return {
    ok: true,
    payload: _timestamped({
      ...result,
      poolAddress: curvePool.address,
      poolSource: curvePool.source || 'verified_default',
      token0Symbol: curvePool.baseToken.symbol,
      token1Symbol: curvePool.quoteToken.symbol,
      executionRail: 'curve_liquidity_remove_dual',
      summary: `Removed ${lpAmount} Curve LP into both pool tokens.`,
    }),
  };
}

async function executeDirectPairZapInTask({ agent, params = {}, dryRun = false, stableToken = 'USDC' }) {
  const normalizedStableToken = String(stableToken || 'USDC').toUpperCase();
  const config = _resolveDirectPairZapLimits(normalizedStableToken);
  const amountIn = String(params.amountIn ?? config?.recommendedAmountIn ?? '0');
  const swapAmountIn = Math.min(Number(amountIn) / 2, Number(config?.maxSwapAmountIn || 0));
  const remainingAmountIn = Number(amountIn) - swapAmountIn;
  const directPair = resolveDirectSwapFallbackPool(config?.pairKey || `${normalizedStableToken}-cirBTC`);

  if (!(Number(amountIn) > 0)) {
    return { ok: false, reason: 'pair_zap_amount_required' };
  }

  if (!(swapAmountIn > 0)) {
    return { ok: false, reason: 'pair_zap_amount_required' };
  }

  if (!(remainingAmountIn > 0)) {
    return { ok: false, reason: 'pair_zap_amount_required' };
  }

  if (!config) {
    return { ok: false, reason: 'swap_not_configured' };
  }

  if (Number(amountIn) > Number(config.maxTotalAmountIn || 0)) {
    return {
      ok: false,
      reason: 'pair_zap_amount_exceeds_max',
      error: `max_total_amount:${config.maxTotalAmountIn}`,
    };
  }

  if (!directPair?.address) {
    return { ok: false, reason: 'direct_pair_not_configured' };
  }

  if (dryRun) {
    const swapQuote = await agentWalletService.getSwapQuoteResult({
      fromToken: normalizedStableToken,
      toToken: 'cirBTC',
      amountIn: swapAmountIn,
    });

    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        amountIn,
        swapAmountIn,
        remainingAmountIn: String(remainingAmountIn),
        amountOut: swapQuote.amountOut,
        swapExecutionRail: swapQuote.executionRail || null,
        swapRouteStrategy: swapQuote.routeStrategy || null,
        swapRouteReason: swapQuote.routeReason || null,
        swapPoolAddress: swapQuote.poolAddress || null,
        swapPoolSource: swapQuote.poolSource || null,
        maxSwapAmountIn: config.maxSwapAmountIn,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        executionRail: 'swap_then_direct_lp_add',
        summary: `Would swap ${swapAmountIn} ${normalizedStableToken} into cirBTC using the normal swap route, then add liquidity on the configured direct ${normalizedStableToken}/cirBTC pair with the remaining ${remainingAmountIn} ${normalizedStableToken}.`,
      }),
    };
  }

  try {
    const swapResult = await agentWalletService.agentSwap({
      agent,
      fromToken: normalizedStableToken,
      toToken: 'cirBTC',
      amountIn: swapAmountIn,
    });

    const liquidityResult = await protocols.executeConstantProductAddLiquidity({
      pairAddress: directPair.address,
      tokenAAddress: directPair.baseToken.address,
      tokenBAddress: directPair.quoteToken.address,
      maxAmountA: String(remainingAmountIn),
      maxAmountB: swapResult.amountOut,
      agentPrivateKey: decrypt(agent.private_key_encrypted),
      decimalsA: directPair.baseToken.decimals || 6,
      decimalsB: directPair.quoteToken.decimals || 8,
    });

    const stableUsed = Number(liquidityResult.amountAUsed || 0);
    const stableLeft = Number(liquidityResult.amountARemaining || 0);
    const cirbtcUsed = Number(liquidityResult.amountBUsed || 0);
    const cirbtcLeft = Number(liquidityResult.amountBRemaining || 0);
    const leftoverParts = [
      stableLeft > 0 ? `${liquidityResult.amountARemaining} ${normalizedStableToken}` : null,
      cirbtcLeft > 0 ? `${liquidityResult.amountBRemaining} cirBTC` : null,
    ].filter(Boolean);
    const leftoverSummary = leftoverParts.length > 0
      ? ` Unmatched remainder stayed in the agent wallet: ${leftoverParts.join(' + ')}.`
      : '';

    return {
      ok: true,
      payload: _timestamped({
        txHash: liquidityResult.txHash,
        swapTxHash: swapResult.hash,
        mintTxHash: liquidityResult.mintTxHash,
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        amountIn,
        swapAmountIn,
        swappedAmountIn: String(swapAmountIn),
        remainingAmountIn: String(remainingAmountIn),
        amountOut: swapResult.amountOut,
        maxSwapAmountIn: config.maxSwapAmountIn,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        lpAmount: liquidityResult.lpAmount,
        liquidityStableAmountUsed: liquidityResult.amountAUsed,
        liquidityStableAmountRemaining: liquidityResult.amountARemaining,
        liquidityVolatileAmountUsed: liquidityResult.amountBUsed,
        liquidityVolatileAmountRemaining: liquidityResult.amountBRemaining,
        swapExecutionRail: swapResult.executionRail || null,
        swapRouteStrategy: swapResult.routeStrategy || null,
        swapRouteReason: swapResult.routeReason || null,
        swapPoolAddress: swapResult.poolAddress || null,
        swapPoolSource: swapResult.poolSource || null,
        executionRail: 'swap_then_direct_lp_add',
        summary: `LP bootstrap completed with a fixed half split: swapped ${swapAmountIn} ${normalizedStableToken} into ${swapResult.amountOut} cirBTC using the normal swap route, then added ${stableUsed > 0 ? liquidityResult.amountAUsed : '0'} ${normalizedStableToken} + ${cirbtcUsed > 0 ? liquidityResult.amountBUsed : '0'} cirBTC to the direct ${normalizedStableToken}/cirBTC pair.${leftoverSummary} This manual paid task does not use the LLM.`,
      }),
    };
  } catch (error) {
    if (/seeded before zap-in|pair reserves are inconsistent|liquidity addition down to zero/i.test(error.message || '')) {
      return { ok: false, reason: 'direct_pair_seed_required', error: error.message };
    }

    return { ok: false, reason: 'swap_error', error: error.message };
  }
}

async function executeDirectPairAddLiquidityTask({ agent, params = {}, dryRun = false, stableToken = 'USDC' }) {
  const { normalizedStableToken, config, directPair } = _resolveDirectPairConfig(stableToken);
  const mode = String(params.mode || 'single').toLowerCase();
  const stableCoin = _findDirectPairToken(directPair, normalizedStableToken);
  const volatileCoin = _findDirectPairToken(directPair, 'cirBTC');

  if (!config) {
    return { ok: false, reason: 'swap_not_configured' };
  }

  if (!directPair?.address || !stableCoin || !volatileCoin) {
    return { ok: false, reason: 'direct_pair_not_configured' };
  }

  if (mode === 'dual') {
    const amountStable = String(params.amountStable ?? '0');
    const amountCirbtc = String(params.amountCirbtc ?? '0');

    if (!(Number(amountStable) > 0) || !(Number(amountCirbtc) > 0)) {
      return { ok: false, reason: 'direct_pair_dual_amounts_required' };
    }

    if (dryRun) {
      return {
        ok: true,
        payload: _timestamped({
          dryRun: true,
          mode,
          stableToken: normalizedStableToken,
          volatileToken: 'cirBTC',
          amountStable,
          amountCirbtc,
          poolAddress: directPair.address,
          poolSource: directPair.source || 'env',
          executionRail: 'direct_pair_liquidity_add_dual',
          summary: `Would add dual-sided liquidity with ${amountStable} ${normalizedStableToken} and ${amountCirbtc} cirBTC.`,
        }),
      };
    }

    const result = await protocols.executeConstantProductAddLiquidity({
      pairAddress: directPair.address,
      tokenAAddress: stableCoin.address,
      tokenBAddress: volatileCoin.address,
      maxAmountA: amountStable,
      maxAmountB: amountCirbtc,
      agentPrivateKey: decrypt(agent.private_key_encrypted),
      decimalsA: stableCoin.decimals || 6,
      decimalsB: volatileCoin.decimals || 8,
    });

    return {
      ok: true,
      payload: _timestamped({
        ...result,
        mode,
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        amountStable,
        amountCirbtc,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        executionRail: 'direct_pair_liquidity_add_dual',
        summary: `Added dual-sided liquidity with ${amountStable} ${normalizedStableToken} and ${amountCirbtc} cirBTC on the direct pair.`,
      }),
    };
  }

  const inputToken = String(params.inputToken || normalizedStableToken).toUpperCase();
  const amountIn = String(params.amountIn ?? '0');
  const tokenIn = _findDirectPairToken(directPair, inputToken);
  const tokenOut = _getOtherDirectPairToken(directPair, inputToken);

  if (!(Number(amountIn) > 0)) {
    return { ok: false, reason: 'pair_zap_amount_required' };
  }

  if (!tokenIn || !tokenOut) {
    return { ok: false, reason: 'direct_pair_input_token_invalid' };
  }

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        mode: 'single',
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        inputToken,
        amountIn,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        executionRail: 'direct_pair_zap_in',
        summary: `Would zap ${amountIn} ${inputToken} into the ${normalizedStableToken}/cirBTC direct pair using an auto-derived split.`,
      }),
    };
  }

  try {
    const result = await protocols.executeConstantProductZapIn({
      pairAddress: directPair.address,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
      totalAmountIn: amountIn,
      agentPrivateKey: decrypt(agent.private_key_encrypted),
      decimalsIn: tokenIn.decimals || 6,
      decimalsOut: tokenOut.decimals || 8,
      feePct: directPair.feePct || 0.3,
    });

    return {
      ok: true,
      payload: _timestamped({
        ...result,
        mode: 'single',
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        inputToken,
        amountIn,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        executionRail: 'direct_pair_zap_in',
        summary: `Added one-sided liquidity from ${amountIn} ${inputToken} into the ${normalizedStableToken}/cirBTC direct pair.`,
      }),
    };
  } catch (error) {
    if (/seeded before zap-in|pair reserves are inconsistent|liquidity addition down to zero/i.test(error.message || '')) {
      return { ok: false, reason: 'direct_pair_seed_required', error: error.message };
    }

    return { ok: false, reason: 'swap_error', error: error.message };
  }
}

async function executeDirectPairSwapTask({ agent, params = {}, dryRun = false, stableToken = 'USDC' }) {
  const { normalizedStableToken, config, directPair } = _resolveDirectPairConfig(stableToken);
  const fromToken = String(params.fromToken || normalizedStableToken).toUpperCase();
  const toToken = String(params.toToken || (fromToken === normalizedStableToken ? 'CIRBTC' : normalizedStableToken)).toUpperCase();
  const amountIn = String(params.amountIn ?? '0');
  const tokenIn = _findDirectPairToken(directPair, fromToken);
  const tokenOut = _findDirectPairToken(directPair, toToken);

  if (!config) {
    return { ok: false, reason: 'swap_not_configured' };
  }

  if (!(Number(amountIn) > 0)) {
    return { ok: false, reason: 'pair_swap_amount_required' };
  }

  if (!directPair?.address || !tokenIn || !tokenOut || String(tokenIn.address).toLowerCase() === String(tokenOut.address).toLowerCase()) {
    return { ok: false, reason: 'direct_pair_swap_route_invalid' };
  }

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        fromToken,
        toToken,
        amountIn,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        executionRail: 'direct_pair_swap',
        summary: `Would swap ${amountIn} ${fromToken} into ${toToken} on the direct pair.`,
      }),
    };
  }

  try {
    const result = await protocols.executeConstantProductSwap({
      pairAddress: directPair.address,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
      amountIn,
      agentPrivateKey: decrypt(agent.private_key_encrypted),
      decimalsIn: tokenIn.decimals || 6,
      decimalsOut: tokenOut.decimals || 8,
      feePct: directPair.feePct || 0.3,
    });

    return {
      ok: true,
      payload: _timestamped({
        ...result,
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        fromToken,
        toToken,
        amountIn,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        executionRail: 'direct_pair_swap',
        summary: `Swapped ${amountIn} ${fromToken} into ${toToken} on the direct pair.`,
      }),
    };
  } catch (error) {
    return { ok: false, reason: 'swap_error', error: error.message };
  }
}

async function executeDirectPairRemoveLiquidityTask({ agent, params = {}, dryRun = false, stableToken = 'USDC' }) {
  const normalizedStableToken = String(stableToken || 'USDC').toUpperCase();
  const config = _resolveDirectPairZapLimits(normalizedStableToken);
  const withdrawPct = Number(params.withdrawPct ?? 100);
  const directPair = resolveDirectSwapFallbackPool(config?.pairKey || `${normalizedStableToken}-cirBTC`);

  if (!config) {
    return { ok: false, reason: 'swap_not_configured' };
  }

  if (!Number.isFinite(withdrawPct) || withdrawPct <= 0 || withdrawPct > 100) {
    return { ok: false, reason: 'pair_exit_pct_invalid' };
  }

  if (!directPair?.address) {
    return { ok: false, reason: 'direct_pair_not_configured' };
  }

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        withdrawPct,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        executionRail: 'uniswap_v2_lp_remove',
        summary: `Would burn ${withdrawPct}% of the current ${normalizedStableToken}/cirBTC LP position and return both underlying tokens to the agent wallet.`,
      }),
    };
  }

  try {
    const result = await protocols.executeConstantProductRemoveLiquidity({
      pairAddress: directPair.address,
      withdrawPct,
      agentPrivateKey: decrypt(agent.private_key_encrypted),
      tokenDecimals: {
        [String(directPair.baseToken.address).toLowerCase()]: directPair.baseToken.decimals || 6,
        [String(directPair.quoteToken.address).toLowerCase()]: directPair.quoteToken.decimals || 8,
      },
    });

    const token0Symbol = String(result.token0Address || '').toLowerCase() === String(directPair.baseToken.address || '').toLowerCase()
      ? directPair.baseToken.symbol
      : directPair.quoteToken.symbol;
    const token1Symbol = String(result.token1Address || '').toLowerCase() === String(directPair.baseToken.address || '').toLowerCase()
      ? directPair.baseToken.symbol
      : directPair.quoteToken.symbol;

    return {
      ok: true,
      payload: _timestamped({
        ...result,
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        token0Symbol,
        token1Symbol,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        executionRail: 'uniswap_v2_lp_remove',
        summary: `LP exit completed: burned ${result.lpAmount} LP (${withdrawPct}% of the current position) and returned ${result.token0Amount} ${token0Symbol} plus ${result.token1Amount} ${token1Symbol} to the agent wallet.`,
      }),
    };
  } catch (error) {
    if (/LP position not found/i.test(error.message || '')) {
      return { ok: false, reason: 'direct_pair_lp_not_found', error: error.message };
    }

    return { ok: false, reason: 'swap_error', error: error.message };
  }
}

async function executeDirectPairRemoveLiquiditySingleTask({ agent, params = {}, dryRun = false, stableToken = 'USDC' }) {
  const { normalizedStableToken, config, directPair } = _resolveDirectPairConfig(stableToken);
  const withdrawPct = Number(params.withdrawPct ?? 100);
  const targetToken = String(params.targetToken || normalizedStableToken).toUpperCase();
  const targetCoin = _findDirectPairToken(directPair, targetToken);
  const otherCoin = _getOtherDirectPairToken(directPair, targetToken);

  if (!config) {
    return { ok: false, reason: 'swap_not_configured' };
  }

  if (!Number.isFinite(withdrawPct) || withdrawPct <= 0 || withdrawPct > 100) {
    return { ok: false, reason: 'pair_exit_pct_invalid' };
  }

  if (!directPair?.address || !targetCoin || !otherCoin) {
    return { ok: false, reason: 'direct_pair_not_configured' };
  }

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        withdrawPct,
        targetToken,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        executionRail: 'direct_pair_lp_remove_single',
        summary: `Would burn ${withdrawPct}% of the LP position, then convert the opposite leg into ${targetToken}.`,
      }),
    };
  }

  try {
    const burnResult = await protocols.executeConstantProductRemoveLiquidity({
      pairAddress: directPair.address,
      withdrawPct,
      agentPrivateKey: decrypt(agent.private_key_encrypted),
      tokenDecimals: _getDirectPairDecimalsMap(directPair),
    });

    const token0Coin = _findDirectPairToken(directPair, burnResult.token0Address);
    const token1Coin = _findDirectPairToken(directPair, burnResult.token1Address);
    const token0Amount = Number(burnResult.token0Amount || 0);
    const token1Amount = Number(burnResult.token1Amount || 0);
    const existingTargetAmount = String(targetCoin.address).toLowerCase() === String(burnResult.token0Address || '').toLowerCase()
      ? token0Amount
      : token1Amount;
    const swapAmount = String(otherCoin.address).toLowerCase() === String(burnResult.token0Address || '').toLowerCase()
      ? burnResult.token0Amount
      : burnResult.token1Amount;

    let swapResult = null;
    if (Number(swapAmount) > 0) {
      swapResult = await protocols.executeConstantProductSwap({
        pairAddress: directPair.address,
        tokenInAddress: otherCoin.address,
        tokenOutAddress: targetCoin.address,
        amountIn: swapAmount,
        agentPrivateKey: decrypt(agent.private_key_encrypted),
        decimalsIn: otherCoin.decimals || 6,
        decimalsOut: targetCoin.decimals || 8,
        feePct: directPair.feePct || 0.3,
      });
    }

    const totalTargetAmount = Number(existingTargetAmount || 0) + Number(swapResult?.amountOut || 0);

    return {
      ok: true,
      payload: _timestamped({
        ...burnResult,
        stableToken: normalizedStableToken,
        volatileToken: 'cirBTC',
        targetToken,
        targetTokenAmount: String(totalTargetAmount),
        token0Symbol: token0Coin?.symbol || burnResult.token0Address,
        token1Symbol: token1Coin?.symbol || burnResult.token1Address,
        swapTxHash: swapResult?.txHash || null,
        swapAmountOut: swapResult?.amountOut || null,
        poolAddress: directPair.address,
        poolSource: directPair.source || 'env',
        executionRail: 'direct_pair_lp_remove_single',
        summary: `Exited ${withdrawPct}% of the direct pair and consolidated into ${targetToken}.`,
      }),
    };
  } catch (error) {
    if (/LP position not found/i.test(error.message || '')) {
      return { ok: false, reason: 'direct_pair_lp_not_found', error: error.message };
    }

    return { ok: false, reason: 'swap_error', error: error.message };
  }
}

async function executeBridgeTask({ agent, params = {}, dryRun = false, onStep }) {
  const fromChain = params.fromChain;
  const toChain = params.toChain;
  const amountUsdc = params.amountUsdc;

  if (!fromChain || !toChain || !(Number(amountUsdc) > 0)) {
    return { ok: false, reason: 'bridge_params_required' };
  }

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({ dryRun: true, fromChain, toChain, amountUsdc }),
    };
  }

  const result = await agentWalletService.agentBridgeFull({
    agent,
    fromChain,
    toChain,
    amountUsdc,
    onStep,
  });

  return {
    ok: true,
    payload: _timestamped({ ...result, fromChain, toChain, amountUsdc }),
  };
}

async function executeSepoliaGasFanoutTask({ agent, dryRun = false, onStep }) {
  const amountEth = SEPOLIA_GAS_FANOUT_AMOUNT_ETH;
  const report = async (step, data = {}) => {
    if (!onStep) return;
    await Promise.resolve(onStep(step, data)).catch(() => {});
  };

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        fromChain: 'Sepolia',
        amountEth,
        targets: SEPOLIA_GAS_FANOUT_CHAINS.map((toChain) => ({ toChain, amountEth })),
        summary: `Simulation only. Would bridge ${amountEth} ETH from Sepolia to ${SEPOLIA_GAS_FANOUT_CHAINS.join(', ')}.`,
      }),
    };
  }

  try {
    const targets = [];
    const recipient = agent.wallet_address || agent.walletAddress;

    await report('preparing', { amountEth, fromChain: 'Sepolia' });

    for (const toChain of SEPOLIA_GAS_FANOUT_CHAINS) {
      const balanceBeforeWei = await agentWalletService.getNativeBalance(toChain, recipient);
      const destinationStartBlock = await agentWalletService.getCurrentBlockNumber(toChain).catch(() => null);

      await report('bridging', { toChain, amountEth });
      const result = await agentWalletService.bridgeNativeGasTopUp({
        agent,
        toChain,
        amountEth,
      });

      await report('awaiting_arrival', {
        toChain,
        amountEth,
        topUpTxHash: result.topUpTxHash,
      });

      const balanceAfterWei = await _waitForNativeTopUpArrival({
        chainName: toChain,
        address: recipient,
        balanceBeforeWei,
      });

      const destinationReceipt = await agentWalletService.findRecentIncomingNativeTransfer({
        chainName: toChain,
        recipient,
        amountWei: result.amountWei,
        startBlock: destinationStartBlock,
      }).catch(() => null);

      await report('arrived', {
        toChain,
        fromChain: result.fromChain || 'Sepolia',
        amountEth,
        topUpTxHash: result.topUpTxHash,
        destinationTxHash: destinationReceipt?.hash || null,
      });

      targets.push({
        fromChain: result.fromChain || 'Sepolia',
        toChain,
        amountEth,
        topUpTxHash: result.topUpTxHash,
        sourceTxHash: result.topUpTxHash,
        destinationTxHash: destinationReceipt?.hash || null,
        bridgeKind: result.bridgeKind,
        bridgeAddress: result.bridgeAddress,
        balanceBeforeWei: balanceBeforeWei.toString(),
        balanceAfterWei: balanceAfterWei.toString(),
      });
    }

    await report('complete', {
      amountEth,
      targetCount: targets.length,
    });

    return {
      ok: true,
      payload: _timestamped({
        fromChain: 'Sepolia',
        amountEth,
        targets,
        summary: `Bridged ${amountEth} ETH each from Sepolia to ${SEPOLIA_GAS_FANOUT_CHAINS.join(', ')} and waited for each destination balance update.`,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'bridge_native_topup_error',
      error: error.message,
    };
  }
}

async function executeYieldMoveTask({ agent, params = {}, dryRun = false }) {
  const assetAddress = params.assetAddress || DEFAULT_USDC_ADDRESS;
  const amount = String(params.amount ?? '1');
  const action = params.action || 'supply';

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({ dryRun: true, assetAddress, amount, action }),
    };
  }

  const agentPrivateKey = decrypt(agent.private_key_encrypted);
  const result = action === 'withdraw'
    ? await protocols.executeAaveWithdraw({ assetAddress, amount, agentPrivateKey })
    : await protocols.executeAaveSupply({ assetAddress, amount, agentPrivateKey });

  return {
    ok: true,
    payload: _timestamped({ ...result, assetAddress, amount, action }),
  };
}

async function _executeNativeLendingTask({ agent, params = {}, dryRun = false, action }) {
  const asset = String(params.asset || params.symbol || '').trim().toUpperCase();
  const amount = String(params.amount ?? '0');

  const validation = await nativeLendingRiskService.guardAgentManualLendingAction({
    agent,
    action,
    asset,
    amount,
  });

  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.code,
      error: validation.verdict?.detail || 'Manual lending action blocked by the current risk guard.',
    };
  }

  const assetEntry = validation.asset;
  const walletAddress = agent.wallet_address || agent.walletAddress;
  const basePayload = {
    action,
    asset: assetEntry.symbol,
    amount,
    assetAddress: assetEntry.assetAddress,
    executionRail: 'arc_native_lending',
    executionSource: validation.surface.execution.source,
    buildState: validation.surface.execution.buildState,
    riskBand: validation.surface.risk.band,
    healthFactor: validation.surface.risk.healthFactor,
    availableBorrowUsd: validation.surface.risk.availableBorrowUsd,
  };

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        ...basePayload,
        dryRun: true,
        summary: `Would ${action} ${amount} ${assetEntry.symbol} on the Arc-native lending lane.`,
      }),
    };
  }

  if (!agent?.private_key_encrypted) {
    return { ok: false, reason: 'no_private_key' };
  }

  try {
    const agentPrivateKey = decrypt(agent.private_key_encrypted);
    let result;

    if (action === 'supply') {
      result = await protocols.executeNativeLendingSupply({
        assetAddress: assetEntry.assetAddress,
        amount,
        agentPrivateKey,
        onBehalfOf: walletAddress,
        decimals: assetEntry.decimals,
      });
    } else if (action === 'withdraw') {
      result = await protocols.executeNativeLendingWithdraw({
        assetAddress: assetEntry.assetAddress,
        amount,
        agentPrivateKey,
        to: walletAddress,
        decimals: assetEntry.decimals,
      });
    } else if (action === 'borrow') {
      result = await protocols.executeNativeLendingBorrow({
        assetAddress: assetEntry.assetAddress,
        amount,
        agentPrivateKey,
        to: walletAddress,
        decimals: assetEntry.decimals,
      });
    } else {
      result = await protocols.executeNativeLendingRepay({
        assetAddress: assetEntry.assetAddress,
        amount,
        agentPrivateKey,
        onBehalfOf: walletAddress,
        decimals: assetEntry.decimals,
      });
    }

    return {
      ok: true,
      payload: _timestamped({
        ...result,
        ...basePayload,
        summary: `${action[0].toUpperCase()}${action.slice(1)} ${amount} ${assetEntry.symbol} on the Arc-native lending lane.`,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'native_lending_execution_error',
      error: error.message,
    };
  }
}

async function executeNativeLendingSupplyTask({ agent, params = {}, dryRun = false }) {
  return _executeNativeLendingTask({
    agent,
    params,
    dryRun,
    action: 'supply',
  });
}

async function executeNativeLendingWithdrawTask({ agent, params = {}, dryRun = false }) {
  return _executeNativeLendingTask({
    agent,
    params,
    dryRun,
    action: 'withdraw',
  });
}

async function executeNativeLendingBorrowTask({ agent, params = {}, dryRun = false }) {
  return _executeNativeLendingTask({
    agent,
    params,
    dryRun,
    action: 'borrow',
  });
}

async function executeNativeLendingRepayTask({ agent, params = {}, dryRun = false }) {
  return _executeNativeLendingTask({
    agent,
    params,
    dryRun,
    action: 'repay',
  });
}

async function executeNativeLendingCollateralTopUpTask({ agent, dryRun = false }) {
  const validation = await nativeLendingRiskService.guardAgentCollateralTopUp({ agent });
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.code,
      error: validation.verdict?.detail || 'Collateral top-up is not available right now.',
    };
  }

  const basePayload = {
    action: 'collateral_top_up',
    executionRail: 'arc_native_lending',
    executionSource: validation.surface.execution.source,
    buildState: validation.surface.execution.buildState,
    currentHealthFactor: validation.verdict.currentHealthFactor,
    targetHealthFactor: validation.verdict.targetHealthFactor,
    projectedHealthFactor: validation.verdict.projectedHealthFactor,
    collateralUsdNeeded: validation.verdict.collateralUsdNeeded,
    collateralUsdPlanned: validation.verdict.collateralUsdPlanned,
    collateralUsdShortfall: validation.verdict.collateralUsdShortfall,
    topUpStatus: validation.verdict.status,
    plannedSteps: validation.verdict.steps,
  };

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        ...basePayload,
        dryRun: true,
        summary: 'Would run the deterministic lending collateral top-up plan for the current account.',
      }),
    };
  }

  if (!agent?.private_key_encrypted) {
    return { ok: false, reason: 'no_private_key' };
  }

  const agentPrivateKey = decrypt(agent.private_key_encrypted);
  const walletAddress = agent.wallet_address || agent.walletAddress;
  const assetMap = new Map((validation.surface.assets || []).map((assetEntry) => [assetEntry.symbol, assetEntry]));
  const executedSteps = [];

  try {
    for (const step of validation.verdict.steps || []) {
      const assetEntry = assetMap.get(step.asset);
      if (!assetEntry) {
        throw new Error(`Missing lending asset snapshot for ${step.asset}`);
      }

      const result = await protocols.executeNativeLendingSupply({
        assetAddress: assetEntry.assetAddress,
        amount: step.amount,
        agentPrivateKey,
        onBehalfOf: walletAddress,
        decimals: assetEntry.decimals,
      });

      executedSteps.push({
        ...step,
        txHash: result.txHash || null,
      });
    }

    return {
      ok: true,
      payload: _timestamped({
        ...basePayload,
        stepsExecuted: executedSteps,
        summary: 'Executed the deterministic lending collateral top-up plan for the current account.',
      }),
    };
  } catch (error) {
    if (executedSteps.length > 0) {
      return {
        ok: true,
        payload: _timestamped({
          ...basePayload,
          stepsExecuted: executedSteps,
          partialFailure: {
            error: error.message,
          },
          summary: 'Collateral top-up started, but not all planned supply steps completed.',
        }),
      };
    }

    return {
      ok: false,
      reason: 'native_lending_collateral_topup_error',
      error: error.message,
    };
  }
}

async function executeNativeLendingEmergencyDeleverageTask({ agent, dryRun = false }) {
  const validation = await nativeLendingRiskService.guardAgentEmergencyDeleverage({ agent });
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.code,
      error: validation.verdict?.detail || 'Emergency deleverage is not available right now.',
    };
  }

  const basePayload = {
    action: 'deleverage',
    executionRail: 'arc_native_lending',
    executionSource: validation.surface.execution.source,
    buildState: validation.surface.execution.buildState,
    currentHealthFactor: validation.verdict.currentHealthFactor,
    targetHealthFactor: validation.verdict.targetHealthFactor,
    projectedHealthFactor: validation.verdict.projectedHealthFactor,
    repayUsdNeeded: validation.verdict.repayUsdNeeded,
    repayUsdPlanned: validation.verdict.repayUsdPlanned,
    repayUsdShortfall: validation.verdict.repayUsdShortfall,
    recoveryStatus: validation.verdict.status,
    plannedSteps: validation.verdict.steps,
  };

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        ...basePayload,
        dryRun: true,
        summary: 'Would run the deterministic emergency deleverage plan for the current lending account.',
      }),
    };
  }

  if (!agent?.private_key_encrypted) {
    return { ok: false, reason: 'no_private_key' };
  }

  const agentPrivateKey = decrypt(agent.private_key_encrypted);
  const walletAddress = agent.wallet_address || agent.walletAddress;
  const assetMap = new Map((validation.surface.assets || []).map((assetEntry) => [assetEntry.symbol, assetEntry]));
  const executedSteps = [];

  try {
    for (const step of validation.verdict.steps || []) {
      const assetEntry = assetMap.get(step.asset);
      if (!assetEntry) {
        throw new Error(`Missing lending asset snapshot for ${step.asset}`);
      }

      const result = await protocols.executeNativeLendingRepay({
        assetAddress: assetEntry.assetAddress,
        amount: step.amount,
        agentPrivateKey,
        onBehalfOf: walletAddress,
        decimals: assetEntry.decimals,
      });

      executedSteps.push({
        ...step,
        txHash: result.txHash || null,
      });
    }

    return {
      ok: true,
      payload: _timestamped({
        ...basePayload,
        stepsExecuted: executedSteps,
        summary: 'Executed the deterministic emergency deleverage plan for the current lending account.',
      }),
    };
  } catch (error) {
    if (executedSteps.length > 0) {
      return {
        ok: true,
        payload: _timestamped({
          ...basePayload,
          stepsExecuted: executedSteps,
          partialFailure: {
            error: error.message,
          },
          summary: 'Emergency deleverage started, but not all planned repay steps completed.',
        }),
      };
    }

    return {
      ok: false,
      reason: 'native_lending_deleverage_error',
      error: error.message,
    };
  }
}

async function executeNativeLendingSafeExitTask({ agent, dryRun = false }) {
  const validation = await nativeLendingRiskService.guardAgentSafeExit({ agent });
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.code,
      error: validation.verdict?.detail || 'Safe exit is not available right now.',
    };
  }

  const basePayload = {
    action: 'safe_exit',
    executionRail: 'arc_native_lending',
    executionSource: validation.surface.execution.source,
    buildState: validation.surface.execution.buildState,
    currentHealthFactor: validation.verdict.currentHealthFactor,
    repayUsdNeeded: validation.verdict.repayUsdNeeded,
    repayUsdPlanned: validation.verdict.repayUsdPlanned,
    repayUsdShortfall: validation.verdict.repayUsdShortfall,
    withdrawUsdPlanned: validation.verdict.withdrawUsdPlanned,
    safeExitStatus: validation.verdict.status,
    plannedSteps: validation.verdict.steps,
  };

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        ...basePayload,
        dryRun: true,
        summary: 'Would run the deterministic lending safe-exit flow for the current account.',
      }),
    };
  }

  if (!agent?.private_key_encrypted) {
    return { ok: false, reason: 'no_private_key' };
  }

  const agentPrivateKey = decrypt(agent.private_key_encrypted);
  const walletAddress = agent.wallet_address || agent.walletAddress;
  const assetMap = new Map((validation.surface.assets || []).map((assetEntry) => [assetEntry.symbol, assetEntry]));
  const executedSteps = [];

  try {
    for (const step of validation.verdict.steps || []) {
      const assetEntry = assetMap.get(step.asset);
      if (!assetEntry) {
        throw new Error(`Missing lending asset snapshot for ${step.asset}`);
      }

      let result;
      if (step.action === 'withdraw') {
        result = await protocols.executeNativeLendingWithdraw({
          assetAddress: assetEntry.assetAddress,
          amount: step.amount,
          agentPrivateKey,
          to: walletAddress,
          decimals: assetEntry.decimals,
        });
      } else {
        result = await protocols.executeNativeLendingRepay({
          assetAddress: assetEntry.assetAddress,
          amount: step.amount,
          agentPrivateKey,
          onBehalfOf: walletAddress,
          decimals: assetEntry.decimals,
        });
      }

      executedSteps.push({
        ...step,
        txHash: result.txHash || null,
      });
    }

    return {
      ok: true,
      payload: _timestamped({
        ...basePayload,
        stepsExecuted: executedSteps,
        summary: 'Executed the deterministic lending safe-exit flow for the current account.',
      }),
    };
  } catch (error) {
    if (executedSteps.length > 0) {
      return {
        ok: true,
        payload: _timestamped({
          ...basePayload,
          stepsExecuted: executedSteps,
          partialFailure: {
            error: error.message,
          },
          summary: 'Safe exit started, but not every planned repay or withdraw step completed.',
        }),
      };
    }

    return {
      ok: false,
      reason: 'native_lending_safe_exit_error',
      error: error.message,
    };
  }
}

async function executeNativeLendingLiquidationTask({ agent, params = {}, dryRun = false }) {
  const borrower = String(params.borrower || params.borrowerAddress || '').trim();
  const debtAsset = String(params.debtAsset || params.asset || '').trim().toUpperCase();
  const collateralAsset = String(params.collateralAsset || '').trim().toUpperCase();
  const amount = String(params.amount ?? '0');

  const validation = await nativeLendingRiskService.guardAgentLiquidationAction({
    agent,
    borrower,
    debtAsset,
    collateralAsset,
    amount,
  });

  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.code,
      error: validation.verdict?.detail || 'Liquidation is not available right now.',
    };
  }

  const basePayload = {
    action: 'liquidate',
    borrower,
    debtAsset,
    collateralAsset,
    amount,
    executionRail: 'arc_native_lending',
    executionSource: validation.liquidatorSurface.execution.source,
    buildState: validation.liquidatorSurface.execution.buildState,
    borrowerHealthFactor: validation.borrowerSurface.risk.healthFactor,
  };

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        ...basePayload,
        dryRun: true,
        summary: `Would liquidate ${amount} ${debtAsset} of debt from ${borrower}.`,
      }),
    };
  }

  if (!agent?.private_key_encrypted) {
    return { ok: false, reason: 'no_private_key' };
  }

  try {
    const agentPrivateKey = decrypt(agent.private_key_encrypted);
    const result = await protocols.executeNativeLendingLiquidation({
      borrower,
      debtAssetAddress: validation.verdict.borrowerDebtEntry.assetAddress,
      collateralAssetAddress: validation.verdict.borrowerCollateralEntry.assetAddress,
      amount,
      agentPrivateKey,
      debtAssetDecimals: validation.verdict.borrowerDebtEntry.decimals,
    });

    return {
      ok: true,
      payload: _timestamped({
        ...basePayload,
        ...result,
        summary: `Liquidated ${amount} ${debtAsset} of debt from ${borrower}.`,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'native_lending_liquidation_error',
      error: error.message,
    };
  }
}

async function executeArbTask({ agent, params = {}, dryRun = false, pricingPool, swapPool }) {
  const poolAddress = params.poolAddress || swapPool?.address || process.env.CURVE_USDC_EURC_POOL || null;
  const amountIn = String(params.amountIn ?? '1');
  const pricingTarget = pricingPool || oracle.resolveCurvePool('EURC-USDC');
  const swapTarget = swapPool || oracle.resolveCurvePool('USDC-EURC');
  const forexRate = await oracle.getForexRate('EURC', 'USDC');

  const poolState = pricingTarget?.address
    ? await oracle.getCurvePoolState(pricingTarget)
    : oracle.getMockPoolState('EURC-USDC', forexRate.rate);

  const signal = oracle.buildArbSignal({
    strategy: 'stablecoin_fx',
    forexRate: forexRate.rate,
    poolRate: poolState.impliedRate,
    poolFee: poolState.fee,
    baseToken: 'EURC',
    quoteToken: 'USDC',
    poolLiquidity: (poolState.reserves?.token0 ?? 0) + (poolState.reserves?.token1 ?? 0),
    priceImpacts: poolState.priceImpact,
  });

  const buyEurcFromPool = Number(poolState.impliedRate) < Number(forexRate.rate);
  const opportunity = signal.opportunity || {};
  const confidence = signal.opportunity?.confidence || 'LOW';
  const spreadPct = Number(opportunity.spreadPct || 0);
  const inputAmountNumeric = Number(amountIn);
  const requestedRouteEstimate = buyEurcFromPool && Number.isFinite(inputAmountNumeric) && inputAmountNumeric > 0
    ? oracle.calcArbProfit(inputAmountNumeric, forexRate.rate, poolState.impliedRate, poolState.fee)
    : null;
  const requestedExpectedProfitUsdc = requestedRouteEstimate?.expectedProfitUsdc ?? null;
  const requestedNetProfitUsdc = requestedRouteEstimate?.netProfitUsdc ?? null;
  const signalModelExpectedProfitUsdc = opportunity.expectedProfitUsdc ?? null;
  const signalModelNetProfitUsdc = opportunity.netProfitUsdc ?? null;
  const hasRequestedRouteEstimate = Number.isFinite(Number(requestedNetProfitUsdc));
  const expectedProfitUsdc = hasRequestedRouteEstimate
    ? requestedExpectedProfitUsdc
    : signalModelExpectedProfitUsdc ?? 0;
  const netProfitUsdc = hasRequestedRouteEstimate
    ? requestedNetProfitUsdc
    : signalModelNetProfitUsdc ?? expectedProfitUsdc;
  const formatMetric = (value, digits = 2) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return String(value || '0');
    return numeric.toFixed(digits).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
  };
  const requestedSizeLabel = `${formatMetric(amountIn, 6)} USDC`;
  const signalSummary = `${confidence} confidence with ${formatMetric(spreadPct)}% spread`;
  const payload = _timestamped({
    signal,
    poolAddress,
    amountIn,
    requestedAmountIn: amountIn,
    fromToken: 'USDC',
    toToken: 'EURC',
    direction: buyEurcFromPool ? 'buy_eurc' : 'sell_eurc',
    confidence,
    spreadPct,
    signalRouteFound: Boolean(opportunity.found),
    signalModelAmountUsdc: opportunity.amountUsdc ?? null,
    signalModelExpectedProfitUsdc,
    signalModelNetProfitUsdc,
    requestedExpectedProfitUsdc,
    requestedNetProfitUsdc,
    executionScope: 'curve_entry_leg_only',
    expectedProfitUsdc,
    netProfitUsdc,
  });
  const walletBalances = await _getArbTaskWalletBalances(agent?.wallet_address);
  const oracleEntryCooldown = await readOracleEntryCooldown(agent?.id);
  const oracleStrategyPolicy = evaluateOracleStrategyPolicy({
    agent,
    forexRate,
    poolState,
    signal,
    executionGate: {
      verdict: {
        execute: true,
        suggestedAmount: inputAmountNumeric,
      },
    },
    pricingPool: pricingTarget,
    swapPool: swapTarget,
    requestedAmountUsdc: inputAmountNumeric,
    walletBalances,
    walletReserveUsdc: 0,
    exitQuote: null,
    entryCooldown: oracleEntryCooldown,
  });
  const explicitOracleInventoryCap = Number(agent?.oracle_max_eurc_inventory || 0);
  const configuredOracleInventoryCap = Number(process.env.ORACLE_STRATEGY_MAX_EURC_INVENTORY || 0);
  payload.oracleInventory = {
    currentEurcBalance: oracleStrategyPolicy.metrics?.availableEurcBalance ?? walletBalances.eurc,
    eurcCap: oracleStrategyPolicy.metrics?.maxEurcInventoryEurc ?? null,
    remainingHeadroomEurc: oracleStrategyPolicy.metrics?.remainingEurcInventoryHeadroom ?? null,
    protectedReserveEurc: oracleStrategyPolicy.metrics?.minEurcReserveEurc ?? 0,
    capSource: explicitOracleInventoryCap > 0
      ? 'agent_setting'
      : (configuredOracleInventoryCap > 0 ? 'environment_setting' : 'trade_size_fallback'),
  };
  payload.oracleStrategyPolicy = oracleStrategyPolicy;

  if (!poolAddress) {
    payload.skipped = true;
    payload.summary = `No on-chain trade was sent because the Curve pool is not configured. Requested size: ${requestedSizeLabel}.`;
    return { ok: true, payload };
  }

  if (!buyEurcFromPool) {
    payload.skipped = true;
    payload.summary = `No on-chain trade was sent. The current signal would require selling EURC into Curve, but this task only executes the USDC -> EURC Curve entry leg for the requested ${requestedSizeLabel}.`;
    return { ok: true, payload };
  }

  if (hasRequestedRouteEstimate && Number(requestedNetProfitUsdc) <= 0) {
    payload.skipped = true;
    payload.summary = `No on-chain trade was sent. The requested ${requestedSizeLabel} Curve entry leg is not profitable after Curve fees, so this task did not execute at the user-entered size.`;
    return { ok: true, payload };
  }

  if (!opportunity.found || confidence === 'LOW') {
    payload.skipped = true;
    payload.summary = `No on-chain trade was sent. The latest full-route oracle model is not profitable for the requested ${requestedSizeLabel} Curve entry leg.`;
    return { ok: true, payload };
  }

  if (oracleStrategyPolicy.metrics?.sizeClamped) {
    payload.skipped = true;
    payload.summary = `No on-chain trade was sent. The requested ${requestedSizeLabel} exceeds the current oracle strategy safety cap of ${oracleStrategyPolicy.metrics.effectiveMaxTradeUsdc} USDC for this route.`;
    return { ok: true, payload };
  }

  if (oracleStrategyPolicy.verdict?.execute !== true) {
    payload.skipped = true;
    if (oracleStrategyPolicy.verdict?.blockedBy === 'inventoryCap') {
      const currentEurcBalance = payload.oracleInventory?.currentEurcBalance;
      const eurcCap = payload.oracleInventory?.eurcCap;
      payload.summary = Number.isFinite(Number(currentEurcBalance)) && Number.isFinite(Number(eurcCap))
        ? `No on-chain trade was sent. This task only opens a fresh USDC -> EURC Curve entry, and the agent already holds ${formatMetric(currentEurcBalance, 6)} EURC against a ${formatMetric(eurcCap, 6)} EURC inventory cap. A new entry stays paused until some EURC rotates back into USDC.`
        : `No on-chain trade was sent. ${oracleStrategyPolicy.verdict?.reason || 'Oracle strategy policy v1 blocked this Curve entry leg.'}`;
    } else {
      payload.summary = `No on-chain trade was sent. ${oracleStrategyPolicy.verdict?.reason || 'Oracle strategy policy v1 blocked this Curve entry leg.'}`;
    }
    return { ok: true, payload };
  }

  if (dryRun) {
    payload.dryRun = true;
    payload.summary = `Simulation only. The requested ${requestedSizeLabel} Curve entry leg clears the current oracle strategy policy checks, but this task does not execute the bridge or exit leg.`;
    return { ok: true, payload };
  }

  const indexIn = swapTarget?.baseToken?.index ?? 0;
  const indexOut = swapTarget?.quoteToken?.index ?? 1;
  const tokenInAddress = swapTarget?.baseToken?.address || DEFAULT_USDC_ADDRESS;

  payload.swap = await protocols.executeCurveSwap({
    poolAddress,
    tokenInAddress,
    indexIn,
    indexOut,
    amountIn,
    agentPrivateKey: decrypt(agent.private_key_encrypted),
  });
  payload.swapTxHash = payload.swap?.txHash || payload.swap?.hash || null;
  payload.summary = `Executed the Curve entry leg for ${requestedSizeLabel} on a ${signalSummary}. This task does not complete the bridge or exit leg, so no realized arbitrage profit is claimed here.`;

  return { ok: true, payload };
}

async function executeRebalanceTask({ agent, params = {}, dryRun = false }) {
  const fromToken = params.fromToken || 'USDC';
  const toToken = params.toToken || 'EURC';
  const amountIn = String(params.amountIn || 1);
  const slippagePct = params.slippage || 0.5;
  const curvePool = _resolveCurvePool(`${fromToken}-${toToken}`);

  const positionGuard = await _readCurvePositionGuard(agent, curvePool);
  if (!positionGuard.ok) return positionGuard;

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({
        dryRun: true,
        fromToken,
        toToken,
        amountIn,
        positionBefore: _summarizePoolPosition(positionGuard.position),
      }),
    };
  }

  if (!agentWalletService.isSwapConfigured()) {
    if (!curvePool?.address) {
      return { ok: false, reason: 'curve_pool_not_configured' };
    }

    const result = await protocols.executeCurveSwap({
      poolAddress: curvePool.address,
      tokenInAddress: curvePool.baseToken.address || DEFAULT_USDC_ADDRESS,
      indexIn: curvePool.baseToken.index,
      indexOut: curvePool.quoteToken.index,
      amountIn,
      slippagePct,
      agentPrivateKey: decrypt(agent.private_key_encrypted),
      decimalsIn: curvePool.baseToken.decimals || 6,
      decimalsOut: curvePool.quoteToken.decimals || 6,
    });

    return {
      ok: true,
      payload: _timestamped({
        ...result,
        txHash: result.txHash || result.hash || null,
        fromToken,
        toToken,
        amountIn,
        executionRail: 'curve_fallback',
        poolAddress: curvePool.address,
        poolSource: curvePool.source || 'verified_default',
        positionBefore: _summarizePoolPosition(positionGuard.position),
        summary: `Rebalanced ${amountIn} ${fromToken} to ${toToken} via Curve fallback.`,
      }),
    };
  }

  const result = await agentWalletService.agentSwap({
    agent,
    fromToken,
    toToken,
    amountIn,
    slippagePct,
  });

  return {
    ok: true,
    payload: _timestamped({
      ...result,
      txHash: result.txHash || result.hash || null,
      fromToken,
      toToken,
      amountIn,
      executionRail: 'swap_kit',
      positionBefore: _summarizePoolPosition(positionGuard.position),
      summary: `Rebalanced ${amountIn} ${fromToken} to ${toToken} via Swap Kit.`,
    }),
  };
}

module.exports = {
  executeArbTask,
  executeBridgeTask,
  executeCurveLiquidityAddBalancedTask,
  executeDirectPairSwapTask,
  executeDirectPairRemoveLiquidityTask,
  executeDirectPairRemoveLiquiditySingleTask,
  executeDirectPairAddLiquidityTask,
  executeDirectPairZapInTask,
  executeCurveLiquidityAddTask,
  executeCurveLiquidityRemoveBalancedTask,
  executeCurveLiquidityRemoveTask,
  executeCurveSwapTask,
  executeNativeLendingCollateralTopUpTask,
  executeNativeLendingEmergencyDeleverageTask,
  executeNativeLendingBorrowTask,
  executeNativeLendingLiquidationTask,
  executeNativeLendingRepayTask,
  executeNativeLendingSafeExitTask,
  executeNativeLendingSupplyTask,
  executeNativeLendingWithdrawTask,
  executeRebalanceTask,
  executeSepoliaGasFanoutTask,
  executeYieldMoveTask,
};