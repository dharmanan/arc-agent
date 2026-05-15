'use strict';

const db = require('../../db');
const { URL } = require('url');

const MAX_RECENT_DELIVERIES = 25;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

const DEFAULT_THRESHOLDS = Object.freeze({
  payment_challenge: 20,
  rate_limited: 5,
  server_error: 1,
  settlement_failure: 1,
  gateway_unavailable: 1,
  fallback: 5,
});

const state = {
  storedCount: 0,
  sentCount: 0,
  suppressedCount: 0,
  failedCount: 0,
  lastSentAt: null,
  lastError: null,
  recentDeliveries: [],
  lastTriggeredCounts: Object.create(null),
};

function _normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(meta).filter(([, value]) => value !== undefined),
  );
}

function _pushRecent(delivery) {
  state.recentDeliveries.unshift(delivery);
  if (state.recentDeliveries.length > MAX_RECENT_DELIVERIES) {
    state.recentDeliveries.length = MAX_RECENT_DELIVERIES;
  }
}

function _resolveWebhookUrl() {
  const value = String(process.env.ORACLE_ALERT_WEBHOOK_URL || '').trim();
  return value || null;
}

function _parseJsonEnv(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _resolveTimeoutMs() {
  const parsed = Number.parseInt(process.env.ORACLE_ALERT_WEBHOOK_TIMEOUT_MS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_WEBHOOK_TIMEOUT_MS;
}

function _normalizeHeaderMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, headerValue]) => [String(key || '').trim(), headerValue])
      .filter(([key, headerValue]) => key && headerValue != null)
      .map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

function _resolveLegacyHeaders() {
  const headers = _normalizeHeaderMap(_parseJsonEnv('ORACLE_ALERT_WEBHOOK_HEADERS_JSON'));
  const bearerToken = String(process.env.ORACLE_ALERT_WEBHOOK_BEARER_TOKEN || '').trim();
  if (bearerToken && !headers.authorization) {
    headers.authorization = `Bearer ${bearerToken}`;
  }
  return headers;
}

function _maskTargetUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid_url';
  }
}

function _normalizeSinkDefinition(entry, index, fallbackHeaders = {}) {
  if (!entry) return null;

  const url = typeof entry === 'string'
    ? String(entry).trim()
    : String(entry.url || '').trim();

  if (!url) return null;

  return {
    name: typeof entry === 'string'
      ? `external-sink-${index + 1}`
      : String(entry.name || `external-sink-${index + 1}`).trim() || `external-sink-${index + 1}`,
    url,
    headers: typeof entry === 'string'
      ? { ...fallbackHeaders }
      : {
          ...fallbackHeaders,
          ..._normalizeHeaderMap(entry.headers),
        },
  };
}

function _resolveWebhookTargets() {
  const configuredTargets = _parseJsonEnv('ORACLE_ALERT_WEBHOOK_TARGETS_JSON');
  const fallbackHeaders = _resolveLegacyHeaders();

  if (Array.isArray(configuredTargets) && configuredTargets.length > 0) {
    return configuredTargets
      .map((entry, index) => _normalizeSinkDefinition(entry, index, fallbackHeaders))
      .filter(Boolean);
  }

  const multiUrlValue = String(process.env.ORACLE_ALERT_WEBHOOK_URLS || '').trim();
  if (multiUrlValue) {
    return multiUrlValue
      .split(/[\n,;]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .map((entry, index) => _normalizeSinkDefinition(entry, index, fallbackHeaders))
      .filter(Boolean);
  }

  const legacyUrl = _resolveWebhookUrl();
  if (!legacyUrl) {
    return [];
  }

  return [
    {
      name: String(process.env.ORACLE_ALERT_WEBHOOK_NAME || 'external-sink-1').trim() || 'external-sink-1',
      url: legacyUrl,
      headers: fallbackHeaders,
    },
  ];
}

async function _deliverToWebhookTarget(target, normalizedEvent) {
  const timeoutMs = _resolveTimeoutMs();
  const requestHeaders = {
    'content-type': 'application/json',
    ...target.headers,
  };
  const requestOptions = {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(normalizedEvent),
  };

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    requestOptions.signal = AbortSignal.timeout(timeoutMs);
  }

  const response = await fetch(target.url, requestOptions);
  if (!response.ok) {
    throw new Error(`External sink ${target.name} responded with ${response.status}`);
  }

  return {
    name: target.name,
    destination: _maskTargetUrl(target.url),
    status: 'sent',
    statusCode: response.status,
  };
}

function _resolveNumberEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getOracleAlertConfig() {
  const targets = _resolveWebhookTargets();

  return {
    enabled: true,
    delivery: targets.length > 0 ? 'database+external_sinks' : 'database',
    webhookPresent: targets.length > 0,
    sinkCount: targets.length,
    sinks: targets.map(target => ({
      name: target.name,
      destination: _maskTargetUrl(target.url),
      headerKeys: Object.keys(target.headers || {}).sort(),
    })),
    timeoutMs: _resolveTimeoutMs(),
    thresholds: {
      payment_challenge: _resolveNumberEnv('ORACLE_ALERT_PAYMENT_CHALLENGE_THRESHOLD', DEFAULT_THRESHOLDS.payment_challenge),
      rate_limited: _resolveNumberEnv('ORACLE_ALERT_RATE_LIMIT_THRESHOLD', DEFAULT_THRESHOLDS.rate_limited),
      server_error: _resolveNumberEnv('ORACLE_ALERT_SERVER_ERROR_THRESHOLD', DEFAULT_THRESHOLDS.server_error),
      settlement_failure: _resolveNumberEnv('ORACLE_ALERT_SETTLEMENT_FAILURE_THRESHOLD', DEFAULT_THRESHOLDS.settlement_failure),
      gateway_unavailable: _resolveNumberEnv('ORACLE_ALERT_GATEWAY_UNAVAILABLE_THRESHOLD', DEFAULT_THRESHOLDS.gateway_unavailable),
      fallback: _resolveNumberEnv('ORACLE_ALERT_FALLBACK_THRESHOLD', DEFAULT_THRESHOLDS.fallback),
    },
  };
}

function shouldSendOracleAlert(type, count) {
  const config = getOracleAlertConfig();
  const threshold = config.thresholds[type];

  if (!config.enabled || !Number.isInteger(threshold) || threshold <= 0) {
    return false;
  }

  const normalizedCount = Number.isInteger(count) && count > 0 ? count : 0;
  if (normalizedCount <= 0 || normalizedCount % threshold !== 0) {
    return false;
  }

  const key = `${type}:${normalizedCount}`;
  if (state.lastTriggeredCounts[key]) {
    return false;
  }

  state.lastTriggeredCounts[key] = true;
  return true;
}

async function sendOracleAlert(event) {
  const targets = _resolveWebhookTargets();
  const config = getOracleAlertConfig();
  const timestamp = new Date().toISOString();
  const normalizedEvent = {
    ...event,
    timestamp,
    meta: _normalizeMeta(event?.meta),
  };
  const sinkResults = [];

  let deliveryState = 'stored';
  let message = 'Alert persisted to database';

  if (!config.webhookPresent) {
    state.suppressedCount += 1;
    message = 'Alert persisted to database; no external sinks configured';
  } else {
    const results = await Promise.allSettled(
      targets.map(target => _deliverToWebhookTarget(target, normalizedEvent)),
    );
    const successfulDeliveries = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    const failedDeliveries = results
      .filter(result => result.status === 'rejected')
      .map((result, index) => ({
        name: targets[index]?.name || `external-sink-${index + 1}`,
        destination: _maskTargetUrl(targets[index]?.url || ''),
        status: 'failed',
        error: result.reason?.message || 'external_sink_failed',
      }));

    sinkResults.push(...successfulDeliveries, ...failedDeliveries);
    state.sentCount += successfulDeliveries.length;

    if (failedDeliveries.length > 0) {
      state.failedCount += failedDeliveries.length;
      state.lastError = {
        message: failedDeliveries.map(item => item.error).join(' | '),
        timestamp,
      };
    } else {
      state.lastError = null;
    }

    if (successfulDeliveries.length > 0) {
      state.lastSentAt = timestamp;
    }

    if (successfulDeliveries.length === config.sinkCount) {
      deliveryState = 'sent';
      message = `Alert persisted to database and forwarded to ${successfulDeliveries.length} external sink(s)`;
    } else if (successfulDeliveries.length > 0) {
      deliveryState = 'partially_sent';
      message = `Alert reached ${successfulDeliveries.length}/${config.sinkCount} external sink(s)`;
    } else {
      deliveryState = 'external_delivery_failed';
      message = failedDeliveries.map(item => item.error).join(' | ') || 'All external sinks failed';
    }
  }

  try {
    await db.query(
      `INSERT INTO oracle_alert_events (event_type, event_count, delivery, delivery_state, message, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        normalizedEvent.type,
        normalizedEvent.count,
        config.delivery,
        deliveryState,
        message,
        JSON.stringify({
          timestamp: normalizedEvent.timestamp,
          meta: normalizedEvent.meta,
          sinkResults,
        }),
      ],
    );

    state.storedCount += 1;
    _pushRecent({
      ...normalizedEvent,
      status: deliveryState,
      message,
      sinkResults,
    });
    return deliveryState !== 'external_delivery_failed';
  } catch (error) {
    state.failedCount += 1;
    state.lastError = {
      message: error.message,
      timestamp,
    };
    _pushRecent({
      ...normalizedEvent,
      status: 'database_failed',
      error: error.message,
      sinkResults,
    });
    return false;
  }
}

async function dispatchOracleTestAlert(meta) {
  return sendOracleAlert({
    type: 'manual_test',
    count: 1,
    meta: {
      source: 'oracle_ops_test',
      ...(meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}),
    },
  });
}

function getOracleAlertDeliverySummary() {
  const config = getOracleAlertConfig();

  return {
    ...config,
    storedCount: state.storedCount,
    sentCount: state.sentCount,
    suppressedCount: state.suppressedCount,
    failedCount: state.failedCount,
    lastSentAt: state.lastSentAt,
    lastError: state.lastError ? { ...state.lastError } : null,
    recentDeliveries: state.recentDeliveries.map(item => ({
      ...item,
      meta: item.meta ? { ...item.meta } : null,
      sinkResults: Array.isArray(item.sinkResults)
        ? item.sinkResults.map(result => ({ ...result }))
        : [],
    })),
  };
}

module.exports = {
  dispatchOracleTestAlert,
  getOracleAlertConfig,
  getOracleAlertDeliverySummary,
  sendOracleAlert,
  shouldSendOracleAlert,
};