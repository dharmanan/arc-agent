'use strict';

const crypto = require('crypto');
const os = require('os');

const db = require('../../db');
const { getHealthyArcRpcUrl } = require('../arcProvider');

const RETRY_STATUSES = new Set([
  'pending',
  'processing',
  'deferred',
  'confirmed',
  'failed',
  'manual_review',
  'cancelled',
]);

const DEFAULT_EVENT_TYPE = 'task_execution_fee';
const DEFAULT_TOKEN = 'USDC';
const DEFAULT_RETRY_MAX_ATTEMPTS = 10;
const DEFAULT_RETRY_BASE_DELAY_MS = 900000;
const DEFAULT_RETRY_MAX_DELAY_MS = 21600000;
const DEFAULT_RETRY_LOCK_TIMEOUT_MS = 900000;
const DEFAULT_BACKFILL_SCAN_LIMIT = 5000;
const ARC_RPC_COOLDOWN_CODE = 'ARC_RPC_COOLDOWN';
const QUEUE_ENQUEUE_FAILED_CODE = 'QUEUE_ENQUEUE_FAILED';
const SUBMISSION_PHASES = new Set(['preflight', 'submission_started', 'completed']);

function readPositiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolvePaymentRetryMaxAttempts(value) {
  return Math.max(readPositiveIntegerEnv('PAYMENT_RETRY_MAX_ATTEMPTS', DEFAULT_RETRY_MAX_ATTEMPTS), readNonNegativeInteger(value, DEFAULT_RETRY_MAX_ATTEMPTS));
}

function resolvePaymentRetryBaseDelayMs(value) {
  const fallback = readPositiveIntegerEnv('PAYMENT_RETRY_BASE_DELAY_MS', DEFAULT_RETRY_BASE_DELAY_MS);
  return Math.max(readNonNegativeInteger(value, fallback), 1);
}

function resolvePaymentRetryMaxDelayMs(value) {
  const fallback = readPositiveIntegerEnv('PAYMENT_RETRY_MAX_DELAY_MS', DEFAULT_RETRY_MAX_DELAY_MS);
  return Math.max(readNonNegativeInteger(value, fallback), resolvePaymentRetryBaseDelayMs());
}

function resolvePaymentRetryLockTimeoutMs(value) {
  const fallback = readPositiveIntegerEnv('PAYMENT_RETRY_LOCK_TIMEOUT_MS', DEFAULT_RETRY_LOCK_TIMEOUT_MS);
  return Math.max(readNonNegativeInteger(value, fallback), 1000);
}

function normalizeStatus(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase();
  return RETRY_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeAddress(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizeText(value, fallback = null) {
  const trimmed = String(value ?? '').trim();
  return trimmed || fallback;
}

function normalizeFeeUsdc(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('invalid_fee_amount');
  }
  return Number(parsed.toFixed(6));
}

function normalizeFeeUsdcForKey(value) {
  return normalizeFeeUsdc(value).toFixed(6);
}

function canonicalSerialize(value) {
  if (value == null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSerialize(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildCanonicalPaymentIdentity(input = {}) {
  return {
    agentId: normalizeText(input.agentId, null),
    rail: normalizeText(input.rail, ''),
    referenceType: normalizeText(input.referenceType, ''),
    referenceId: normalizeText(input.referenceId, null),
    feeUsdc: normalizeFeeUsdcForKey(input.feeUsdc),
    recipient: normalizeAddress(input.recipient || input.recipientAddress),
    sourceChain: normalizeText(input.sourceChain || input.fromChain, ''),
    destinationChain: normalizeText(input.destinationChain || input.toChain, ''),
  };
}

function buildPaymentIdempotencyKey(input = {}) {
  const identity = buildCanonicalPaymentIdentity(input);
  return crypto
    .createHash('sha256')
    .update(canonicalSerialize(identity))
    .digest('hex');
}

function normalizeJsonObject(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
}

function normalizeSubmissionPhase(value, fallback = 'preflight') {
  const normalized = String(value || '').trim().toLowerCase();
  return SUBMISSION_PHASES.has(normalized) ? normalized : fallback;
}

function toSafeErrorCode(value, fallback = 'payment_retry_error') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return normalized || fallback;
}

function extractErrorText(error) {
  return [
    error?.message,
    error?.shortMessage,
    error?.reason,
    error?.code,
    error?.cause?.message,
    error?.causeMessage,
    error?.error?.message,
    error?.info?.error?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function collectKnownHashes(value, depth = 0, target = {}) {
  if (!value || depth > 4) return target;

  if (typeof value === 'string' && value.startsWith('0x') && value.length >= 10) {
    if (!target.txHash) target.txHash = value;
    return target;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKnownHashes(entry, depth + 1, target);
    }
    return target;
  }

  if (typeof value !== 'object') {
    return target;
  }

  const map = {
    approvalTxHash: 'approvalTxHash',
    gatewayApprovalTxHash: 'approvalTxHash',
    approveTxHash: 'approvalTxHash',
    depositTxHash: 'depositTxHash',
    gatewayDepositTxHash: 'depositTxHash',
    mintTxHash: 'mintTxHash',
    gatewayMintTxHash: 'mintTxHash',
    txHash: 'txHash',
    transactionHash: 'txHash',
    hash: 'txHash',
  };

  for (const [key, valueKey] of Object.entries(map)) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.startsWith('0x') && candidate.length >= 10) {
      if (!target[valueKey]) target[valueKey] = candidate;
    }
  }

  for (const nested of Object.values(value)) {
    collectKnownHashes(nested, depth + 1, target);
  }

  return target;
}

function hasAnyBroadcastHash(hashes = {}) {
  return Boolean(hashes.approvalTxHash || hashes.depositTxHash || hashes.mintTxHash || hashes.txHash);
}

function isArcRpcCooldownError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === ARC_RPC_COOLDOWN_CODE) {
    return true;
  }

  const text = extractErrorText(error);
  return text.includes('request limit reached')
    || text.includes('rate limit')
    || text.includes('arc rpc is cooling down');
}

function classifyRetryFailure(error, knownHashes = {}) {
  const text = extractErrorText(error);
  const code = String(error?.code || '').trim();

  if (isArcRpcCooldownError(error)) {
    return {
      status: 'deferred',
      safeCode: 'arc_rpc_cooldown',
      reason: 'arc_rpc_cooldown',
      ambiguous: false,
    };
  }

  const permanentPatterns = [
    ['invalid signer', 'invalid_signer'],
    ['signer unavailable', 'signer_unavailable'],
    ['private key is missing', 'missing_private_key'],
    ['invalid private key', 'invalid_private_key'],
    ['valid recipient address is required', 'invalid_recipient'],
    ['invalid recipient', 'invalid_recipient'],
    ['unsupported circle gateway chain mapping', 'unsupported_chain'],
    ['unsupported chain', 'unsupported_chain'],
    ['insufficient funds', 'insufficient_funds'],
    ['insufficient_wallet_balance_for_gateway_deposit', 'insufficient_funds'],
    ['wallet_balance_too_low', 'insufficient_funds'],
    ['simulation failed', 'simulation_failure'],
    ['tx_simulation_failed', 'simulation_failure'],
    ['execution reverted', 'contract_revert'],
    ['contract revert', 'contract_revert'],
    ['invalid configuration', 'invalid_configuration'],
    ['invalid_fee_amount', 'invalid_fee_amount'],
    ['amountusdc must be a positive number', 'invalid_fee_amount'],
    ['malformed retry payload', 'malformed_retry_payload'],
    ['permanent validation failure', 'permanent_validation_failure'],
  ];

  for (const [pattern, safeCode] of permanentPatterns) {
    if (text.includes(pattern)) {
      return {
        status: 'failed',
        safeCode,
        reason: safeCode,
        ambiguous: false,
      };
    }
  }

  const ambiguousPatterns = [
    'gateway_transfer_unconfirmed',
    'response timeout',
    'timed out',
    'broadcast',
    'submitted',
    'already known',
    'replacement transaction underpriced',
    'nonce too low',
    'nonce has already been used',
  ];

  if (hasAnyBroadcastHash(knownHashes)) {
    return {
      status: 'manual_review',
      safeCode: 'post_broadcast_ambiguous',
      reason: 'post_broadcast_ambiguous',
      ambiguous: true,
    };
  }

  for (const pattern of ambiguousPatterns) {
    if (text.includes(pattern)) {
      return {
        status: 'manual_review',
        safeCode: 'post_broadcast_ambiguous',
        reason: 'post_broadcast_ambiguous',
        ambiguous: true,
      };
    }
  }

  const retryablePreflightPatterns = [
    'temporarily unavailable',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
    'connection reset',
    'socket hang up',
    'timeout before send',
  ];

  for (const pattern of retryablePreflightPatterns) {
    if (text.includes(pattern)) {
      return {
        status: 'deferred',
        safeCode: 'rpc_unavailable_preflight',
        reason: 'rpc_unavailable_preflight',
        ambiguous: false,
      };
    }
  }

  return {
    status: 'manual_review',
    safeCode: toSafeErrorCode(code, 'unclassified_retry_error'),
    reason: 'unclassified_retry_error',
    ambiguous: true,
  };
}

function defaultJitterFn(delayMs) {
  const spread = Math.max(Math.floor(delayMs * 0.1), 1);
  const jitter = Math.floor(Math.random() * (spread + 1));
  return Math.max(delayMs + jitter, 0);
}

function computeNextRetryDelayMs(attemptCount, options = {}) {
  const baseDelayMs = resolvePaymentRetryBaseDelayMs(options.baseDelayMs);
  const maxDelayMs = resolvePaymentRetryMaxDelayMs(options.maxDelayMs);
  const safeAttempt = Math.max(Number(attemptCount) || 0, 0);
  const exponentialDelay = Math.min(baseDelayMs * (2 ** safeAttempt), maxDelayMs);
  const jitterFn = typeof options.jitterFn === 'function' ? options.jitterFn : defaultJitterFn;
  return Math.min(Math.max(Number(jitterFn(exponentialDelay)) || exponentialDelay, 0), maxDelayMs);
}

function computeNextAttemptAt(attemptCount, options = {}) {
  const delayMs = computeNextRetryDelayMs(attemptCount, options);
  return new Date(Date.now() + delayMs).toISOString();
}

function maskTxHash(txHash) {
  const value = String(txHash || '').trim();
  if (!value || value.length < 12) return null;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function normalizeRetryIntentInput(input = {}) {
  const normalizedFeeUsdc = normalizeFeeUsdc(input.feeUsdc);
  const sourceChain = normalizeText(input.sourceChain || input.fromChain, null);
  const destinationChain = normalizeText(input.destinationChain || input.toChain, null);
  const rail = normalizeText(input.rail, null);
  const referenceType = normalizeText(input.referenceType, null);

  if (!sourceChain || !destinationChain || !rail || !referenceType) {
    throw new Error('malformed_retry_payload');
  }

  const idempotencyKey = normalizeText(input.idempotencyKey, null)
    || buildPaymentIdempotencyKey({
      agentId: input.agentId,
      rail,
      referenceType,
      referenceId: input.referenceId,
      feeUsdc: normalizedFeeUsdc,
      recipient: input.recipient || input.recipientAddress,
      sourceChain,
      destinationChain,
    });

  return {
    idempotencyKey,
    agentId: normalizeText(input.agentId, null),
    eventType: normalizeText(input.eventType, DEFAULT_EVENT_TYPE),
    rail,
    referenceType,
    referenceId: normalizeText(input.referenceId, null),
    feeUsdc: normalizedFeeUsdc,
    token: normalizeText(input.token, DEFAULT_TOKEN) || DEFAULT_TOKEN,
    sourceChain,
    destinationChain,
    recipientAddress: normalizeAddress(input.recipientAddress || input.recipient),
    status: normalizeStatus(input.status, 'pending'),
    attemptCount: Math.max(readNonNegativeInteger(input.attemptCount, 0), 0),
    maxAttempts: Math.max(readPositiveIntegerEnv('PAYMENT_RETRY_MAX_ATTEMPTS', DEFAULT_RETRY_MAX_ATTEMPTS), readNonNegativeInteger(input.maxAttempts, resolvePaymentRetryMaxAttempts())),
    nextAttemptAt: input.nextAttemptAt || null,
    lockedAt: input.lockedAt || null,
    lockedBy: normalizeText(input.lockedBy, null),
    lastErrorCode: normalizeText(input.lastErrorCode, null),
    lastError: normalizeText(input.lastError, null),
    gatewayApprovalTxHash: normalizeText(input.gatewayApprovalTxHash, null),
    gatewayDepositTxHash: normalizeText(input.gatewayDepositTxHash, null),
    gatewayMintTxHash: normalizeText(input.gatewayMintTxHash, null),
    payload: normalizeJsonObject(input.payload),
  };
}

async function getRetryIntentById(intentId, client = db) {
  const { rows: [row] } = await client.query(
    `SELECT *
       FROM agentic_payment_retry_intents
      WHERE id = $1
      LIMIT 1`,
    [intentId],
  );
  return row || null;
}

async function getRetryIntentByIdempotencyKey(idempotencyKey, client = db) {
  const { rows: [row] } = await client.query(
    `SELECT *
       FROM agentic_payment_retry_intents
      WHERE idempotency_key = $1
      LIMIT 1`,
    [idempotencyKey],
  );
  return row || null;
}

async function hasConfirmedEventForIntent(intent, client = db) {
  const idempotencyKey = normalizeText(intent?.idempotency_key, null);
  if (!idempotencyKey) return false;

  const normalizedFee = (() => {
    try {
      return normalizeFeeUsdcForKey(intent?.fee_usdc);
    } catch {
      return null;
    }
  })();

  const legacyAgentId = normalizeText(intent?.agent_id, null);
  const legacyRail = normalizeText(intent?.rail, null);
  const legacyReferenceType = normalizeText(intent?.reference_type, null);
  const legacyReferenceId = normalizeText(intent?.reference_id, '');
  const legacyRecipient = normalizeAddress(intent?.recipient_address || null);
  const legacySourceChain = normalizeText(intent?.source_chain, null);
  const legacyDestinationChain = normalizeText(intent?.destination_chain, null);
  const legacyToken = normalizeText(intent?.token, null);
  const hasStrictLegacyIdentity = Boolean(
    legacyAgentId
    && legacyRail
    && legacyReferenceType
    && legacyRecipient
    && legacySourceChain
    && legacyDestinationChain
    && legacyToken
    && normalizedFee,
  );

  const { rows: [existing] } = await client.query(
    `SELECT id
       FROM agentic_payment_events
      WHERE status = 'confirmed'
        AND event_type = $1
        AND (
          payload->>'idempotencyKey' = $2
          OR (
            $3::boolean = TRUE
            AND agent_id IS NOT NULL
            AND counterparty_address IS NOT NULL
            AND source_chain IS NOT NULL
            AND destination_chain IS NOT NULL
            AND token IS NOT NULL
            AND amount_usdc IS NOT NULL
            AND agent_id::text = $4
            AND rail = $5
            AND reference_type = $6
            AND COALESCE(reference_id, '') = $7
            AND LOWER(counterparty_address) = $8
            AND source_chain = $9
            AND destination_chain = $10
            AND token = $11
            AND ROUND(amount_usdc::numeric, 6) = $12::numeric
          )
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    [
      intent.event_type || DEFAULT_EVENT_TYPE,
      idempotencyKey,
      hasStrictLegacyIdentity,
      legacyAgentId,
      legacyRail,
      legacyReferenceType,
      legacyReferenceId,
      legacyRecipient,
      legacySourceChain,
      legacyDestinationChain,
      legacyToken,
      normalizedFee,
    ],
  );

  return Boolean(existing?.id);
}

async function insertPaymentEvent(client, event) {
  const payload = normalizeJsonObject(event.payload);

  const { rows: [row] } = await client.query(
    `INSERT INTO agentic_payment_events
       (agent_id, event_type, rail, reference_type, reference_id, tx_hash, amount_usdc,
        token, status, source_chain, destination_chain, counterparty_address, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13::jsonb)
     RETURNING *`,
    [
      event.agentId || null,
      event.eventType || DEFAULT_EVENT_TYPE,
      event.rail,
      event.referenceType,
      event.referenceId || null,
      event.txHash || null,
      Number.isFinite(Number(event.amountUsdc)) ? Number(event.amountUsdc) : null,
      event.token || DEFAULT_TOKEN,
      event.status,
      event.sourceChain || null,
      event.destinationChain || null,
      event.counterpartyAddress || null,
      JSON.stringify(payload),
    ],
  );

  return row || null;
}

async function insertConfirmedEventIfMissing(client, intent, txHashes = {}, payload = {}) {
  const exists = await hasConfirmedEventForIntent(intent, client);
  if (exists) {
    return { inserted: false, row: null };
  }

  const eventRow = await insertPaymentEvent(client, {
    agentId: intent.agent_id || null,
    eventType: intent.event_type || DEFAULT_EVENT_TYPE,
    rail: intent.rail,
    referenceType: intent.reference_type,
    referenceId: intent.reference_id || null,
    txHash: txHashes.mintTxHash || txHashes.depositTxHash || txHashes.approvalTxHash || txHashes.txHash || null,
    amountUsdc: intent.fee_usdc,
    token: intent.token || DEFAULT_TOKEN,
    status: 'confirmed',
    sourceChain: intent.source_chain,
    destinationChain: intent.destination_chain,
    counterpartyAddress: intent.recipient_address || null,
    payload: {
      idempotencyKey: intent.idempotency_key,
      retryIntentId: intent.id,
      gatewayApprovalTxHash: txHashes.approvalTxHash || null,
      gatewayDepositTxHash: txHashes.depositTxHash || null,
      gatewayMintTxHash: txHashes.mintTxHash || null,
      ...normalizeJsonObject(payload),
    },
  });

  return { inserted: Boolean(eventRow?.id), row: eventRow };
}

async function appendNonTerminalEvent(intent, status, meta = {}) {
  return insertPaymentEvent(db, {
    agentId: intent.agent_id || null,
    eventType: intent.event_type || DEFAULT_EVENT_TYPE,
    rail: intent.rail,
    referenceType: intent.reference_type,
    referenceId: intent.reference_id || null,
    txHash: meta.txHash || null,
    amountUsdc: intent.fee_usdc,
    token: intent.token || DEFAULT_TOKEN,
    status,
    sourceChain: intent.source_chain,
    destinationChain: intent.destination_chain,
    counterpartyAddress: intent.recipient_address || null,
    payload: {
      idempotencyKey: intent.idempotency_key,
      retryIntentId: intent.id,
      safeCode: meta.safeCode || null,
      errorCode: meta.errorCode || null,
      error: meta.error || null,
      gatewayApprovalTxHash: meta.gatewayApprovalTxHash || null,
      gatewayDepositTxHash: meta.gatewayDepositTxHash || null,
      gatewayMintTxHash: meta.gatewayMintTxHash || null,
      ...normalizeJsonObject(meta.payload),
    },
  }).catch(() => null);
}

async function createOrUpdateRetryIntent(input = {}, options = {}) {
  const intent = normalizeRetryIntentInput(input);
  const conflictMode = String(options.conflictMode || 'upsert').trim().toLowerCase();
  const intentPayload = {
    ...normalizeJsonObject(intent.payload),
    submissionPhase: normalizeSubmissionPhase(intent.payload?.submissionPhase, 'preflight'),
  };

  const { rows: insertedRows } = await db.query(
    `INSERT INTO agentic_payment_retry_intents
       (idempotency_key, agent_id, event_type, rail, reference_type, reference_id,
        fee_usdc, token, source_chain, destination_chain, recipient_address,
        status, attempt_count, max_attempts, next_attempt_at, locked_at, locked_by,
        last_error_code, last_error, gateway_approval_tx_hash, gateway_deposit_tx_hash,
        gateway_mint_tx_hash, payload)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21,
             $22, $23::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      intent.idempotencyKey,
      intent.agentId,
      intent.eventType,
      intent.rail,
      intent.referenceType,
      intent.referenceId,
      intent.feeUsdc,
      intent.token,
      intent.sourceChain,
      intent.destinationChain,
      intent.recipientAddress,
      intent.status,
      intent.attemptCount,
      intent.maxAttempts,
      intent.nextAttemptAt,
      intent.lockedAt,
      intent.lockedBy,
      intent.lastErrorCode,
      intent.lastError,
      intent.gatewayApprovalTxHash,
      intent.gatewayDepositTxHash,
      intent.gatewayMintTxHash,
      JSON.stringify(intentPayload),
    ],
  );

  if (insertedRows[0]) {
    return {
      intent: insertedRows[0],
      created: true,
      updated: false,
      duplicate: false,
    };
  }

  const existing = await getRetryIntentByIdempotencyKey(intent.idempotencyKey);
  if (conflictMode === 'insert_only') {
    return {
      intent: existing,
      created: false,
      updated: false,
      duplicate: true,
    };
  }

  const { rows: updatedRows } = await db.query(
    `UPDATE agentic_payment_retry_intents
        SET agent_id = COALESCE($2, agent_id),
            status = $3,
            max_attempts = GREATEST(max_attempts, $4),
            next_attempt_at = COALESCE($5::timestamptz, next_attempt_at),
            last_error_code = COALESCE($6, last_error_code),
            last_error = COALESCE($7, last_error),
            recipient_address = COALESCE($8, recipient_address),
            payload = COALESCE(payload, '{}'::jsonb) || $9::jsonb,
            updated_at = NOW()
      WHERE idempotency_key = $1
        AND status IN ('pending', 'deferred')
      RETURNING *`,
    [
      intent.idempotencyKey,
      intent.agentId,
      normalizeStatus(intent.status, 'deferred'),
      intent.maxAttempts,
      intent.nextAttemptAt,
      intent.lastErrorCode,
      intent.lastError,
      intent.recipientAddress,
        JSON.stringify(intentPayload),
    ],
  );

  if (updatedRows[0]) {
    return {
      intent: updatedRows[0],
      created: false,
      updated: true,
      duplicate: false,
    };
  }

  return {
    intent: existing || (await getRetryIntentByIdempotencyKey(intent.idempotencyKey)),
    created: false,
    updated: false,
    duplicate: true,
  };
}

async function backfillDeferredPaymentEvents(options = {}) {
  const limit = Math.max(readNonNegativeInteger(options.limit, DEFAULT_BACKFILL_SCAN_LIMIT), 1);
  const summary = {
    scanned: 0,
    inserted: 0,
    skippedConfirmed: 0,
    skippedDuplicate: 0,
    invalidPayload: 0,
  };

  const { rows } = await db.query(
    `SELECT id, agent_id, event_type, rail, reference_type, reference_id,
            amount_usdc, token, source_chain, destination_chain, counterparty_address,
            payload
       FROM agentic_payment_events
      WHERE status = 'deferred'
        AND payload ? 'retryIntent'
      ORDER BY id ASC
      LIMIT $1`,
    [limit],
  );

  for (const row of rows) {
    summary.scanned += 1;

    const payload = normalizeJsonObject(row.payload);
    const retryIntent = normalizeJsonObject(payload.retryIntent);

    try {
      const sourceChain = normalizeText(retryIntent.fromChain || retryIntent.sourceChain || row.source_chain, null);
      const destinationChain = normalizeText(retryIntent.toChain || retryIntent.destinationChain || row.destination_chain, null);
      const feeUsdc = retryIntent.feeUsdc != null ? retryIntent.feeUsdc : row.amount_usdc;
      const rail = normalizeText(retryIntent.rail || row.rail, null);
      const referenceType = normalizeText(retryIntent.referenceType || row.reference_type, null);
      const referenceId = normalizeText(retryIntent.referenceId || row.reference_id, null);
      const recipient = normalizeAddress(retryIntent.recipient || row.counterparty_address || payload.recipientAddress || null);

      if (!sourceChain || !destinationChain || !rail || !referenceType || !(Number(feeUsdc) > 0)) {
        summary.invalidPayload += 1;
        continue;
      }

      const idempotencyKey = buildPaymentIdempotencyKey({
        agentId: row.agent_id,
        rail,
        referenceType,
        referenceId,
        feeUsdc,
        recipient,
        sourceChain,
        destinationChain,
      });

      const hasConfirmed = await hasConfirmedEventForIntent({
        id: null,
        idempotency_key: idempotencyKey,
        event_type: row.event_type || DEFAULT_EVENT_TYPE,
        rail,
        reference_type: referenceType,
        reference_id: referenceId,
        fee_usdc: feeUsdc,
      });

      if (hasConfirmed) {
        summary.skippedConfirmed += 1;
        continue;
      }

      const createResult = await createOrUpdateRetryIntent({
        idempotencyKey,
        agentId: row.agent_id,
        eventType: row.event_type || DEFAULT_EVENT_TYPE,
        rail,
        referenceType,
        referenceId,
        feeUsdc,
        token: row.token || DEFAULT_TOKEN,
        sourceChain,
        destinationChain,
        recipientAddress: recipient,
        status: 'deferred',
        attemptCount: 0,
        maxAttempts: resolvePaymentRetryMaxAttempts(),
        nextAttemptAt: null,
        payload: {
          source: 'agentic_payment_events_backfill',
          sourceEventId: row.id,
          retryIntent,
          idempotencyKey,
        },
      }, {
        conflictMode: 'insert_only',
      });

      if (createResult.created) {
        summary.inserted += 1;
      } else {
        summary.skippedDuplicate += 1;
      }
    } catch {
      summary.invalidPayload += 1;
    }
  }

  const skipped = summary.skippedConfirmed + summary.skippedDuplicate + summary.invalidPayload;
  console.log(`[PAYMENT_RETRY] Backfill complete scanned=${summary.scanned} inserted=${summary.inserted} skipped=${skipped} skippedConfirmed=${summary.skippedConfirmed} skippedDuplicate=${summary.skippedDuplicate} invalidPayload=${summary.invalidPayload}`);

  return summary;
}

async function claimDueRetryIntents(options = {}) {
  const batchSize = Math.max(readNonNegativeInteger(options.batchSize, 10), 1);
  const workerIdBase = normalizeText(options.workerId, `payment-retry-${os.hostname()}-${process.pid}`);
  const lockTimeoutMs = resolvePaymentRetryLockTimeoutMs(options.lockTimeoutMs);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `WITH due AS (
         SELECT id
           FROM agentic_payment_retry_intents
          WHERE status IN ('pending', 'deferred')
            AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
            AND attempt_count < max_attempts
            AND (locked_at IS NULL OR locked_at <= NOW() - ($3 * INTERVAL '1 millisecond'))
          ORDER BY COALESCE(next_attempt_at, created_at) ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE agentic_payment_retry_intents intents
          SET status = 'processing',
              locked_at = NOW(),
              locked_by = $2 || ':' || intents.id::text,
              updated_at = NOW()
         FROM due
        WHERE intents.id = due.id
        RETURNING intents.*`,
      [batchSize, workerIdBase, lockTimeoutMs],
    );

    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function markIntentDeferred(intentId, options = {}) {
  const nextAttemptAt = options.nextAttemptAt || null;
  const payloadPatch = {
    ...normalizeJsonObject(options.payload),
    submissionPhase: 'preflight',
  };

  const { rows: [row] } = await db.query(
    `UPDATE agentic_payment_retry_intents
        SET status = 'deferred',
            next_attempt_at = $2::timestamptz,
            locked_at = NULL,
            locked_by = NULL,
            last_error_code = $3,
            last_error = $4,
            payload = COALESCE(payload, '{}'::jsonb) || $5::jsonb,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      intentId,
      nextAttemptAt,
      normalizeText(options.lastErrorCode, null),
      normalizeText(options.lastError, null),
      JSON.stringify(payloadPatch),
    ],
  );

  if (!row) return null;

  await appendNonTerminalEvent(row, 'deferred', {
    safeCode: options.safeCode || null,
    errorCode: options.lastErrorCode || null,
    error: options.lastError || null,
    payload: {
      nextAttemptAt: row.next_attempt_at,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      reason: options.safeCode || null,
      ...normalizeJsonObject(options.payload),
    },
  });

  if (!options.silent) {
    console.log(`[PAYMENT_RETRY] Deferred intent=${row.id} reason=${options.safeCode || 'deferred'} nextRetryAt=${row.next_attempt_at || null}`);
  }
  return row;
}

async function markIntentFailed(intentId, options = {}) {
  const { rows: [row] } = await db.query(
    `UPDATE agentic_payment_retry_intents
        SET status = 'failed',
            next_attempt_at = NULL,
            locked_at = NULL,
            locked_by = NULL,
            last_error_code = $2,
            last_error = $3,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      intentId,
      normalizeText(options.lastErrorCode, null),
      normalizeText(options.lastError, null),
    ],
  );

  if (!row) return null;

  await appendNonTerminalEvent(row, 'failed', {
    safeCode: options.safeCode || null,
    errorCode: options.lastErrorCode || null,
    error: options.lastError || null,
    payload: normalizeJsonObject(options.payload),
  });

  if (!options.silent) {
    console.log(`[PAYMENT_RETRY] Failed intent=${row.id} reason=${options.safeCode || 'failed'}`);
  }
  return row;
}

async function markIntentManualReview(intentId, options = {}) {
  const txHashes = collectKnownHashes({
    gatewayApprovalTxHash: options.gatewayApprovalTxHash,
    gatewayDepositTxHash: options.gatewayDepositTxHash,
    gatewayMintTxHash: options.gatewayMintTxHash,
    txHash: options.txHash,
    payload: options.payload,
  });

  const { rows: [row] } = await db.query(
    `UPDATE agentic_payment_retry_intents
        SET status = 'manual_review',
            next_attempt_at = NULL,
            locked_at = NULL,
            locked_by = NULL,
            last_error_code = $2,
            last_error = $3,
            gateway_approval_tx_hash = COALESCE($4, gateway_approval_tx_hash),
            gateway_deposit_tx_hash = COALESCE($5, gateway_deposit_tx_hash),
            gateway_mint_tx_hash = COALESCE($6, gateway_mint_tx_hash),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      intentId,
      normalizeText(options.lastErrorCode, null),
      normalizeText(options.lastError, null),
      txHashes.approvalTxHash || null,
      txHashes.depositTxHash || null,
      txHashes.mintTxHash || null,
    ],
  );

  if (!row) return null;

  await appendNonTerminalEvent(row, 'manual_review', {
    safeCode: options.safeCode || null,
    errorCode: options.lastErrorCode || null,
    error: options.lastError || null,
    gatewayApprovalTxHash: txHashes.approvalTxHash || null,
    gatewayDepositTxHash: txHashes.depositTxHash || null,
    gatewayMintTxHash: txHashes.mintTxHash || null,
    txHash: txHashes.mintTxHash || txHashes.depositTxHash || txHashes.approvalTxHash || txHashes.txHash || null,
    payload: normalizeJsonObject(options.payload),
  });

  if (!options.silent) {
    console.log(`[PAYMENT_RETRY] Manual review intent=${row.id} reason=${options.safeCode || 'manual_review'}`);
  }
  return row;
}

async function markIntentConfirmed(intentId, options = {}) {
  const txHashes = collectKnownHashes({
    gatewayApprovalTxHash: options.gatewayApprovalTxHash,
    gatewayDepositTxHash: options.gatewayDepositTxHash,
    gatewayMintTxHash: options.gatewayMintTxHash,
    txHash: options.txHash,
    payload: options.payload,
  });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const completionPayload = {
      ...normalizeJsonObject(options.payload),
      submissionPhase: normalizeSubmissionPhase(options.submissionPhase, 'completed'),
      submissionCompletedAt: normalizeText(options.submissionCompletedAt, new Date().toISOString()),
    };

    const { rows: [intent] } = await client.query(
      `SELECT *
         FROM agentic_payment_retry_intents
        WHERE id = $1
        FOR UPDATE`,
      [intentId],
    );

    if (!intent) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows: [updated] } = await client.query(
      `UPDATE agentic_payment_retry_intents
          SET status = 'confirmed',
              next_attempt_at = NULL,
              locked_at = NULL,
              locked_by = NULL,
              last_error_code = NULL,
              last_error = NULL,
              gateway_approval_tx_hash = COALESCE($2, gateway_approval_tx_hash),
              gateway_deposit_tx_hash = COALESCE($3, gateway_deposit_tx_hash),
              gateway_mint_tx_hash = COALESCE($4, gateway_mint_tx_hash),
              payload = COALESCE(payload, '{}'::jsonb) || $5::jsonb,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        intentId,
        txHashes.approvalTxHash || null,
        txHashes.depositTxHash || null,
        txHashes.mintTxHash || null,
        JSON.stringify(completionPayload),
      ],
    );

    await insertConfirmedEventIfMissing(client, updated, txHashes, normalizeJsonObject(options.payload));

    await client.query('COMMIT');

    if (!options.silent) {
      console.log(`[PAYMENT_RETRY] Confirmed intent=${updated.id} tx=${maskTxHash(txHashes.mintTxHash || txHashes.depositTxHash || txHashes.approvalTxHash || txHashes.txHash) || 'n/a'}`);
    }
    return updated;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function increaseIntentAttemptCount(intentId) {
  const { rows: [row] } = await db.query(
    `UPDATE agentic_payment_retry_intents
        SET attempt_count = attempt_count + 1,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [intentId],
  );
  return row || null;
}

async function markIntentSubmissionStarted(intentId, options = {}) {
  const lockOwner = normalizeText(options.lockOwner, null);
  const payloadPatch = {
    ...normalizeJsonObject(options.payload),
    submissionPhase: 'submission_started',
    submissionStartedAt: normalizeText(options.submissionStartedAt, new Date().toISOString()),
  };

  const { rows: [row] } = await db.query(
    `UPDATE agentic_payment_retry_intents
        SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
      WHERE id = $1
        AND status = 'processing'
        AND ($2::text IS NULL OR locked_by = $2)
      RETURNING *`,
    [intentId, lockOwner, JSON.stringify(payloadPatch)],
  );

  return row || null;
}

async function releaseIntentAfterEnqueueFailure(intentId, options = {}) {
  const lockOwner = normalizeText(options.lockOwner, null);
  const attemptCount = Math.max(readNonNegativeInteger(options.attemptCount, 0), 0);
  const jitterFn = typeof options.jitterFn === 'function' ? options.jitterFn : defaultJitterFn;
  const nextAttemptAt = options.nextAttemptAt || computeNextAttemptAt(attemptCount, { jitterFn });
  const lastError = normalizeText(options.lastError, 'Retry enqueue failed');
  const payloadPatch = {
    ...normalizeJsonObject(options.payload),
    submissionPhase: 'preflight',
    enqueueFailure: {
      code: QUEUE_ENQUEUE_FAILED_CODE,
      at: new Date().toISOString(),
      lockOwner,
      message: lastError,
    },
  };

  const { rows: [row] } = await db.query(
    `UPDATE agentic_payment_retry_intents
        SET status = 'deferred',
            next_attempt_at = $3::timestamptz,
            locked_at = NULL,
            locked_by = NULL,
            last_error_code = $4,
            last_error = $5,
            payload = COALESCE(payload, '{}'::jsonb) || $6::jsonb,
            updated_at = NOW()
      WHERE id = $1
        AND status = 'processing'
        AND ($2::text IS NULL OR locked_by = $2)
      RETURNING *`,
    [
      intentId,
      lockOwner,
      nextAttemptAt,
      QUEUE_ENQUEUE_FAILED_CODE,
      lastError,
      JSON.stringify(payloadPatch),
    ],
  );

  if (!row) return null;

  await appendNonTerminalEvent(row, 'deferred', {
    safeCode: 'queue_enqueue_failed',
    errorCode: QUEUE_ENQUEUE_FAILED_CODE,
    error: lastError,
    payload: {
      nextAttemptAt: row.next_attempt_at,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      ...normalizeJsonObject(options.payload),
    },
  });

  if (!options.silent) {
    console.warn(`[PAYMENT_RETRY] Enqueue release intent=${row.id} nextRetryAt=${row.next_attempt_at || null}`);
  }

  return row;
}

async function processRetryIntent(options = {}) {
  const intentId = normalizeText(options.intentId, null);
  const lockOwner = normalizeText(options.lockOwner, null);
  const settleExecutionFee = options.settleExecutionFee;
  const jitterFn = typeof options.jitterFn === 'function' ? options.jitterFn : defaultJitterFn;

  if (!intentId) {
    return { ok: false, reason: 'intent_id_missing' };
  }
  if (typeof settleExecutionFee !== 'function') {
    return { ok: false, reason: 'settle_execution_fee_missing' };
  }

  let intent = await getRetryIntentById(intentId);
  if (!intent) {
    return { ok: false, reason: 'intent_not_found' };
  }

  if (['confirmed', 'failed', 'manual_review', 'cancelled'].includes(String(intent.status || '').toLowerCase())) {
    return { ok: true, skipped: true, reason: 'intent_terminal', status: intent.status };
  }

  if (intent.status !== 'processing') {
    return { ok: true, skipped: true, reason: 'intent_not_processing', status: intent.status };
  }

  if (lockOwner && intent.locked_by && String(intent.locked_by) !== lockOwner) {
    return { ok: true, skipped: true, reason: 'intent_locked_elsewhere', lockedBy: intent.locked_by };
  }

  const hasConfirmedEvent = await hasConfirmedEventForIntent(intent);
  if (hasConfirmedEvent) {
    await markIntentConfirmed(intent.id, {
      payload: {
        reconciliation: 'confirmed_event_exists',
      },
    });
    return { ok: true, reconciled: true, status: 'confirmed' };
  }

  const healthyArcRpcUrl = getHealthyArcRpcUrl('payment_retry_preflight', {
    trafficClass: 'transaction',
  });
  if (!healthyArcRpcUrl) {
    const nextAttemptAt = computeNextAttemptAt(intent.attempt_count, {
      jitterFn,
    });

    await markIntentDeferred(intent.id, {
      safeCode: 'arc_rpc_cooldown',
      lastErrorCode: ARC_RPC_COOLDOWN_CODE,
      lastError: 'Arc RPC is cooling down',
      nextAttemptAt,
      payload: {
        preflight: true,
      },
    });

    return {
      ok: true,
      status: 'deferred',
      reason: 'arc_rpc_cooldown',
      nextAttemptAt,
      attemptCount: intent.attempt_count,
    };
  }

  if (!intent.agent_id) {
    await markIntentFailed(intent.id, {
      safeCode: 'malformed_retry_payload',
      lastErrorCode: 'malformed_retry_payload',
      lastError: 'Retry intent does not include agent id',
    });
    return { ok: true, status: 'failed', reason: 'malformed_retry_payload' };
  }

  const { rows: [agent] } = await db.query(
    `SELECT id, user_id, name, wallet_address, private_key_encrypted, status
       FROM agents
      WHERE id = $1
      LIMIT 1`,
    [intent.agent_id],
  );

  if (!agent || !agent.private_key_encrypted) {
    await markIntentFailed(intent.id, {
      safeCode: 'signer_unavailable',
      lastErrorCode: 'signer_unavailable',
      lastError: 'Agent signer is unavailable',
    });
    return { ok: true, status: 'failed', reason: 'signer_unavailable' };
  }

  intent = await increaseIntentAttemptCount(intent.id) || intent;

  if (intent.attempt_count > intent.max_attempts) {
    await markIntentFailed(intent.id, {
      safeCode: 'max_attempts_exhausted',
      lastErrorCode: 'max_attempts_exhausted',
      lastError: 'Retry attempts exhausted',
    });
    return { ok: true, status: 'failed', reason: 'max_attempts_exhausted' };
  }

  try {
    const submissionStarted = await markIntentSubmissionStarted(intent.id, {
      lockOwner,
    });
    if (!submissionStarted) {
      return { ok: true, skipped: true, reason: 'intent_not_processing_before_submission' };
    }

    const payload = normalizeJsonObject(intent.payload);
    const settlement = await settleExecutionFee({
      agent,
      referenceId: intent.reference_id || `retry-intent-${intent.id}`,
      referenceType: intent.reference_type,
      feeUsdc: Number(intent.fee_usdc),
      fromChain: intent.source_chain,
      toChain: intent.destination_chain,
      mode: normalizeText(payload.mode, 'circle_gateway_execution_fee'),
      rail: intent.rail,
      idempotencyKey: intent.idempotency_key,
      replayFingerprint: intent.idempotency_key,
      retryIntentId: intent.id,
      isRetryAttempt: true,
      skipAuditEvent: true,
    });

    const resultHashes = collectKnownHashes(settlement);

    if (settlement?.status === 'confirmed' && resultHashes.mintTxHash) {
      await markIntentConfirmed(intent.id, {
        gatewayApprovalTxHash: settlement.gatewayApprovalTxHash || resultHashes.approvalTxHash || null,
        gatewayDepositTxHash: settlement.gatewayDepositTxHash || resultHashes.depositTxHash || null,
        gatewayMintTxHash: settlement.gatewayMintTxHash || resultHashes.mintTxHash || null,
        payload: {
          settlement,
          confirmedBy: 'retry_worker',
        },
      });

      return {
        ok: true,
        status: 'confirmed',
        mintTxHash: settlement.gatewayMintTxHash || resultHashes.mintTxHash,
      };
    }

    if (settlement?.status === 'deferred') {
      if (intent.attempt_count >= intent.max_attempts) {
        await markIntentFailed(intent.id, {
          safeCode: 'max_attempts_exhausted',
          lastErrorCode: 'max_attempts_exhausted',
          lastError: 'Retry attempts exhausted while deferred',
          payload: { settlement },
        });
        return { ok: true, status: 'failed', reason: 'max_attempts_exhausted' };
      }

      const nextAttemptAt = computeNextAttemptAt(intent.attempt_count, { jitterFn });
      await markIntentDeferred(intent.id, {
        safeCode: normalizeText(settlement.reason, 'deferred'),
        lastErrorCode: normalizeText(settlement.errorCode, ARC_RPC_COOLDOWN_CODE),
        lastError: normalizeText(settlement.error, 'Retry deferred'),
        nextAttemptAt,
        payload: { settlement },
      });

      return {
        ok: true,
        status: 'deferred',
        reason: settlement.reason || 'deferred',
        nextAttemptAt,
      };
    }

    if (settlement?.status === 'failed' && !resultHashes.mintTxHash && (resultHashes.approvalTxHash || resultHashes.depositTxHash)) {
      await markIntentManualReview(intent.id, {
        safeCode: 'post_broadcast_ambiguous',
        lastErrorCode: normalizeText(settlement.errorCode, 'post_broadcast_ambiguous'),
        lastError: normalizeText(settlement.error, 'Gateway transfer confirmation is missing'),
        gatewayApprovalTxHash: settlement.gatewayApprovalTxHash || resultHashes.approvalTxHash || null,
        gatewayDepositTxHash: settlement.gatewayDepositTxHash || resultHashes.depositTxHash || null,
        gatewayMintTxHash: settlement.gatewayMintTxHash || resultHashes.mintTxHash || null,
        payload: { settlement },
      });

      return {
        ok: true,
        status: 'manual_review',
        reason: 'post_broadcast_ambiguous',
      };
    }

    const classified = classifyRetryFailure({ message: settlement?.error || settlement?.reason || 'retry_failed' }, resultHashes);

    if (classified.status === 'deferred' && intent.attempt_count < intent.max_attempts) {
      const nextAttemptAt = computeNextAttemptAt(intent.attempt_count, { jitterFn });
      await markIntentDeferred(intent.id, {
        safeCode: classified.safeCode,
        lastErrorCode: classified.safeCode,
        lastError: settlement?.error || settlement?.reason || 'Retry deferred',
        nextAttemptAt,
        payload: { settlement },
      });
      return { ok: true, status: 'deferred', reason: classified.safeCode, nextAttemptAt };
    }

    if (classified.status === 'manual_review') {
      await markIntentManualReview(intent.id, {
        safeCode: classified.safeCode,
        lastErrorCode: classified.safeCode,
        lastError: settlement?.error || settlement?.reason || 'Retry requires manual review',
        gatewayApprovalTxHash: settlement?.gatewayApprovalTxHash || resultHashes.approvalTxHash || null,
        gatewayDepositTxHash: settlement?.gatewayDepositTxHash || resultHashes.depositTxHash || null,
        gatewayMintTxHash: settlement?.gatewayMintTxHash || resultHashes.mintTxHash || null,
        payload: { settlement },
      });
      return { ok: true, status: 'manual_review', reason: classified.safeCode };
    }

    await markIntentFailed(intent.id, {
      safeCode: classified.safeCode,
      lastErrorCode: classified.safeCode,
      lastError: settlement?.error || settlement?.reason || 'Retry failed',
      payload: { settlement },
    });

    return { ok: true, status: 'failed', reason: classified.safeCode };
  } catch (error) {
    const knownHashes = collectKnownHashes(error);
    const classified = classifyRetryFailure(error, knownHashes);

    if (classified.status === 'deferred' && intent.attempt_count < intent.max_attempts) {
      const nextAttemptAt = computeNextAttemptAt(intent.attempt_count, { jitterFn });
      await markIntentDeferred(intent.id, {
        safeCode: classified.safeCode,
        lastErrorCode: classified.safeCode,
        lastError: error?.message || 'Retry deferred',
        nextAttemptAt,
        payload: {
          retryError: classified.safeCode,
        },
      });
      return { ok: true, status: 'deferred', reason: classified.safeCode, nextAttemptAt };
    }

    if (classified.status === 'manual_review') {
      await markIntentManualReview(intent.id, {
        safeCode: classified.safeCode,
        lastErrorCode: classified.safeCode,
        lastError: error?.message || 'Retry requires manual review',
        gatewayApprovalTxHash: knownHashes.approvalTxHash || null,
        gatewayDepositTxHash: knownHashes.depositTxHash || null,
        gatewayMintTxHash: knownHashes.mintTxHash || null,
        txHash: knownHashes.txHash || null,
      });
      return { ok: true, status: 'manual_review', reason: classified.safeCode };
    }

    await markIntentFailed(intent.id, {
      safeCode: intent.attempt_count >= intent.max_attempts ? 'max_attempts_exhausted' : classified.safeCode,
      lastErrorCode: classified.safeCode,
      lastError: error?.message || 'Retry failed',
    });

    return {
      ok: true,
      status: 'failed',
      reason: intent.attempt_count >= intent.max_attempts ? 'max_attempts_exhausted' : classified.safeCode,
    };
  }
}

async function releaseExpiredLocks(options = {}) {
  const lockTimeoutMs = resolvePaymentRetryLockTimeoutMs(options.lockTimeoutMs);
  const { rows } = await db.query(
    `SELECT *
       FROM agentic_payment_retry_intents
      WHERE status = 'processing'
        AND locked_at IS NOT NULL
        AND locked_at <= NOW() - ($1 * INTERVAL '1 millisecond')
      ORDER BY locked_at ASC
      LIMIT $2`,
    [lockTimeoutMs, Math.max(readNonNegativeInteger(options.limit, 100), 1)],
  );

  let reopened = 0;
  let manualReview = 0;

  for (const row of rows) {
    const payload = normalizeJsonObject(row.payload);
    const payloadHashes = collectKnownHashes(payload);
    const submissionPhase = normalizeSubmissionPhase(payload.submissionPhase, 'preflight');
    const hasBroadcast = Boolean(
      row.gateway_approval_tx_hash
      || row.gateway_deposit_tx_hash
      || row.gateway_mint_tx_hash
      || payloadHashes.approvalTxHash
      || payloadHashes.depositTxHash
      || payloadHashes.mintTxHash
      || payloadHashes.txHash,
    );
    const submissionStarted = submissionPhase === 'submission_started';
    const completedPhase = submissionPhase === 'completed';

    if (hasBroadcast || submissionStarted || completedPhase) {
      const safeCode = hasBroadcast
        ? 'lock_expired_post_broadcast'
        : submissionStarted
          ? 'lock_expired_submission_started'
          : 'lock_expired_completed_phase';
      await markIntentManualReview(row.id, {
        safeCode,
        lastErrorCode: safeCode,
        lastError: hasBroadcast
          ? 'Processing lock expired after a potential broadcast'
          : submissionStarted
            ? 'Processing lock expired after submission started'
            : 'Processing lock expired after completion phase mismatch',
        gatewayApprovalTxHash: row.gateway_approval_tx_hash || payloadHashes.approvalTxHash || null,
        gatewayDepositTxHash: row.gateway_deposit_tx_hash || payloadHashes.depositTxHash || null,
        gatewayMintTxHash: row.gateway_mint_tx_hash || payloadHashes.mintTxHash || null,
        payload: {
          submissionPhase,
        },
        silent: true,
      });
      manualReview += 1;
      continue;
    }

    await db.query(
      `UPDATE agentic_payment_retry_intents
          SET status = 'deferred',
              next_attempt_at = NOW(),
              locked_at = NULL,
              locked_by = NULL,
              payload = COALESCE(payload, '{}'::jsonb) || '{"submissionPhase":"preflight"}'::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [row.id],
    );
    reopened += 1;
  }

  if (rows.length > 0) {
    console.log(`[PAYMENT_RETRY] Lock recovery reopened=${reopened} manualReview=${manualReview}`);
  }

  return {
    scanned: rows.length,
    reopened,
    manualReview,
  };
}

module.exports = {
  createOrUpdateRetryIntent,
  backfillDeferredPaymentEvents,
  claimDueRetryIntents,
  processRetryIntent,
  markIntentDeferred,
  markIntentConfirmed,
  markIntentFailed,
  markIntentManualReview,
  releaseExpiredLocks,
  releaseIntentAfterEnqueueFailure,
  markIntentSubmissionStarted,
  buildPaymentIdempotencyKey,
  computeNextRetryDelayMs,
  classifyRetryFailure,
  isArcRpcCooldownError,
  QUEUE_ENQUEUE_FAILED_CODE,
};
