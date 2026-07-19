'use strict';
/**
 * GET /api/oracle/stablecoin-fx?pair=EURC/USDC   — forex rate vs pool rate comparison
 * GET /api/oracle/pool-state?pool=USDC-EURC&venue=curve — on-chain pool state
 * GET /api/oracle/yield-rank?asset=USDC           — DeFi yield ranking
 * GET /api/oracle/arb-signal?strategy=stablecoin_fx — arbitrage opportunity signal
 * GET /api/oracle/status                          — service health + cache stats
 *
 * All endpoints require authentication.
 * oracle_enabled flag is checked only for /arb-signal (heavier, opt-in).
 * Other endpoints are informational (read-only, low cost).
 */
const router          = require('express').Router();
const rateLimit       = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const oracle          = require('../services/oracle');
const protocols       = require('../services/protocols');
const agentWalletService = require('../services/agentWalletService');
const agentService    = require('../services/agentService');
const db              = require('../db');
const { ORACLE_PRICES } = require('../services/oracle/pricing');
const { getPredictionMarketPulse, getEventOddsCompare } = require('../services/predictionMarketService');
const { getWalletAssetSnapshot } = require('../services/walletSnapshotService');
const {
  createGatewayRouteConfig,
  createGatewaySellerMiddleware,
  getGatewaySellerSummary,
} = require('../services/agenticEconomy/gatewaySeller');
const { getGatewayFacilitatorSummary } = require('../services/agenticEconomy/gatewayFacilitator');
const {
  depositGatewayBalanceForAgent,
  getAgentGatewayBalances,
  getGatewayBuyerSummary,
} = require('../services/agenticEconomy/gatewayBuyer');
const { getTaskEconomyConfigSummary } = require('../services/agenticEconomy/taskEconomyService');
const { getJobEconomyConfigSummary } = require('../services/agenticEconomy/jobEconomyService');
const { logOracleGateway } = require('../services/agenticEconomy/logger');

// Verified Arc Curve pools fall back to known-good live addresses when envs are absent.
const ORACLE_PAY_ADDRESS = process.env.ORACLE_PAY_ADDRESS || null;
const ORACLE_BUYER_DOCS_URL = process.env.ORACLE_BUYER_DOCS_URL
  || 'https://arcmachina.xyz/oracle-public-buyer-guide.html';
const ORACLE_BUYER_MACHINE_DOCS_URL = process.env.ORACLE_BUYER_MACHINE_DOCS_URL
  || 'https://arcmachina.xyz/oracle-public-buyer-manifest.json';
const ORACLE_BUYER_EXAMPLE_URL = process.env.ORACLE_BUYER_EXAMPLE_URL
  || 'https://arcmachina.xyz/downloads/oraclePublicBuyerExample.js';
const ORACLE_BUYER_HELPER_URL = process.env.ORACLE_BUYER_HELPER_URL
  || 'https://arcmachina.xyz/downloads/arcOracleBuyerHelper.js';
const ORACLE_MANUAL_GATEWAY_FUND_USDC = process.env.ORACLE_MANUAL_GATEWAY_FUND_USDC || '1';
const USDC_ADDRESS = process.env.USDC_ADDRESS_ARC || process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const EURC_ADDRESS = process.env.EURC_ADDRESS_ARC || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const WUSDC_ADDRESS = process.env.WUSDC_ADDRESS_ARC || '0x911b4000D3422F482F4062a913885f7b035382Df';
const ORACLE_PEG_MONITOR_SUPPORTED_ASSETS = ['USDC', 'EURC', 'USDT'];
const ORACLE_RESERVE_STATE_ASSET_MAP = Object.freeze({
  USDC: { address: USDC_ADDRESS, decimals: 6, market: 'aave_v3' },
  EURC: { address: EURC_ADDRESS, decimals: 6, market: 'aave_v3' },
  WUSDC: { address: WUSDC_ADDRESS, decimals: 18, market: 'aave_v3' },
});
const ORACLE_RESERVE_STATE_SUPPORTED_ASSETS = Object.keys(ORACLE_RESERVE_STATE_ASSET_MAP);
const ORACLE_PROTOCOL_TVL_SUPPORTED_PROTOCOLS = ['aave', 'morpho', 'maple', 'centrifuge', 'superform'];
const ORACLE_POOL_COMPARE_DEFAULT_TARGETS = ['curve:USDC-EURC', 'curve:EURC-WUSDC', 'uniswap_v2_like:QTM-WUSDC'];
const ORACLE_ARB_SCAN_MULTI_DEFAULT_TARGETS = ['curve:EURC-USDC', 'curve:EURC-WUSDC', 'curve:WUSDC-USDC'];
const DEFAULT_ORACLE_ARB_BRIDGE_FEE_USDC = 0.1;
const DEFAULT_ORACLE_ARB_GAS_ESTIMATE_USDC = 0.15;
const DEFAULT_ORACLE_ARB_EXIT_FEE_PCT = 0.3;
const ORACLE_PUBLIC_RATE_LIMIT_WINDOW_MS = Math.max(parseInt(process.env.ORACLE_PUBLIC_RATE_LIMIT_WINDOW_MS || '60000', 10), 1000);
const ORACLE_PUBLIC_RATE_LIMIT_MAX = Math.max(parseInt(process.env.ORACLE_PUBLIC_RATE_LIMIT_MAX || '30', 10), 1);
const ORACLE_PUBLIC_MAX_QUERY_KEYS = Math.max(parseInt(process.env.ORACLE_PUBLIC_MAX_QUERY_KEYS || '4', 10), 1);
const ORACLE_PUBLIC_MAX_QUERY_LENGTH = Math.max(parseInt(process.env.ORACLE_PUBLIC_MAX_QUERY_LENGTH || '180', 10), 32);
const ORACLE_PUBLIC_BLOCKED_UA_PATTERNS = (process.env.ORACLE_PUBLIC_BLOCKED_UA_PATTERNS
  || 'sqlmap,nikto,masscan,nessus,acunetix,gobuster,dirbuster,zgrab')
  .split(',')
  .map(item => item.trim().toLowerCase())
  .filter(Boolean);
const ORACLE_PUBLIC_RESERVE_STATE_ENABLED = Boolean(String(process.env.AAVE_POOL_ADDRESS || '').trim());
const ORACLE_PUBLIC_ENDPOINTS = [
  {
    key: 'stablecoin-fx',
    title: 'Stablecoin FX',
    path: '/api/oracle/public/stablecoin-fx',
    priceUsdc: ORACLE_PRICES['stablecoin-fx'],
    description: 'Forex rate, USDC peg, and live Arc Curve comparison for supported stablecoin pairs.',
    supportedPairs: ['EURC/USDC', 'EURC/WUSDC'],
    exampleQueries: [
      '/api/oracle/public/stablecoin-fx?pair=EURC/USDC',
      '/api/oracle/public/stablecoin-fx?pair=EURC/WUSDC',
    ],
  },
  {
    key: 'pool-state',
    title: 'Pool State',
    path: '/api/oracle/public/pool-state',
    priceUsdc: ORACLE_PRICES['pool-state'],
    description: 'Live Curve and filtered external-pool health, reserves and implied pricing.',
    supportedVenues: ['curve', 'uniswap_v2_like', 'arcfx'],
    supportedPools: ['USDC-EURC', 'EURC-USDC', 'EURC-WUSDC', 'WUSDC-EURC', 'WUSDC-USDC', 'USDC-WUSDC', 'USDC-USYC', 'USYC-USDC', 'QTM-WUSDC', 'BERA-WETH', 'MUSDC-MEURC'],
    exampleQueries: [
      '/api/oracle/public/pool-state?pool=USDC-EURC&venue=curve',
      '/api/oracle/public/pool-state?pool=EURC-WUSDC&venue=curve',
      '/api/oracle/public/pool-state?pool=QTM-WUSDC&venue=uniswap_v2_like',
      '/api/oracle/public/pool-state?pool=MUSDC-MEURC&venue=arcfx',
    ],
  },
  {
    key: 'peg-monitor',
    title: 'Peg Monitor',
    path: '/api/oracle/public/peg-monitor',
    priceUsdc: ORACLE_PRICES['peg-monitor'],
    description: 'Spot peg health for the main stablecoins covered by the oracle catalog.',
    supportedPairs: ORACLE_PEG_MONITOR_SUPPORTED_ASSETS,
    exampleQueries: [
      '/api/oracle/public/peg-monitor?assets=USDC,EURC,USDT',
    ],
  },
  ...(ORACLE_PUBLIC_RESERVE_STATE_ENABLED
    ? [{
        key: 'reserve-state',
        title: 'Reserve State',
        path: '/api/oracle/public/reserve-state',
        priceUsdc: ORACLE_PRICES['reserve-state'],
        description: 'Aave-style reserve APY and utilization surface for the supported stablecoin watchlist.',
        supportedPairs: ORACLE_RESERVE_STATE_SUPPORTED_ASSETS,
        exampleQueries: [
          '/api/oracle/public/reserve-state?assets=USDC,EURC,WUSDC',
        ],
      }]
    : []),
  {
    key: 'pool-compare',
    title: 'Pool Compare',
    path: '/api/oracle/public/pool-compare',
    priceUsdc: ORACLE_PRICES['pool-compare'],
    description: 'Side-by-side implied-rate, fee and liquidity comparison across multiple Oracle pool targets.',
    supportedVenues: ['curve', 'uniswap_v2_like', 'arcfx'],
    supportedPools: ['USDC-EURC', 'EURC-WUSDC', 'QTM-WUSDC', 'MUSDC-MEURC'],
    exampleQueries: [
      '/api/oracle/public/pool-compare?targets=curve:USDC-EURC,curve:EURC-WUSDC,uniswap_v2_like:QTM-WUSDC',
    ],
  },
  {
    key: 'wallet-asset-snapshot',
    title: 'Wallet Asset Snapshot',
    path: '/api/oracle/public/wallet-asset-snapshot',
    priceUsdc: ORACLE_PRICES['wallet-asset-snapshot'],
    description: 'Arc wallet balances, live LP positions, and a yesterday UTC activity recap when the wallet is already indexed as an Arc agent.',
    exampleQueries: [
      '/api/oracle/public/wallet-asset-snapshot?walletAddress=0x000000000000000000000000000000000000dEaD',
    ],
  },
  {
    key: 'prediction-market-check',
    title: 'Prediction Market Check',
    path: '/api/oracle/public/prediction-market-check',
    priceUsdc: ORACLE_PRICES['prediction-market-check'],
    description: 'Live Polymarket-based crypto market regime summary with liquidity, movement, and Arc action guidance.',
    supportedTopics: ['crypto', 'bitcoin', 'ethereum'],
    exampleQueries: [
      '/api/oracle/public/prediction-market-check?topic=crypto',
      '/api/oracle/public/prediction-market-check?topic=bitcoin&limit=5',
    ],
  },
  {
    key: 'event-odds-compare',
    title: 'Event Odds Compare',
    path: '/api/oracle/public/event-odds-compare',
    priceUsdc: ORACLE_PRICES['event-odds-compare'],
    description: 'Live Polymarket comparison between two topic clusters, scored as aligned, split or divergent with Arc action guidance.',
    supportedTopics: ['bitcoin', 'ethereum', 'crypto'],
    exampleQueries: [
      '/api/oracle/public/event-odds-compare?primaryTopic=bitcoin&secondaryTopic=ethereum',
      '/api/oracle/public/event-odds-compare?primaryTopic=crypto&secondaryTopic=ethereum&limit=4',
    ],
  },
  {
    key: 'arb-signal',
    title: 'Arb Signal',
    path: '/api/oracle/public/arb-signal',
    priceUsdc: ORACLE_PRICES['arb-signal'],
    description: 'Stablecoin arbitrage summary with spread and confidence data.',
  },
  {
    key: 'arb-scan-multi',
    title: 'Arb Scan Multi',
    path: '/api/oracle/public/arb-scan-multi',
    priceUsdc: ORACLE_PRICES['arb-scan-multi'],
    description: 'Multi-lane stablecoin arbitrage scan across supported Curve-style oracle targets.',
    supportedVenues: ['curve'],
    supportedPools: ['EURC-USDC', 'EURC-WUSDC', 'WUSDC-USDC'],
    exampleQueries: [
      '/api/oracle/public/arb-scan-multi?targets=curve:EURC-USDC,curve:EURC-WUSDC,curve:WUSDC-USDC',
    ],
  },
];
const ORACLE_EXTERNAL_DEX_CATALOG = {
  curve: {
    verifiedLivePools: ['USDC-EURC', 'EURC-USDC', 'EURC-WUSDC', 'WUSDC-EURC', 'WUSDC-USDC', 'USDC-WUSDC'],
    mappedButEmptyPools: ['USDC-USYC', 'USYC-USDC'],
    note: 'Canonical stablecoin oracle lanes stay on verified Arc Curve pools.',
  },
  uniswapV2Like: {
    discovery: 'ArcScan search plus on-chain allPairs scan',
    factories: [
      {
        address: '0x9442cb5b2bBF2009b1933c762f5B89eDCD3eaE08',
        activePoolCount: 20,
        note: 'Active V2-style venue, but only filtered whitelist pairs are surfaced by pool-state.',
      },
    ],
    whitelistedPools: [
      {
        pair: 'QTM/WUSDC',
        key: 'QTM-WUSDC',
        address: '0xD330Ae5713AF6507f43420e85C941a68BfbaD9D0',
        stableSideLiquidity: 5795.621151,
      },
      {
        pair: 'BERA/WETH',
        key: 'BERA-WETH',
        address: '0x26CB7a91AfdF38eeD6681585F80ee88ac1B90cb3',
        stableSideLiquidity: null,
      },
    ],
    filteredOutReason: 'Long-tail or meme-style pairs without a stable/known-asset whitelist match are excluded from pool-state.',
    note: 'No cirBTC or canonical USDC/EURC pool was found in the scanned V2-style factories.',
  },
  arcFx: {
    whitelistedPools: [
      {
        pair: 'mUSDC/mEURC',
        key: 'MUSDC-MEURC',
        address: '0x0183dd0195595757d187EEdB9C83d33B1C48235E',
        reserve0: 566199.474901,
        reserve1: 526280.783433,
        note: 'Active mock-stable pool observed via ArcScan LP search.',
      },
    ],
    note: 'ArcFX surfaced an active mock-stable lane; sampled ArcFX USDC/EURC LP entries were present but empty.',
  },
  aaveLike: {
    explorerNamesVisible: true,
    sampledAddressesHaveCodeOnArc: false,
    note: 'ArcScan search can return Aave-like metadata tags, but sampled addresses did not have bytecode on Arc.',
  },
};

function _roundTo(value, digits) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function _derivePoolFallbackRate(baseSymbol, quoteSymbol) {
  const base = String(baseSymbol || '').toUpperCase();
  const quote = String(quoteSymbol || '').toUpperCase();

  if (base === 'EURC' && (quote === 'USDC' || quote === 'WUSDC')) return 1.08;
  if ((base === 'USDC' || base === 'WUSDC') && quote === 'EURC') return 0.9259;
  return 1;
}

function _buildOraclePoolStateFallback(pool, {
  fallbackReason = 'pool_state_unavailable',
  source = 'empty_fallback',
} = {}) {
  const baseSymbol = pool?.baseToken?.symbol || 'TOKEN0';
  const quoteSymbol = pool?.quoteToken?.symbol || 'TOKEN1';
  const impliedRate = _derivePoolFallbackRate(baseSymbol, quoteSymbol);

  const mock = oracle.getMockPoolState(pool?.key || `${baseSymbol}-${quoteSymbol}`, impliedRate);

  return {
    ...mock,
    poolAddress: pool?.address || mock.poolAddress,
    protocol: pool?.protocol || mock.protocol,
    venue: pool?.venue || pool?.protocol || mock.protocol,
    baseToken: {
      symbol: baseSymbol,
      address: pool?.baseToken?.address || null,
      decimals: Number(pool?.baseToken?.decimals || 18),
    },
    quoteToken: {
      symbol: quoteSymbol,
      address: pool?.quoteToken?.address || null,
      decimals: Number(pool?.quoteToken?.decimals || 18),
    },
    reserves: {
      token0: Number(mock?.reserves?.token0 || 0),
      token1: Number(mock?.reserves?.token1 || 0),
    },
    priceImpact: {
      swap1k: Number(mock?.priceImpact?.swap1k || 0),
      swap10k: Number(mock?.priceImpact?.swap10k || 0),
      swap50k: Number(mock?.priceImpact?.swap50k || 0),
    },
    source,
    isFallback: true,
    fallbackReason,
    liquidityState: pool?.liquidityState || 'unknown',
    rateUnit: `${quoteSymbol} per ${baseSymbol}`,
    fetchedAt: new Date().toISOString(),
  };
}

function _normalizeCsvValues(value, fallbackValues) {
  const rawValues = Array.isArray(value)
    ? value.flatMap(item => String(item).split(','))
    : String(value || '').split(',');

  const normalized = rawValues
    .map(item => String(item || '').trim())
    .filter(Boolean);

  return normalized.length > 0 ? normalized : [...fallbackValues];
}

function _normalizePegMonitorAssets(value) {
  const requested = _normalizeCsvValues(value, ORACLE_PEG_MONITOR_SUPPORTED_ASSETS)
    .map(item => item.toUpperCase());

  const filtered = requested.filter(asset => ORACLE_PEG_MONITOR_SUPPORTED_ASSETS.includes(asset));
  return [...new Set(filtered.length > 0 ? filtered : ORACLE_PEG_MONITOR_SUPPORTED_ASSETS)];
}

function _normalizeReserveStateAssets(value) {
  const requested = _normalizeCsvValues(value, ORACLE_RESERVE_STATE_SUPPORTED_ASSETS)
    .map(item => item.toUpperCase());

  const filtered = requested.filter(asset => ORACLE_RESERVE_STATE_SUPPORTED_ASSETS.includes(asset));
  return [...new Set(filtered.length > 0 ? filtered : ORACLE_RESERVE_STATE_SUPPORTED_ASSETS)];
}

function _normalizeProtocolList(value) {
  const requested = _normalizeCsvValues(value, ORACLE_PROTOCOL_TVL_SUPPORTED_PROTOCOLS)
    .map(item => item.toLowerCase());

  const filtered = requested.filter(protocol => ORACLE_PROTOCOL_TVL_SUPPORTED_PROTOCOLS.includes(protocol));
  return [...new Set(filtered.length > 0 ? filtered : ORACLE_PROTOCOL_TVL_SUPPORTED_PROTOCOLS)];
}

function _normalizePoolCompareTargets(value) {
  const requested = _normalizeCsvValues(value, ORACLE_POOL_COMPARE_DEFAULT_TARGETS).slice(0, 5);

  return requested.map((item) => {
    const [maybeVenue, ...poolParts] = String(item || '').split(':');
    if (poolParts.length === 0) {
      return {
        venue: 'curve',
        poolKey: oracle.normalizeCurvePoolKey(maybeVenue),
      };
    }

    return {
      venue: oracle.normalizePoolVenue(maybeVenue),
      poolKey: oracle.normalizeCurvePoolKey(poolParts.join(':')),
    };
  });
}

function _normalizeArbScanTargets(value) {
  const requested = _normalizeCsvValues(value, ORACLE_ARB_SCAN_MULTI_DEFAULT_TARGETS).slice(0, 5);

  return requested.map((item) => {
    const [maybeVenue, ...poolParts] = String(item || '').split(':');
    if (poolParts.length === 0) {
      return {
        venue: 'curve',
        poolKey: oracle.normalizeCurvePoolKey(maybeVenue),
      };
    }

    return {
      venue: oracle.normalizePoolVenue(maybeVenue),
      poolKey: oracle.normalizeCurvePoolKey(poolParts.join(':')),
    };
  });
}

function _normalizePublicOracleQueryValue(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) return null;
    return String(value[0] || '').trim();
  }

  return String(value || '').trim();
}

function _readPositiveOracleNumberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function _rejectPublicOracleRequest(req, res, statusCode, error, detail) {
  const meta = {
    error,
    detail: detail || null,
    statusCode,
    path: req.originalUrl || req.path || null,
    method: req.method,
    ip: req.ip || null,
  };
  const userAgent = req.get('user-agent') || null;

  if (userAgent) {
    meta.userAgent = userAgent;
  }

  oracle.recordOracleSignal('public_request_rejected', meta);
  logOracleGateway(statusCode >= 429 ? 'warn' : 'info', 'Oracle public request rejected', meta);

  return res.status(statusCode).json({
    error,
    detail: detail || null,
    sellerMode: 'circle_gateway',
  });
}

const PUBLIC_ORACLE_QUERY_RULES = Object.freeze({
  'stablecoin-fx': {
    pair: { maxLength: 24, pattern: /^[A-Za-z0-9]{2,12}\/[A-Za-z0-9]{2,12}$/ },
  },
  'pool-state': {
    pool: { maxLength: 40, pattern: /^[A-Za-z0-9_-]{3,40}$/ },
    venue: { maxLength: 20, allowedValues: ['curve', 'uniswap_v2_like', 'arcfx'] },
  },
  'peg-monitor': {
    assets: { maxLength: 48, pattern: /^[A-Za-z0-9_,-]{3,48}$/ },
  },
  'reserve-state': {
    assets: { maxLength: 48, pattern: /^[A-Za-z0-9_,-]{3,48}$/ },
  },
  'pool-compare': {
    targets: { maxLength: 180, pattern: /^[A-Za-z0-9:_,-]{3,180}$/ },
  },
  'wallet-asset-snapshot': {
    walletAddress: { maxLength: 42, pattern: /^0x[a-fA-F0-9]{40}$/ },
  },
  'prediction-market-check': {
    topic: { maxLength: 48, pattern: /^[A-Za-z0-9 _-]{2,48}$/ },
    limit: { maxLength: 1, pattern: /^[1-8]$/ },
  },
  'event-odds-compare': {
    primaryTopic: { maxLength: 48, pattern: /^[A-Za-z0-9 _-]{2,48}$/ },
    secondaryTopic: { maxLength: 48, pattern: /^[A-Za-z0-9 _-]{2,48}$/ },
    limit: { maxLength: 1, pattern: /^[1-8]$/ },
  },
  'arb-signal': {
    strategy: { maxLength: 32, allowedValues: ['stablecoin_fx'] },
  },
  'arb-scan-multi': {
    targets: { maxLength: 180, pattern: /^[A-Za-z0-9:_,-]{3,180}$/ },
  },
  revenue: {},
});

const publicOracleRateLimit = rateLimit({
  windowMs: ORACLE_PUBLIC_RATE_LIMIT_WINDOW_MS,
  max: ORACLE_PUBLIC_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => _rejectPublicOracleRequest(
    req,
    res,
    429,
    'oracle_public_rate_limit_reached',
    `Retry after ${Math.ceil(options.windowMs / 1000)} seconds.`,
  ),
});

function _publicOracleAbuseGuard(req, res, next) {
  const queryKeys = Object.keys(req.query || {});
  const rawQuery = (req.originalUrl || '').split('?')[1] || '';
  const userAgent = String(req.get('user-agent') || '').toLowerCase();

  if (queryKeys.length > ORACLE_PUBLIC_MAX_QUERY_KEYS) {
    return _rejectPublicOracleRequest(req, res, 400, 'oracle_public_query_too_wide', 'Too many query parameters.');
  }

  if (rawQuery.length > ORACLE_PUBLIC_MAX_QUERY_LENGTH) {
    return _rejectPublicOracleRequest(req, res, 414, 'oracle_public_query_too_long', 'Query string exceeds the allowed length.');
  }

  if (userAgent && ORACLE_PUBLIC_BLOCKED_UA_PATTERNS.some(pattern => userAgent.includes(pattern))) {
    return _rejectPublicOracleRequest(req, res, 403, 'oracle_public_request_blocked', 'Request signature is blocked.');
  }

  return next();
}

function _createPublicOracleQueryGuard(endpointKey) {
  const rules = PUBLIC_ORACLE_QUERY_RULES[endpointKey] || {};

  return (req, res, next) => {
    for (const [key, rawValue] of Object.entries(req.query || {})) {
      if (!Object.prototype.hasOwnProperty.call(rules, key)) {
        return _rejectPublicOracleRequest(req, res, 400, 'oracle_public_query_param_not_allowed', `Unsupported query param: ${key}`);
      }

      const normalizedValue = _normalizePublicOracleQueryValue(rawValue);
      if (!normalizedValue) {
        return _rejectPublicOracleRequest(req, res, 400, 'oracle_public_query_param_invalid', `Invalid value for ${key}`);
      }

      const rule = rules[key];
      if (normalizedValue.length > rule.maxLength) {
        return _rejectPublicOracleRequest(req, res, 414, 'oracle_public_query_too_long', `Query value too long for ${key}`);
      }

      if (rule.allowedValues && !rule.allowedValues.includes(normalizedValue.toLowerCase())) {
        return _rejectPublicOracleRequest(req, res, 400, 'oracle_public_query_param_invalid', `Unsupported value for ${key}`);
      }

      if (rule.pattern && !rule.pattern.test(normalizedValue)) {
        return _rejectPublicOracleRequest(req, res, 400, 'oracle_public_query_param_invalid', `Invalid value for ${key}`);
      }
    }

    return next();
  };
}

async function _buildPegMonitorResponse(assetsValue) {
  const assets = _normalizePegMonitorAssets(assetsValue);
  const [prices, eurcFx] = await Promise.all([
    oracle.getMultipleTokenPrices(assets),
    assets.includes('EURC') ? oracle.getForexRate('EURC', 'USDC') : Promise.resolve(null),
  ]);

  const monitors = assets.map((asset) => {
    const price = prices[asset] || null;
    const targetUsd = asset === 'EURC' ? eurcFx?.rate ?? 1 : 1;
    const targetSource = asset === 'EURC' ? eurcFx?.source || 'frankfurter' : 'usd_parity';
    const marketPriceUsd = typeof price?.usdPrice === 'number' ? price.usdPrice : targetUsd;
    const deviationPct = targetUsd > 0
      ? Math.abs((marketPriceUsd - targetUsd) / targetUsd) * 100
      : 0;
    const isFallback = Boolean(price?.isFallback) || Boolean(asset === 'EURC' && eurcFx?.isFallback);

    return {
      asset,
      marketPriceUsd: _roundTo(marketPriceUsd, 6),
      targetUsd: _roundTo(targetUsd, 6),
      deviationPct: _roundTo(deviationPct, 4),
      isDepegRisk: deviationPct > 0.5,
      source: price?.source || 'coingecko',
      targetSource,
      isFallback,
      fallbackReason: price?.fallbackReason || (asset === 'EURC' ? eurcFx?.fallbackReason || null : null),
    };
  });

  const highestDeviation = monitors.slice().sort((left, right) => (right.deviationPct || 0) - (left.deviationPct || 0))[0] || null;

  return {
    assets,
    monitors,
    isFallback: monitors.some(item => item.isFallback),
    summary: highestDeviation
      ? {
          highestDeviationAsset: highestDeviation.asset,
          highestDeviationPct: highestDeviation.deviationPct,
        }
      : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function _buildReserveStateResponse(assetsValue) {
  const assets = _normalizeReserveStateAssets(assetsValue);

  const reserves = await Promise.all(assets.map(async (asset) => {
    const config = ORACLE_RESERVE_STATE_ASSET_MAP[asset];
    let onchainReserve = null;
    let onchainError = null;

    try {
      onchainReserve = await oracle.getAaveReserveData(config.address);
    } catch (error) {
      onchainError = error;
    }

    if (onchainReserve) {
      return {
        asset,
        assetAddress: config.address,
        market: config.market,
        supplyApy: onchainReserve.supplyApy,
        borrowApy: onchainReserve.borrowApy,
        utilization: onchainReserve.utilization,
        source: 'aave_onchain',
        isFallback: false,
        fallbackReason: null,
        fetchedAt: new Date().toISOString(),
      };
    }

    const fallbackReason = onchainError
      ? 'onchain_fetch_failed'
      : (process.env.AAVE_POOL_ADDRESS ? 'reserve_not_available' : 'aave_pool_not_configured');
    const fallbackYield = await oracle.getYieldOpportunities(asset, 0)
      .then(entries => entries.find(entry => entry.name?.toLowerCase().includes('aave')) || null)
      .catch(() => null);

    oracle.recordOracleFallback('reserve_state', {
      asset,
      reason: fallbackReason,
      detail: onchainError?.message || null,
      provider: onchainError ? 'aave_onchain' : 'defillama',
    });

    return {
      asset,
      assetAddress: config.address,
      market: config.market,
      supplyApy: fallbackYield?.apy ?? null,
      borrowApy: null,
      utilization: null,
      source: fallbackYield?.source || 'defillama',
      isFallback: true,
      fallbackReason,
      fetchedAt: new Date().toISOString(),
    };
  }));

  const highestSupply = reserves
    .filter(item => Number.isFinite(item.supplyApy))
    .sort((left, right) => right.supplyApy - left.supplyApy)[0] || null;

  return {
    assets,
    reserves,
    isFallback: reserves.some(item => item.isFallback),
    summary: highestSupply
      ? {
          highestSupplyAsset: highestSupply.asset,
          highestSupplyApy: highestSupply.supplyApy,
        }
      : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function _buildProtocolTvlResponse(protocolsValue) {
  const protocols = _normalizeProtocolList(protocolsValue);
  const entries = await Promise.all(protocols.map(protocol => oracle.getProtocolTvl(protocol)));

  const protocolsWithSummary = entries.map((entry, index) => ({
    protocol: protocols[index],
    tvl: entry?.tvl ?? null,
    change24h: entry?.change24h ?? null,
    source: entry?.source || 'defillama',
    isFallback: Boolean(entry?.isFallback),
    fallbackReason: entry?.fallbackReason || null,
    fetchedAt: entry?.fetchedAt || new Date().toISOString(),
  }));

  const recommendation = protocolsWithSummary
    .filter(item => Number.isFinite(item.tvl))
    .sort((left, right) => right.tvl - left.tvl)[0] || null;

  return {
    protocols: protocolsWithSummary,
    recommendation: recommendation
      ? {
          protocol: recommendation.protocol,
          tvl: recommendation.tvl,
          reasoning: 'Highest currently available TVL in the configured ARC protocol watchlist.',
        }
      : null,
    isFallback: protocolsWithSummary.some(item => item.isFallback),
    fetchedAt: new Date().toISOString(),
  };
}

async function _buildPoolCompareResponse(targetsValue) {
  const targets = _normalizePoolCompareTargets(targetsValue);
  const snapshots = await Promise.all(targets.map(target => _getOraclePoolStateSnapshot(target.poolKey, target.venue)));

  const comparisons = snapshots.map((snapshot) => {
    const state = snapshot.state;
    const totalReserveUnits = (state?.reserves?.token0 ?? 0) + (state?.reserves?.token1 ?? 0);

    return {
      venue: snapshot.venue,
      poolKey: snapshot.poolKey,
      source: state?.source || snapshot.pool?.source || null,
      isFallback: state?.isFallback === true || state?.source === 'mock_testnet',
      fallbackReason: state?.fallbackReason || null,
      liquidityState: state?.liquidityState || snapshot.pool?.liquidityState || null,
      impliedRate: state?.impliedRate ?? null,
      inverseRate: state?.inverseRate ?? null,
      fee: state?.fee ?? null,
      rateUnit: state?.rateUnit || null,
      totalReserveUnits: _roundTo(totalReserveUnits, 6),
      note: snapshot.note || null,
    };
  });

  const deepestPool = comparisons
    .filter(item => Number.isFinite(item.totalReserveUnits))
    .sort((left, right) => right.totalReserveUnits - left.totalReserveUnits)[0] || null;

  return {
    targets,
    pools: comparisons,
    isFallback: comparisons.some(item => item.isFallback),
    summary: deepestPool
      ? {
          deepestPool: deepestPool.poolKey,
          deepestVenue: deepestPool.venue,
          deepestReserveUnits: deepestPool.totalReserveUnits,
        }
      : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function _buildPredictionMarketCheckResponse(topic, limit) {
  const pulse = await getPredictionMarketPulse({ topic, limit });

  return {
    sku: 'prediction-market-check',
    chargeModel: 'x402_circle_gateway',
    priceUsdc: ORACLE_PRICES['prediction-market-check'],
    ...pulse,
  };
}

async function _buildEventOddsCompareResponse(primaryTopic, secondaryTopic, limit) {
  const snapshot = await getEventOddsCompare({ primaryTopic, secondaryTopic, limit });

  return {
    sku: 'event-odds-compare',
    chargeModel: 'x402_circle_gateway',
    priceUsdc: ORACLE_PRICES['event-odds-compare'],
    ...snapshot,
  };
}

async function _buildWalletAssetSnapshotResponse(walletAddress) {
  const snapshot = await getWalletAssetSnapshot({ walletAddress });

  return {
    sku: 'wallet-asset-snapshot',
    chargeModel: 'x402_circle_gateway',
    priceUsdc: ORACLE_PRICES['wallet-asset-snapshot'],
    ...snapshot,
  };
}

function _buildNoOpportunitySignal({ venue, poolKey, pair, note, reason, poolState, forex }) {
  return {
    timestamp: new Date().toISOString(),
    strategy: 'stablecoin_fx',
    venue,
    poolKey,
    pair: pair || null,
    note: note || null,
    skippedReason: reason,
    opportunity: {
      found: false,
      type: 'FX_CURVE_ARB',
      description: note || 'No profitable arbitrage opportunity at this time',
      steps: [],
      expectedProfitUsdc: 0,
      expectedProfitPct: 0,
      gasEstimateUsdc: 0,
      netProfitUsdc: 0,
      confidence: 'LOW',
      expiresSeconds: 30,
    },
    isFallback: Boolean(forex?.isFallback)
      || Boolean(poolState?.isFallback)
      || poolState?.source === 'mock_testnet',
    dataSources: {
      forex: forex
        ? {
            source: forex.source,
            isFallback: Boolean(forex.isFallback),
            fallbackReason: forex.fallbackReason || null,
          }
        : null,
      poolState: poolState
        ? {
            source: poolState.source,
            isFallback: Boolean(poolState.isFallback) || poolState.source === 'mock_testnet',
            fallbackReason: poolState.fallbackReason || null,
          }
        : null,
    },
  };
}

async function _buildOracleArbExecutionContext({ snapshot, amountUsdc, baseToken, quoteToken }) {
  const execution = {
    bridgeFeeUsdc: _readPositiveOracleNumberEnv('ORACLE_ARB_BRIDGE_FEE_USDC', DEFAULT_ORACLE_ARB_BRIDGE_FEE_USDC),
    gasEstimateUsdc: _readPositiveOracleNumberEnv('ORACLE_ARB_GAS_ESTIMATE_USDC', DEFAULT_ORACLE_ARB_GAS_ESTIMATE_USDC),
    exitFeePct: _readPositiveOracleNumberEnv('ORACLE_ARB_EXIT_FEE_PCT', DEFAULT_ORACLE_ARB_EXIT_FEE_PCT),
    exitVenue: process.env.ORACLE_ARB_EXIT_VENUE || 'External exit venue',
    bridgeRequired: true,
    requireLiveExit: false,
    liveExitQuote: null,
  };

  if (snapshot.venue !== 'curve' || !snapshot.pool?.address) {
    return execution;
  }

  const normalizedAmountUsdc = Number(amountUsdc);
  if (!Number.isFinite(normalizedAmountUsdc) || normalizedAmountUsdc <= 0) {
    return execution;
  }

  const entryPoolFeePct = Number(snapshot.state?.fee);
  const entryPoolFeeUsdc = Number.isFinite(entryPoolFeePct) && entryPoolFeePct > 0
    ? _roundTo(normalizedAmountUsdc * (entryPoolFeePct / 100), 6)
    : 0;

  const entryInIndex = snapshot.pool.quoteToken?.index;
  const entryOutIndex = snapshot.pool.baseToken?.index;
  if (!Number.isInteger(entryInIndex) || !Number.isInteger(entryOutIndex)) {
    return execution;
  }

  try {
    const entryQuote = await protocols.getCurveQuote(
      snapshot.pool.address,
      entryInIndex,
      entryOutIndex,
      String(normalizedAmountUsdc),
      snapshot.pool.quoteToken?.decimals || 6,
      snapshot.pool.baseToken?.decimals || 6,
    );

    const expectedBaseOut = Number(entryQuote?.amountOut || 0);
    if (!Number.isFinite(expectedBaseOut) || expectedBaseOut <= 0) {
      return execution;
    }

    const buildLiveExitExecution = ({
      exitQuote,
      exitVenue,
      bridgeRequired,
      bridgeFeeUsdc,
      routeStrategy,
      chainName = null,
      bridgeProtocol = null,
      path = null,
    }) => {
      const expectedUsdcOut = Number(exitQuote?.amountOut || 0);
      if (!Number.isFinite(expectedUsdcOut) || expectedUsdcOut <= 0) {
        return null;
      }

      const minimumExpectedUsdcOut = _roundTo(
        normalizedAmountUsdc + entryPoolFeeUsdc + bridgeFeeUsdc + execution.gasEstimateUsdc,
        6,
      );
      const expectedNetProfitUsdc = _roundTo(expectedUsdcOut - minimumExpectedUsdcOut, 6);

      return {
        ...execution,
        bridgeFeeUsdc,
        exitVenue,
        bridgeRequired,
        liveExitQuote: {
          profitable: expectedNetProfitUsdc > 0,
          expectedBaseOut: _roundTo(expectedBaseOut, 6),
          expectedUsdcOut: _roundTo(expectedUsdcOut, 6),
          expectedNetProfitUsdc,
          minimumExpectedUsdcOut,
          executionRail: exitQuote?.executionRail || null,
          routeStrategy: routeStrategy || exitQuote?.routeStrategy || null,
          routeReason: exitQuote?.quoteError || exitQuote?.routeReason || null,
          chainName,
          bridgeProtocol,
          path,
        },
      };
    };

    try {
      const externalExitQuote = await agentWalletService.getExternalSwapQuoteResult({
        chainName: 'Sepolia',
        fromToken: baseToken,
        toToken: quoteToken,
        amountIn: String(expectedBaseOut),
      });
      const externalExecution = buildLiveExitExecution({
        exitQuote: externalExitQuote,
        exitVenue: externalExitQuote?.venueLabel || process.env.ORACLE_ARB_EXIT_VENUE || 'External exit venue',
        bridgeRequired: true,
        bridgeFeeUsdc: execution.bridgeFeeUsdc,
        routeStrategy: externalExitQuote?.path ? externalExitQuote.path.join(' -> ') : null,
        chainName: externalExitQuote?.chainName || 'Sepolia',
        bridgeProtocol: 'CCTP',
        path: externalExitQuote?.path || null,
      });

      if (externalExecution) {
        return externalExecution;
      }
    } catch (error) {
      oracle.recordOracleSignal('arb_external_exit_quote_unavailable', {
        venue: snapshot.venue,
        poolKey: snapshot.poolKey,
        baseToken,
        quoteToken,
        detail: error.message,
      });
    }

    const liveArcExitQuote = await agentWalletService.getSwapQuoteResult({
      fromToken: baseToken,
      toToken: quoteToken,
      amountIn: String(expectedBaseOut),
    });
    const liveArcExecution = buildLiveExitExecution({
      exitQuote: liveArcExitQuote,
      exitVenue: liveArcExitQuote?.executionRail === 'swap_kit'
        ? 'Live ARC sell quote'
        : 'Live fallback sell quote',
      bridgeRequired: false,
      bridgeFeeUsdc: 0,
      chainName: 'Arc Testnet',
    });

    if (liveArcExecution) {
      return liveArcExecution;
    }

    return execution;
  } catch (error) {
    oracle.recordOracleSignal('arb_live_exit_quote_unavailable', {
      venue: snapshot.venue,
      poolKey: snapshot.poolKey,
      baseToken,
      quoteToken,
      detail: error.message,
    });
    return execution;
  }
}

async function _buildStablecoinArbSignalResponse(poolKey = 'EURC-USDC', venue = 'curve') {
  const snapshot = await _getOraclePoolStateSnapshot(poolKey, venue);
  const poolState = snapshot.state;
  const baseToken = poolState?.baseToken?.symbol || snapshot.pool?.baseToken?.symbol || null;
  const quoteToken = poolState?.quoteToken?.symbol || snapshot.pool?.quoteToken?.symbol || null;
  const pair = baseToken && quoteToken ? `${baseToken}/${quoteToken}` : null;

  if (!poolState || !baseToken || !quoteToken || !Number.isFinite(poolState.impliedRate)) {
    return _buildNoOpportunitySignal({
      venue: snapshot.venue,
      poolKey: snapshot.poolKey,
      pair,
      note: snapshot.note || 'Pool state is unavailable for arbitrage evaluation',
      reason: 'pool_state_unavailable',
      poolState,
      forex: null,
    });
  }

  let forexRate;
  try {
    forexRate = await oracle.getForexRate(baseToken, quoteToken);
  } catch (error) {
    return _buildNoOpportunitySignal({
      venue: snapshot.venue,
      poolKey: snapshot.poolKey,
      pair,
      note: snapshot.note || error.message,
      reason: 'unsupported_forex_pair',
      poolState,
      forex: {
        source: 'frankfurter',
        isFallback: true,
        fallbackReason: 'unsupported_pair',
      },
    });
  }

  const optimalAmountUsdc = oracle.calcOptimalSwapSize(
    poolState.priceImpact?.swap1k,
    poolState.priceImpact?.swap10k,
  );
  const execution = await _buildOracleArbExecutionContext({
    snapshot,
    amountUsdc: optimalAmountUsdc,
    baseToken,
    quoteToken,
  });
  const signal = oracle.buildArbSignal({
    strategy: 'stablecoin_fx',
    forexRate: forexRate.rate,
    poolRate: poolState.impliedRate,
    poolFee: poolState.fee,
    poolLiquidity: (poolState.reserves?.token0 ?? 0) + (poolState.reserves?.token1 ?? 0),
    priceImpacts: poolState.priceImpact,
    baseToken,
    quoteToken,
    execution,
  });

  signal.venue = snapshot.venue;
  signal.poolKey = snapshot.poolKey;
  signal.pair = pair;
  signal.note = snapshot.note || null;
  signal.executionAssumptions = {
    bridgeFeeUsdc: execution.bridgeFeeUsdc,
    gasEstimateUsdc: execution.gasEstimateUsdc,
    exitFeePct: execution.exitFeePct,
    exitVenue: execution.exitVenue,
    bridgeRequired: execution.bridgeRequired,
    liveExitQuoteAvailable: Boolean(execution.liveExitQuote),
  };
  signal.isFallback = Boolean(forexRate?.isFallback)
    || Boolean(poolState?.isFallback)
    || poolState?.source === 'mock_testnet';
  signal.dataSources = {
    forex: {
      source: forexRate.source,
      isFallback: Boolean(forexRate.isFallback),
      fallbackReason: forexRate.fallbackReason || null,
    },
    poolState: {
      source: poolState.source,
      isFallback: Boolean(poolState.isFallback) || poolState.source === 'mock_testnet',
      fallbackReason: poolState.fallbackReason || null,
    },
    liveExitQuote: execution.liveExitQuote
      ? {
          source: execution.liveExitQuote.executionRail || 'quote',
          isFallback: false,
          fallbackReason: execution.liveExitQuote.routeReason || null,
        }
      : null,
  };

  return signal;
}

async function _buildArbScanMultiResponse(targetsValue) {
  const targets = _normalizeArbScanTargets(targetsValue);
  const scans = await Promise.all(targets.map(target => _buildStablecoinArbSignalResponse(target.poolKey, target.venue)));
  const profitable = scans.filter(item => item.opportunity?.found);
  const bestOpportunity = profitable
    .slice()
    .sort((left, right) => (right.opportunity?.netProfitUsdc || 0) - (left.opportunity?.netProfitUsdc || 0))[0] || null;

  return {
    targets,
    scans,
    isFallback: scans.some(item => item.isFallback),
    summary: {
      scannedCount: scans.length,
      profitableCount: profitable.length,
      bestOpportunity: bestOpportunity
        ? {
            venue: bestOpportunity.venue,
            poolKey: bestOpportunity.poolKey,
            pair: bestOpportunity.pair,
            netProfitUsdc: bestOpportunity.opportunity.netProfitUsdc,
            confidence: bestOpportunity.opportunity.confidence,
          }
        : null,
    },
    fetchedAt: new Date().toISOString(),
  };
}

function _getOracleCurvePool(poolKey = 'USDC-EURC') {
  return oracle.resolveCurvePool(poolKey);
}

async function _getOracleCurvePoolSnapshot(poolKey = 'USDC-EURC', fallbackRate) {
  const normalizedPoolKey = oracle.normalizeCurvePoolKey(poolKey);
  const pool = _getOracleCurvePool(normalizedPoolKey);

  if (!pool?.address) {
    const [base] = normalizedPoolKey.split('-');
    const mockRate = fallbackRate || (base === 'WUSDC' ? 1.001 : 1.0912);
    oracle.recordOracleFallback('curve_pool_mock', {
      poolKey: normalizedPoolKey,
      reason: 'missing_live_pool_metadata',
    });

    const mockState = {
      ...oracle.getMockPoolState(normalizedPoolKey, mockRate),
      isFallback: true,
      fallbackReason: 'missing_live_pool_metadata',
    };

    return {
      poolKey: normalizedPoolKey,
      pool: null,
      note: 'No supported live pool metadata found — returning mock state',
      state: mockState,
    };
  }

  try {
    return {
      poolKey: normalizedPoolKey,
      pool,
      note: pool.liquidityState === 'empty'
        ? 'Verified Arc pool found, but current on-chain liquidity is empty'
        : null,
      state: await oracle.getCurvePoolState(pool),
    };
  } catch (error) {
    oracle.recordOracleFallback('curve_pool_state', {
      poolKey: normalizedPoolKey,
      reason: 'arc_rpc_unavailable',
      detail: error?.message || null,
    });

    return {
      poolKey: normalizedPoolKey,
      pool,
      note: 'Live Arc pool state is temporarily unavailable — returning fallback snapshot',
      state: _buildOraclePoolStateFallback(pool, {
        fallbackReason: 'arc_rpc_unavailable',
        source: 'empty_fallback',
      }),
    };
  }
}

async function _getOraclePoolStateSnapshot(poolKey = 'USDC-EURC', venue = 'curve') {
  const normalizedVenue = oracle.normalizePoolVenue(venue);

  if (normalizedVenue === 'curve') {
    const snapshot = await _getOracleCurvePoolSnapshot(poolKey);
    return {
      venue: 'curve',
      poolKey: snapshot.poolKey,
      note: snapshot.note,
      pool: snapshot.pool,
      state: snapshot.state,
    };
  }

  const pool = oracle.resolveOraclePoolStateTarget(poolKey, normalizedVenue);

  if (!pool?.address) {
    return {
      venue: normalizedVenue,
      poolKey: oracle.normalizeCurvePoolKey(poolKey),
      note: 'No whitelisted external pool metadata found for the requested venue',
      pool: null,
      state: null,
    };
  }

  return {
    venue: normalizedVenue,
    poolKey: pool.key,
    note: pool.note || null,
    pool,
    state: await (async () => {
      try {
        return await oracle.getConstantProductPoolState(pool);
      } catch (error) {
        oracle.recordOracleFallback('external_pool_state', {
          poolKey: pool.key,
          venue: normalizedVenue,
          reason: 'arc_rpc_unavailable',
          detail: error?.message || null,
        });

        return _buildOraclePoolStateFallback(pool, {
          fallbackReason: 'arc_rpc_unavailable',
          source: 'empty_fallback',
        });
      }
    })(),
  };
}

async function _getOracleStablecoinFxCurveQuote(base, quote) {
  const normalizedPoolKey = oracle.normalizeCurvePoolKey(`${base}-${quote}`);
  const pool = _getOracleCurvePool(normalizedPoolKey);

  if (!pool?.address) {
    return {
      poolKey: normalizedPoolKey,
      note: 'No verified live Arc Curve pool is mapped for this pair',
      pool: null,
      state: null,
    };
  }

  const snapshot = await _getOracleCurvePoolSnapshot(normalizedPoolKey);

  return {
    poolKey: snapshot.poolKey,
    note: snapshot.note,
    pool: {
      address: snapshot.pool.address,
      source: snapshot.pool.source,
      liquidityState: snapshot.pool.liquidityState,
      baseToken: snapshot.pool.baseToken.symbol,
      quoteToken: snapshot.pool.quoteToken.symbol,
    },
    state: snapshot.state,
  };
}

async function _buildStablecoinFxResponse(base, quote) {
  const [forexRate, usdcPeg, arcCurvePool] = await Promise.all([
    oracle.getForexRate(base, quote),
    oracle.getUsdcPegDeviation(),
    _getOracleStablecoinFxCurveQuote(base, quote),
  ]);

  return {
    pair: `${base}/${quote}`,
    forex: forexRate,
    usdcPeg,
    arcCurvePool,
    isFallback: Boolean(forexRate?.isFallback)
      || Boolean(usdcPeg?.isFallback)
      || Boolean(arcCurvePool?.state?.isFallback)
      || arcCurvePool?.state?.source === 'mock_testnet',
    fetchedAt: new Date().toISOString(),
  };
}

function _formatGatewayPrice(priceUsdc) {
  return `$${String(priceUsdc)}`;
}

function _normalizeOracleGatewayPayer(payer) {
  const normalized = String(payer || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(normalized) ? normalized.toLowerCase() : null;
}

function _normalizeOracleGatewaySettlementId(transaction) {
  const normalized = String(transaction || '').trim();

  if (/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    return normalized.toLowerCase();
  }

  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(normalized)) {
    return normalized.toLowerCase();
  }

  return null;
}

function _decodeOracleGatewayPaymentResponse(paymentResponseHeader) {
  if (!paymentResponseHeader) return null;

  try {
    const decoded = Buffer.from(String(paymentResponseHeader), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);

    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function _recordOracleGatewaySettlement({ endpointKey, paymentResponseHeader, statusCode }) {
  if (statusCode >= 400) return false;

  const paymentResponse = _decodeOracleGatewayPaymentResponse(paymentResponseHeader);
  const txHash = _normalizeOracleGatewaySettlementId(paymentResponse?.transaction);
  const amountUsdc = Number(ORACLE_PRICES[endpointKey] || '0');

  if (!paymentResponse?.success || !txHash) {
    return false;
  }

  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    logOracleGateway('warn', 'Skipped oracle gateway payment persistence because price is invalid', {
      endpoint: endpointKey,
      rawPrice: ORACLE_PRICES[endpointKey] || null,
      txHash,
    });
    return false;
  }

  try {
    await db.query(
      `INSERT INTO oracle_payments (tx_hash, endpoint, amount_usdc, from_addr)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [txHash, endpointKey, amountUsdc, _normalizeOracleGatewayPayer(paymentResponse.payer)],
    );
    return true;
  } catch (error) {
    logOracleGateway('warn', 'Failed to persist oracle gateway settlement', {
      endpoint: endpointKey,
      error: error.message,
      txHash,
    });
    return false;
  }
}

function _createOraclePaymentAuditMiddleware(endpointKey) {
  return (req, res, next) => {
    res.once('finish', () => {
      const paymentRequiredHeader = res.getHeader('PAYMENT-REQUIRED') || res.getHeader('X-PAYMENT-REQUIRED');
      const paymentResponseHeader = res.getHeader('PAYMENT-RESPONSE') || res.getHeader('X-PAYMENT-RESPONSE');
      const normalizedHeader = Array.isArray(paymentResponseHeader)
        ? paymentResponseHeader[0]
        : paymentResponseHeader;

      if (res.statusCode === 402) {
        oracle.recordOracleSignal('payment_challenge', {
          endpoint: endpointKey,
          statusCode: res.statusCode,
        });
        logOracleGateway('warn', 'Oracle public route returned payment challenge', {
          endpoint: endpointKey,
          statusCode: res.statusCode,
          method: req.method,
          path: req.originalUrl || req.path || null,
          priceUsdc: ORACLE_PRICES[endpointKey] || null,
          docsUrlPresent: Boolean(ORACLE_BUYER_DOCS_URL),
          machineDocsUrlPresent: Boolean(ORACLE_BUYER_MACHINE_DOCS_URL),
          paymentRequiredHeaderPresent: Boolean(paymentRequiredHeader),
        });
      } else if (res.statusCode === 429) {
        oracle.recordOracleSignal('rate_limited', {
          endpoint: endpointKey,
          statusCode: res.statusCode,
        });
        logOracleGateway('warn', 'Oracle public route returned rate limit', {
          endpoint: endpointKey,
          statusCode: res.statusCode,
          method: req.method,
          path: req.originalUrl || req.path || null,
        });
      } else if (res.statusCode >= 500) {
        oracle.recordOracleSignal('server_error', {
          endpoint: endpointKey,
          statusCode: res.statusCode,
        });
        logOracleGateway('error', 'Oracle public route returned server error', {
          endpoint: endpointKey,
          statusCode: res.statusCode,
          method: req.method,
          path: req.originalUrl || req.path || null,
        });
      }

      void _recordOracleGatewaySettlement({
        endpointKey,
        paymentResponseHeader: normalizedHeader,
        statusCode: res.statusCode,
      });
    });

    next();
  };
}

function _getOracleGatewaySummary() {
  try {
    return {
      seller: {
        enabled: Boolean(ORACLE_PAY_ADDRESS),
        sellerAddress: ORACLE_PAY_ADDRESS,
        ...getGatewaySellerSummary(),
        facilitator: getGatewayFacilitatorSummary(),
      },
      buyer: getGatewayBuyerSummary(),
      taskEconomy: getTaskEconomyConfigSummary(),
      jobEconomy: getJobEconomyConfigSummary(),
    };
  } catch (error) {
    logOracleGateway('warn', 'Failed to build oracle gateway summary', {
      error: error.message,
      sellerAddress: ORACLE_PAY_ADDRESS,
    });

    return {
      seller: {
        enabled: false,
        sellerAddress: ORACLE_PAY_ADDRESS,
        mode: 'gateway-seller',
        facilitator: {
          supportedCache: {
            ready: false,
            networkCount: 0,
            loadedAt: null,
            lastError: null,
          },
        },
      },
      buyer: {
        mode: 'gateway-buyer',
        configured: false,
        chainCount: 0,
        supportedChains: [],
      },
      taskEconomy: {
        mode: 'circle_gateway_task_fee',
        configured: false,
      },
      jobEconomy: {
        mode: 'job_escrow_with_gateway_fee',
        configured: false,
      },
      error: error.message,
    };
  }
}

function _buildOracleUnpaidResponse(endpointKey, priceUsdc) {
  return (context) => ({
    contentType: 'application/json',
    body: {
      error: 'payment_required',
      endpoint: endpointKey,
      price: `${priceUsdc} USDC`,
      sellerMode: 'circle_gateway',
      callbackEndpoint: context.url || context.path || null,
      docsUrl: ORACLE_BUYER_DOCS_URL,
      machineDocsUrl: ORACLE_BUYER_MACHINE_DOCS_URL,
      downloads: {
        exampleUrl: ORACLE_BUYER_EXAMPLE_URL,
        helperUrl: ORACLE_BUYER_HELPER_URL,
      },
      note: 'Retry with the payment headers returned by the Circle Gateway x402 flow.',
    },
  });
}

function _buildOracleSettlementFailedResponse(endpointKey) {
  return (_context, settleResult) => {
    const reason = settleResult?.errorReason || settleResult?.error || settleResult?.message || 'unknown_settlement_error';

    oracle.recordOracleSignal('settlement_failure', {
      endpoint: endpointKey,
      reason,
      statusCode: 402,
    });

    logOracleGateway('warn', 'Oracle gateway settlement failed', {
      endpoint: endpointKey,
      reason,
      statusCode: 402,
    });

    return {
      contentType: 'application/json',
      body: {
        error: 'payment_settlement_failed',
        endpoint: endpointKey,
        sellerMode: 'circle_gateway',
        reason,
      },
    };
  };
}

function _createGatewayUnavailableMiddleware(reason, detail) {
  return (_req, res) => {
    oracle.recordOracleSignal('gateway_unavailable', {
      reason,
      detail: detail || null,
      statusCode: 503,
    });

    logOracleGateway('error', 'Oracle gateway middleware unavailable', {
      reason,
      detail: detail || null,
      statusCode: 503,
    });

    res.status(503).json({
      error: 'gateway_not_configured',
      reason,
      detail: detail || null,
      sellerMode: 'circle_gateway',
    });
  };
}

function _createOracleGatewayMiddleware(path, endpointKey) {
  if (!ORACLE_PAY_ADDRESS) {
    return _createGatewayUnavailableMiddleware('oracle_pay_address_missing');
  }

  const endpoint = ORACLE_PUBLIC_ENDPOINTS.find(item => item.key === endpointKey);
  if (!endpoint) {
    return _createGatewayUnavailableMiddleware('unknown_endpoint', endpointKey);
  }

  try {
    return createGatewaySellerMiddleware({
      [`GET ${path}`]: createGatewayRouteConfig({
        sellerAddress: ORACLE_PAY_ADDRESS,
        price: _formatGatewayPrice(endpoint.priceUsdc),
        description: endpoint.description,
        resource: endpoint.path,
        unpaidResponseBody: _buildOracleUnpaidResponse(endpointKey, endpoint.priceUsdc),
        settlementFailedResponseBody: _buildOracleSettlementFailedResponse(endpointKey),
      }),
    });
  } catch (error) {
    return _createGatewayUnavailableMiddleware('gateway_middleware_init_failed', error.message);
  }
}

const stablecoinFxGateway = _createOracleGatewayMiddleware('/stablecoin-fx', 'stablecoin-fx');
const poolStateGateway = _createOracleGatewayMiddleware('/pool-state', 'pool-state');
const pegMonitorGateway = _createOracleGatewayMiddleware('/peg-monitor', 'peg-monitor');
const reserveStateGateway = ORACLE_PUBLIC_RESERVE_STATE_ENABLED
  ? _createOracleGatewayMiddleware('/reserve-state', 'reserve-state')
  : null;
const poolCompareGateway = _createOracleGatewayMiddleware('/pool-compare', 'pool-compare');
const walletAssetSnapshotGateway = _createOracleGatewayMiddleware('/wallet-asset-snapshot', 'wallet-asset-snapshot');
const predictionMarketCheckGateway = _createOracleGatewayMiddleware('/prediction-market-check', 'prediction-market-check');
const eventOddsCompareGateway = _createOracleGatewayMiddleware('/event-odds-compare', 'event-odds-compare');
const arbSignalGateway = _createOracleGatewayMiddleware('/arb-signal', 'arb-signal');
const arbScanMultiGateway = _createOracleGatewayMiddleware('/arb-scan-multi', 'arb-scan-multi');

async function _getOracleRevenueStats() {
  const { rows: [row] } = await db.query(
    `SELECT COALESCE(SUM(amount_usdc),0)::float AS total_usdc,
            COUNT(*)::int AS request_count
     FROM oracle_payments`,
  );

  return {
    totalUsdc: row.total_usdc,
    requestCount: row.request_count,
  };
}

async function _getAgenticPaymentAuditStats() {
  const { rows: [row] } = await db.query(
    `SELECT COUNT(*)::int AS total_events,
            COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed_count,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
            COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped_count,
            COUNT(*) FILTER (WHERE event_type = 'nano_payment')::int AS nano_events,
            COUNT(*) FILTER (WHERE event_type = 'task_execution_fee')::int AS task_events,
            COUNT(*) FILTER (WHERE event_type = 'job_create_fee')::int AS job_create_events,
            COUNT(*) FILTER (WHERE event_type = 'job_payout')::int AS job_payout_events,
            MAX(created_at) AS last_event_at
     FROM agentic_payment_events`,
  );

  return {
    totalEvents: row.total_events,
    confirmedCount: row.confirmed_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    nanoEvents: row.nano_events,
    taskEvents: row.task_events,
    jobCreateEvents: row.job_create_events,
    jobPayoutEvents: row.job_payout_events,
    lastEventAt: row.last_event_at ? new Date(row.last_event_at).toISOString() : null,
  };
}

async function _getAgentGatewayUsage(agentId) {
  const [{ rows: summaryRows }, { rows: recentRows }] = await Promise.all([
    db.query(
      `SELECT rail,
              reference_type,
              COUNT(*)::int AS count,
              COALESCE(SUM(amount_usdc), 0)::float AS total_usdc,
              MAX(created_at) AS last_at
         FROM agentic_payment_events
        WHERE agent_id = $1
          AND status = 'confirmed'
        GROUP BY rail, reference_type
        ORDER BY MAX(created_at) DESC
        LIMIT 6`,
      [agentId],
    ),
    db.query(
      `SELECT created_at,
              event_type,
              rail,
              reference_type,
              reference_id,
              amount_usdc::float AS amount_usdc,
              tx_hash,
              status
         FROM agentic_payment_events
        WHERE agent_id = $1
          AND status = 'confirmed'
        ORDER BY created_at DESC
        LIMIT 8`,
      [agentId],
    ),
  ]);

  return {
    sharedBalance: true,
    note: 'Gateway available balance is a shared warm balance. Confirmed public x402 payments, automation/task/job fees, and other Gateway-backed buyer flows can all spend it before the next on-demand refill from the wallet.',
    summary: summaryRows.map((row) => ({
      rail: row.rail,
      referenceType: row.reference_type,
      count: Number(row.count || 0),
      totalUsdc: Number(row.total_usdc || 0),
      lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
    })),
    recent: recentRows.map((row) => ({
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      eventType: row.event_type,
      rail: row.rail,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      amountUsdc: Number(row.amount_usdc || 0),
      txHash: row.tx_hash || null,
      status: row.status,
    })),
  };
}

// ── GET /api/oracle/status ────────────────────────────────────────────────────
router.get('/status', requireAuth, async (_req, res, next) => {
  try {
    const [revenue, agenticPaymentAudit] = await Promise.all([
      _getOracleRevenueStats(),
      _getAgenticPaymentAuditStats(),
    ]);

    res.json({
      service:    'ARC DeFi Oracle',
      network:    'arc-testnet',
      timestamp:  new Date().toISOString(),
      cache:      oracle.getCacheStats(),
      revenue,
      payment: {
        address: ORACLE_PAY_ADDRESS,
        token: 'USDC',
        tokenAddress: USDC_ADDRESS,
        chain: 'arc-testnet',
        chainId: 5042002,
      },
      publicEndpoints: ORACLE_PUBLIC_ENDPOINTS,
      marketCoverage: {
        externalDexes: ORACLE_EXTERNAL_DEX_CATALOG,
      },
      observability: oracle.getOracleObservabilitySummary(),
      gateway: {
        ..._getOracleGatewaySummary(),
        audit: agenticPaymentAudit,
      },
      config: {
        payToConfigured: Boolean(ORACLE_PAY_ADDRESS),
        pools: {
          usdcEurcConfigured: Boolean(_getOracleCurvePool('USDC-EURC')?.address),
          usdcEurcSource: _getOracleCurvePool('USDC-EURC')?.source || null,
          usdcEurcLiquidityState: _getOracleCurvePool('USDC-EURC')?.liquidityState || null,
          eurcWusdcConfigured: Boolean(_getOracleCurvePool('EURC-WUSDC')?.address),
          eurcWusdcSource: _getOracleCurvePool('EURC-WUSDC')?.source || null,
          eurcWusdcLiquidityState: _getOracleCurvePool('EURC-WUSDC')?.liquidityState || null,
          wusdcUsdcConfigured: Boolean(_getOracleCurvePool('WUSDC-USDC')?.address),
          wusdcUsdcSource: _getOracleCurvePool('WUSDC-USDC')?.source || null,
          wusdcUsdcLiquidityState: _getOracleCurvePool('WUSDC-USDC')?.liquidityState || null,
          usdcUsycConfigured: Boolean(_getOracleCurvePool('USDC-USYC')?.address),
          usdcUsycSource: _getOracleCurvePool('USDC-USYC')?.source || null,
          usdcUsycLiquidityState: _getOracleCurvePool('USDC-USYC')?.liquidityState || null,
        },
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/oracle/gateway/fund ───────────────────────────────────────────
router.post('/gateway/fund', requireAuth, async (req, res, next) => {
  try {
    const agentId = String(req.body?.agentId || '').trim();
    const chainName = String(req.body?.chainName || 'Arc Testnet').trim() || 'Arc Testnet';
    const amountUsdc = req.body?.amountUsdc || ORACLE_MANUAL_GATEWAY_FUND_USDC;

    if (!agentId) {
      return res.status(400).json({ error: 'agent_id_required' });
    }

    const agent = await agentService.getAgent(agentId, req.user.userId);
    if (!agent) {
      return res.status(404).json({ error: 'agent_not_found' });
    }

    const rawAgent = await agentService.getAgentWithKey(agentId, req.user.userId);
    if (!rawAgent) {
      return res.status(404).json({ error: 'agent_signer_not_found' });
    }

    const walletAddress = String(agent.walletAddress || rawAgent.wallet_address || '').toLowerCase();
    const funding = await depositGatewayBalanceForAgent(rawAgent, amountUsdc, {
      chainName,
      walletAddress,
      operation: 'manual_gateway_fund',
    });

    res.json({
      agentId,
      chainName,
      amountUsdc: funding.amountUsdc,
      walletAddress,
      wallet: {
        availableUsdc: funding.balancesAfter.wallet.formattedAvailable,
        totalUsdc: funding.balancesAfter.wallet.formattedTotal,
      },
      gateway: {
        availableUsdc: funding.balancesAfter.gateway.formattedAvailable,
        totalUsdc: funding.balancesAfter.gateway.formattedTotal,
        withdrawingUsdc: funding.balancesAfter.gateway.formattedWithdrawing,
        withdrawableUsdc: funding.balancesAfter.gateway.formattedWithdrawable,
      },
      deposit: {
        approvalTxHash: funding.depositResult?.approvalTxHash || null,
        depositTxHash: funding.depositResult?.depositTxHash || null,
      },
      funded: funding.funded,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const code = String(err?.code || '').trim().toUpperCase();
    if (['ARC_RPC_COOLDOWN', 'GATEWAY_SERVICE_RATE_LIMITED', 'GATEWAY_DEFERRED_UNKNOWN'].includes(code)) {
      const retryAfterMs = Number.isFinite(Number(err?.retryAfterMs)) ? Number(err.retryAfterMs) : null;
      const retryAt = typeof err?.retryAt === 'string' && err.retryAt.trim() ? err.retryAt : null;

      const deferredMessageByCode = {
        ARC_RPC_COOLDOWN: 'Gateway funding could not be submitted because the configured transaction endpoints are temporarily rate limited.',
        GATEWAY_SERVICE_RATE_LIMITED: 'Gateway funding could not be submitted because the shared Gateway service is temporarily rate limited.',
        GATEWAY_DEFERRED_UNKNOWN: 'Gateway funding could not be submitted because the failure source could not be proven safely at this time.',
      };

      return res.status(503).json({
        agentId: String(req.body?.agentId || '').trim(),
        chainName: String(req.body?.chainName || 'Arc Testnet').trim() || 'Arc Testnet',
        status: 'deferred',
        availability: 'temporarily_unavailable',
        retryable: true,
        errorCode: code,
        funded: false,
        deposit: {
          approvalTxHash: null,
          depositTxHash: null,
        },
        message: deferredMessageByCode[code] || deferredMessageByCode.GATEWAY_DEFERRED_UNKNOWN,
        retryAfterMs,
        retryAt,
      });
    }

    if (err.statusCode && !err.status) {
      err.status = err.statusCode;
    }
    next(err);
  }
});

// ── POST /api/oracle/debug/test-alert ───────────────────────────────────────
router.post('/debug/test-alert', requireAuth, async (req, res, next) => {
  try {
    const note = String(req.body?.note || '').trim();
    const ok = await oracle.dispatchOracleTestAlert({
      source: 'private_oracle_route',
      requestedByUserId: req.user.userId,
      note: note || null,
    });
    const observability = oracle.getOracleObservabilitySummary();

    res.json({
      ok,
      message: ok
        ? 'Oracle alert test dispatched.'
        : 'Oracle alert test stored, but at least one external sink failed.',
      alerting: observability.alerting,
      triggeredAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── GET /api/oracle/debug/gateway-balance ────────────────────────────────────
// ?agentId=<uuid>&chainName=Arc%20Testnet
router.get('/debug/gateway-balance', requireAuth, async (req, res, next) => {
  try {
    const agentId = String(req.query.agentId || '').trim();
    const chainName = String(req.query.chainName || 'Arc Testnet').trim() || 'Arc Testnet';

    if (!agentId) {
      return res.status(400).json({ error: 'agent_id_required' });
    }

    const agent = await agentService.getAgent(agentId, req.user.userId);
    if (!agent) {
      return res.status(404).json({ error: 'agent_not_found' });
    }

    const rawAgent = await agentService.getAgentWithKey(agentId, req.user.userId);
    if (!rawAgent) {
      return res.status(404).json({ error: 'agent_signer_not_found' });
    }

    const usagePromise = _getAgentGatewayUsage(agentId);
    let balances;
    try {
      balances = await getAgentGatewayBalances(rawAgent, { chainName });
    } catch (error) {
      if (String(error?.code || '').trim().toUpperCase() === 'ARC_RPC_COOLDOWN') {
        const usage = await usagePromise.catch(() => null);
        return res.status(200).json({
          agentId,
          chainName,
          status: 'deferred',
          availability: 'temporarily_unavailable',
          retryable: true,
          errorCode: 'ARC_RPC_COOLDOWN',
          walletAddress: String(agent.walletAddress || rawAgent.wallet_address || '').toLowerCase(),
          wallet: null,
          gateway: null,
          usage,
          funded: null,
          fetchedAt: new Date().toISOString(),
        });
      }
      throw error;
    }

    const usage = await usagePromise;

    res.json({
      agentId,
      chainName,
      walletAddress: String(agent.walletAddress || rawAgent.wallet_address || '').toLowerCase(),
      wallet: {
        availableUsdc: balances.wallet.formattedAvailable,
        totalUsdc: balances.wallet.formattedTotal,
      },
      gateway: {
        availableUsdc: balances.gateway.formattedAvailable,
        totalUsdc: balances.gateway.formattedTotal,
        withdrawingUsdc: balances.gateway.formattedWithdrawing,
        withdrawableUsdc: balances.gateway.formattedWithdrawable,
      },
      usage,
      funded: balances.gateway.available > 0n,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── GET /api/oracle/stablecoin-fx ─────────────────────────────────────────────
// ?pair=EURC/USDC   (default)
router.get('/stablecoin-fx', requireAuth, async (req, res, next) => {
  try {
    const pairParam = (req.query.pair || 'EURC/USDC').toString().toUpperCase();
    const [base, quote = 'USDC'] = pairParam.split('/');

    res.json(await _buildStablecoinFxResponse(base, quote));
  } catch (err) { next(err); }
});

// ── GET /api/oracle/pool-state ────────────────────────────────────────────────
// ?pool=USDC-EURC   (default)
router.get('/pool-state', requireAuth, async (req, res, next) => {
  try {
    const snapshot = await _getOraclePoolStateSnapshot(req.query.pool || 'USDC-EURC', req.query.venue || 'curve');
    res.json({
      venue: snapshot.venue,
      poolKey: snapshot.poolKey,
      note: snapshot.note,
      pool: snapshot.pool
        ? {
            address: snapshot.pool.address,
            protocol: snapshot.pool.protocol,
            venue: snapshot.pool.venue,
            source: snapshot.pool.source,
            liquidityState: snapshot.pool.liquidityState,
            baseToken: snapshot.pool.baseToken.symbol,
            quoteToken: snapshot.pool.quoteToken.symbol,
          }
        : null,
      state: snapshot.state,
      isFallback: snapshot.state?.isFallback === true || snapshot.state?.source === 'mock_testnet',
    });
  } catch (err) { next(err); }
});

// ── GET /api/oracle/peg-monitor ───────────────────────────────────────────────
router.get('/peg-monitor', requireAuth, async (req, res, next) => {
  try {
    res.json(await _buildPegMonitorResponse(req.query.assets));
  } catch (err) { next(err); }
});

// ── GET /api/oracle/reserve-state ───────────────────────────────────────────
router.get('/reserve-state', requireAuth, async (req, res, next) => {
  try {
    res.json(await _buildReserveStateResponse(req.query.assets));
  } catch (err) { next(err); }
});

// ── GET /api/oracle/protocol-tvl ─────────────────────────────────────────────
router.get('/protocol-tvl', requireAuth, async (req, res, next) => {
  try {
    res.json(await _buildProtocolTvlResponse(req.query.protocols));
  } catch (err) { next(err); }
});

// ── GET /api/oracle/pool-compare ─────────────────────────────────────────────
router.get('/pool-compare', requireAuth, async (req, res, next) => {
  try {
    res.json(await _buildPoolCompareResponse(req.query.targets));
  } catch (err) { next(err); }
});

// ── GET /api/oracle/wallet-asset-snapshot ───────────────────────────────────
router.get('/wallet-asset-snapshot', requireAuth, async (req, res, next) => {
  try {
    const walletAddress = String(req.query.walletAddress || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({ error: 'wallet_address_invalid' });
    }

    res.json(await _buildWalletAssetSnapshotResponse(walletAddress));
  } catch (err) { next(err); }
});

// ── GET /api/oracle/prediction-market-check ─────────────────────────────────
router.get('/prediction-market-check', requireAuth, async (req, res, next) => {
  try {
    res.json(await _buildPredictionMarketCheckResponse(req.query.topic, req.query.limit));
  } catch (err) { next(err); }
});

// ── GET /api/oracle/event-odds-compare ──────────────────────────────────────
router.get('/event-odds-compare', requireAuth, async (req, res, next) => {
  try {
    res.json(await _buildEventOddsCompareResponse(req.query.primaryTopic, req.query.secondaryTopic, req.query.limit));
  } catch (err) { next(err); }
});

// ── GET /api/oracle/yield-rank ────────────────────────────────────────────────
// ?asset=USDC&minApy=1.0   (defaults)
router.get('/yield-rank', requireAuth, async (req, res, next) => {
  try {
    const asset  = (req.query.asset  || 'USDC').toString().toUpperCase();
    const minApy = parseFloat(req.query.minApy || '1.0');

    const protocols = await oracle.getYieldOpportunities(asset, isNaN(minApy) ? 1.0 : minApy);

    const recommendation = protocols[0]
      ? {
          protocol:  protocols[0].name,
          apy:       protocols[0].apy,
          reasoning: `Highest APY among known ARC testnet protocols for ${asset}`,
        }
      : null;

    res.json({
      asset,
      timestamp:      new Date().toISOString(),
      protocols,
      isFallback: protocols.some(item => item.isFallback),
      recommendation,
    });
  } catch (err) { next(err); }
});

// ── GET /api/oracle/arb-signal ────────────────────────────────────────────────
// ?strategy=stablecoin_fx&agentId=<id>
// Requires oracle_enabled = true on the agent (opt-in guard)
router.get('/arb-signal', requireAuth, async (req, res, next) => {
  try {
    const strategy = (req.query.strategy || 'stablecoin_fx').toString();
    const agentId  = req.query.agentId?.toString();

    // Opt-in guard — only if agentId provided and oracle_enabled check requested
    if (agentId) {
      const agent = await agentService.getAgent(agentId, req.user.userId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      if (!agent.features?.oracleEnabled) {
        return res.status(403).json({
          error:   'oracle_disabled',
          message: 'Enable the Oracle Data Feed feature on your agent first.',
        });
      }
    }

    if (strategy === 'stablecoin_fx') {
      return res.json(await _buildStablecoinArbSignalResponse('EURC-USDC', 'curve'));
    }

    res.status(400).json({ error: `Unknown strategy: ${strategy}`, supported: ['stablecoin_fx'] });
  } catch (err) { next(err); }
});

// ── GET /api/oracle/arb-scan-multi ──────────────────────────────────────────
router.get('/arb-scan-multi', requireAuth, async (req, res, next) => {
  try {
    const agentId = req.query.agentId?.toString();

    if (agentId) {
      const agent = await agentService.getAgent(agentId, req.user.userId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      if (!agent.features?.oracleEnabled) {
        return res.status(403).json({
          error: 'oracle_disabled',
          message: 'Enable the Oracle Data Feed feature on your agent first.',
        });
      }
    }

    res.json(await _buildArbScanMultiResponse(req.query.targets));
  } catch (err) { next(err); }
});

// ── PUBLIC endpoints (Circle Gateway x402 — no JWT required) ─────────────────
// These are accessible by anyone on the internet; payment is the only gate.

const publicRouter = require('express').Router();  // no requireAuth
publicRouter.use(publicOracleRateLimit);
publicRouter.use(_publicOracleAbuseGuard);

// GET /api/oracle/public/stablecoin-fx
publicRouter.get('/stablecoin-fx', _createPublicOracleQueryGuard('stablecoin-fx'), _createOraclePaymentAuditMiddleware('stablecoin-fx'), stablecoinFxGateway, async (req, res, next) => {
  try {
    const pairParam = (req.query.pair || 'EURC/USDC').toString().toUpperCase();
    const [base, quote = 'USDC'] = pairParam.split('/');
    res.json(await _buildStablecoinFxResponse(base, quote));
  } catch (err) { next(err); }
});

// GET /api/oracle/public/pool-state
publicRouter.get('/pool-state', _createPublicOracleQueryGuard('pool-state'), _createOraclePaymentAuditMiddleware('pool-state'), poolStateGateway, async (req, res, next) => {
  try {
    const snapshot = await _getOraclePoolStateSnapshot(req.query.pool || 'USDC-EURC', req.query.venue || 'curve');
    res.json({
      venue: snapshot.venue,
      poolKey: snapshot.poolKey,
      note: snapshot.note,
      pool: snapshot.pool
        ? {
            address: snapshot.pool.address,
            protocol: snapshot.pool.protocol,
            venue: snapshot.pool.venue,
            source: snapshot.pool.source,
            liquidityState: snapshot.pool.liquidityState,
            baseToken: snapshot.pool.baseToken.symbol,
            quoteToken: snapshot.pool.quoteToken.symbol,
          }
        : null,
      state: snapshot.state,
      isFallback: snapshot.state?.isFallback === true || snapshot.state?.source === 'mock_testnet',
    });
  } catch (err) { next(err); }
});

// GET /api/oracle/public/peg-monitor
publicRouter.get('/peg-monitor', _createPublicOracleQueryGuard('peg-monitor'), _createOraclePaymentAuditMiddleware('peg-monitor'), pegMonitorGateway, async (req, res, next) => {
  try {
    res.json(await _buildPegMonitorResponse(req.query.assets));
  } catch (err) { next(err); }
});

if (ORACLE_PUBLIC_RESERVE_STATE_ENABLED) {
  // GET /api/oracle/public/reserve-state
  publicRouter.get('/reserve-state', _createPublicOracleQueryGuard('reserve-state'), _createOraclePaymentAuditMiddleware('reserve-state'), reserveStateGateway, async (req, res, next) => {
    try {
      res.json(await _buildReserveStateResponse(req.query.assets));
    } catch (err) { next(err); }
  });
}

// GET /api/oracle/public/pool-compare
publicRouter.get('/pool-compare', _createPublicOracleQueryGuard('pool-compare'), _createOraclePaymentAuditMiddleware('pool-compare'), poolCompareGateway, async (req, res, next) => {
  try {
    res.json(await _buildPoolCompareResponse(req.query.targets));
  } catch (err) { next(err); }
});

// GET /api/oracle/public/wallet-asset-snapshot
publicRouter.get('/wallet-asset-snapshot', _createPublicOracleQueryGuard('wallet-asset-snapshot'), _createOraclePaymentAuditMiddleware('wallet-asset-snapshot'), walletAssetSnapshotGateway, async (req, res, next) => {
  try {
    res.json(await _buildWalletAssetSnapshotResponse(req.query.walletAddress));
  } catch (err) { next(err); }
});

// GET /api/oracle/public/prediction-market-check
publicRouter.get('/prediction-market-check', _createPublicOracleQueryGuard('prediction-market-check'), _createOraclePaymentAuditMiddleware('prediction-market-check'), predictionMarketCheckGateway, async (req, res, next) => {
  try {
    res.json(await _buildPredictionMarketCheckResponse(req.query.topic, req.query.limit));
  } catch (err) { next(err); }
});

// GET /api/oracle/public/event-odds-compare
publicRouter.get('/event-odds-compare', _createPublicOracleQueryGuard('event-odds-compare'), _createOraclePaymentAuditMiddleware('event-odds-compare'), eventOddsCompareGateway, async (req, res, next) => {
  try {
    res.json(await _buildEventOddsCompareResponse(req.query.primaryTopic, req.query.secondaryTopic, req.query.limit));
  } catch (err) { next(err); }
});

// GET /api/oracle/public/arb-signal
// Redacted: confidence=LOW results only return summary; HIGH returns full signal (higher price)
publicRouter.get('/arb-signal', _createPublicOracleQueryGuard('arb-signal'), _createOraclePaymentAuditMiddleware('arb-signal'), arbSignalGateway, async (req, res, next) => {
  try {
    res.json(await _buildStablecoinArbSignalResponse('EURC-USDC', 'curve'));
  } catch (err) { next(err); }
});

// GET /api/oracle/public/arb-scan-multi
publicRouter.get('/arb-scan-multi', _createPublicOracleQueryGuard('arb-scan-multi'), _createOraclePaymentAuditMiddleware('arb-scan-multi'), arbScanMultiGateway, async (req, res, next) => {
  try {
    res.json(await _buildArbScanMultiResponse(req.query.targets));
  } catch (err) { next(err); }
});

// GET /api/oracle/public/revenue — total collected fees (public, no auth, transparency)
publicRouter.get('/revenue', _createPublicOracleQueryGuard('revenue'), async (_req, res, next) => {
  try {
    res.json(await _getOracleRevenueStats());
  } catch (err) { next(err); }
});

router.use('/public', publicRouter);

module.exports = router;
module.exports._decodeOracleGatewayPaymentResponse = _decodeOracleGatewayPaymentResponse;
module.exports._recordOracleGatewaySettlement = _recordOracleGatewaySettlement;

