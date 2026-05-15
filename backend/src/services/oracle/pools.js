'use strict';

const TOKENS = {
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  CIRBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
  WUSDC: '0x911b4000D3422F482F4062a913885f7b035382Df',
  USYC: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
};

const VERIFIED_CURVE_POOLS = {
  'USDC-EURC': {
    envVar: 'CURVE_USDC_EURC_POOL',
    address: '0x2D84D79C852f6842AbE0304b70bBaA1506AdD457',
    baseToken: { symbol: 'USDC', address: TOKENS.USDC, decimals: 6, index: 0 },
    quoteToken: { symbol: 'EURC', address: TOKENS.EURC, decimals: 6, index: 1 },
    liquidityState: 'active',
  },
  'EURC-USDC': {
    envVar: 'CURVE_USDC_EURC_POOL',
    address: '0x2D84D79C852f6842AbE0304b70bBaA1506AdD457',
    baseToken: { symbol: 'EURC', address: TOKENS.EURC, decimals: 6, index: 1 },
    quoteToken: { symbol: 'USDC', address: TOKENS.USDC, decimals: 6, index: 0 },
    liquidityState: 'active',
  },
  'WUSDC-EURC': {
    envVar: 'CURVE_WUSDC_EURC_POOL',
    address: '0x942644106B073E30D72c2C5D7529D5C296ea91ab',
    baseToken: { symbol: 'WUSDC', address: TOKENS.WUSDC, decimals: 18, index: 0 },
    quoteToken: { symbol: 'EURC', address: TOKENS.EURC, decimals: 6, index: 1 },
    liquidityState: 'active',
  },
  'EURC-WUSDC': {
    envVar: 'CURVE_WUSDC_EURC_POOL',
    address: '0x942644106B073E30D72c2C5D7529D5C296ea91ab',
    baseToken: { symbol: 'EURC', address: TOKENS.EURC, decimals: 6, index: 1 },
    quoteToken: { symbol: 'WUSDC', address: TOKENS.WUSDC, decimals: 18, index: 0 },
    liquidityState: 'active',
  },
  'WUSDC-USDC': {
    envVar: 'CURVE_WUSDC_USDC_POOL',
    address: '0xbbc2A38aB48fA953eC68Ee6115Bd518D3A226f6e',
    baseToken: { symbol: 'WUSDC', address: TOKENS.WUSDC, decimals: 18, index: 0 },
    quoteToken: { symbol: 'USDC', address: TOKENS.USDC, decimals: 6, index: 1 },
    liquidityState: 'active',
  },
  'USDC-WUSDC': {
    envVar: 'CURVE_WUSDC_USDC_POOL',
    address: '0xbbc2A38aB48fA953eC68Ee6115Bd518D3A226f6e',
    baseToken: { symbol: 'USDC', address: TOKENS.USDC, decimals: 6, index: 1 },
    quoteToken: { symbol: 'WUSDC', address: TOKENS.WUSDC, decimals: 18, index: 0 },
    liquidityState: 'active',
  },
  'USDC-USYC': {
    envVar: 'CURVE_USDC_USYC_POOL',
    address: '0x348982a42850DFF2354f65122745cE6B714275f2',
    baseToken: { symbol: 'USDC', address: TOKENS.USDC, decimals: 6, index: 0 },
    quoteToken: { symbol: 'USYC', address: TOKENS.USYC, decimals: 6, index: 1 },
    liquidityState: 'empty',
  },
  'USYC-USDC': {
    envVar: 'CURVE_USDC_USYC_POOL',
    address: '0x348982a42850DFF2354f65122745cE6B714275f2',
    baseToken: { symbol: 'USYC', address: TOKENS.USYC, decimals: 6, index: 1 },
    quoteToken: { symbol: 'USDC', address: TOKENS.USDC, decimals: 6, index: 0 },
    liquidityState: 'empty',
  },
};

const EXPERIMENTAL_EXTERNAL_POOLS = {
  uniswap_v2_like: {
    'QTM-WUSDC': {
      address: '0xD330Ae5713AF6507f43420e85C941a68BfbaD9D0',
      protocol: 'uniswap_v2_like',
      poolModel: 'constant_product',
      feePct: 0.3,
      note: 'Experimental external venue snapshot from a filtered whitelist.',
      baseToken: { symbol: 'QTM', address: '0xCD304d2A421BFEd31d45f0054AF8E8a6a4cF3EaE', decimals: 18 },
      quoteToken: { symbol: 'WUSDC', address: TOKENS.WUSDC, decimals: 6 },
    },
    'BERA-WETH': {
      address: '0x26CB7a91AfdF38eeD6681585F80ee88ac1B90cb3',
      protocol: 'uniswap_v2_like',
      poolModel: 'constant_product',
      feePct: 0.3,
      note: 'Experimental external venue snapshot from a filtered whitelist.',
      baseToken: { symbol: 'BERA', address: '0xA95648526E7Bac1Bf6FDf70e84A59EA180D913d8', decimals: 18 },
      quoteToken: { symbol: 'WETH', address: '0xAad965DAD0eF78198426abD83339E61713188496', decimals: 18 },
    },
  },
  arcfx: {
    'MUSDC-MEURC': {
      address: '0x0183dd0195595757d187EEdB9C83d33B1C48235E',
      protocol: 'arcfx',
      poolModel: 'constant_product',
      feePct: 0.3,
      note: 'Experimental ArcFX pool snapshot from a filtered stable/mock-stable whitelist.',
      baseToken: { symbol: 'mUSDC', address: '0xdfab34D7943828DC147c8e9B5998a565c627e419', decimals: 6 },
      quoteToken: { symbol: 'mEURC', address: '0x51e70D96EeDF1f7540A5783BB93cA3D335E97e5C', decimals: 6 },
    },
  },
};

const ENV_DIRECT_EXTERNAL_POOLS = {
  uniswap_v2_like: {
    'CIRBTC-USDC': {
      envVar: 'ARC_V2_CIRBTC_USDC_PAIR',
      protocol: 'uniswap_v2_like',
      poolModel: 'constant_product',
      feePct: 0.3,
      note: 'Env-configured direct cirBTC/USDC pool for swap fallback and oracle visibility.',
      baseToken: { symbol: 'cirBTC', address: TOKENS.CIRBTC, decimals: 8 },
      quoteToken: { symbol: 'USDC', address: TOKENS.USDC, decimals: 6 },
    },
    'USDC-CIRBTC': {
      envVar: 'ARC_V2_CIRBTC_USDC_PAIR',
      protocol: 'uniswap_v2_like',
      poolModel: 'constant_product',
      feePct: 0.3,
      note: 'Env-configured direct USDC/cirBTC pool for swap fallback and oracle visibility.',
      baseToken: { symbol: 'USDC', address: TOKENS.USDC, decimals: 6 },
      quoteToken: { symbol: 'cirBTC', address: TOKENS.CIRBTC, decimals: 8 },
    },
    'CIRBTC-EURC': {
      envVar: 'ARC_V2_CIRBTC_EURC_PAIR',
      protocol: 'uniswap_v2_like',
      poolModel: 'constant_product',
      feePct: 0.3,
      note: 'Env-configured direct cirBTC/EURC pool for swap fallback and oracle visibility.',
      baseToken: { symbol: 'cirBTC', address: TOKENS.CIRBTC, decimals: 8 },
      quoteToken: { symbol: 'EURC', address: TOKENS.EURC, decimals: 6 },
    },
    'EURC-CIRBTC': {
      envVar: 'ARC_V2_CIRBTC_EURC_PAIR',
      protocol: 'uniswap_v2_like',
      poolModel: 'constant_product',
      feePct: 0.3,
      note: 'Env-configured direct EURC/cirBTC pool for swap fallback and oracle visibility.',
      baseToken: { symbol: 'EURC', address: TOKENS.EURC, decimals: 6 },
      quoteToken: { symbol: 'cirBTC', address: TOKENS.CIRBTC, decimals: 8 },
    },
  },
};

function normalizeCurvePoolKey(poolKey = 'USDC-EURC') {
  return String(poolKey || 'USDC-EURC')
    .trim()
    .toUpperCase()
    .replace(/\//g, '-');
}

function normalizePoolVenue(venue = 'curve') {
  return String(venue || 'curve')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

function resolveCurvePool(poolKey = 'USDC-EURC') {
  const normalizedKey = normalizeCurvePoolKey(poolKey);
  const definition = VERIFIED_CURVE_POOLS[normalizedKey];

  if (!definition) {
    return null;
  }

  const envAddress = definition.envVar ? process.env[definition.envVar] : null;

  return {
    key: normalizedKey,
    requestedKey: normalizedKey,
    venue: 'curve',
    protocol: 'curve',
    poolModel: 'stableswap',
    address: envAddress || definition.address,
    source: envAddress ? 'env' : 'verified_default',
    liquidityState: definition.liquidityState,
    baseToken: { ...definition.baseToken },
    quoteToken: { ...definition.quoteToken },
  };
}

function resolveEnvExternalPool(poolKey = 'CIRBTC-USDC', venue = 'uniswap_v2_like') {
  const normalizedVenue = normalizePoolVenue(venue);
  const normalizedKey = normalizeCurvePoolKey(poolKey);
  const definition = ENV_DIRECT_EXTERNAL_POOLS[normalizedVenue]?.[normalizedKey];

  if (!definition) {
    return null;
  }

  const envAddress = definition.envVar ? process.env[definition.envVar] : null;
  if (!envAddress) {
    return null;
  }

  return {
    key: normalizedKey,
    requestedKey: normalizedKey,
    venue: normalizedVenue,
    protocol: definition.protocol,
    poolModel: definition.poolModel,
    address: envAddress,
    source: 'env',
    liquidityState: 'unknown',
    feePct: definition.feePct,
    note: definition.note,
    baseToken: { ...definition.baseToken },
    quoteToken: { ...definition.quoteToken },
  };
}

function resolveDirectSwapFallbackPool(poolKey = 'USDC-EURC') {
  const curvePool = resolveCurvePool(poolKey);
  if (curvePool) {
    return curvePool;
  }

  return resolveEnvExternalPool(poolKey, 'uniswap_v2_like');
}

function resolveOraclePoolStateTarget(poolKey = 'USDC-EURC', venue = 'curve') {
  const normalizedVenue = normalizePoolVenue(venue);

  if (normalizedVenue === 'curve') {
    return resolveCurvePool(poolKey);
  }

  const envExternalPool = resolveEnvExternalPool(poolKey, normalizedVenue);
  if (envExternalPool) {
    return envExternalPool;
  }

  const normalizedKey = normalizeCurvePoolKey(poolKey);
  const definition = EXPERIMENTAL_EXTERNAL_POOLS[normalizedVenue]?.[normalizedKey];

  if (!definition) {
    return null;
  }

  return {
    key: normalizedKey,
    requestedKey: normalizedKey,
    venue: normalizedVenue,
    protocol: definition.protocol,
    poolModel: definition.poolModel,
    address: definition.address,
    source: 'experimental_whitelist',
    liquidityState: 'active',
    feePct: definition.feePct,
    note: definition.note,
    baseToken: { ...definition.baseToken },
    quoteToken: { ...definition.quoteToken },
  };
}

module.exports = {
  EXPERIMENTAL_EXTERNAL_POOLS,
  ENV_DIRECT_EXTERNAL_POOLS,
  TOKENS,
  normalizeCurvePoolKey,
  normalizePoolVenue,
  resolveDirectSwapFallbackPool,
  resolveOraclePoolStateTarget,
  resolveCurvePool,
};