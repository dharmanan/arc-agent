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

function getProvider() {
  const rpcUrl = process.env.ARC_RPC_URL;
  if (!rpcUrl) throw new Error('ARC_RPC_URL is not defined');
  return new ethers.JsonRpcProvider(rpcUrl);
}

async function getCurvePoolState(poolName, poolAddress, token0Decimals = 6, token1Decimals = 6) {
  const cacheKey = `curve_pool_${poolAddress}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const provider = getProvider();
  const pool     = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);

  const [balance0Raw, balance1Raw, feeRaw] = await Promise.all([
    pool.balances(0),
    pool.balances(1),
    pool.fee(),
  ]);

  const balance0   = Number(ethers.formatUnits(balance0Raw, token0Decimals));
  const balance1   = Number(ethers.formatUnits(balance1Raw, token1Decimals));
  const feePct     = Number(feeRaw) / 1e10; // Curve fee is 1e10 normalized
  const impliedRate = balance1 / balance0;

  const calcPriceImpact = async (amountUsdc) => {
    try {
      const amountIn  = ethers.parseUnits(amountUsdc.toString(), token0Decimals);
      const amountOut = await pool.get_dy(0, 1, amountIn);
      const outFormatted = Number(ethers.formatUnits(amountOut, token1Decimals));
      const idealOut     = amountUsdc * impliedRate;
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
    poolName,
    poolAddress,
    reserves:     { token0: balance0, token1: balance1 },
    impliedRate:  Math.round(impliedRate * 100000) / 100000,
    fee:          feePct,
    priceImpact:  {
      swap1k:  Math.round(impact1k  * 10000) / 10000,
      swap10k: Math.round(impact10k * 10000) / 10000,
      swap50k: Math.round(impact50k * 10000) / 10000,
    },
    volume24h: 0, // Not available onchain; use ArcScan API later
    source:    'arc_rpc',
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

module.exports = { getCurvePoolState, getAaveReserveData, getBandFeed, getMockPoolState };
