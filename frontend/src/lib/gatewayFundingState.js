export const ARC_RPC_COOLDOWN_CODE = 'ARC_RPC_COOLDOWN';

export function parseDeferredManualGatewayFundError(error) {
  const payload = error?.data || {};
  const status = String(payload.status || error?.responseStatus || '').trim().toLowerCase();
  const errorCode = String(payload.errorCode || error?.code || '').trim().toUpperCase();

  if (status !== 'deferred' || !errorCode) {
    return null;
  }

  const retryAfterRaw = payload.retryAfterMs ?? error?.retryAfterMs ?? null;
  const retryAfterMs = Number.isFinite(Number(retryAfterRaw)) ? Number(retryAfterRaw) : null;
  const retryAt = typeof payload.retryAt === 'string' && payload.retryAt.trim()
    ? payload.retryAt
    : (typeof error?.retryAt === 'string' && error.retryAt.trim() ? error.retryAt : null);

  return {
    status,
    errorCode,
    retryAfterMs,
    retryAt,
  };
}

export function shouldRecordManualGatewayFundSuccess(payload) {
  const approvalTxHash = payload?.deposit?.approvalTxHash || null;
  const depositTxHash = payload?.deposit?.depositTxHash || null;
  return Boolean(payload?.funded === true || approvalTxHash || depositTxHash);
}

export function isRetryCooldownActive(retryAt, nowMs = Date.now()) {
  if (!retryAt) return false;
  const retryAtMs = Date.parse(String(retryAt));
  return Number.isFinite(retryAtMs) && retryAtMs > nowMs;
}

export function isArcRpcDeferredManualFund(deferredState) {
  return String(deferredState?.status || '').toLowerCase() === 'deferred'
    && String(deferredState?.errorCode || '').toUpperCase() === ARC_RPC_COOLDOWN_CODE;
}
