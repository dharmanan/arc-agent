'use strict';

const { ethers } = require('ethers');
const db = require('../db');
const oracle = require('./oracle');
const { resolveCurvePool, resolveDirectSwapFallbackPool } = require('./oracle/pools');
const { getHealthyArcRpcProvider, safeArcRpcCall } = require('./arcProvider');

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

const POSITION_PRICE_SYMBOL_MAP = {
  CIRBTC: 'BTC',
  WUSDC: 'USDC',
  USYC: 'USDC',
};

const POSITION_PRICE_FALLBACK_USD = {
  USDC: 1,
  WUSDC: 1,
  USYC: 1,
  EURC: 1.08,
};

const LP_DAILY_TURNOVER_BASELINES = {
  curve: 0.22,
  uniswap_v2_like: 0.06,
  constant_product: 0.06,
};

const LP_MAX_APR_PCT = {
  curve: 18,
  uniswap_v2_like: 24,
  constant_product: 24,
};

const POSITION_SNAPSHOT_CACHE_TTL_MS = 10 * 60 * 1000;
const positionSnapshotCache = new Map();
const SUPPRESSED_POSITION_WARNING_TERMS = [
  'arc rpc unavailable for curve position read',
  'arc rpc unavailable for direct-pair position read',
  'rate limit',
  'too many requests',
  'exceeded maximum retry limit',
];

function getProvider() {
  return getHealthyArcRpcProvider('positions_provider');
}

function formatUnits(value, decimals) {
  return ethers.formatUnits(value, decimals);
}

function roundTo(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const scale = 10 ** digits;
  return Math.round(numeric * scale) / scale;
}

function toPriceLookupSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  return POSITION_PRICE_SYMBOL_MAP[normalized] || normalized;
}

async function getTokenPriceLookup(symbols = []) {
  const requestedSymbols = Array.from(new Set(
    symbols
      .map(toPriceLookupSymbol)
      .filter(Boolean),
  ));

  if (!requestedSymbols.length) return {};

  const prices = await oracle.getMultipleTokenPrices(requestedSymbols);
  return prices && typeof prices === 'object' ? prices : {};
}

function getUsdPriceForSymbol(symbol, priceLookup = {}) {
  const normalized = String(symbol || '').trim().toUpperCase();
  const lookupKey = toPriceLookupSymbol(normalized);
  const lookedUpPrice = Number(priceLookup?.[lookupKey]?.usdPrice);

  if (Number.isFinite(lookedUpPrice) && lookedUpPrice > 0) {
    return lookedUpPrice;
  }

  return POSITION_PRICE_FALLBACK_USD[normalized] ?? null;
}

function getPoolStateForPosition(position) {
  if (position?.protocol === 'curve') {
    const pool = resolveCurvePool(position.poolKey);
    if (!pool?.address) return null;
    return oracle.getCurvePoolState(pool);
  }

  const directPair = resolveDirectSwapFallbackPool(position?.poolKey);
  if (!directPair?.address) return null;
  return oracle.getConstantProductPoolState(directPair);
}

function buildPositionSnapshotCacheKey(walletAddress, poolKeys = []) {
  const normalizedWallet = String(walletAddress || '').toLowerCase();
  const normalizedPools = Array.isArray(poolKeys) && poolKeys.length
    ? poolKeys.map(key => String(key || '').trim().toUpperCase()).sort().join(',')
    : 'ALL_POOLS';

  return `${normalizedWallet}|${normalizedPools}`;
}

function cloneSnapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function readCachedPositionSnapshot(cacheKey) {
  const cached = positionSnapshotCache.get(cacheKey);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    positionSnapshotCache.delete(cacheKey);
    return null;
  }

  return cloneSnapshot(cached.payload);
}

function writeCachedPositionSnapshot(cacheKey, payload) {
  positionSnapshotCache.set(cacheKey, {
    expiresAt: Date.now() + POSITION_SNAPSHOT_CACHE_TTL_MS,
    payload: cloneSnapshot(payload),
  });
}

function shouldSuppressUserFacingPositionWarning(message) {
  const normalizedMessage = String(message || '').toLowerCase();
  if (!normalizedMessage) return false;

  return SUPPRESSED_POSITION_WARNING_TERMS.some(term => normalizedMessage.includes(term));
}

function getTurnoverDepthModifier(priceImpact10kPct) {
  const numeric = Number(priceImpact10kPct);
  if (!Number.isFinite(numeric)) return 1;
  if (numeric <= 0.15) return 1.35;
  if (numeric <= 0.5) return 1.15;
  if (numeric <= 1.5) return 1;
  if (numeric <= 3) return 0.75;
  return 0.5;
}

function estimateYieldMetrics(position, poolState, totalValueUsd) {
  const liquidityState = String(poolState?.liquidityState || position?.liquidityState || '').toLowerCase();
  const feePct = Number(poolState?.fee ?? position?.feePct ?? 0);
  const baselineTurnover = LP_DAILY_TURNOVER_BASELINES[position?.protocol] || LP_DAILY_TURNOVER_BASELINES.constant_product;

  if (!Number.isFinite(totalValueUsd) || totalValueUsd <= 0 || !Number.isFinite(feePct) || feePct <= 0 || liquidityState === 'empty') {
    return {
      aprPct: 0,
      apyPct: 0,
      dailyUsd: 0,
      weeklyUsd: 0,
      source: 'live_pool_fee_depth_heuristic',
      note: 'Approximate fee-only LP estimate is unavailable until the pool has live liquidity and a non-zero fee tier.',
      includesPriceExposure: false,
      turnoverRatio: 0,
      poolFeePct: roundTo(feePct, 4) || 0,
      priceImpact10kPct: roundTo(poolState?.priceImpact?.swap10k, 4),
    };
  }

  const turnoverRatio = baselineTurnover * getTurnoverDepthModifier(poolState?.priceImpact?.swap10k);
  const uncappedAprPct = feePct * turnoverRatio * 365;
  const aprPctCeiling = LP_MAX_APR_PCT[position?.protocol] || LP_MAX_APR_PCT.constant_product;
  const aprPct = Math.min(uncappedAprPct, aprPctCeiling);
  const apyPct = ((1 + (aprPct / 100) / 365) ** 365 - 1) * 100;
  const dailyUsd = totalValueUsd * (aprPct / 100) / 365;
  const weeklyUsd = dailyUsd * 7;

  return {
    aprPct: roundTo(aprPct, 2) || 0,
    apyPct: roundTo(apyPct, 2) || 0,
    dailyUsd: roundTo(dailyUsd, 4) || 0,
    weeklyUsd: roundTo(weeklyUsd, 4) || 0,
    source: 'live_pool_fee_depth_heuristic',
    note: 'Approximate fee-only LP estimate from the current pool fee tier and live depth proxy, with a protocol safety cap until a true volume feed is wired. This excludes token price movement, incentives and impermanent loss.',
    includesPriceExposure: false,
    turnoverRatio: roundTo(turnoverRatio * 100, 2) || 0,
    poolFeePct: roundTo(feePct, 4) || 0,
    priceImpact10kPct: roundTo(poolState?.priceImpact?.swap10k, 4),
    isCapped: uncappedAprPct > aprPct,
  };
}

async function enrichPosition(position, priceLookup) {
  let poolState = null;
  try {
    poolState = await getPoolStateForPosition(position);
  } catch {
    poolState = null;
  }

  const valuedUnderlying = (position.underlying || []).map((asset) => {
    const amount = Number(asset.amount || 0);
    const usdPrice = getUsdPriceForSymbol(asset.symbol, priceLookup);
    const usdValue = Number.isFinite(amount) && Number.isFinite(usdPrice)
      ? amount * usdPrice
      : null;

    return {
      ...asset,
      usdPrice: Number.isFinite(usdPrice) ? roundTo(usdPrice, 6) : null,
      usdValue: Number.isFinite(usdValue) ? roundTo(usdValue, 4) : null,
    };
  });

  const totalValueUsd = valuedUnderlying.reduce((sum, asset) => (
    sum + (Number.isFinite(asset.usdValue) ? Number(asset.usdValue) : 0)
  ), 0);

  const underlying = valuedUnderlying.map((asset) => ({
    ...asset,
    exposurePct: totalValueUsd > 0 && Number.isFinite(asset.usdValue)
      ? roundTo((Number(asset.usdValue) / totalValueUsd) * 100, 2)
      : null,
  }));

  return {
    ...position,
    underlying,
    valuation: {
      totalUsd: roundTo(totalValueUsd, 4) || 0,
      source: 'token_spot_lookup',
      note: 'Stable assets use spot/fallback prices; cirBTC is valued against BTC spot as a wrapped BTC proxy.',
    },
    analytics: {
      impliedRate: roundTo(poolState?.impliedRate, 6),
      inverseRate: roundTo(poolState?.inverseRate, 6),
      priceImpact1kPct: roundTo(poolState?.priceImpact?.swap1k, 4),
      priceImpact10kPct: roundTo(poolState?.priceImpact?.swap10k, 4),
      priceImpact50kPct: roundTo(poolState?.priceImpact?.swap50k, 4),
      poolFeePct: roundTo(poolState?.fee ?? position?.feePct, 4),
      liquidityState: poolState?.liquidityState || position?.liquidityState || null,
    },
    yieldMetrics: estimateYieldMetrics(position, poolState, totalValueUsd),
  };
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

function filterTrackedDirectPairPools(poolKeys = []) {
  const normalizedKeys = Array.isArray(poolKeys)
    ? poolKeys.map(key => String(key || '').trim().toUpperCase())
    : [];

  if (!normalizedKeys.length) {
    return getTrackedDirectPairPools();
  }

  return getTrackedDirectPairPools().filter(pool => normalizedKeys.includes(String(pool.key || '').toUpperCase()));
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

  const snapshotCacheKey = buildPositionSnapshotCacheKey(walletAddress, poolKeys);
  const provider = getProvider();
  const trackedPools = dedupeTrackedCurvePools(poolKeys);
  const trackedDirectPairs = filterTrackedDirectPairPools(poolKeys);

  const settled = await Promise.allSettled(
    trackedPools.map(pool => readCurvePosition(provider, walletAddress, pool)),
  );

  const directSettled = await Promise.allSettled(
    trackedDirectPairs.map(pool => readDirectPairPosition(provider, walletAddress, pool)),
  );

  const rawPositions = settled
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value)
    .concat(
      directSettled
        .filter(result => result.status === 'fulfilled' && result.value)
        .map(result => result.value),
    );

  const priceLookup = await getTokenPriceLookup(
    rawPositions.flatMap(position => (position.underlying || []).map(asset => asset.symbol)),
  ).catch(() => ({}));

  const positions = await Promise.all(
    rawPositions.map(position => enrichPosition(position, priceLookup).catch(() => position)),
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
    .filter(Boolean)
    .filter(warning => !shouldSuppressUserFacingPositionWarning(warning.message));

  const liveSnapshot = {
    walletAddress,
    positions,
    warnings,
    updatedAt: new Date().toISOString(),
    stale: false,
    dataFreshness: 'live',
  };

  if (positions.length > 0) {
    writeCachedPositionSnapshot(snapshotCacheKey, {
      walletAddress,
      positions,
      updatedAt: liveSnapshot.updatedAt,
    });
    return liveSnapshot;
  }

  const cachedSnapshot = readCachedPositionSnapshot(snapshotCacheKey);
  if (cachedSnapshot) {
    return {
      walletAddress,
      positions: cachedSnapshot.positions || [],
      warnings: [],
      updatedAt: cachedSnapshot.updatedAt || liveSnapshot.updatedAt,
      stale: true,
      dataFreshness: 'cached',
    };
  }

  return liveSnapshot;
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
  const readResult = await safeArcRpcCall('positions_direct_pair_read', async () => {
    const contract = new ethers.Contract(pool.address, V2_PAIR_POSITION_ABI, provider);
    const [lpBalanceRaw, totalSupplyRaw, token0, token1, reserves] = await Promise.all([
      contract.balanceOf(walletAddress),
      contract.totalSupply(),
      contract.token0(),
      contract.token1(),
      contract.getReserves(),
    ]);

    return { lpBalanceRaw, totalSupplyRaw, token0, token1, reserves };
  }, null);

  if (!readResult) {
    return null;
  }

  const { lpBalanceRaw, totalSupplyRaw, token0, token1, reserves } = readResult;

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
  const readResult = await safeArcRpcCall('positions_curve_read', async () => {
    const contract = new ethers.Contract(pool.address, CURVE_POSITION_ABI, provider);
    const [lpBalanceRaw, totalSupplyRaw, reserve0Raw, reserve1Raw, virtualPriceRaw] = await Promise.all([
      contract.balanceOf(walletAddress),
      contract.totalSupply(),
      contract.balances(pool.baseToken.index),
      contract.balances(pool.quoteToken.index),
      contract.get_virtual_price().catch(() => null),
    ]);

    return { lpBalanceRaw, totalSupplyRaw, reserve0Raw, reserve1Raw, virtualPriceRaw };
  }, null);

  if (!readResult) {
    return null;
  }

  const { lpBalanceRaw, totalSupplyRaw, reserve0Raw, reserve1Raw, virtualPriceRaw } = readResult;

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