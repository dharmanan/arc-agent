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

function normalizeSeverity(severity) {
  const normalized = String(severity || 'info').trim().toLowerCase();
  if (['info', 'warn', 'critical'].includes(normalized)) return normalized;
  return 'info';
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
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
    if (suspiciousCount >= SUSPICIOUS_AGENT_EVENT_FREEZE_THRESHOLD) {
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
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  assertAgentOperational,
  buildFrozenAgentError,
  freezeAgentForSecurityReview,
  recordAuthFailure,
  recordAuthLockout,
  recordSecurityEvent,
  recordSuspiciousAgentActivity,
};