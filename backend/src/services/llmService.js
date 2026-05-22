'use strict';
/**
 * LLM Service — wraps Anthropic / OpenAI / Gemini.
 *
 * Key design decisions:
 *  1. Market analysis results are cached in Redis (TTL = LLM_CACHE_TTL, default 5 min)
 *     so 100 agents asking the same question only costs ONE LLM call.
 *  2. All decisions are written to llm_audit for transparency.
 *  3. Users supply their own API keys (decrypted in-flight, never logged).
 */
const crypto    = require('crypto');
const Anthropic  = require('@anthropic-ai/sdk');
const OpenAI     = require('openai');
const db         = require('../db');
const redis      = require('./redisClient');
const { decrypt } = require('./cryptoService');

const CACHE_TTL = parseInt(process.env.LLM_CACHE_TTL || '300', 10); // seconds
const CHAT_MAX_TOKENS = (() => {
  const parsed = Number.parseInt(process.env.LLM_CHAT_MAX_TOKENS || '256', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 256;
})();

// Testnet-approved models — cost-effective tier only
// Each entry: [modelId, provider]
const ALLOWED_MODELS = new Set([
  'claude-haiku-3-5-20241022',   // Anthropic (paid)
  'gemini-2.0-flash',            // Google (paid)
  'gpt-4o-mini',                 // OpenAI (paid)
  'llama-3.3-70b-versatile',     // Groq FREE tier — recommended for beginners
  'llama-3.1-8b-instant',        // Groq FREE tier — fastest
]);

// Models that route to Groq's OpenAI-compatible endpoint
const GROQ_MODELS = new Set([
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
]);

function getProviderName(model) {
  if (model.startsWith('claude')) return 'Anthropic';
  if (GROQ_MODELS.has(model)) return 'Groq';
  if (model.startsWith('gemini')) return 'Google';
  return 'OpenAI';
}

// ── Client factory ────────────────────────────────────────────────────────────
function buildClient(model, apiKey) {
  if (model.startsWith('claude')) {
    return new Anthropic({ apiKey });
  }
  // Groq uses OpenAI-compatible endpoint
  if (GROQ_MODELS.has(model)) {
    return new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  // Gemini uses OpenAI-compatible endpoint
  if (model.startsWith('gemini')) {
    return new OpenAI({
      apiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    });
  }
  return new OpenAI({ apiKey });
}

// ── Core call (with Redis caching) ────────────────────────────────────────────
async function callLlm({ model, apiKey, systemPrompt, userPrompt, agentId }) {
  if (!ALLOWED_MODELS.has(model)) {
    throw new Error(`Model "${model}" is not allowed on testnet. Allowed: ${[...ALLOWED_MODELS].join(', ')}`);
  }
  const cacheKey = `llm:${crypto.createHash('sha256').update(model + systemPrompt + userPrompt).digest('hex')}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    await auditLog(agentId, model, userPrompt, cached, 0, true);
    return { decision: cached, fromCache: true };
  }

  const t0 = Date.now();
  let decision;

  const client = buildClient(model, apiKey);

  if (model.startsWith('claude')) {
    const msg = await client.messages.create({
      model,
      max_tokens: CHAT_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    decision = msg.content[0].text;
  } else {
    const resp = await client.chat.completions.create({
      model,
      max_tokens: CHAT_MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    });
    decision = resp.choices[0].message.content;
  }

  const latency = Date.now() - t0;
  await redis.setex(cacheKey, CACHE_TTL, decision);
  await auditLog(agentId, model, userPrompt, decision, latency, false);
  return { decision, fromCache: false, latencyMs: latency };
}

async function auditLog(agentId, model, prompt, decision, latencyMs, fromCache) {
  const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
  await db.query(
    `INSERT INTO llm_audit (agent_id, model, prompt_hash, decision, latency_ms, from_cache)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [agentId || null, model, promptHash, decision, latencyMs, fromCache],
  ).catch(err => console.error('[LLM AUDIT]', err.message));
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Shared market analysis — result cached globally for all agents.
 * @param {{ chain: string, token: string }} params
 */
async function analyzeMarket({ chain, token, model, apiKey, agentId }) {
  return callLlm({
    model,
    apiKey,
    agentId,
    systemPrompt: `You are a DeFi market analysis engine for Arc Testnet.
Respond with concise JSON only: {
  "opportunity": string,
  "risk": "low"|"medium"|"high",
  "action": string,
  "signal": {
    "lane": "stable_curve"|"observe",
    "shouldReviewDefi": boolean,
    "stableLpMinAllocationPct": number|null,
    "stableLpTargetAllocationPct": number|null,
    "stableLpMaxAllocationPct": number|null,
    "confidence": "low"|"medium"|"high"
  }
}`,
    userPrompt: `Analyze current testnet conditions for ${token} on ${chain}. What should my agent do?`,
  });
}

/**
 * Pre-transaction analysis — is this transaction safe?
 */
async function analyzeTransaction({ toAddress, amountUsdc, chain, model, apiKey, agentId }) {
  return callLlm({
    model,
    apiKey,
    agentId,
    systemPrompt: `You are a transaction safety analyzer for an Arc Testnet agent wallet.
Respond with JSON only: { "safe": boolean, "reason": string, "riskScore": 0-10 }`,
    userPrompt: `Analyze this transaction:
- To: ${toAddress}
- Amount: ${amountUsdc} USDC
- Chain: ${chain}
Is it safe?`,
  });
}

/**
 * Arbitrage decision — called by the agent queue when a price diff event arrives.
 */
async function getArbitrageDecision({ opportunity, model, apiKey, agentId }) {
  return callLlm({
    model,
    apiKey,
    agentId,
    systemPrompt: `You are an arbitrage bot controller for Arc Testnet.
Respond with JSON: { "execute": boolean, "reason": string, "suggestedAmount": number }`,
    userPrompt: `Opportunity: ${JSON.stringify(opportunity)}. Should I execute?`,
  });
}

// ── Resolve API key for an agent (decrypt from DB if not provided directly) ───
async function resolveApiKey(agent) {
  if (!agent.llm_api_key_encrypted) throw new Error('No LLM API key configured for this agent');
  return decrypt(agent.llm_api_key_encrypted);
}

async function testConnection({ model, apiKey, agentId = null }) {
  if (!ALLOWED_MODELS.has(model)) {
    throw new Error(`Model "${model}" is not allowed on testnet.`);
  }
  if (!apiKey) {
    throw new Error('No API key available for test');
  }

  const provider = getProviderName(model);
  const challenge = crypto.randomBytes(3).toString('hex').toUpperCase();
  const promptText = `Reply with exactly CONNECTED:${challenge}`;
  const client = buildClient(model, apiKey);
  let responseText = '';
  const startedAt = Date.now();

  if (model.startsWith('claude')) {
    const msg = await client.messages.create({
      model,
      max_tokens: 16,
      system: promptText,
      messages: [{ role: 'user', content: promptText }],
    });
    responseText = msg.content?.[0]?.text || '';
  } else {
    const resp = await client.chat.completions.create({
      model,
      max_tokens: 16,
      messages: [
        { role: 'system', content: promptText },
        { role: 'user', content: promptText },
      ],
    });
    responseText = resp.choices?.[0]?.message?.content || '';
  }

  const latencyMs = Date.now() - startedAt;
  const verified = new RegExp(`CONNECTED[:\\s-]*${challenge}`, 'i').test(responseText.trim());
  if (!verified) {
    throw new Error(`Provider responded, but verification challenge ${challenge} was not echoed back.`);
  }

  await auditLog(agentId, model, `test_connection:${challenge}`, responseText.trim(), latencyMs, false);
  console.info(`[LLM TEST] agent=${agentId || 'none'} provider=${provider} model=${model} latencyMs=${latencyMs} challenge=${challenge} verified=true`);

  return {
    ok: true,
    model,
    provider,
    responseText: responseText.trim(),
    challenge,
    latencyMs,
    verifiedAt: new Date().toISOString(),
    verifiedLive: true,
  };
}

module.exports = {
  analyzeMarket,
  analyzeTransaction,
  getArbitrageDecision,
  resolveApiKey,
  testConnection,
  getProviderName,
};
