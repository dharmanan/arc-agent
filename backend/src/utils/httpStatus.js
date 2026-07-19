'use strict';

function toValidHttpStatus(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 400 && value <= 599 ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return parsed >= 400 && parsed <= 599 ? parsed : null;
  }

  return null;
}

function resolveErrorHttpStatus(error, fallback = 500) {
  const candidates = [
    error?.statusCode,
    error?.httpStatus,
    error?.status,
  ];

  for (const candidate of candidates) {
    const resolved = toValidHttpStatus(candidate);
    if (resolved != null) {
      return resolved;
    }
  }

  const fallbackStatus = toValidHttpStatus(fallback);
  return fallbackStatus == null ? 500 : fallbackStatus;
}

module.exports = {
  resolveErrorHttpStatus,
  toValidHttpStatus,
};