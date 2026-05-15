'use strict';
/**
 * GET  /api/transactions/:agentId            — list transactions
 * POST /api/transactions/send                — send USDC/EURC
 * POST /api/transactions/nano-pay            — nano payment (< $0.01, always agentic)
 * POST /api/transactions/bridge              — cross-chain bridge (Circle CCTP) — agentic OR creates manual TX
 * POST /api/transactions/bridge/gas-topup    — bridge native ETH from Sepolia to destination testnet for agent gas
 * POST /api/transactions/bridge/step         — execute one CCTP step (manual mode, agent wallet)
 * GET  /api/transactions/bridge/:txId/attestation — poll Circle attestation API for a burn tx
 * POST /api/transactions/swap                — USDC↔EURC swap on Arc Testnet (agentic)
 * POST /api/transactions/swap/quote          — get price quote (no tx)
 * GET  /api/transactions/tx/:txId/status     — poll status
 */
const router              = require('express').Router();
const { ethers }          = require('ethers');
const { z }               = require('zod');
const { requireAuth }     = require('../middleware/auth');
const { txRateLimit }     = require('../middleware/rateLimit');
const transactionService  = require('../services/transactionService');
const agentService        = require('../services/agentService');
const agentWalletService  = require('../services/agentWalletService');

// ── Public Swap Quote (read-only, no tx) ─────────────────────────────────────
const quoteSchema = z.object({
  fromToken: z.enum(['USDC', 'EURC', 'cirBTC']),
  toToken:   z.enum(['USDC', 'EURC', 'cirBTC']),
  amountIn:  z.number().positive(),
});

router.post('/swap/quote', txRateLimit, async (req, res, next) => {
  try {
    const body = quoteSchema.parse(req.body);
    const { amountOut, quoteError } = await agentWalletService.getSwapQuoteResult(body);
    const stablePair = ['USDC', 'EURC'].includes(body.fromToken) && ['USDC', 'EURC'].includes(body.toToken);

    res.json({
      fromToken:  body.fromToken,
      toToken:    body.toToken,
      amountIn:   body.amountIn,
      amountOut:  amountOut ?? (stablePair ? body.amountIn : null),
      isDexQuote: amountOut !== null,
      quoteError: amountOut === null ? quoteError : null,
    });
  } catch (err) { next(err); }
});

router.use(requireAuth);
router.use(txRateLimit);

// ── Helpers ───────────────────────────────────────────────────────────────────
async function assertAgentOwner(agentId, userId) {
  const agent = await agentService.getAgent(agentId, userId);
  if (!agent) throw Object.assign(new Error('Agent not found or not yours'), { status: 404 });
  // Attach userId for transactionService to use in getAgentWithKey
  agent.userId = userId;
  return agent;
}

// ── List transactions for an agent ────────────────────────────────────────────
router.get('/:agentId', async (req, res, next) => {
  try {
    await assertAgentOwner(req.params.agentId, req.user.userId);
    const txs = await transactionService.listTransactions(req.params.agentId);
    res.json(txs);
  } catch (err) { next(err); }
});

// ── Send USDC/EURC ────────────────────────────────────────────────────────────
const sendSchema = z.object({
  agentId:    z.string().uuid(),
  toAddress:  z.string().min(10).max(100),
  amountUsdc: z.number().positive().max(100_000),
  token:      z.enum(['USDC', 'EURC']).default('USDC'),
  chain:      z.enum(['Arc Testnet', 'Sepolia', 'Base', 'Optimism', 'Arbitrum', 'Solana']),
});

router.post('/send', async (req, res, next) => {
  try {
    const body  = sendSchema.parse(req.body);
    const agent = await assertAgentOwner(body.agentId, req.user.userId);
    const tx    = await transactionService.sendPayment({
      agent,
      toAddress:  body.toAddress,
      amountUsdc: body.amountUsdc,
      token:      body.token,
      chain:      body.chain,
    });
    res.status(202).json(tx);
  } catch (err) {
    // QR payment: surface limit errors with structured payloads for the frontend
    if (err.code === 'EXCEEDS_MAX_TRADE') {
      return res.status(422).json({ error: err.message, requiresPasskey: true });
    }
    if (err.code === 'DAILY_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: err.message, dailyLimitReached: true });
    }
    next(err);
  }
});

// ── Nano Payment (< $0.01 USDC, always agentic) ───────────────────────────────
// Reference: https://developers.circle.com/gateway/nanopayments#agentic-payments
const nanoPaySchema = z.object({
  agentId:    z.string().uuid(),
  toAddress:  z.string().min(10).max(100),
  amountUsdc: z.number().positive().max(agentWalletService.NANO_THRESHOLD_USDC - 0.000001),
  token:      z.literal('USDC').default('USDC'),
  memo:       z.string().max(200).optional(),  // purpose label for audit log
});

router.post('/nano-pay', async (req, res, next) => {
  try {
    const body  = nanoPaySchema.parse(req.body);
    const agent = await assertAgentOwner(body.agentId, req.user.userId);
    const tx    = await transactionService.nanoPay({
      agent,
      toAddress:  body.toAddress,
      amountUsdc: body.amountUsdc,
      memo:       body.memo,
    });
    res.status(202).json({ ...tx, memo: body.memo, token: body.token });
  } catch (err) { next(err); }
});

// ── Bridge ────────────────────────────────────────────────────────────────────
const bridgeSchema = z.object({
  agentId:    z.string().uuid(),
  fromChain:  z.enum(['Arc Testnet', 'Sepolia', 'Base Sepolia', 'Optimism Sepolia', 'Arbitrum Sepolia']),
  toChain:    z.enum(['Arc Testnet', 'Sepolia', 'Base Sepolia', 'Optimism Sepolia', 'Arbitrum Sepolia']),
  amountUsdc: z.number().positive().max(100_000),
  mode:       z.enum(['auto', 'manual']).default('auto'),
  token:      z.string().optional(),
}).refine(b => b.fromChain !== b.toChain, { message: 'from/to chain must differ' });

router.post('/bridge', async (req, res, next) => {
  try {
    const body  = bridgeSchema.parse(req.body);
    const agent = await assertAgentOwner(body.agentId, req.user.userId);
    const tx    = await transactionService.bridgeTokens({
      agent,
      fromChain:  body.fromChain,
      toChain:    body.toChain,
      amountUsdc: body.amountUsdc,
      mode:       body.mode || 'auto',   // 'auto' → agentic if within limit; 'manual' → always manual
    });
    res.status(202).json(tx);
  } catch (err) {
    if (err.code === 'INSUFFICIENT_DESTINATION_GAS') {
      const recommendedTopUpWei = await agentWalletService.getRecommendedNativeTopUpWei(
        err.toChain,
        err.balanceWei || 0n,
      ).catch(() => null);

      return res.status(422).json({
        error: err.message,
        destinationGasLow: true,
        toChain: err.toChain || null,
        currentNativeBalance: err.balanceWei != null ? ethers.formatEther(err.balanceWei) : null,
        requiredNativeBalance: err.requiredWei != null ? ethers.formatEther(err.requiredWei) : null,
        recommendedTopUp: recommendedTopUpWei != null ? ethers.formatEther(recommendedTopUpWei) : null,
      });
    }
    next(err);
  }
});

const gasTopUpSchema = z.object({
  agentId: z.string().uuid(),
  toChain: z.enum(['Base Sepolia', 'Optimism Sepolia', 'Arbitrum Sepolia']),
  amountEth: z.number().positive().max(10).optional(),
});

router.post('/bridge/gas-topup', async (req, res, next) => {
  try {
    const body  = gasTopUpSchema.parse(req.body);
    const agent = await assertAgentOwner(body.agentId, req.user.userId);
    const tx    = await transactionService.bridgeNativeGasTopUp({
      agent,
      toChain: body.toChain,
      amountEth: body.amountEth,
    });
    res.status(202).json(tx);
  } catch (err) { next(err); }
});

// ── Bridge Step (manual mode — ajan cüzdanı ile tek adım) ────────────────────
// Body: { agentId, txId, step: 'approve'|'burn'|'mint', meta?: { message, attestation } }
const bridgeStepSchema = z.object({
  agentId: z.string().uuid(),
  txId:    z.string().uuid(),
  step:    z.enum(['approve', 'burn', 'mint']),
  meta:    z.object({
    message:     z.string().optional(),
    attestation: z.string().optional(),
  }).optional(),
});

router.post('/bridge/step', async (req, res, next) => {
  try {
    const body   = bridgeStepSchema.parse(req.body);
    const agent  = await assertAgentOwner(body.agentId, req.user.userId);
    const result = await transactionService.executeBridgeStep({
      agent,
      txId: body.txId,
      step: body.step,
      meta: body.meta,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ── Bridge Attestation Poll (manual mode — Circle API sorgula) ────────────────
// GET /bridge/:txId/attestation
router.get('/bridge/:txId/attestation', async (req, res, next) => {
  try {
    const result = await transactionService.getBridgeAttestation({
      txId:   req.params.txId,
      userId: req.user.userId,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ── Swap — Arc Testnet only, USDC / EURC / cirBTC (agentic) ─────────────────
const swapSchema = z.object({
  agentId:   z.string().uuid(),
  fromToken: z.enum(['USDC', 'EURC', 'cirBTC']),
  toToken:   z.enum(['USDC', 'EURC', 'cirBTC']),
  amountIn:  z.number().positive(),
  slippage:  z.number().min(0.1).max(50).optional(),
}).refine(b => b.fromToken !== b.toToken, { message: 'fromToken and toToken must differ' });

router.post('/swap', async (req, res, next) => {
  try {
    const body  = swapSchema.parse(req.body);
    const agent = await assertAgentOwner(body.agentId, req.user.userId);
    const tx    = await transactionService.swapTokens({
      agent,
      fromToken: body.fromToken,
      toToken:   body.toToken,
      amountIn:  body.amountIn,
      slippage:  body.slippage,
      chain:     'Arc Testnet',
    });
    res.status(202).json(tx);
  } catch (err) { next(err); }
});

// ── Poll status ───────────────────────────────────────────────────────────────
router.get('/tx/:txId/status', async (req, res, next) => {
  try {
    const row = await transactionService.getTransactionStatus(req.params.txId, req.user.userId);
    if (!row) return res.status(404).json({ error: 'Transaction not found' });
    res.json(row);
  } catch (err) { next(err); }
});

module.exports = router;
