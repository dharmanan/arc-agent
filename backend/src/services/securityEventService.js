'use strict';

const db = require('../db');

const SUSPICIOUS_AGENT_EVENT_WINDOW_SEC = Math.max(
  Number.parseInt(process.env.SECURITY_AGENT_EVENT_WINDOW_SEC || '900', 10) || 900,
  60,
);
const SUSPICIOUS_AGENT_EVENT_FREEZE_THRESHOLD = Math.max(
  Number.parseInt(process.env.SECURITY_AGENT_FREEZE_THRESHOLD || '3', 10) || 3,
  1,
);
const SECURITY_AGENT_FREEZE_ENABLED = (() => {
  const raw = String(process.env.SECURITY_AGENT_FREEZE_ENABLED || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
})();
const SECURITY_AGENT_AUTO_UNFREEZE_ENABLED = (() => {
  const raw = String(process.env.SECURITY_AGENT_AUTO_UNFREEZE_ENABLED || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
})();
const SECURITY_AGENT_AUTO_UNFREEZE_COOLDOWN_SEC = Math.max(
  Number.parseInt(
    process.env.SECURITY_AGENT_AUTO_UNFREEZE_COOLDOWN_SEC
      || process.env.SECURITY_AGENT_EVENT_WINDOW_SEC
      || '900',
    10,
  ) || SUSPICIOUS_AGENT_EVENT_WINDOW_SEC,
  60,
);
const SECURITY_AGENT_AUTO_UNFREEZE_SWEEP_INTERVAL_MS = Math.max(
  Number.parseInt(process.env.SECURITY_AGENT_AUTO_UNFREEZE_SWEEP_INTERVAL_MS || '60000', 10) || 60000,
  15000,
);
const SECURITY_AGENT_AUTO_UNFREEZE_BATCH_SIZE = Math.max(
  Math.min(Number.parseInt(process.env.SECURITY_AGENT_AUTO_UNFREEZE_BATCH_SIZE || '50', 10) || 50, 200),
  1,
);
const SECURITY_AGENT_AUTO_UNFREEZE_REASONS = new Set(
  String(process.env.SECURITY_AGENT_AUTO_UNFREEZE_REASONS || 'suspicious_agent_activity')
    .split(/[\s,;]+/)
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean),
);

let securityFreezeRecoveryTimer = null;

function normalizeSeverity(severity) {
  const normalized = String(severity || 'info').trim().toLowerCase();
  if (['info', 'warn', 'critical'].includes(normalized)) return normalized;
  return 'info';
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeFreezeReason(reason) {
  return String(reason || '').trim().toLowerCase();
}

function parseTimestampMs(value) {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildFrozenAgentError(agent) {
  return Object.assign(new Error('Agent is frozen pending a security review.'), {
    status: 423,
    code: 'agent_security_frozen',
    details: {
      agentId: agent?.id || null,
      freezeReason: agent?.security_freeze_reason || null,
      frozenAt: agent?.security_frozen_at || null,
    },
  });
}

function assertAgentOperational(agent) {
  if (!agent) return agent;

  const status = String(agent.status || '').trim().toLowerCase();
  const isActive = agent.is_active !== false;
  if (status === 'locked' || !isActive) {
    throw buildFrozenAgentError(agent);
  }

  return agent;
}

async function recordSecurityEvent({
  category,
  eventType,
  severity = 'info',
  action = 'logged',
  userId = null,
  agentId = null,
  ownerAddress = null,
  walletAddress = null,
  requestId = null,
  ipAddress = null,
  chainName = null,
  metadata = {},
  frozenAgent = false,
  freezeReason = null,
}, client = db) {
  const { rows } = await client.query(
    `INSERT INTO security_events (
       user_id,
       agent_id,
       category,
       event_type,
       severity,
       action,
       owner_address,
       wallet_address,
       request_id,
       ip_address,
       chain_name,
       metadata,
       frozen_agent,
       freeze_reason
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
     RETURNING *`,
    [
      userId,
      agentId,
      String(category || 'security'),
      String(eventType || 'security_event'),
      normalizeSeverity(severity),
      String(action || 'logged'),
      ownerAddress,
      walletAddress,
      requestId,
      ipAddress,
      chainName,
      JSON.stringify(normalizeJsonObject(metadata)),
      Boolean(frozenAgent),
      freezeReason,
    ],
  );

  return rows[0] || null;
}

async function freezeAgentForSecurityReview({
  agentId,
  reason,
  metadata = {},
  chainName = null,
  requestId = null,
}) {
  if (!agentId) {
    throw new Error('agentId is required to freeze an agent');
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE agents
          SET status = 'locked',
              is_active = FALSE,
              security_frozen_at = COALESCE(security_frozen_at, NOW()),
              security_freeze_reason = COALESCE(security_freeze_reason, $2)
        WHERE id = $1
        RETURNING id, user_id, wallet_address, status, is_active, security_frozen_at, security_freeze_reason`,
      [agentId, String(reason || 'security_review_required')],
    );
    const frozenAgent = rows[0] || null;

    if (!frozenAgent) {
      await client.query('ROLLBACK');
      return null;
    }

    const event = await recordSecurityEvent({
      category: 'agent_security',
      eventType: 'agent_frozen',
      severity: 'critical',
      action: 'frozen',
      userId: frozenAgent.user_id,
      agentId: frozenAgent.id,
      walletAddress: frozenAgent.wallet_address,
      requestId,
      chainName,
      metadata,
      frozenAgent: true,
      freezeReason: frozenAgent.security_freeze_reason,
    }, client);

    await client.query('COMMIT');
    return {
      agent: frozenAgent,
      event,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recordAuthFailure({
  userId,
  ownerAddress,
  ipAddress = null,
  requestId = null,
  metadata = {},
}) {
  return recordSecurityEvent({
    category: 'auth',
    eventType: 'passkey_auth_failed',
    severity: 'warn',
    action: 'logged',
    userId,
    ownerAddress,
    ipAddress,
    requestId,
    metadata,
  });
}

async function recordAuthLockout({
  userId,
  ownerAddress,
  ipAddress = null,
  requestId = null,
  metadata = {},
}) {
  return recordSecurityEvent({
    category: 'auth',
    eventType: 'passkey_auth_lockout',
    severity: 'critical',
    action: 'logged',
    userId,
    ownerAddress,
    ipAddress,
    requestId,
    metadata,
  });
}

async function recordSuspiciousAgentActivity({
  agentId,
  userId = null,
  walletAddress = null,
  chainName = null,
  eventType,
  severity = 'warn',
  requestId = null,
  metadata = {},
}) {
  if (!agentId) return { event: null, frozen: null, suspiciousCount: 0 };

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const event = await recordSecurityEvent({
      category: 'agent_tx',
      eventType,
      severity,
      action: 'logged',
      userId,
      agentId,
      walletAddress,
      requestId,
      chainName,
      metadata,
    }, client);

    const { rows: [suspiciousWindow] } = await client.query(
      `SELECT COUNT(*)::int AS total
         FROM security_events
        WHERE agent_id = $1
          AND category = 'agent_tx'
          AND severity IN ('warn', 'critical')
          AND created_at >= NOW() - ($2::text || ' seconds')::interval`,
      [agentId, String(SUSPICIOUS_AGENT_EVENT_WINDOW_SEC)],
    );

    let frozen = null;
    const suspiciousCount = Number(suspiciousWindow?.total || 0);
    if (SECURITY_AGENT_FREEZE_ENABLED && suspiciousCount >= SUSPICIOUS_AGENT_EVENT_FREEZE_THRESHOLD) {
      const { rows: [alreadyFrozen] } = await client.query(
        `SELECT id, user_id, wallet_address, status, is_active, security_frozen_at, security_freeze_reason
           FROM agents
          WHERE id = $1
          FOR UPDATE`,
        [agentId],
      );

      if (alreadyFrozen && String(alreadyFrozen.status || '').toLowerCase() !== 'locked') {
        const { rows: [frozenAgent] } = await client.query(
          `UPDATE agents
              SET status = 'locked',
                  is_active = FALSE,
                  security_frozen_at = NOW(),
                  security_freeze_reason = $2
            WHERE id = $1
            RETURNING id, user_id, wallet_address, status, is_active, security_frozen_at, security_freeze_reason`,
          [agentId, 'suspicious_agent_activity'],
        );

        frozen = frozenAgent || null;
        if (frozen) {
          await recordSecurityEvent({
            category: 'agent_security',
            eventType: 'agent_frozen',
            severity: 'critical',
            action: 'frozen',
            userId: frozen.user_id,
            agentId: frozen.id,
            walletAddress: frozen.wallet_address,
            requestId,
            chainName,
            metadata: {
              ...normalizeJsonObject(metadata),
              suspiciousCount,
              threshold: SUSPICIOUS_AGENT_EVENT_FREEZE_THRESHOLD,
              windowSec: SUSPICIOUS_AGENT_EVENT_WINDOW_SEC,
            },
            frozenAgent: true,
            freezeReason: 'suspicious_agent_activity',
          }, client);
        }
      }
    }

    await client.query('COMMIT');
    return {
      event,
      frozen,
      suspiciousCount,
      threshold: SUSPICIOUS_AGENT_EVENT_FREEZE_THRESHOLD,
      windowSec: SUSPICIOUS_AGENT_EVENT_WINDOW_SEC,
      freezeEnabled: SECURITY_AGENT_FREEZE_ENABLED,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function canAutoUnfreezeAgent(agent, nowMs = Date.now()) {
  if (!SECURITY_AGENT_AUTO_UNFREEZE_ENABLED || !agent) return false;

  const status = String(agent.status || '').trim().toLowerCase();
  if (status !== 'locked') return false;
  if (agent.is_active !== false) return false;

  const freezeReason = normalizeFreezeReason(agent.security_freeze_reason);
  if (!SECURITY_AGENT_AUTO_UNFREEZE_REASONS.has(freezeReason)) return false;

  const frozenAtMs = parseTimestampMs(agent.security_frozen_at);
  if (!Number.isFinite(frozenAtMs)) return false;

  return (nowMs - frozenAtMs) >= (SECURITY_AGENT_AUTO_UNFREEZE_COOLDOWN_SEC * 1000);
}

async function autoUnfreezeEligibleAgents({ limit = SECURITY_AGENT_AUTO_UNFREEZE_BATCH_SIZE } = {}) {
  if (!SECURITY_AGENT_AUTO_UNFREEZE_ENABLED) {
    return {
      enabled: false,
      scanned: 0,
      unfrozen: 0,
      skippedRecentSuspicious: 0,
      skippedCooldown: 0,
    };
  }

  const safeLimit = Math.max(Math.min(Number.parseInt(limit, 10) || SECURITY_AGENT_AUTO_UNFREEZE_BATCH_SIZE, 200), 1);
  const nowMs = Date.now();

  const { rows: candidates } = await db.query(
    `SELECT id, user_id, wallet_address, status, is_active, security_frozen_at, security_freeze_reason
       FROM agents
      WHERE status = 'locked'
        AND is_active = FALSE
        AND security_frozen_at IS NOT NULL
      ORDER BY security_frozen_at ASC
      LIMIT $1`,
    [safeLimit],
  );

  let unfrozen = 0;
  let skippedRecentSuspicious = 0;
  let skippedCooldown = 0;
  const unfrozenAgentIds = [];

  for (const candidate of candidates) {
    if (!canAutoUnfreezeAgent(candidate, nowMs)) {
      skippedCooldown += 1;
      continue;
    }

    const { rows: [recentSuspicious] } = await db.query(
      `SELECT COUNT(*)::int AS total
         FROM security_events
        WHERE agent_id = $1
          AND category = 'agent_tx'
          AND severity IN ('warn', 'critical')
          AND created_at >= NOW() - ($2::text || ' seconds')::interval`,
      [candidate.id, String(SUSPICIOUS_AGENT_EVENT_WINDOW_SEC)],
    );

    const recentCount = Number(recentSuspicious?.total || 0);
    if (recentCount > 0) {
      skippedRecentSuspicious += 1;
      continue;
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const { rows: [lockedAgent] } = await client.query(
        `SELECT id, user_id, wallet_address, status, is_active, security_frozen_at, security_freeze_reason
           FROM agents
          WHERE id = $1
          FOR UPDATE`,
        [candidate.id],
      );

      if (!canAutoUnfreezeAgent(lockedAgent, nowMs)) {
        await client.query('ROLLBACK');
        continue;
      }

      const { rows: [unfrozenAgent] } = await client.query(
        `UPDATE agents
            SET status = 'idle',
                is_active = TRUE,
                security_frozen_at = NULL,
                security_freeze_reason = NULL
          WHERE id = $1
            AND status = 'locked'
            AND is_active = FALSE
          RETURNING id, user_id, wallet_address`,
        [candidate.id],
      );

      if (!unfrozenAgent) {
        await client.query('ROLLBACK');
        continue;
      }

      await recordSecurityEvent({
        category: 'agent_security',
        eventType: 'agent_unfrozen',
        severity: 'warn',
        action: 'unfrozen',
        userId: unfrozenAgent.user_id,
        agentId: unfrozenAgent.id,
        walletAddress: unfrozenAgent.wallet_address,
        metadata: {
          autoRecovery: true,
          previousFreezeReason: candidate.security_freeze_reason || null,
          previousFrozenAt: candidate.security_frozen_at || null,
          cooldownSec: SECURITY_AGENT_AUTO_UNFREEZE_COOLDOWN_SEC,
          suspiciousWindowSec: SUSPICIOUS_AGENT_EVENT_WINDOW_SEC,
        },
      }, client);

      await client.query('COMMIT');
      unfrozen += 1;
      unfrozenAgentIds.push(unfrozenAgent.id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[SECURITY] auto unfreeze error:', error.message);
    } finally {
      client.release();
    }
  }

  return {
    enabled: true,
    scanned: candidates.length,
    unfrozen,
    unfrozenAgentIds,
    skippedRecentSuspicious,
    skippedCooldown,
  };
}

function startSecurityFreezeRecovery() {
  if (!SECURITY_AGENT_AUTO_UNFREEZE_ENABLED) {
    console.log('[SECURITY] Auto-unfreeze recovery disabled');
    return;
  }

  if (securityFreezeRecoveryTimer) return;

  const runRecovery = async () => {
    const summary = await autoUnfreezeEligibleAgents();
    if (summary.unfrozen > 0) {
      console.log(
        `[SECURITY] Auto-unfroze ${summary.unfrozen} agent(s) after cooldown (${summary.unfrozenAgentIds.join(', ')})`,
      );
    }
  };

  runRecovery().catch((error) => {
    console.error('[SECURITY] Initial auto-unfreeze sweep failed:', error.message);
  });

  securityFreezeRecoveryTimer = setInterval(() => {
    runRecovery().catch((error) => {
      console.error('[SECURITY] Auto-unfreeze sweep failed:', error.message);
    });
  }, SECURITY_AGENT_AUTO_UNFREEZE_SWEEP_INTERVAL_MS);

  console.log(
    `[SECURITY] Auto-unfreeze recovery started — interval ${SECURITY_AGENT_AUTO_UNFREEZE_SWEEP_INTERVAL_MS / 1000}s, cooldown ${SECURITY_AGENT_AUTO_UNFREEZE_COOLDOWN_SEC}s`,
  );
}

function stopSecurityFreezeRecovery() {
  if (!securityFreezeRecoveryTimer) return;
  clearInterval(securityFreezeRecoveryTimer);
  securityFreezeRecoveryTimer = null;
}

module.exports = {
  autoUnfreezeEligibleAgents,
  assertAgentOperational,
  buildFrozenAgentError,
  freezeAgentForSecurityReview,
  recordAuthFailure,
  recordAuthLockout,
  recordSecurityEvent,
  recordSuspiciousAgentActivity,
  startSecurityFreezeRecovery,
  stopSecurityFreezeRecovery,
};