'use strict';

const axios = require('axios');
const { getCache, setCache, TTL } = require('./oracle/cache');

const POLYMARKET_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
const POLYMARKET_MARKETS_URL = 'https://gamma-api.polymarket.com/markets';
const DEFAULT_TOPIC = 'crypto';
const DEFAULT_MATCH_LIMIT = 5;
const DEFAULT_EVENT_FETCH_LIMIT = 40;
const DEFAULT_MARKET_FETCH_LIMIT = 120;
const PULSE_CACHE_TTL = TTL.YIELD_RANK;
const DEFAULT_COMPARE_PRIMARY_TOPIC = 'bitcoin';
const DEFAULT_COMPARE_SECONDARY_TOPIC = 'ethereum';

const TOPIC_KEYWORDS = Object.freeze({
  crypto: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'stablecoin', 'usdc', 'usdt', 'eurc', 'defi', 'etf'],
  stablecoin: ['stablecoin', 'stablecoins', 'usdc', 'usdt', 'eurc', 'peg', 'circle'],
  bitcoin: ['bitcoin', 'btc', 'mstr', 'microstrategy', 'saylor', 'etf'],
  ethereum: ['ethereum', 'eth', 'ether', 'staking', 'l2', 'layer 2'],
  macro: ['macro', 'fed', 'rates', 'inflation', 'recession', 'economy', 'treasury', 'cpi'],
  politics: ['politics', 'election', 'president', 'congress', 'senate', 'white house', 'trump', 'biden'],
});

function _normalizeTopic(topic) {
  const normalized = String(topic || '').trim().toLowerCase().slice(0, 80);
  return normalized || DEFAULT_TOPIC;
}

function _safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function _toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function _dedupeMarkets(markets) {
  const seen = new Set();
  const result = [];

  for (const market of markets || []) {
    const key = String(market?.id || market?.conditionId || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(market);
  }

  return result;
}

function _flattenEventMarkets(events) {
  return (events || []).flatMap(event => {
    const eventMarkets = Array.isArray(event?.markets) ? event.markets : [];

    return eventMarkets.map(market => ({
      ...market,
      _eventTitle: event?.title || null,
      _eventSlug: event?.slug || null,
    }));
  });
}

function _buildTopicKeywords(topic) {
  const normalizedTopic = _normalizeTopic(topic);
  const phraseParts = normalizedTopic.split(/\s+/).filter(Boolean);
  const keywords = new Set([normalizedTopic]);

  for (const keyword of TOPIC_KEYWORDS[normalizedTopic] || []) {
    keywords.add(keyword);
  }

  for (const part of phraseParts) {
    if (part.length >= 3) keywords.add(part);
  }

  return [...keywords];
}

function _escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _containsKeyword(haystack, keyword) {
  if (!haystack || !keyword) return false;

  const expression = new RegExp(`(^|[^a-z0-9])${_escapeRegex(keyword)}([^a-z0-9]|$)`, 'i');
  return expression.test(haystack);
}

function _scoreMarket(rawMarket, topic, keywords) {
  const headline = [
    rawMarket?.question,
    rawMarket?.slug,
    rawMarket?._eventTitle,
    rawMarket?._eventSlug,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!headline) return 0;

  let score = 0;
  if (_containsKeyword(headline, topic)) score += 10;

  for (const keyword of keywords) {
    if (_containsKeyword(headline, keyword)) score += 2;
  }

  if (score > 0 && rawMarket?.featured) score += 1;
  if (rawMarket?._eventTitle && _containsKeyword(String(rawMarket._eventTitle).toLowerCase(), topic)) score += 3;

  return score;
}

function _filterMarketsByTopic(markets, topic) {
  const normalizedTopic = _normalizeTopic(topic);
  const keywords = _buildTopicKeywords(normalizedTopic);

  return (markets || [])
    .map(market => ({ market, score: _scoreMarket(market, normalizedTopic, keywords) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return _toFiniteNumber(right.market?.volume24hr) - _toFiniteNumber(left.market?.volume24hr);
    })
    .map(entry => entry.market);
}

function _normalizeMarket(rawMarket) {
  if (!rawMarket || rawMarket.closed === true || rawMarket.active === false) return null;

  const outcomes = _safeJsonArray(rawMarket.outcomes);
  const outcomePrices = _safeJsonArray(rawMarket.outcomePrices).map(value => _toFiniteNumber(value, NaN));
  const marketSlug = rawMarket.slug || null;
  const eventSlug = rawMarket._eventSlug || rawMarket.events?.[0]?.slug || null;
  const yesIndex = outcomes.findIndex(outcome => String(outcome || '').toLowerCase() === 'yes');
  const normalizedYesIndex = yesIndex >= 0 ? yesIndex : 0;
  const yesProbability = outcomePrices[normalizedYesIndex];
  const noProbability = outcomePrices.length > 1
    ? outcomePrices[(normalizedYesIndex + 1) % outcomePrices.length]
    : Number.isFinite(yesProbability) ? 1 - yesProbability : NaN;

  return {
    marketId: String(rawMarket.id || rawMarket.conditionId || '').trim(),
    question: rawMarket.question || rawMarket.title || 'Untitled market',
    eventTitle: rawMarket._eventTitle || rawMarket.events?.[0]?.title || null,
    url: eventSlug && marketSlug
      ? `https://polymarket.com/event/${eventSlug}/${marketSlug}`
      : marketSlug
        ? `https://polymarket.com/market/${marketSlug}`
        : null,
    yesProbabilityPct: Number.isFinite(yesProbability) ? Math.round(yesProbability * 10_000) / 100 : null,
    noProbabilityPct: Number.isFinite(noProbability) ? Math.round(noProbability * 10_000) / 100 : null,
    oneDayPriceChangePct: Math.round(Math.abs(_toFiniteNumber(rawMarket.oneDayPriceChange, 0)) * 10_000) / 100,
    volume24hrUsd: Math.round(_toFiniteNumber(rawMarket.volume24hr, 0) * 100) / 100,
    liquidityUsd: Math.round(_toFiniteNumber(rawMarket.liquidity, rawMarket.liquidityClob) * 100) / 100,
    endDate: rawMarket.endDate || null,
    source: 'polymarket',
  };
}

function _average(values) {
  const finiteValues = values.filter(value => Number.isFinite(value));
  if (!finiteValues.length) return null;

  const total = finiteValues.reduce((sum, value) => sum + value, 0);
  return total / finiteValues.length;
}

function _buildNoMatchSnapshot(topic, scannedMarketCount) {
  return {
    topic,
    provider: 'polymarket',
    status: 'no_match',
    regime: 'NO_MATCH',
    confidence: 'LOW',
    summary: `No active Polymarket crypto markets matched "${topic}". Try a broader topic like crypto, bitcoin, ethereum, or stablecoin.`,
    actionHint: 'Keep this card in research mode for now and use a broader topic before choosing the next Arc action.',
    recommendedTaskId: null,
    metrics: {
      matchingMarkets: 0,
      scannedMarkets: scannedMarketCount,
      averageYesProbabilityPct: null,
      averageOneDayMovePct: null,
      averageLiquidityUsd: null,
      totalVolume24hrUsd: 0,
    },
    highlights: [],
    methodology: 'This live card filters active Polymarket crypto markets by topic, then scores short-term movement and liquidity.',
    isFallback: false,
    fallbackReason: null,
    fetchedAt: new Date().toISOString(),
  };
}

function _buildFallbackSnapshot(topic, reason) {
  return {
    topic,
    provider: 'polymarket',
    status: 'fallback',
    regime: 'UNAVAILABLE',
    confidence: 'LOW',
    summary: 'Live prediction market data is temporarily unavailable. Retry this check before using it to guide an Arc move.',
    actionHint: 'Do not treat this as a live signal until the provider responds again.',
    recommendedTaskId: null,
    metrics: {
      matchingMarkets: 0,
      scannedMarkets: 0,
      averageYesProbabilityPct: null,
      averageOneDayMovePct: null,
      averageLiquidityUsd: null,
      totalVolume24hrUsd: null,
    },
    highlights: [],
    methodology: 'This live card normally scores active Polymarket crypto markets by movement and liquidity.',
    isFallback: true,
    fallbackReason: reason,
    fetchedAt: new Date().toISOString(),
  };
}

function _buildPulseSnapshot(topic, normalizedMarkets, scannedMarketCount) {
  if (!normalizedMarkets.length) {
    return _buildNoMatchSnapshot(topic, scannedMarketCount);
  }

  const averageYesProbabilityPct = _average(normalizedMarkets.map(market => market.yesProbabilityPct));
  const averageOneDayMovePct = _average(normalizedMarkets.map(market => market.oneDayPriceChangePct)) || 0;
  const averageLiquidityUsd = _average(normalizedMarkets.map(market => market.liquidityUsd)) || 0;
  const totalVolume24hrUsd = normalizedMarkets.reduce((sum, market) => sum + _toFiniteNumber(market.volume24hrUsd, 0), 0);
  const maxOneDayMovePct = normalizedMarkets.reduce(
    (highest, market) => Math.max(highest, _toFiniteNumber(market.oneDayPriceChangePct, 0)),
    0,
  );

  let regime = 'CALM';
  if (averageOneDayMovePct >= 6 || maxOneDayMovePct >= 12 || averageLiquidityUsd < 20_000) {
    regime = 'UNSTABLE';
  } else if (averageOneDayMovePct >= 3 || averageLiquidityUsd < 50_000) {
    regime = 'ELEVATED';
  }

  let confidence = 'LOW';
  if (normalizedMarkets.length >= 5 && totalVolume24hrUsd >= 500_000 && averageLiquidityUsd >= 50_000) {
    confidence = 'HIGH';
  } else if (normalizedMarkets.length >= 3 && totalVolume24hrUsd >= 100_000) {
    confidence = 'MEDIUM';
  }

  const recommendedTaskId = regime === 'UNSTABLE' ? 'EXEC_CCTP_BRIDGE' : 'EXEC_REBALANCE';
  const summaryByRegime = {
    CALM: `Prediction markets look calm for "${topic}" right now. The matched markets are liquid enough and short-term moves remain contained.`,
    ELEVATED: `Prediction markets around "${topic}" are showing elevated movement. The setup still looks actionable, but not quiet.`,
    UNSTABLE: `Prediction markets around "${topic}" are moving fast enough to treat the setup as unstable. That raises the bar for staying aggressively positioned on Arc.`,
  };
  const actionHintByRegime = {
    CALM: 'Stay on Arc and rebalance only if the stablecoin mix still needs adjustment.',
    ELEVATED: 'Stay on Arc if needed, but rebalance cautiously instead of treating this as a clean risk-on setup.',
    UNSTABLE: 'Consider a defensive bridge before the next Arc execution if capital preservation matters more than staying local.',
  };

  return {
    topic,
    provider: 'polymarket',
    status: 'live',
    regime,
    confidence,
    summary: `${summaryByRegime[regime]} Avg 24h move: ${averageOneDayMovePct.toFixed(2)}%. 24h matched volume: $${Math.round(totalVolume24hrUsd).toLocaleString('en-US')}.`,
    actionHint: actionHintByRegime[regime],
    recommendedTaskId,
    metrics: {
      matchingMarkets: normalizedMarkets.length,
      scannedMarkets: scannedMarketCount,
      averageYesProbabilityPct: averageYesProbabilityPct != null ? Math.round(averageYesProbabilityPct * 100) / 100 : null,
      averageOneDayMovePct: Math.round(averageOneDayMovePct * 100) / 100,
      averageLiquidityUsd: Math.round(averageLiquidityUsd * 100) / 100,
      totalVolume24hrUsd: Math.round(totalVolume24hrUsd * 100) / 100,
    },
    highlights: normalizedMarkets,
    methodology: 'This live card filters active Polymarket crypto markets by topic, then scores short-term movement and liquidity instead of trying to infer event semantics.',
    isFallback: false,
    fallbackReason: null,
    fetchedAt: new Date().toISOString(),
  };
}

function _buildCompareNoMatchSnapshot(topic, scannedMarketCount) {
  return {
    topic,
    provider: 'polymarket',
    status: 'no_match',
    regime: 'NO_MATCH',
    confidence: 'LOW',
    summary: `Not enough active Polymarket markets matched "${topic}" for a real comparison yet. Try a broader topic like crypto, bitcoin, ethereum, or stablecoin.`,
    actionHint: 'Keep this card in research mode until at least two liquid markets match the topic.',
    recommendedTaskId: null,
    metrics: {
      matchingMarkets: 0,
      scannedMarkets: scannedMarketCount,
      averageYesProbabilityPct: null,
      averageOneDayMovePct: null,
      averageLiquidityUsd: null,
      totalVolume24hrUsd: 0,
      probabilitySpreadPct: null,
    },
    highlights: [],
    methodology: 'This live card compares the strongest active Polymarket matches for a topic and scores disagreement, movement, and liquidity.',
    isFallback: false,
    fallbackReason: null,
    fetchedAt: new Date().toISOString(),
  };
}

function _resolveComparisonSecondaryTopic(primaryTopic) {
  const fallbacks = [DEFAULT_COMPARE_SECONDARY_TOPIC, 'stablecoin', 'macro', 'crypto'];
  return fallbacks.find(candidate => candidate !== primaryTopic) || DEFAULT_COMPARE_SECONDARY_TOPIC;
}

function _normalizeCompareTopics(primaryTopic, secondaryTopic) {
  const normalizedPrimaryTopic = _normalizeTopic(primaryTopic || DEFAULT_COMPARE_PRIMARY_TOPIC);
  const rawSecondaryTopic = _normalizeTopic(secondaryTopic || _resolveComparisonSecondaryTopic(normalizedPrimaryTopic));
  const normalizedSecondaryTopic = rawSecondaryTopic === normalizedPrimaryTopic
    ? _resolveComparisonSecondaryTopic(normalizedPrimaryTopic)
    : rawSecondaryTopic;

  return {
    primaryTopic: normalizedPrimaryTopic,
    secondaryTopic: normalizedSecondaryTopic,
  };
}

function _buildTopicMarketSlice(topic, normalizedMarkets, scannedMarketCount) {
  if (!normalizedMarkets.length) {
    return {
      topic,
      matchingMarkets: 0,
      scannedMarkets: scannedMarketCount,
      regime: 'NO_MATCH',
      averageYesProbabilityPct: null,
      averageOneDayMovePct: null,
      averageLiquidityUsd: null,
      totalVolume24hrUsd: 0,
      topMarket: null,
      highlights: [],
      pressureScore: 0,
    };
  }

  const averageYesProbabilityPct = _average(normalizedMarkets.map(market => market.yesProbabilityPct));
  const averageOneDayMovePct = _average(normalizedMarkets.map(market => market.oneDayPriceChangePct)) || 0;
  const averageLiquidityUsd = _average(normalizedMarkets.map(market => market.liquidityUsd)) || 0;
  const totalVolume24hrUsd = normalizedMarkets.reduce((sum, market) => sum + _toFiniteNumber(market.volume24hrUsd, 0), 0);
  const maxOneDayMovePct = normalizedMarkets.reduce(
    (highest, market) => Math.max(highest, _toFiniteNumber(market.oneDayPriceChangePct, 0)),
    0,
  );

  let regime = 'CALM';
  if (averageOneDayMovePct >= 6 || maxOneDayMovePct >= 12 || averageLiquidityUsd < 20_000) {
    regime = 'UNSTABLE';
  } else if (averageOneDayMovePct >= 3 || averageLiquidityUsd < 50_000) {
    regime = 'ELEVATED';
  }

  const topMarket = normalizedMarkets[0] || null;
  const pressureScore = averageOneDayMovePct
    + (regime === 'UNSTABLE' ? 4 : regime === 'ELEVATED' ? 2 : 0)
    + (topMarket?.oneDayPriceChangePct || 0) * 0.15;

  return {
    topic,
    matchingMarkets: normalizedMarkets.length,
    scannedMarkets: scannedMarketCount,
    regime,
    averageYesProbabilityPct: averageYesProbabilityPct != null ? Math.round(averageYesProbabilityPct * 100) / 100 : null,
    averageOneDayMovePct: Math.round(averageOneDayMovePct * 100) / 100,
    averageLiquidityUsd: Math.round(averageLiquidityUsd * 100) / 100,
    totalVolume24hrUsd: Math.round(totalVolume24hrUsd * 100) / 100,
    topMarket,
    highlights: normalizedMarkets,
    pressureScore: Math.round(pressureScore * 100) / 100,
  };
}

function _buildCompareFallbackSnapshot(topic, reason) {
  return {
    topic,
    provider: 'polymarket',
    status: 'fallback',
    regime: 'UNAVAILABLE',
    confidence: 'LOW',
    summary: 'Live event-odds comparison is temporarily unavailable. Retry before using this result to guide an Arc move.',
    actionHint: 'Do not treat this as a live comparison until the provider responds again.',
    recommendedTaskId: null,
    metrics: {
      matchingMarkets: 0,
      scannedMarkets: 0,
      averageYesProbabilityPct: null,
      averageOneDayMovePct: null,
      averageLiquidityUsd: null,
      totalVolume24hrUsd: null,
      probabilitySpreadPct: null,
    },
    highlights: [],
    methodology: 'This live card normally compares the strongest active Polymarket matches for a topic and scores disagreement, movement, and liquidity.',
    isFallback: true,
    fallbackReason: reason,
    fetchedAt: new Date().toISOString(),
  };
}

function _buildEventOddsCompareSnapshot(primaryTopic, secondaryTopic, primaryMarkets, secondaryMarkets, scannedMarketCount) {
  if (!primaryMarkets.length || !secondaryMarkets.length) {
    return _buildCompareNoMatchSnapshot(`${primaryTopic} vs ${secondaryTopic}`, scannedMarketCount);
  }

  const primary = _buildTopicMarketSlice(primaryTopic, primaryMarkets, scannedMarketCount);
  const secondary = _buildTopicMarketSlice(secondaryTopic, secondaryMarkets, scannedMarketCount);
  const movementGapPct = Math.abs((primary.averageOneDayMovePct || 0) - (secondary.averageOneDayMovePct || 0));
  const liquidityGapUsd = Math.abs((primary.averageLiquidityUsd || 0) - (secondary.averageLiquidityUsd || 0));
  const pressureGap = Math.abs((primary.pressureScore || 0) - (secondary.pressureScore || 0));
  const combinedVolume24hrUsd = (primary.totalVolume24hrUsd || 0) + (secondary.totalVolume24hrUsd || 0);
  const combinedMatchingMarkets = (primary.matchingMarkets || 0) + (secondary.matchingMarkets || 0);

  const dominantTopic = pressureGap < 1
    ? null
    : primary.pressureScore > secondary.pressureScore
      ? primary.topic
      : secondary.topic;

  let comparisonState = 'aligned';
  if (
    primary.regime === 'UNSTABLE'
    || secondary.regime === 'UNSTABLE'
    || movementGapPct >= 4
    || pressureGap >= 4
  ) {
    comparisonState = 'divergent';
  } else if (
    primary.regime !== secondary.regime
    || movementGapPct >= 1.5
    || pressureGap >= 1.5
  ) {
    comparisonState = 'split';
  }

  const regime = comparisonState === 'divergent'
    ? 'UNSTABLE'
    : comparisonState === 'split'
      ? 'ELEVATED'
      : 'CALM';

  let confidence = 'LOW';
  if (combinedMatchingMarkets >= 6 && combinedVolume24hrUsd >= 250_000) {
    confidence = 'HIGH';
  } else if (combinedMatchingMarkets >= 4 && combinedVolume24hrUsd >= 100_000) {
    confidence = 'MEDIUM';
  }

  const recommendedTaskId = regime === 'UNSTABLE' ? 'EXEC_CCTP_BRIDGE' : 'EXEC_REBALANCE';
  const summaryByState = {
    aligned: dominantTopic
      ? `${primaryTopic} and ${secondaryTopic} are telling a similar story right now, even though ${dominantTopic} is moving a bit faster.`
      : `${primaryTopic} and ${secondaryTopic} are telling a similar story right now, without a strong split between them.`,
    split: dominantTopic
      ? `${dominantTopic} is running hotter than the other topic, so the comparison is no longer clean enough to treat as one simple risk read.`
      : `${primaryTopic} and ${secondaryTopic} are no longer fully aligned, so the setup deserves a more cautious read than a single-topic pulse.`,
    divergent: dominantTopic
      ? `${dominantTopic} is clearly running hotter than the other topic. That divergence is strong enough to treat as a separate defensive signal, not a cosmetic comparison.`
      : `${primaryTopic} and ${secondaryTopic} are sharply split. That divergence raises the bar for staying aggressively positioned on Arc.`,
  };
  const actionHintByState = {
    aligned: 'Stay on Arc unless the wallet mix still needs a normal rebalance after reviewing both sides.',
    split: 'Prefer a measured rebalance after reviewing both topics side by side instead of treating one topic as the whole story.',
    divergent: 'Consider a defensive bridge before the next Arc execution if the hotter topic is driving a broader risk-off setup.',
  };

  return {
    primaryTopic,
    secondaryTopic,
    provider: 'polymarket',
    status: 'live',
    regime,
    confidence,
    summary: `${summaryByState[comparisonState]} Move gap: ${movementGapPct.toFixed(2)}%. Combined 24h volume: $${Math.round(combinedVolume24hrUsd).toLocaleString('en-US')}.`,
    actionHint: actionHintByState[comparisonState],
    recommendedTaskId,
    metrics: {
      matchingMarkets: combinedMatchingMarkets,
      scannedMarkets: scannedMarketCount,
      averageOneDayMovePct: Math.round((((primary.averageOneDayMovePct || 0) + (secondary.averageOneDayMovePct || 0)) / 2) * 100) / 100,
      averageLiquidityUsd: Math.round((((primary.averageLiquidityUsd || 0) + (secondary.averageLiquidityUsd || 0)) / 2) * 100) / 100,
      totalVolume24hrUsd: Math.round(combinedVolume24hrUsd * 100) / 100,
      movementGapPct: Math.round(movementGapPct * 100) / 100,
      liquidityGapUsd: Math.round(liquidityGapUsd * 100) / 100,
      primaryMatchingMarkets: primary.matchingMarkets,
      secondaryMatchingMarkets: secondary.matchingMarkets,
    },
    comparison: {
      state: comparisonState,
      dominantTopic,
      movementGapPct: Math.round(movementGapPct * 100) / 100,
      liquidityGapUsd: Math.round(liquidityGapUsd * 100) / 100,
      primary,
      secondary,
    },
    highlights: {
      primary: primary.highlights,
      secondary: secondary.highlights,
    },
    methodology: 'This live card compares two separate topic clusters on Polymarket and scores whether they stay aligned, split, or diverge enough to justify a different Arc action.',
    isFallback: false,
    fallbackReason: null,
    fetchedAt: new Date().toISOString(),
  };
}

async function _getNormalizedPredictionMarkets({ topic, limit = DEFAULT_MATCH_LIMIT } = {}) {
  const normalizedTopic = _normalizeTopic(topic);
  const normalizedLimit = Math.min(Math.max(parseInt(limit || DEFAULT_MATCH_LIMIT, 10), 1), 8);
  const { cryptoEventMarkets, openMarkets } = await _fetchPolymarketCandidates();
  const combinedMarkets = _dedupeMarkets([...cryptoEventMarkets, ...openMarkets]);

  let candidateMarkets;
  if (normalizedTopic === DEFAULT_TOPIC) {
    candidateMarkets = cryptoEventMarkets;
  } else {
    candidateMarkets = _filterMarketsByTopic(combinedMarkets, normalizedTopic);
  }

  const normalizedMarkets = candidateMarkets
    .map(_normalizeMarket)
    .filter(Boolean)
    .sort((left, right) => {
      if (right.volume24hrUsd !== left.volume24hrUsd) return right.volume24hrUsd - left.volume24hrUsd;
      return right.liquidityUsd - left.liquidityUsd;
    })
    .slice(0, normalizedLimit);

  return {
    normalizedTopic,
    normalizedMarkets,
    scannedMarketCount: combinedMarkets.length,
  };
}

async function _fetchPolymarketCandidates() {
  const [eventResponse, marketResponse] = await Promise.all([
    axios.get(POLYMARKET_EVENTS_URL, {
      params: {
        limit: DEFAULT_EVENT_FETCH_LIMIT,
        closed: false,
        tag_slug: 'crypto',
      },
      timeout: 8000,
    }),
    axios.get(POLYMARKET_MARKETS_URL, {
      params: {
        limit: DEFAULT_MARKET_FETCH_LIMIT,
        closed: false,
      },
      timeout: 8000,
    }),
  ]);

  const eventMarkets = _flattenEventMarkets(Array.isArray(eventResponse.data) ? eventResponse.data : []);
  const openMarkets = Array.isArray(marketResponse.data) ? marketResponse.data : [];

  return {
    cryptoEventMarkets: _dedupeMarkets(eventMarkets),
    openMarkets: _dedupeMarkets(openMarkets),
  };
}

async function getPredictionMarketPulse({ topic, limit = DEFAULT_MATCH_LIMIT } = {}) {
  const normalizedTopic = _normalizeTopic(topic);
  const normalizedLimit = Math.min(Math.max(parseInt(limit || DEFAULT_MATCH_LIMIT, 10), 1), 8);
  const cacheKey = `prediction_market_pulse:${normalizedTopic}:${normalizedLimit}`;
  const cached = getCache(cacheKey);

  if (cached) return cached;

  try {
    const { normalizedMarkets, scannedMarketCount } = await _getNormalizedPredictionMarkets({
      topic: normalizedTopic,
      limit: normalizedLimit,
    });
    const result = _buildPulseSnapshot(normalizedTopic, normalizedMarkets, scannedMarketCount);
    setCache(cacheKey, result, PULSE_CACHE_TTL);
    return result;
  } catch (error) {
    const fallback = _buildFallbackSnapshot(normalizedTopic, error.message || 'api_unreachable');
    setCache(cacheKey, fallback, PULSE_CACHE_TTL);
    return fallback;
  }
}

async function getEventOddsCompare({ primaryTopic, secondaryTopic, limit = DEFAULT_MATCH_LIMIT } = {}) {
  const topics = _normalizeCompareTopics(primaryTopic, secondaryTopic);
  const normalizedLimit = Math.min(Math.max(parseInt(limit || DEFAULT_MATCH_LIMIT, 10), 2), 8);
  const cacheKey = `event_odds_compare:${topics.primaryTopic}:${topics.secondaryTopic}:${normalizedLimit}`;
  const cached = getCache(cacheKey);

  if (cached) return cached;

  try {
    const [primaryResult, secondaryResult] = await Promise.all([
      _getNormalizedPredictionMarkets({
        topic: topics.primaryTopic,
        limit: normalizedLimit,
      }),
      _getNormalizedPredictionMarkets({
        topic: topics.secondaryTopic,
        limit: normalizedLimit,
      }),
    ]);
    const result = _buildEventOddsCompareSnapshot(
      topics.primaryTopic,
      topics.secondaryTopic,
      primaryResult.normalizedMarkets,
      secondaryResult.normalizedMarkets,
      Math.max(primaryResult.scannedMarketCount, secondaryResult.scannedMarketCount),
    );
    setCache(cacheKey, result, PULSE_CACHE_TTL);
    return result;
  } catch (error) {
    const fallback = _buildCompareFallbackSnapshot(`${topics.primaryTopic} vs ${topics.secondaryTopic}`, error.message || 'api_unreachable');
    setCache(cacheKey, fallback, PULSE_CACHE_TTL);
    return fallback;
  }
}

module.exports = {
  getEventOddsCompare,
  getPredictionMarketPulse,
};