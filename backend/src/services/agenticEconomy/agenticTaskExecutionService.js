'use strict';

const oracle = require('../oracle');
const protocols = require('../protocols');
const agentWalletService = require('../agentWalletService');
const { decrypt } = require('../cryptoService');

const DEFAULT_USDC_ADDRESS = process.env.USDC_ADDRESS_ARC || '0x3600000000000000000000000000000000000000';
const DEFAULT_EURC_ADDRESS = process.env.EURC_ADDRESS_ARC || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

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
  const amountIn = params.amountIn || 1;
  const slippagePct = params.slippage || 0.5;

  if (dryRun) {
    return {
      ok: true,
      payload: _timestamped({ dryRun: true, fromToken, toToken, amountIn }),
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
    payload: _timestamped({ ...result, fromToken, toToken, amountIn }),
  };
}

module.exports = {
  executeArbTask,
  executeBridgeTask,
  executeCurveSwapTask,
  executeRebalanceTask,
  executeYieldMoveTask,
};