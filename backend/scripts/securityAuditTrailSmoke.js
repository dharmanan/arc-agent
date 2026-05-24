'use strict';

const path = require('path');
const { ethers } = require('ethers');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const db = require('../src/db');
const agentService = require('../src/services/agentService');
const {
  recordSecurityEvent,
  recordSuspiciousAgentActivity,
} = require('../src/services/securityEventService');

function parseArgs(argv) {
  const options = {
    agentId: '',
    walletAddress: String(process.env.SMOKE_AGENT_WALLET || '').trim(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if ((current === '--agent' || current === '--agent-id') && argv[index + 1]) {
      options.agentId = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (current === '--wallet' && argv[index + 1]) {
      options.walletAddress = String(argv[index + 1] || '').trim();
      index += 1;
    }
  }

  return options;
}

function resolveSmokeWalletAddress(explicitWalletAddress = '') {
  if (/^0x[a-fA-F0-9]{40}$/.test(explicitWalletAddress)) {
    return ethers.getAddress(explicitWalletAddress).toLowerCase();
  }

  const privateKey = String(process.env.SMOKE_AGENT_PRIVATE_KEY || '').trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    return new ethers.Wallet(privateKey).address.toLowerCase();
  }

  throw new Error('Missing smoke wallet address. Define SMOKE_AGENT_WALLET or SMOKE_AGENT_PRIVATE_KEY in root .env.');
}

async function resolveAgent({ agentId, walletAddress }) {
  if (agentId) {
    const { rows: [agent] } = await db.query(
      `SELECT id, user_id, wallet_address, status, is_active,
              security_frozen_at::text AS security_frozen_at,
              security_freeze_reason
         FROM agents
        WHERE id = $1
        LIMIT 1`,
      [agentId],
    );
    return agent || null;
  }

  const { rows: [agent] } = await db.query(
    `SELECT id, user_id, wallet_address, status, is_active,
            security_frozen_at::text AS security_frozen_at,
            security_freeze_reason
       FROM agents
      WHERE LOWER(wallet_address) = $1
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [walletAddress],
  );
  return agent || null;
}

async function readSuspiciousWindow(agentId, windowSec) {
  const { rows: [summary] } = await db.query(
    `SELECT COUNT(*)::int AS total
       FROM security_events
      WHERE agent_id = $1
        AND category = 'agent_tx'
        AND severity IN ('warn', 'critical')
        AND created_at >= NOW() - ($2::text || ' seconds')::interval`,
    [agentId, String(windowSec)],
  );
  return Number(summary?.total || 0);
}

async function reloadAgent(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, user_id, wallet_address, status, is_active,
            security_frozen_at::text AS security_frozen_at,
            security_freeze_reason
       FROM agents
      WHERE id = $1`,
    [agentId],
  );
  return agent || null;
}

async function restoreAgentState(agent, smokeRunId) {
  await db.query(
    `UPDATE agents
        SET status = $2,
            is_active = $3,
            security_frozen_at = $4,
            security_freeze_reason = $5
      WHERE id = $1`,
    [
      agent.id,
      agent.status,
      agent.is_active,
      agent.security_frozen_at,
      agent.security_freeze_reason,
    ],
  );

  await recordSecurityEvent({
    category: 'agent_security',
    eventType: 'agent_unfrozen_smoke_reset',
    severity: 'info',
    action: 'reset',
    userId: agent.user_id,
    agentId: agent.id,
    walletAddress: agent.wallet_address,
    metadata: {
      smokeRunId,
      restoredStatus: agent.status,
      restoredIsActive: agent.is_active,
    },
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const smokeWalletAddress = resolveSmokeWalletAddress(options.walletAddress);
  const agent = await resolveAgent({
    agentId: options.agentId,
    walletAddress: smokeWalletAddress,
  });

  if (!agent) {
    throw new Error('Smoke agent was not found in the database. Pass --agent-id explicitly or set SMOKE_AGENT_WALLET to a known agent wallet.');
  }

  if (String(agent.status || '').toLowerCase() === 'locked' || agent.is_active === false) {
    throw new Error(`Smoke agent ${agent.id} is already frozen/locked. Refusing to mutate its state automatically.`);
  }

  const smokeRunId = `security-audit-smoke-${Date.now()}`;
  const preState = { ...agent };
  const threshold = Math.max(Number.parseInt(process.env.SECURITY_AGENT_FREEZE_THRESHOLD || '3', 10) || 3, 1);
  const windowSec = Math.max(Number.parseInt(process.env.SECURITY_AGENT_EVENT_WINDOW_SEC || '900', 10) || 900, 60);
  const initialSuspiciousCount = await readSuspiciousWindow(agent.id, windowSec);
  const targetAttempts = initialSuspiciousCount >= threshold ? 1 : (threshold - initialSuspiciousCount);
  const attempts = [];

  for (let index = 0; index < targetAttempts; index += 1) {
    const result = await recordSuspiciousAgentActivity({
      agentId: agent.id,
      userId: agent.user_id,
      walletAddress: agent.wallet_address,
      chainName: 'Arc Testnet',
      eventType: 'smoke_tx_replay_blocked',
      severity: 'warn',
      metadata: {
        smokeRunId,
        attempt: index + 1,
        source: 'security_audit_smoke_v1',
      },
    });
    attempts.push({
      attempt: index + 1,
      suspiciousCount: result.suspiciousCount,
      frozeAgent: Boolean(result.frozen),
    });
    if (result.frozen) break;
  }

  const frozenAgent = await reloadAgent(agent.id);
  if (!frozenAgent || String(frozenAgent.status || '').toLowerCase() !== 'locked' || frozenAgent.is_active !== false) {
    throw new Error(`Agent freeze did not trigger as expected. Final state: ${JSON.stringify(frozenAgent)}`);
  }

  let loaderBlocked = false;
  try {
    await agentService.getAgentWithKeyById(agent.id);
  } catch (error) {
    loaderBlocked = error?.code === 'agent_security_frozen';
  }

  if (!loaderBlocked) {
    throw new Error('Agent loader did not block the frozen smoke agent.');
  }

  await restoreAgentState(preState, smokeRunId);
  const restoredAgent = await reloadAgent(agent.id);

  console.log(JSON.stringify({
    smokeWalletAddress,
    agentId: agent.id,
    threshold,
    windowSec,
    initialSuspiciousCount,
    attempts,
    frozenAt: frozenAgent.security_frozen_at,
    freezeReason: frozenAgent.security_freeze_reason,
    loaderBlocked,
    restoredStatus: restoredAgent?.status || null,
    restoredIsActive: restoredAgent?.is_active ?? null,
    smokeRunId,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});