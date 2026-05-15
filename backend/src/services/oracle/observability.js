'use strict';

const MAX_RECENT_EVENTS = 25;
const {
  getOracleAlertDeliverySummary,
  sendOracleAlert,
  shouldSendOracleAlert,
} = require('./alerts');

const state = {
  startedAt: new Date().toISOString(),
  signalCounts: Object.create(null),
  fallbackCounts: Object.create(null),
  recentSignals: [],
  recentFallbacks: [],
};

function _normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(meta).filter(([, value]) => value !== undefined),
  );
}

function _increment(bucket, key) {
  bucket[key] = (bucket[key] || 0) + 1;
  return bucket[key];
}

function _maybeDispatchAlert(type, count, meta) {
  if (!shouldSendOracleAlert(type, count)) {
    return;
  }

  void sendOracleAlert({
    type,
    count,
    meta,
  });
}

function _pushRecent(bucket, entry) {
  bucket.unshift(entry);
  if (bucket.length > MAX_RECENT_EVENTS) {
    bucket.length = MAX_RECENT_EVENTS;
  }
}

function recordOracleSignal(type, meta) {
  const normalizedType = String(type || 'unknown_signal').trim() || 'unknown_signal';
  const timestamp = new Date().toISOString();

  const count = _increment(state.signalCounts, normalizedType);
  _pushRecent(state.recentSignals, {
    type: normalizedType,
    timestamp,
    meta: _normalizeMeta(meta),
  });
  _maybeDispatchAlert(normalizedType, count, meta);
}

function recordOracleFallback(component, meta) {
  const normalizedComponent = String(component || 'unknown_fallback').trim() || 'unknown_fallback';
  const timestamp = new Date().toISOString();
  const normalizedMeta = _normalizeMeta(meta);

  const count = _increment(state.fallbackCounts, normalizedComponent);
  _pushRecent(state.recentFallbacks, {
    component: normalizedComponent,
    timestamp,
    meta: normalizedMeta,
  });
  _maybeDispatchAlert('fallback', count, {
    component: normalizedComponent,
    ...(normalizedMeta || {}),
  });
}

function getOracleObservabilitySummary() {
  return {
    startedAt: state.startedAt,
    signalCounts: { ...state.signalCounts },
    fallbackCounts: { ...state.fallbackCounts },
    recentSignals: state.recentSignals.map(item => ({
      ...item,
      meta: item.meta ? { ...item.meta } : null,
    })),
    recentFallbacks: state.recentFallbacks.map(item => ({
      ...item,
      meta: item.meta ? { ...item.meta } : null,
    })),
    alerting: getOracleAlertDeliverySummary(),
  };
}

module.exports = {
  getOracleObservabilitySummary,
  recordOracleFallback,
  recordOracleSignal,
};