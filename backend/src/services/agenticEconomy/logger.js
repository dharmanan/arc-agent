'use strict';

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(meta).filter(([, value]) => value !== undefined),
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