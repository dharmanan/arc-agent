'use strict';

const { ethers } = require('ethers');
const db = require('../db');
const { resolveCurvePool, resolveDirectSwapFallbackPool } = require('./oracle/pools');

const CURVE_POSITION_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balances(uint256 i) view returns (uint256)',
  'function get_virtual_price() view returns (uint256)',
];

const V2_PAIR_POSITION_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const TRACKED_CURVE_POOLS = [
  'USDC-EURC',
  'EURC-WUSDC',
  'WUSDC-USDC',
  'USDC-USYC',
];

function getProvider() {
  const rpcUrl = process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
  return new ethers.JsonRpcProvider(rpcUrl);
}

function formatUnits(value, decimals) {
  return ethers.formatUnits(value, decimals);
}

function dedupeTrackedCurvePools(poolKeys = TRACKED_CURVE_POOLS) {
  const targetPoolKeys = Array.isArray(poolKeys) && poolKeys.length
    ? poolKeys
    : TRACKED_CURVE_POOLS;
  const pools = [];
  const seenAddresses = new Set();

  for (const poolKey of targetPoolKeys) {
    const pool = resolveCurvePool(poolKey);
    if (!pool?.address) continue;

    const normalizedAddress = String(pool.address).toLowerCase();
    if (seenAddresses.has(normalizedAddress)) continue;
    seenAddresses.add(normalizedAddress);

    pools.push({
      key: poolKey,
      ...pool,
    });
  }

  return pools;
}

function getTrackedDirectPairPools() {
  const pairKeys = ['USDC-CIRBTC', 'EURC-CIRBTC'];
  const pairs = [];
  const seenAddresses = new Set();

  for (const poolKey of pairKeys) {
    const pool = resolveDirectSwapFallbackPool(poolKey);
    if (!pool?.address || pool.protocol === 'curve') continue;

    const normalizedAddress = String(pool.address).toLowerCase();
    if (seenAddresses.has(normalizedAddress)) continue;
    seenAddresses.add(normalizedAddress);

    pairs.push({
      key: poolKey,
      ...pool,
    });
  }

  return pairs;
}

async function getWalletPositions(walletAddress, { poolKeys } = {}) {
  if (!walletAddress) {
    return {
      walletAddress: null,
      positions: [],
      warnings: [{ poolKey: 'wallet', message: 'wallet_address_missing' }],
      updatedAt: new Date().toISOString(),
    };
  }

  const provider = getProvider();
  const trackedPools = dedupeTrackedCurvePools(poolKeys);
  const trackedDirectPairs = (!Array.isArray(poolKeys) || !poolKeys.length)
    ? getTrackedDirectPairPools()
    : [];

  const settled = await Promise.allSettled(
    trackedPools.map(pool => readCurvePosition(provider, walletAddress, pool)),
  );

  const directSettled = await Promise.allSettled(
    trackedDirectPairs.map(pool => readDirectPairPosition(provider, walletAddress, pool)),
  );

  const positions = settled
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value)
    .concat(
      directSettled
        .filter(result => result.status === 'fulfilled' && result.value)
        .map(result => result.value),
    );

  const warnings = settled
    .map((result, index) => {
      if (result.status === 'fulfilled') return null;
      return {
        poolKey: trackedPools[index]?.key || 'unknown',
        message: result.reason?.message || 'position_read_failed',
      };
    })
    .concat(
      directSettled
        .map((result, index) => {
          if (result.status === 'fulfilled') return null;
          return {
            poolKey: trackedDirectPairs[index]?.key || 'unknown_direct_pair',
            message: result.reason?.message || 'position_read_failed',
          };
        })
        .filter(Boolean),
    )
    .filter(Boolean);

  return {
    walletAddress,
    positions,
    warnings,
    updatedAt: new Date().toISOString(),
  };
}

function getTokenMetaForAddress(pool, address) {
  const normalizedAddress = String(address || '').toLowerCase();
  if (String(pool.baseToken?.address || '').toLowerCase() === normalizedAddress) {
    return pool.baseToken;
  }
  if (String(pool.quoteToken?.address || '').toLowerCase() === normalizedAddress) {
    return pool.quoteToken;
  }
  return null;
}

async function readDirectPairPosition(provider, walletAddress, pool) {
  const contract = new ethers.Contract(pool.address, V2_PAIR_POSITION_ABI, provider);
  const [lpBalanceRaw, totalSupplyRaw, token0, token1, reserves] = await Promise.all([
    contract.balanceOf(walletAddress),
    contract.totalSupply(),
    contract.token0(),
    contract.token1(),
    contract.getReserves(),
  ]);

  if (lpBalanceRaw <= 0n) {
    return null;
  }

  const token0Meta = getTokenMetaForAddress(pool, token0) || pool.baseToken;
  const token1Meta = getTokenMetaForAddress(pool, token1) || pool.quoteToken;
  const shareBps = totalSupplyRaw > 0n
    ? Number((lpBalanceRaw * 10000n) / totalSupplyRaw) / 100
    : 0;
  const underlying0Raw = totalSupplyRaw > 0n
    ? (reserves.reserve0 * lpBalanceRaw) / totalSupplyRaw
    : 0n;
  const underlying1Raw = totalSupplyRaw > 0n
    ? (reserves.reserve1 * lpBalanceRaw) / totalSupplyRaw
    : 0n;

  return {
    protocol: pool.protocol || 'uniswap_v2_like',
    chain: 'Arc Testnet',
    poolKey: pool.key,
    poolAddress: pool.address,
    poolSource: pool.source || 'env',
    poolModel: pool.poolModel || 'constant_product',
    feePct: pool.feePct || 0.3,
    liquidityState: pool.liquidityState || 'active',
    lpToken: {
      symbol: `${token0Meta.symbol}/${token1Meta.symbol} LP`,
      balance: formatUnits(lpBalanceRaw, 18),
      decimals: 18,
    },
    sharePct: shareBps,
    underlying: [
      {
        symbol: token0Meta.symbol,
        amount: formatUnits(underlying0Raw, token0Meta.decimals || 18),
        decimals: token0Meta.decimals || 18,
      },
      {
        symbol: token1Meta.symbol,
        amount: formatUnits(underlying1Raw, token1Meta.decimals || 18),
        decimals: token1Meta.decimals || 18,
      },
    ],
    virtualPrice: null,
    updatedAt: new Date().toISOString(),
  };
}

async function readCurvePosition(provider, walletAddress, pool) {
  const contract = new ethers.Contract(pool.address, CURVE_POSITION_ABI, provider);
  const [lpBalanceRaw, totalSupplyRaw, reserve0Raw, reserve1Raw, virtualPriceRaw] = await Promise.all([
    contract.balanceOf(walletAddress),
    contract.totalSupply(),
    contract.balances(pool.baseToken.index),
    contract.balances(pool.quoteToken.index),
    contract.get_virtual_price().catch(() => null),
  ]);

  if (lpBalanceRaw <= 0n) {
    return null;
  }

  const shareBps = totalSupplyRaw > 0n
    ? Number((lpBalanceRaw * 10000n) / totalSupplyRaw) / 100
    : 0;

  const underlyingBaseRaw = totalSupplyRaw > 0n
    ? (reserve0Raw * lpBalanceRaw) / totalSupplyRaw
    : 0n;
  const underlyingQuoteRaw = totalSupplyRaw > 0n
    ? (reserve1Raw * lpBalanceRaw) / totalSupplyRaw
    : 0n;

  return {
    protocol: 'curve',
    chain: 'Arc Testnet',
    poolKey: pool.key,
    poolAddress: pool.address,
    poolSource: pool.source || 'verified_default',
    liquidityState: pool.liquidityState || 'unknown',
    lpToken: {
      symbol: `${pool.baseToken.symbol}/${pool.quoteToken.symbol} LP`,
      balance: formatUnits(lpBalanceRaw, 18),
      decimals: 18,
    },
    sharePct: shareBps,
    underlying: [
      {
        symbol: pool.baseToken.symbol,
        amount: formatUnits(underlyingBaseRaw, pool.baseToken.decimals || 6),
        decimals: pool.baseToken.decimals || 6,
      },
      {
        symbol: pool.quoteToken.symbol,
        amount: formatUnits(underlyingQuoteRaw, pool.quoteToken.decimals || 6),
        decimals: pool.quoteToken.decimals || 6,
      },
    ],
    virtualPrice: virtualPriceRaw ? ethers.formatUnits(virtualPriceRaw, 18) : null,
    updatedAt: new Date().toISOString(),
  };
}

async function getAgentPositions(agentId, userId) {
  const { rows } = await db.query(
    'SELECT id, wallet_address FROM agents WHERE id = $1 AND user_id = $2',
    [agentId, userId],
  );
  if (!rows.length) return null;

  const agent = rows[0];
  const snapshot = await getWalletPositions(agent.wallet_address);

  return {
    agentId: agent.id,
    ...snapshot,
  };
}

module.exports = {
  getAgentPositions,
  getWalletPositions,
};