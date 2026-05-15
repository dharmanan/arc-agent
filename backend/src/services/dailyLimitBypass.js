'use strict';

function parseBypassList(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

const DEV_BYPASS_ADDRS = parseBypassList(process.env.DEV_BYPASS_AGENT_ADDRESSES);
const DEV_BYPASS_AGENT_IDS = parseBypassList(process.env.DEV_BYPASS_AGENT_IDS);

function getDailyLimitBypass(agent) {
  const walletAddress = String(agent?.wallet_address || '').trim().toLowerCase();
  if (walletAddress && DEV_BYPASS_ADDRS.has(walletAddress)) {
    return {
      enabled: true,
      source: 'wallet_address',
      value: walletAddress,
    };
  }

  const agentId = String(agent?.id || '').trim().toLowerCase();
  if (agentId && DEV_BYPASS_AGENT_IDS.has(agentId)) {
    return {
      enabled: true,
      source: 'agent_id',
      value: agentId,
    };
  }

  return {
    enabled: false,
    source: null,
    value: null,
  };
}

function isDailyLimitBypassed(agent) {
  return getDailyLimitBypass(agent).enabled;
}

module.exports = {
  getDailyLimitBypass,
  isDailyLimitBypassed,
};