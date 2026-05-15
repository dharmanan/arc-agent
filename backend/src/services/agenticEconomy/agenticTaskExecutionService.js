'use strict';

const oracle = require('../oracle');
const protocols = require('../protocols');
const agentWalletService = require('../agentWalletService');
const positionsService = require('../positionsService');
const { decrypt } = require('../cryptoService');
const { resolveDirectSwapFallbackPool } = require('../oracle/pools');

const DEFAULT_USDC_ADDRESS = process.env.USDC_ADDRESS_ARC || '0x3600000000000000000000000000000000000000';
const DEFAULT_EURC_ADDRESS = process.env.EURC_ADDRESS_ARC || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const DIRECT_PAIR_ZAP_LIMITS = {
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

function _timestamped(payload) {
  return {
    ...payload,
    executedAt: new Date().toISOString(),
  };
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

async function executeCurveLiquidityRemoveTask({ agent, params = {}, dryRun = false }) {
  const tokenOut = params.tokenOut || 'USDC';
  const lpAmount = String(params.lpAmount ?? '1');
  const curvePool = _resolveStableCurvePoolForToken(tokenOut);
  const poolCoin = _resolveCurveCoin(curvePool, tokenOut);

  if (!curvePool?.address) {
    return { ok: false, reason: 'curve_pool_not_configured' };
  }

  const positionGuard = await _readCurvePositionGuard(agent, curvePool);
  if (!positionGuard.ok) return positionGuard;

  const currentLpBalance = Number(positionGuard.position?.lpToken?.balance || 0);
  if (!positionGuard.position || currentLpBalance <= 0) {
    return { ok: false, reason: 'lp_position_not_found' };
  }
  if (Number(lpAmount) > currentLpBalance) {
    return {
      ok: false,
      reason: 'insufficient_lp_position',
      error: `available_lp_balance:${positionGuard.position.lpToken.balance}`,
    };
  }

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

async function executeDirectPairZapInTask({ agent, params = {}, dryRun = false, stableToken = 'USDC' }) {
  const normalizedStableToken = String(stableToken || 'USDC').toUpperCase();
  const config = DIRECT_PAIR_ZAP_LIMITS[normalizedStableToken];
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

async function executeDirectPairRemoveLiquidityTask({ agent, params = {}, dryRun = false, stableToken = 'USDC' }) {
  const normalizedStableToken = String(stableToken || 'USDC').toUpperCase();
  const config = DIRECT_PAIR_ZAP_LIMITS[normalizedStableToken];
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
  const confidence = signal.opportunity?.confidence || 'LOW';
  const payload = _timestamped({
    signal,
    poolAddress,
    amountIn,
    direction: buyEurcFromPool ? 'buy_eurc' : 'sell_eurc',
  });

  if (dryRun || !poolAddress || confidence === 'LOW') {
    payload.dryRun = dryRun || !poolAddress;
    payload.skipped = !dryRun && Boolean(poolAddress) && confidence === 'LOW';
    return { ok: true, payload };
  }

  const indexIn = buyEurcFromPool
    ? (swapTarget?.baseToken?.index ?? 0)
    : (swapTarget?.quoteToken?.index ?? 1);
  const indexOut = buyEurcFromPool
    ? (swapTarget?.quoteToken?.index ?? 1)
    : (swapTarget?.baseToken?.index ?? 0);
  const tokenInAddress = buyEurcFromPool
    ? (swapTarget?.baseToken?.address || DEFAULT_USDC_ADDRESS)
    : (swapTarget?.quoteToken?.address || DEFAULT_EURC_ADDRESS);

  payload.swap = await protocols.executeCurveSwap({
    poolAddress,
    tokenInAddress,
    indexIn,
    indexOut,
    amountIn,
    agentPrivateKey: decrypt(agent.private_key_encrypted),
  });

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
  if (positionGuard.position && Number(positionGuard.position.lpToken?.balance || 0) > 0) {
    return {
      ok: false,
      reason: 'lp_position_exit_required',
    };
  }

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
  executeDirectPairRemoveLiquidityTask,
  executeDirectPairZapInTask,
  executeCurveLiquidityAddTask,
  executeCurveLiquidityRemoveTask,
  executeCurveSwapTask,
  executeRebalanceTask,
  executeYieldMoveTask,
};