'use strict';
const crypto = require('crypto');
const db = require('../db');

/**
 * Rule Engine — static fallback decision engine for agents without LLM API keys.
 *
 * Provides the same three-function interface as llmService so callers can
 * swap engines transparently:
 *   analyzeMarket        → { opportunity, risk, action }
 *   analyzeTransaction   → { safe, reason, riskScore }
 *   getArbitrageDecision → { execute, reason, suggestedAmount }
 *
 * All functions return { decision: <JSON string>, fromCache: false, engine: 'rule' }
 *
 * Rules (25 total):
 *   M1–M7  : Market analysis
 *   T1–T10 : Transaction safety
 *   A1–A8  : Arbitrage decisions
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const DAILY_LIMIT_USDC  = 1_000;   // M4, T5 — testnet daily cap
const MAX_TRADE_USDC    = 500;     // T6     — single-trade cap
const MIN_SPREAD_PCT    = 0.5;     // A3     — minimum spread to attempt arb
const MIN_PROFIT_USDC   = 1.0;     // A4     — minimum expected profit
const MAX_ARB_USDC      = 100;     // A7     — suggested arb amount cap
const DUST_USDC         = 0.01;    // T7     — dust threshold
const AUDIT_MODEL       = 'rule_engine';

const ADDRESS_RE   = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const SAFE_CHAINS = new Set([
  'arc-testnet', 'arc', 'sepolia',
  'base-sepolia', 'optimism-sepolia', 'arbitrum-sepolia',
]);

const VOLATILE_TOKENS = new Set(['cirBTC', 'WBTC', 'BTC', 'ETH', 'WETH']);
const STABLE_TOKENS   = new Set(['USDC', 'EURC', 'USDT', 'DAI']);

// ── Helper ────────────────────────────────────────────────────────────────────
async function auditDecision(agentId, promptShape, decision) {
  const promptHash = crypto.createHash('sha256').update(JSON.stringify(promptShape)).digest('hex');
  await db.query(
    `INSERT INTO llm_audit (agent_id, model, prompt_hash, decision, latency_ms, from_cache)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [agentId || null, AUDIT_MODEL, promptHash, decision, 0, false],
  ).catch(err => console.error('[RULE AUDIT]', err.message));
}

async function ok(agentId, promptShape, obj) {
  const decision = JSON.stringify(obj);
  await auditDecision(agentId, promptShape, decision);
  return { decision, fromCache: false, engine: 'rule' };
}

// ─────────────────────────────────────────────────────────────────────────────
// analyzeMarket
// Same signature as llmService.analyzeMarket({ chain, token, agentId })
// Returns: { opportunity: string, risk: "low"|"medium"|"high", action: string }
//
// Rules:
//   M1  Volatile token (cirBTC/ETH/WBTC)    → risk = "medium"
//   M2  Stable token (USDC/EURC/USDT/DAI)   → risk = "low"
//   M3  Unknown token                        → risk = "medium" (conservative)
//   M4  Daily testnet limit reminder         → appended to action when risk != low
//   M5  Arc Testnet chain                    → bridge testing opportunity
//   M6  Ethereum Sepolia                     → CCTP bridge opportunity
//   M7  L2 testnets (Base/Optimism/Arb)      → multi-chain rebalancing opportunity
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeMarket({ chain, token, agentId } = {}) {
  const c = (chain  || '').toLowerCase();
  const t =  token  || '';
  const promptShape = {
    task: 'analyzeMarket',
    chain: chain || null,
    token: token || null,
  };

  // M1 / M2 / M3 — risk
  let risk;
  if (VOLATILE_TOKENS.has(t))      risk = 'medium'; // M1
  else if (STABLE_TOKENS.has(t))   risk = 'low';    // M2
  else                              risk = 'medium'; // M3

  // M5 / M6 / M7 — opportunity + action
  let opportunity, action;
  if (c.includes('arc')) {
    // M5
    opportunity = 'Arc Testnet is active — ideal for testing CCTP bridge flows';
    action      = 'bridge a small USDC amount to Sepolia or Base Sepolia to verify flows';
  } else if (c === 'sepolia') {
    // M6
    opportunity = 'Ethereum Sepolia CCTP lane open — monitor for USDC cross-chain arbitrage';
    action      = 'hold and watch for incoming bridge deposits; rebalance if imbalanced';
  } else if (c.includes('base') || c.includes('optimism') || c.includes('arbitrum')) {
    // M7
    opportunity = 'L2 testnet lane active — multi-chain rebalancing available';
    action      = 'monitor balances across L2 chains and bridge to the lowest-fee chain';
  } else {
    opportunity = 'Unknown chain — conservative stance';
    action      = 'hold and monitor; do not execute until chain is whitelisted';
  }

  // M4 — append daily-limit reminder for non-stable or elevated-risk tokens
  if (risk !== 'low') {
    action += ` (max ${MAX_TRADE_USDC} USDC per trade, ${DAILY_LIMIT_USDC} USDC daily limit)`;
  }

  return ok(agentId, promptShape, { opportunity, risk, action });
}

// ─────────────────────────────────────────────────────────────────────────────
// analyzeTransaction
// Same signature as llmService.analyzeTransaction({ toAddress, amountUsdc, chain, agentId })
// Returns: { safe: boolean, reason: string, riskScore: 0-10 }
//
// Rules:
//   T1  Missing destination address          → unsafe, score 10
//   T2  Zero address (0x000...000)           → unsafe, score 10
//   T3  Invalid address format               → unsafe, score  9
//   T4  Amount ≤ 0                           → unsafe, score  8
//   T5  Amount > DAILY_LIMIT_USDC (1 000)    → unsafe, score  9
//   T6  Amount > MAX_TRADE_USDC   (  500)    → unsafe, score  7
//   T7  Amount < DUST_USDC        ( 0.01)    → safe but suspicious, score 3
//   T8  Amount in (0.01, 10] USDC            → safe, low risk, score 1
//   T9  Chain not in SAFE_CHAINS             → safe but elevated risk, score 5
//   T10 All checks pass                      → safe, score 1
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeTransaction({ toAddress, amountUsdc, chain, agentId } = {}) {
  const amount = Number(amountUsdc) || 0;
  const c = (chain || '').toLowerCase();
  const promptShape = {
    task: 'analyzeTransaction',
    toAddress: toAddress || null,
    amountUsdc: amountUsdc ?? null,
    chain: chain || null,
  };

  // T1
  if (!toAddress) {
    return ok(agentId, promptShape, { safe: false, reason: '[T1] Missing destination address', riskScore: 10 });
  }
  // T2
  if (toAddress === ZERO_ADDRESS) {
    return ok(agentId, promptShape, { safe: false, reason: '[T2] Destination is the zero address', riskScore: 10 });
  }
  // T3
  if (!ADDRESS_RE.test(toAddress)) {
    return ok(agentId, promptShape, { safe: false, reason: '[T3] Destination address format invalid (expected 0x + 40 hex chars)', riskScore: 9 });
  }
  // T4
  if (amount <= 0) {
    return ok(agentId, promptShape, { safe: false, reason: '[T4] Amount must be greater than zero', riskScore: 8 });
  }
  // T5
  if (amount > DAILY_LIMIT_USDC) {
    return ok(agentId, promptShape, { safe: false, reason: `[T5] Amount ${amount} USDC exceeds daily limit of ${DAILY_LIMIT_USDC} USDC`, riskScore: 9 });
  }
  // T6
  if (amount > MAX_TRADE_USDC) {
    return ok(agentId, promptShape, { safe: false, reason: `[T6] Amount ${amount} USDC exceeds single-trade cap of ${MAX_TRADE_USDC} USDC`, riskScore: 7 });
  }
  // T7
  if (amount < DUST_USDC) {
    return ok(agentId, promptShape, { safe: true, reason: `[T7] Dust amount ${amount} USDC — likely a connectivity test`, riskScore: 3 });
  }
  // T9
  if (c && !SAFE_CHAINS.has(c)) {
    return ok(agentId, promptShape, { safe: true, reason: `[T9] Chain "${chain}" not in whitelist — proceed with caution`, riskScore: 5 });
  }
  // T8 / T10
  const riskScore = amount <= 10 ? 1 : amount <= 100 ? 2 : 3; // T8 gradient
  return ok(agentId, promptShape, { safe: true, reason: '[T10] Transaction passes all static safety checks', riskScore });
}

// ─────────────────────────────────────────────────────────────────────────────
// getArbitrageDecision
// Same signature as llmService.getArbitrageDecision({ opportunity, agentId })
// Returns: { execute: boolean, reason: string, suggestedAmount: number }
//
// Rules:
//   A1  No opportunity object provided      → skip
//   A2  spreadPct field missing             → skip
//   A3  spreadPct < MIN_SPREAD_PCT (0.5 %)  → skip
//   A4  expectedProfitUsdc < MIN_PROFIT (1) → skip
//   A5  amountUsdc ≤ 0                      → skip
//   A6  fromChain not in SAFE_CHAINS        → skip
//   A7  suggestedAmount capped at MAX_ARB_USDC (100)
//   A8  All checks pass                     → execute
// ─────────────────────────────────────────────────────────────────────────────
async function getArbitrageDecision({ opportunity, agentId } = {}) {
  const promptShape = {
    task: 'getArbitrageDecision',
    opportunity: opportunity || null,
  };

  // A1
  if (!opportunity || typeof opportunity !== 'object') {
    return ok(agentId, promptShape, { execute: false, reason: '[A1] No opportunity data provided', suggestedAmount: 0 });
  }

  const { spreadPct, amountUsdc, fromChain, expectedProfitUsdc } = opportunity;

  // A2
  if (spreadPct == null) {
    return ok(agentId, promptShape, { execute: false, reason: '[A2] Spread percentage not provided in opportunity', suggestedAmount: 0 });
  }
  // A3
  if (Number(spreadPct) < MIN_SPREAD_PCT) {
    return ok(agentId, promptShape, { execute: false, reason: `[A3] Spread ${spreadPct}% is below minimum threshold of ${MIN_SPREAD_PCT}%`, suggestedAmount: 0 });
  }
  // A4
  if (expectedProfitUsdc != null && Number(expectedProfitUsdc) < MIN_PROFIT_USDC) {
    return ok(agentId, promptShape, { execute: false, reason: `[A4] Expected profit ${expectedProfitUsdc} USDC is below minimum of ${MIN_PROFIT_USDC} USDC`, suggestedAmount: 0 });
  }
  // A5
  if (amountUsdc != null && Number(amountUsdc) <= 0) {
    return ok(agentId, promptShape, { execute: false, reason: '[A5] Opportunity amount is zero or negative', suggestedAmount: 0 });
  }
  // A6
  if (fromChain && !SAFE_CHAINS.has((fromChain || '').toLowerCase())) {
    return ok(agentId, promptShape, { execute: false, reason: `[A6] Source chain "${fromChain}" is not in the safe-chain whitelist`, suggestedAmount: 0 });
  }

  // A7 / A8 — cap amount and execute
  const raw       = Number(amountUsdc) || MAX_ARB_USDC;
  const suggested = Math.min(raw, MAX_ARB_USDC);

  return ok(agentId, promptShape, {
    execute: true,
    reason:  `[A8] Spread ${spreadPct}% clears threshold — executing with ${suggested} USDC (capped at ${MAX_ARB_USDC})`,
    suggestedAmount: suggested,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = { analyzeMarket, analyzeTransaction, getArbitrageDecision };
