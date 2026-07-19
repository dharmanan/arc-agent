'use strict';

const { ensureGatewayWarmBalance } = require('../services/agenticEconomy/gatewayBuyer');

const DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_MIN_USDC = 1;
const DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_TARGET_USDC = 3;
const GATEWAY_AUTO_WARM_DEBOUNCE_MS = Math.max(
  Number.parseInt(process.env.GATEWAY_AUTO_WARM_DEBOUNCE_MS || '15000', 10) || 15000,
  5000,
);

const gatewayAutoWarmDebounceByAgent = new Map();

function normalizeUsdcAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric * 1_000_000) / 1_000_000;
}

function getAgentGatewayAutoTopupConfig(agent) {
  const minAvailableUsdc = normalizeUsdcAmount(
    agent?.gateway_auto_topup_min_usdc ?? DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_MIN_USDC,
  ) || DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_MIN_USDC;
  const targetAvailableUsdc = normalizeUsdcAmount(
    agent?.gateway_auto_topup_target_usdc ?? DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_TARGET_USDC,
  ) || DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_TARGET_USDC;

  return {
    enabled: agent?.gateway_auto_topup_enabled !== false,
    minAvailableUsdc,
    targetAvailableUsdc: Math.max(targetAvailableUsdc, minAvailableUsdc),
  };
}

function pruneGatewayAutoWarmDebounce(now = Date.now()) {
  for (const [agentId, expiresAt] of gatewayAutoWarmDebounceByAgent.entries()) {
    if (!agentId || !Number.isFinite(expiresAt) || expiresAt <= now) {
      gatewayAutoWarmDebounceByAgent.delete(agentId);
    }
  }
}

function getGatewayAutoWarmDebounceRemainingMs(agentId, now = Date.now()) {
  if (!agentId) return 0;
  pruneGatewayAutoWarmDebounce(now);
  const expiresAt = Number(gatewayAutoWarmDebounceByAgent.get(agentId) || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return 0;
  return Math.max(Math.ceil(expiresAt - now), 0);
}

function markGatewayAutoWarmDebounce(agentId, now = Date.now()) {
  if (!agentId) return;
  gatewayAutoWarmDebounceByAgent.set(agentId, now + GATEWAY_AUTO_WARM_DEBOUNCE_MS);
}

function isArcRpcCooldownError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (
    code === 'ARC_RPC_COOLDOWN'
    || code === 'GATEWAY_SERVICE_RATE_LIMITED'
    || code === 'GATEWAY_DEFERRED_UNKNOWN'
  ) {
    return true;
  }

  const message = String(error?.message || error?.cause?.message || '').trim();
  return /request limit reached|arc rpc is cooling down|rate limit/i.test(message);
}

function isGatewayAutoWarmExpectedSkipError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === 'AGENT_TX_BUSY' || code === 'TX_REPLAY_BLOCKED' || code === 'AGENT_TX_RATE_LIMITED') {
    return true;
  }

  if (isArcRpcCooldownError(error)) {
    return true;
  }

  const status = Number.parseInt(String(error?.status || error?.statusCode || ''), 10);
  if (status === 409 || status === 429) return true;

  const message = String(error?.message || error?.cause?.message || '').trim();
  return /another transaction is already executing|matching transaction was already submitted|rate limit|request limit reached/i.test(message);
}

async function maybeWarmAgentGatewayBalance(agent, trigger, overrides = {}) {
  const baseConfig = getAgentGatewayAutoTopupConfig(agent);
  const config = {
    ...baseConfig,
    minAvailableUsdc: normalizeUsdcAmount(
      overrides.minAvailableUsdc == null ? baseConfig.minAvailableUsdc : overrides.minAvailableUsdc,
    ) || baseConfig.minAvailableUsdc,
    targetAvailableUsdc: Math.max(
      normalizeUsdcAmount(
        overrides.targetAvailableUsdc == null ? baseConfig.targetAvailableUsdc : overrides.targetAvailableUsdc,
      ) || baseConfig.targetAvailableUsdc,
      normalizeUsdcAmount(
        overrides.minAvailableUsdc == null ? baseConfig.minAvailableUsdc : overrides.minAvailableUsdc,
      ) || baseConfig.minAvailableUsdc,
    ),
  };
  if (!config.enabled || !agent?.private_key_encrypted) {
    return {
      attempted: false,
      deposited: false,
      reason: config.enabled ? 'signer_unavailable' : 'disabled',
    };
  }

  const debounceRemainingMs = getGatewayAutoWarmDebounceRemainingMs(agent?.id);
  if (debounceRemainingMs > 0) {
    return {
      attempted: false,
      deposited: false,
      reason: 'debounced',
      retryAfterMs: debounceRemainingMs,
    };
  }
  markGatewayAutoWarmDebounce(agent?.id);

  try {
    const result = await ensureGatewayWarmBalance(agent, {
      chainName: 'Arc Testnet',
      minAvailableUsdc: config.minAvailableUsdc,
      targetAvailableUsdc: config.targetAvailableUsdc,
    });

    if (result?.deposited) {
      console.log(
        `[GATEWAY] Auto-warmed agent=${agent.id} trigger=${trigger} amount=${result.amountUsdc} available=${result?.balancesAfter?.gateway?.formattedAvailable || '0'}`,
      );
    }

    return result;
  } catch (error) {
    if (isGatewayAutoWarmExpectedSkipError(error)) {
      console.log(`[GATEWAY] Auto-warm deferred agent=${agent?.id || 'unknown'} trigger=${trigger}: ${error.message}`);
    } else {
      console.warn(`[GATEWAY] Auto-warm skipped agent=${agent?.id || 'unknown'} trigger=${trigger}: ${error.message}`);
    }
    return {
      attempted: false,
      deposited: false,
      reason: isGatewayAutoWarmExpectedSkipError(error) ? 'deferred' : 'error',
      error: error.message,
      errorCode: error?.code || null,
    };
  }
}

function __resetGatewayAutoWarmDebounceForTests() {
  gatewayAutoWarmDebounceByAgent.clear();
}

module.exports = {
  maybeWarmAgentGatewayBalance,
  isGatewayAutoWarmExpectedSkipError,
  isArcRpcCooldownError,
  __resetGatewayAutoWarmDebounceForTests,
};
