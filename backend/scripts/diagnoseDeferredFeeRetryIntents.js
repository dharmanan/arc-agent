'use strict';

const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const db = require('../src/db');
const paymentRetryService = require('../src/services/agenticEconomy/paymentRetryService');

async function run() {
  const summary = {
    scanned: 0,
    matchedRetryIntent: 0,
    missingRetryIntent: 0,
    withIdempotencyKey: 0,
    pendingOrDeferred: 0,
    attemptCountZero: 0,
    confirmedDuplicateEvents: 0,
  };

  const { rows } = await db.query(
    `SELECT id, agent_id, rail, reference_type, reference_id, amount_usdc,
            source_chain, destination_chain, counterparty_address, payload
       FROM agentic_payment_events
      WHERE status = 'deferred'
        AND event_type = 'task_execution_fee'
        AND rail = 'agentic_automation_economy'
        AND amount_usdc = 0.1
      ORDER BY id ASC`,
  );

  summary.scanned = rows.length;

  for (const row of rows) {
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const retryIntent = payload.retryIntent && typeof payload.retryIntent === 'object'
      ? payload.retryIntent
      : {};

    const sourceChain = retryIntent.fromChain || retryIntent.sourceChain || row.source_chain || 'Arc Testnet';
    const destinationChain = retryIntent.toChain || retryIntent.destinationChain || row.destination_chain || 'Arc Testnet';
    const recipient = retryIntent.recipient || row.counterparty_address || payload.recipientAddress || null;

    const idempotencyKey = paymentRetryService.buildPaymentIdempotencyKey({
      agentId: row.agent_id,
      rail: row.rail,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      feeUsdc: row.amount_usdc,
      recipient,
      sourceChain,
      destinationChain,
    });

    if (idempotencyKey) {
      summary.withIdempotencyKey += 1;
    }

    const { rows: [intent] } = await db.query(
      `SELECT id, status, attempt_count
         FROM agentic_payment_retry_intents
        WHERE idempotency_key = $1
        LIMIT 1`,
      [idempotencyKey],
    );

    if (!intent) {
      summary.missingRetryIntent += 1;
    } else {
      summary.matchedRetryIntent += 1;
      if (intent.status === 'pending' || intent.status === 'deferred') {
        summary.pendingOrDeferred += 1;
      }
      if (Number(intent.attempt_count || 0) === 0) {
        summary.attemptCountZero += 1;
      }
    }

    const { rows: [confirmed] } = await db.query(
      `SELECT id
         FROM agentic_payment_events
        WHERE status = 'confirmed'
          AND event_type = 'task_execution_fee'
          AND (
            payload->>'idempotencyKey' = $1
            OR (
              rail = $2
              AND reference_type = $3
              AND COALESCE(reference_id, '') = COALESCE($4, '')
              AND amount_usdc = $5::numeric
            )
          )
        LIMIT 1`,
      [
        idempotencyKey,
        row.rail,
        row.reference_type,
        row.reference_id,
        row.amount_usdc,
      ],
    );

    if (confirmed?.id) {
      summary.confirmedDuplicateEvents += 1;
    }
  }

  console.log('[PAYMENT_RETRY_DIAGNOSTIC]', JSON.stringify(summary));
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[PAYMENT_RETRY_DIAGNOSTIC] failed:', error.message);
    process.exit(1);
  });
