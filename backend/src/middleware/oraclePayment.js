'use strict';
/**
 * oraclePayment — x402 nanopayment guard for public oracle endpoints.
 *
 * Flow for external callers (no account needed):
 *   1. Call endpoint without X-Payment-Tx header.
 *   2. Receive 402 { error, price, payTo, chain, callbackEndpoint }.
 *   3. Send USDC on Arc Testnet to payTo address.
 *   4. Retry the same request with X-Payment-Tx: <txHash>.
 *   5. Server verifies on-chain; serves data.
 *
 * Replay protection: verified tx hashes cached in Redis for 1 hour.
 * Testnet: simple RPC receipt check. Mainnet: upgrade to Circle x402 Gateway.
 */
const { ethers }    = require('ethers');
const redis         = require('../services/redisClient');
const { getPrice }  = require('../services/oracle/pricing');
const db            = require('../db');

const ORACLE_PAY_ADDRESS = (process.env.ORACLE_PAY_ADDRESS || '').toLowerCase();
const ARC_RPC_URL        = process.env.ARC_TESTNET_RPC || process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';

// Minimal ERC-20 Transfer event topic
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// USDC on Arc Testnet (6 decimals) — 0x3600...
const USDC_ADDRESS   = (process.env.USDC_ADDRESS_ARC || process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000').toLowerCase();
const USDC_DECIMALS  = 6;

/**
 * Verify that txHash is a confirmed USDC transfer of at least `expectedUsdc`
 * to `ORACLE_PAY_ADDRESS` on Arc Testnet.
 *
 * Returns { ok: true, amountUsdc, from } on success, { ok: false, reason } on failure.
 */
async function verifyPaymentTx(txHash, expectedUsdc) {
  if (!ORACLE_PAY_ADDRESS) {
    // Hard fail — running without ORACLE_PAY_ADDRESS in production is a misconfiguration.
    // Dev/test: set ORACLE_PAY_ADDRESS=0x0000000000000000000000000000000000000001 as a placeholder.
    console.error('[ORACLE_PAYMENT] ORACLE_PAY_ADDRESS not set — rejecting all payment claims');
    return { ok: false, reason: 'server_misconfiguration' };
  }

  let provider;
  try {
    provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
  } catch {
    return { ok: false, reason: 'rpc_unavailable' };
  }

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch {
    return { ok: false, reason: 'receipt_fetch_failed' };
  }
  if (!receipt || receipt.status !== 1) {
    return { ok: false, reason: 'tx_not_confirmed' };
  }

  // Look for a Transfer(from, ORACLE_PAY_ADDRESS, amount) log from USDC contract
  let totalPaid = 0n;
  let from = null;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === USDC_ADDRESS &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics.length >= 3
    ) {
      const toAddr = '0x' + log.topics[2].slice(26);
      if (toAddr.toLowerCase() === ORACLE_PAY_ADDRESS) {
        totalPaid += BigInt(log.data === '0x' ? '0x0' : log.data);
        if (!from) from = '0x' + log.topics[1].slice(26);
      }
    }
  }

  const paidUsdc    = Number(totalPaid) / 10 ** USDC_DECIMALS;
  const requiredAmt = parseFloat(expectedUsdc);
  if (paidUsdc < requiredAmt) {
    return { ok: false, reason: 'insufficient_payment', paid: paidUsdc, required: requiredAmt };
  }

  return { ok: true, amountUsdc: paidUsdc, from };
}

/**
 * Express middleware factory.
 * Usage: router.get('/public/stablecoin-fx', oraclePayment('stablecoin-fx'), handler)
 */
function oraclePayment(endpointKey) {
  const price = getPrice(endpointKey);
  if (!price) throw new Error(`[oraclePayment] No price defined for endpoint: ${endpointKey}`);

  return async (req, res, next) => {
    const txHash = (req.headers['x-payment-tx'] || '').trim().toLowerCase();

    // No payment header → return 402
    if (!txHash) {
      return res.status(402).json({
        error:            'payment_required',
        price:            `${price} USDC`,
        payTo:            ORACLE_PAY_ADDRESS || '(ORACLE_PAY_ADDRESS not configured)',
        chain:            'arc-testnet',
        chainId:          5042002,
        token:            'USDC',
        tokenAddress:     USDC_ADDRESS,
        callbackEndpoint: req.originalUrl,
        instructions:     `Send ${price} USDC to payTo on arc-testnet, then retry with X-Payment-Tx: <txHash>`,
      });
    }

    // Basic format check
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      return res.status(400).json({ error: 'invalid_tx_hash' });
    }

    // Redis replay cache — fast path for recently verified tx hashes
    const cacheKey = `oracle:paid:${txHash}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        req.paymentVerified = true;
        req.paymentTxHash   = txHash;
        return next();
      }
    } catch { /* Redis unavailable — fall through */ }

    // DB replay check — permanent record, survives Redis restarts and TTL expiry
    try {
      const { rows } = await db.query(
        'SELECT id FROM oracle_payments WHERE tx_hash = $1 LIMIT 1',
        [txHash],
      );
      if (rows.length > 0) {
        // Already verified and logged — restore Redis cache and serve
        try { await redis.set(cacheKey, '1', 'EX', 3600); } catch { /* non-fatal */ }
        req.paymentVerified = true;
        req.paymentTxHash   = txHash;
        return next();
      }
    } catch (err) {
      console.error('[ORACLE_PAYMENT] DB replay check failed:', err.message);
      // If DB is unreachable we cannot safely verify replay — reject
      return res.status(503).json({ error: 'payment_verification_unavailable' });
    }

    // On-chain verification
    const result = await verifyPaymentTx(txHash, price);
    if (!result.ok) {
      return res.status(402).json({ error: 'payment_invalid', reason: result.reason });
    }

    // Cache the verified tx in Redis (fast path for subsequent calls within same session)
    try {
      await redis.set(cacheKey, '1', 'EX', 3600);
    } catch { /* non-fatal */ }

    // Record in DB (fire-and-forget, non-blocking)
    db.query(
      `INSERT INTO oracle_payments (tx_hash, endpoint, amount_usdc, from_addr)
       VALUES ($1, $2, $3, $4) ON CONFLICT (tx_hash) DO NOTHING`,
      [txHash, endpointKey, result.amountUsdc, result.from],
    ).catch(err => console.error('[ORACLE_PAYMENT] DB write error:', err.message));

    req.paymentVerified = true;
    req.paymentTxHash   = txHash;
    next();
  };
}

module.exports = oraclePayment;
