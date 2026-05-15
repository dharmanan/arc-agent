'use strict';

const db = require('../../db');
const { logAgenticEconomy } = require('./logger');

function normalizePayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
}

function normalizeAmount(amountUsdc) {
  const parsed = Number(amountUsdc);
  return Number.isFinite(parsed) ? parsed : null;
}

async function recordAgenticPaymentEvent({
  agentId = null,
  eventType,
  rail,
  referenceType,
  referenceId = null,
  txHash = null,
  amountUsdc = null,
  token = 'USDC',
  status,
  sourceChain = null,
  destinationChain = null,
  counterpartyAddress = null,
  payload = {},
}) {
  const { rows: [row] } = await db.query(
    `INSERT INTO agentic_payment_events
       (agent_id, event_type, rail, reference_type, reference_id, tx_hash, amount_usdc,
        token, status, source_chain, destination_chain, counterparty_address, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13::jsonb)
     RETURNING *`,
    [
      agentId,
      eventType,
      rail,
      referenceType,
      referenceId,
      txHash,
      normalizeAmount(amountUsdc),
      token,
      status,
      sourceChain,
      destinationChain,
      counterpartyAddress,
      JSON.stringify(normalizePayload(payload)),
    ],
  );

  return row;
}

async function recordAgenticPaymentEventSafe(event) {
  try {
    return await recordAgenticPaymentEvent(event);
  } catch (err) {
    logAgenticEconomy('warn', 'Failed to persist agentic payment event', {
      error: err.message,
      eventType: event?.eventType,
      rail: event?.rail,
      referenceId: event?.referenceId || null,
      referenceType: event?.referenceType,
      status: event?.status,
    });
    return null;
  }
}

module.exports = {
  recordAgenticPaymentEvent,
  recordAgenticPaymentEventSafe,
};