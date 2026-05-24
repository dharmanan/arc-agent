'use strict';

const REDACTED_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'signature',
  'privateKey',
  'private_key',
  'credential',
  'attestationObject',
  'clientDataJSON',
]);

function sanitizeMetaValue(value, depth = 0) {
  if (depth > 4) return '[Truncated]';
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeMetaValue(entry, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: value.message || 'Unknown error',
      code: value.code || null,
    };
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        REDACTED_KEYS.has(String(key || '').trim())
          ? '[Redacted]'
          : sanitizeMetaValue(entry, depth + 1),
      ]),
    );
  }

  if (typeof value === 'string' && value.length > 1024) {
    return `${value.slice(0, 1024)}…`;
  }

  return value;
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(meta)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, sanitizeMetaValue(value)]),
  );
}

function emit(prefix, level, message, meta) {
  const logger = console[level] || console.log;
  const normalizedMeta = normalizeMeta(meta);

  if (normalizedMeta && Object.keys(normalizedMeta).length > 0) {
    logger(`${prefix} ${message}`, normalizedMeta);
    return;
  }

  logger(`${prefix} ${message}`);
}

function logGateway(level, message, meta) {
  emit('[GATEWAY]', level, message, meta);
}

function logOracleGateway(level, message, meta) {
  emit('[ORACLE_GATEWAY]', level, message, meta);
}

function logTaskEconomy(level, message, meta) {
  emit('[TASK_ECONOMY]', level, message, meta);
}

function logJobEconomy(level, message, meta) {
  emit('[JOB_ECONOMY]', level, message, meta);
}

function logAgenticEconomy(level, message, meta) {
  emit('[AGENTIC_ECONOMY]', level, message, meta);
}

module.exports = {
  logAgenticEconomy,
  logGateway,
  logJobEconomy,
  logOracleGateway,
  logTaskEconomy,
};