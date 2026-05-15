'use strict';

const { ethers } = require('ethers');
const { getCache, setCache, TTL } = require('./cache');

// Curve pool ABI — only needed functions
const CURVE_POOL_ABI = [
  'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
  'function balances(uint256 i) view returns (uint256)',
  'function fee() view returns (uint256)',
  'function coins(uint256 i) view returns (address)',
  'function get_virtual_price() view returns (uint256)',
];

const CONSTANT_PRODUCT_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

// Aave pool ABI
const AAVE_POOL_ABI = [
  'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
  'function getReservesList() view returns (address[])',
];

// Band Protocol reference ABI
const BAND_REFERENCE_ABI = [
  'function latestAnswer() view returns (int256)',
  'function latestTimestamp() view returns (uint256)',
  'function decimals() view returns (uint8)',
];

function normalizeCurvePoolRequest(poolConfigOrName, poolAddress, token0Decimals = 6, token1Decimals = 6) {
  if (poolConfigOrName && typeof poolConfigOrName === 'object' && !Array.isArray(poolConfigOrName)) {
    const baseToken = poolConfigOrName.baseToken || {};
    const quoteToken = poolConfigOrName.quoteToken || {};

    return {
      poolName: poolConfigOrName.requestedKey || poolConfigOrName.key || poolConfigOrName.poolName || 'UNKNOWN',
      poolAddress: poolConfigOrName.address || poolConfigOrName.poolAddress || null,
      baseToken: {
        symbol: baseToken.symbol || 'TOKEN0',
        address: baseToken.address || null,
        decimals: Number.isInteger(baseToken.decimals) ? baseToken.decimals : token0Decimals,
        index: Number.isInteger(baseToken.index) ? baseToken.index : 0,
      },
      quoteToken: {
        symbol: quoteToken.symbol || 'TOKEN1',
        address: quoteToken.address || null,
        decimals: Number.isInteger(quoteToken.decimals) ? quoteToken.decimals : token1Decimals,
        index: Number.isInteger(quoteToken.index) ? quoteToken.index : 1,
      },
    };
  }

  return {
    poolName: poolConfigOrName,
    poolAddress,
    baseToken: {
      symbol: 'TOKEN0',
      address: null,
      decimals: token0Decimals,
      index: 0,
    },
    quoteToken: {
      symbol: 'TOKEN1',
      address: null,
      decimals: token1Decimals,
      index: 1,
    },
  };
}

function normalizeConstantProductPoolRequest(poolConfigOrName, poolAddress, token0Decimals = 18, token1Decimals = 18) {
  if (poolConfigOrName && typeof poolConfigOrName === 'object' && !Array.isArray(poolConfigOrName)) {
    const baseToken = poolConfigOrName.baseToken || {};
    const quoteToken = poolConfigOrName.quoteToken || {};

    return {
      poolName: poolConfigOrName.requestedKey || poolConfigOrName.key || poolConfigOrName.poolName || 'UNKNOWN',
      poolAddress: poolConfigOrName.address || poolConfigOrName.poolAddress || null,
      protocol: poolConfigOrName.protocol || 'constant_product',
      venue: poolConfigOrName.venue || poolConfigOrName.protocol || 'constant_product',
      feePct: Number.isFinite(poolConfigOrName.feePct) ? poolConfigOrName.feePct : 0.3,
      baseToken: {
        symbol: baseToken.symbol || 'TOKEN0',
        address: baseToken.address || null,
        decimals: Number.isInteger(baseToken.decimals) ? baseToken.decimals : token0Decimals,
      },
      quoteToken: {
        symbol: quoteToken.symbol || 'TOKEN1',
        address: quoteToken.address || null,
        decimals: Number.isInteger(quoteToken.decimals) ? quoteToken.decimals : token1Decimals,
      },
    };
  }

  return {
    poolName: poolConfigOrName,
    poolAddress,
    protocol: 'constant_product',
    venue: 'constant_product',
    feePct: 0.3,
    baseToken: {
      symbol: 'TOKEN0',
      address: null,
      decimals: token0Decimals,
    },
    quoteToken: {
      symbol: 'TOKEN1',
      address: null,
      decimals: token1Decimals,
    },
  };
}

function roundTo(value, digits) {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function getProvider() {
  const rpcUrl = process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC;
  if (!rpcUrl) throw new Error('ARC_RPC_URL or ARC_TESTNET_RPC is not defined');
  return new ethers.JsonRpcProvider(rpcUrl);
}

async function getCurvePoolState(poolName, poolAddress, token0Decimals = 6, token1Decimals = 6) {
  const request = normalizeCurvePoolRequest(poolName, poolAddress, token0Decimals, token1Decimals);
  const { poolName: resolvedPoolName, poolAddress: resolvedPoolAddress, baseToken, quoteToken } = request;

  if (!resolvedPoolAddress) {
    throw new Error('Curve pool address is required');
  }

  const cacheKey = `curve_pool_${resolvedPoolAddress}_${baseToken.index}_${quoteToken.index}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const provider = getProvider();
  const pool     = new ethers.Contract(resolvedPoolAddress, CURVE_POOL_ABI, provider);

  const [balance0Raw, balance1Raw, feeRaw, spotAmountOutRaw] = await Promise.all([
    pool.balances(baseToken.index),
    pool.balances(quoteToken.index),
    pool.fee(),
    pool.get_dy(baseToken.index, quoteToken.index, ethers.parseUnits('1', baseToken.decimals)).catch(() => 0n),
  ]);

  const balance0   = Number(ethers.formatUnits(balance0Raw, baseToken.decimals));
  const balance1   = Number(ethers.formatUnits(balance1Raw, quoteToken.decimals));
  const feePct     = Number(feeRaw) / 1e8; // Curve fee normalized to 1e10, convert to percent
  const impliedRate = Number(ethers.formatUnits(spotAmountOutRaw, quoteToken.decimals));

  const calcPriceImpact = async (amountBase) => {
    if (!(impliedRate > 0)) {
      return 99.0;
    }

    try {
      const amountIn  = ethers.parseUnits(amountBase.toString(), baseToken.decimals);
      const amountOut = await pool.get_dy(baseToken.index, quoteToken.index, amountIn);
      const outFormatted = Number(ethers.formatUnits(amountOut, quoteToken.decimals));
      const idealOut     = amountBase * impliedRate;

      if (!(idealOut > 0)) {
        return 99.0;
      }

      return Math.abs((idealOut - outFormatted) / idealOut) * 100;
    } catch {
      return 99.0; // Insufficient liquidity
    }
  };

  const [impact1k, impact10k, impact50k] = await Promise.all([
    calcPriceImpact(1_000),
    calcPriceImpact(10_000),
    calcPriceImpact(50_000),
  ]);

  const result = {
    protocol: 'curve',
    poolName: resolvedPoolName,
    poolAddress: resolvedPoolAddress,
    baseToken: {
      symbol: baseToken.symbol,
      address: baseToken.address,
      decimals: baseToken.decimals,
      index: baseToken.index,
    },
    quoteToken: {
      symbol: quoteToken.symbol,
      address: quoteToken.address,
      decimals: quoteToken.decimals,
      index: quoteToken.index,
    },
    reserves:     { token0: balance0, token1: balance1 },
    impliedRate:  roundTo(impliedRate, 6),
    inverseRate:  impliedRate > 0 ? roundTo(1 / impliedRate, 6) : 0,
    fee:          roundTo(feePct, 6),
    priceImpact:  {
      swap1k:  roundTo(impact1k, 4),
      swap10k: roundTo(impact10k, 4),
      swap50k: roundTo(impact50k, 4),
    },
    volume24h: 0, // Not available onchain; use ArcScan API later
    source:    'arc_rpc',
    rateUnit:  `${quoteToken.symbol} per ${baseToken.symbol}`,
    liquidityState: balance0 > 0 && balance1 > 0 ? 'active' : 'empty',
    fetchedAt: new Date().toISOString(),
  };

  setCache(cacheKey, result, TTL.POOL_STATE);
  return result;
}

async function getConstantProductPoolState(poolName, poolAddress, token0Decimals = 18, token1Decimals = 18) {
  const request = normalizeConstantProductPoolRequest(poolName, poolAddress, token0Decimals, token1Decimals);
  const { poolName: resolvedPoolName, poolAddress: resolvedPoolAddress, baseToken, quoteToken, protocol, venue, feePct } = request;

  if (!resolvedPoolAddress) {
    throw new Error('Constant-product pool address is required');
  }

  const cacheKey = `constant_product_pool_${resolvedPoolAddress}_${baseToken.symbol}_${quoteToken.symbol}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const provider = getProvider();
  const pool = new ethers.Contract(resolvedPoolAddress, CONSTANT_PRODUCT_POOL_ABI, provider);
  const [token0Address, token1Address, reservesRaw] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.getReserves(),
  ]);

  const token0Lower = String(token0Address || '').toLowerCase();
  const token1Lower = String(token1Address || '').toLowerCase();
  const baseLower = String(baseToken.address || '').toLowerCase();
  const quoteLower = String(quoteToken.address || '').toLowerCase();

  let baseReserveRaw = reservesRaw.reserve0;
  let quoteReserveRaw = reservesRaw.reserve1;

  if (baseLower && quoteLower) {
    if (token0Lower === quoteLower && token1Lower === baseLower) {
      baseReserveRaw = reservesRaw.reserve1;
      quoteReserveRaw = reservesRaw.reserve0;
    } else if (token0Lower === baseLower && token1Lower === quoteLower) {
      baseReserveRaw = reservesRaw.reserve0;
      quoteReserveRaw = reservesRaw.reserve1;
    }
  }

  const baseReserve = Number(ethers.formatUnits(baseReserveRaw, baseToken.decimals));
  const quoteReserve = Number(ethers.formatUnits(quoteReserveRaw, quoteToken.decimals));
  const impliedRate = baseReserve > 0 ? quoteReserve / baseReserve : 0;
  const feeFactor = Math.max(0, 1 - (feePct / 100));

  const calcPriceImpact = (amountBase) => {
    if (!(impliedRate > 0) || !(baseReserve > 0) || !(quoteReserve > 0)) {
      return 99.0;
    }

    const amountInWithFee = amountBase * feeFactor;
    const amountOut = (quoteReserve * amountInWithFee) / (baseReserve + amountInWithFee);
    const idealOut = amountBase * impliedRate;

    if (!(idealOut > 0)) {
      return 99.0;
    }

    return Math.abs((idealOut - amountOut) / idealOut) * 100;
  };

  const result = {
    protocol,
    venue,
    poolName: resolvedPoolName,
    poolAddress: resolvedPoolAddress,
    baseToken: {
      symbol: baseToken.symbol,
      address: baseToken.address,
      decimals: baseToken.decimals,
    },
    quoteToken: {
      symbol: quoteToken.symbol,
      address: quoteToken.address,
      decimals: quoteToken.decimals,
    },
    reserves: { token0: baseReserve, token1: quoteReserve },
    impliedRate: roundTo(impliedRate, 6),
    inverseRate: impliedRate > 0 ? roundTo(1 / impliedRate, 6) : 0,
    fee: roundTo(feePct, 6),
    priceImpact: {
      swap1k: roundTo(calcPriceImpact(1_000), 4),
      swap10k: roundTo(calcPriceImpact(10_000), 4),
      swap50k: roundTo(calcPriceImpact(50_000), 4),
    },
    volume24h: 0,
    source: 'arc_rpc',
    rateUnit: `${quoteToken.symbol} per ${baseToken.symbol}`,
    liquidityState: baseReserve > 0 && quoteReserve > 0 ? 'active' : 'empty',
    fetchedAt: new Date().toISOString(),
  };

  setCache(cacheKey, result, TTL.POOL_STATE);
  return result;
}

async function getAaveReserveData(assetAddress) {
  const poolAddress = process.env.AAVE_POOL_ADDRESS;
  if (!poolAddress) return null;

  const cacheKey = `aave_reserve_${assetAddress}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const provider = getProvider();
  const pool     = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);
  const data     = await pool.getReserveData(assetAddress);

  // currentLiquidityRate is in ray (1e27) → convert to APY
  const liquidityRate    = Number(data.currentLiquidityRate);
  const supplyApy        = ((1 + liquidityRate / 1e27 / 365) ** 365 - 1) * 100;
  const variableBorrowRate = Number(data.currentVariableBorrowRate);
  const borrowApy          = ((1 + variableBorrowRate / 1e27 / 365) ** 365 - 1) * 100;

  const result = {
    supplyApy:   Math.round(supplyApy * 100) / 100,
    borrowApy:   Math.round(borrowApy * 100) / 100,
    utilization: 0,
  };

  setCache(cacheKey, result, TTL.YIELD_RANK);
  return result;
}

async function getBandFeed(pair = 'USDC/USD') {
  const contractAddress = process.env.BAND_REFERENCE_CONTRACT;
  if (!contractAddress) return null;

  const cacheKey = `band_${pair}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const provider = getProvider();
  const ref      = new ethers.Contract(contractAddress, BAND_REFERENCE_ABI, provider);

  const [answer, timestamp, decimals] = await Promise.all([
    ref.latestAnswer(),
    ref.latestTimestamp(),
    ref.decimals(),
  ]);

  const rate      = Number(answer) / 10 ** Number(decimals);
  const updatedAt = new Date(Number(timestamp) * 1000).toISOString();

  const result = { rate, updatedAt, source: 'band_protocol_arc' };
  setCache(cacheKey, result, TTL.FX_RATE);
  return result;
}

// Mock pool state — when ARC testnet contract address is not yet known
function getMockPoolState(poolName, impliedRate) {
  return {
    protocol:    'curve',
    poolName,
    poolAddress: '0x0000000000000000000000000000000000000000',
    reserves:    { token0: 1_250_000, token1: 1_352_500 },
    impliedRate,
    fee:         0.04,
    priceImpact: { swap1k: 0.0012, swap10k: 0.0098, swap50k: 0.0421 },
    volume24h:   0,
    source:      'mock_testnet',
    fetchedAt:   new Date().toISOString(),
  };
}

module.exports = { getCurvePoolState, getConstantProductPoolState, getAaveReserveData, getBandFeed, getMockPoolState };
