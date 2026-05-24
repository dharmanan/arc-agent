'use strict';
/**
 * GET    /api/agents            — list user's agents
 * POST   /api/agents            — create agent
 * GET    /api/agents/:id        — get single agent
 * PUT    /api/agents/:id        — update settings / LLM key
 * DELETE /api/agents/:id        — deactivate agent
 * PUT    /api/agents/:id/permissions   — update smart permissions
 * GET    /api/agents/:id/status — live status (balance, daily spent, mode)
 */
const router        = require('express').Router();
const { z }         = require('zod');
const { requireAuth } = require('../middleware/auth');
const agentService  = require('../services/agentService');
const llmService    = require('../services/llmService');
const reputationService = require('../services/reputationService');
const positionsService = require('../services/positionsService');
const lpRewardService = require('../services/lpRewardService');
const nativeLendingRiskService = require('../services/nativeLendingRiskService');
const agentQueue = require('../queue/agentQueue');
const { encrypt }   = require('../services/cryptoService');

const LLM_MODEL_OPTIONS = [
  'claude-haiku-3-5-20241022',
  'gemini-2.0-flash',
  'gpt-4o-mini',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
];

router.use(requireAuth);

// ── List agents ───────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const agents = await agentService.listAgents(req.user.userId);
    res.json(agents);
  } catch (err) { next(err); }
});

// ── Create agent ──────────────────────────────────────────────────────────────
const createSchema = z.object({
  name:              z.string().min(1).max(100),
  dailyLimitUsdc:    z.number().positive().max(100_000).optional(),
  maxGasGwei:        z.number().positive().max(500).optional(),
  slippagePercent:   z.number().min(0.1).max(50).optional(),
  maxTradeUsdc:      z.number().positive().max(100_000).optional(),
  defiWalletReserveUsdc: z.number().min(0).max(100_000).optional(),
});

router.post('/', async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const agent = await agentService.createAgent(req.user.userId, data);
    res.status(201).json(agent);
  } catch (err) { next(err); }
});

// ── Get single agent ──────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const agent = await agentService.getAgent(req.params.id, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch (err) { next(err); }
});

// ── Update settings ───────────────────────────────────────────────────────────
const updateSchema = z.object({
  name:              z.string().min(1).max(100).optional(),
  dailyLimitUsdc:    z.number().positive().max(100_000).optional(),
  maxGasGwei:        z.number().positive().max(500).optional(),
  slippagePercent:   z.number().min(0.1).max(50).optional(),
  maxTradeUsdc:      z.number().positive().max(100_000).optional(),
  defiWalletReserveUsdc: z.number().min(0).max(100_000).optional(),
  oracleMaxEurcInventory: z.number().positive().max(100_000).nullable().optional(),
  oracleMinEurcReserve: z.number().min(0).max(100_000).nullable().optional(),
  gatewayAutoTopupEnabled: z.boolean().optional(),
  gatewayAutoTopupMinUsdc: z.number().positive().max(100_000).optional(),
  gatewayAutoTopupTargetUsdc: z.number().positive().max(100_000).optional(),
  autoLockMinutes:   z.number().int().min(1).max(60).optional(),
  contractGuard:     z.boolean().optional(),
  isSmartMode:       z.boolean().optional(),
  // LLM — user provides their own key, encrypted at rest
  llmApiKey:         z.string().max(200).optional(),
  // Testnet-approved models only (cost-effective tier)
  llmModel:          z.enum(LLM_MODEL_OPTIONS).optional(),
  // Faza 2.0: opt-in feature flags (all default OFF)
  dailyTasksEnabled:     z.boolean().optional(),
  marketAnalysisEnabled: z.boolean().optional(),
  oracleEnabled:         z.boolean().optional(),
  defiLoopEnabled:       z.boolean().optional(),
  lendingAutomationEnabled: z.boolean().optional(),
  carryAutomationEnabled: z.boolean().optional(),
  cirbtcLpEnabled:       z.boolean().optional(),
  reputationEnabled:     z.boolean().optional(),
}).strict();

router.put('/:id', async (req, res, next) => {
  try {
    const data = updateSchema.parse(req.body);

    // Encrypt API key before storing
    if (data.llmApiKey) {
      data.llmApiKeyEncrypted = encrypt(data.llmApiKey);
      delete data.llmApiKey;
      data.isSmartMode = true;
    }

    const agent = await agentService.updateAgent(req.params.id, req.user.userId, data);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const kickoffJobs = [];
    if (data.marketAnalysisEnabled === true && agent.isSmartMode) {
      kickoffJobs.push(agentQueue.add('MARKET_ANALYSIS', {
        agentId: agent.id,
        chain: 'arc-testnet',
        token: 'USDC',
      }, {
        jobId: `market-analysis-manual-${agent.id}-${Date.now()}`,
      }));
    }
    if (data.oracleEnabled === true) {
      kickoffJobs.push(agentQueue.add('ORACLE_QUERY', {
        agentId: agent.id,
      }, {
        jobId: `oracle-manual-${agent.id}-${Date.now()}`,
      }));
    }
    if (
      data.defiLoopEnabled === true
      || data.lendingAutomationEnabled === true
      || data.carryAutomationEnabled === true
      || data.cirbtcLpEnabled === true
    ) {
      kickoffJobs.push(agentQueue.add('DEFI_LOOP', {
        agentId: agent.id,
      }, {
        jobId: `defi-manual-${agent.id}-${Date.now()}`,
      }));
    }

    if (kickoffJobs.length > 0) {
      Promise.allSettled(kickoffJobs).catch(() => {});
    }

    res.json(agent);
  } catch (err) { next(err); }
});

const testLlmSchema = z.object({
  llmApiKey: z.string().max(200).optional(),
  llmModel:  z.enum(LLM_MODEL_OPTIONS).optional(),
}).strict();

router.post('/:id/test-llm', async (req, res, next) => {
  try {
    const data = testLlmSchema.parse(req.body || {});
    const agent = await agentService.getAgentWithKey(req.params.id, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const model = data.llmModel || agent.llm_model || 'llama-3.3-70b-versatile';
    const typedKey = String(data.llmApiKey || '').trim();
    const usingStoredKey = typedKey.length === 0;

    let apiKey = typedKey;
    if (!apiKey) {
      apiKey = await llmService.resolveApiKey(agent);
    }

    const result = await llmService.testConnection({ model, apiKey, agentId: agent.id });
    res.json({
      ok: true,
      usingStoredKey,
      ...result,
    });
  } catch (err) {
    if (!err.status) err.status = 400;
    next(err);
  }
});

// ── Update smart permissions ──────────────────────────────────────────────────
router.put('/:id/permissions', async (req, res, next) => {
  try {
    const schema = z.record(z.string(), z.boolean());
    const perms = schema.parse(req.body);
    const result = await agentService.updatePermissions(req.params.id, req.user.userId, perms);
    if (!result) return res.status(404).json({ error: 'Agent not found' });
    res.json(result);
  } catch (err) { next(err); }
});

// ── Live status ───────────────────────────────────────────────────────────────
router.get('/:id/status', async (req, res, next) => {
  try {
    const status = await agentService.getAgentStatus(req.params.id, req.user.userId);
    if (!status) return res.status(404).json({ error: 'Agent not found' });
    res.json(status);
  } catch (err) { next(err); }
});

// ── Reputation overview ──────────────────────────────────────────────────────
router.get('/:id/reputation', async (req, res, next) => {
  try {
    const overview = await reputationService.getReputationOverview(
      req.params.id,
      req.user.userId,
      req.query.limit,
    );
    if (!overview) return res.status(404).json({ error: 'Agent not found' });
    res.json(overview);
  } catch (err) { next(err); }
});

// ── Live protocol positions ──────────────────────────────────────────────────
router.get('/:id/positions', async (req, res, next) => {
  try {
    const positions = await positionsService.getAgentPositions(req.params.id, req.user.userId);
    if (!positions) return res.status(404).json({ error: 'Agent not found' });
    res.json(positions);
  } catch (err) { next(err); }
});

// ── Native lending surface ───────────────────────────────────────────────────
router.get('/:id/lending', async (req, res, next) => {
  try {
    const surface = await nativeLendingRiskService.getAgentLendingSurface(req.params.id, req.user.userId);
    if (!surface) return res.status(404).json({ error: 'Agent not found' });
    res.json(surface);
  } catch (err) { next(err); }
});

// ── Claimable reward overview ────────────────────────────────────────────────
router.get('/:id/rewards', async (req, res, next) => {
  try {
    const rewards = await lpRewardService.getAgentRewardOverview(req.params.id, req.user.userId, {
      programLimit: req.query.programLimit,
      accrualLimit: req.query.accrualLimit,
      claimLimit: req.query.claimLimit,
      snapshotLimit: req.query.snapshotLimit,
    });
    if (!rewards) return res.status(404).json({ error: 'Agent not found' });
    res.json(rewards);
  } catch (err) { next(err); }
});

// ── Deactivate agent ──────────────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await agentService.deactivateAgent(req.params.id, req.user.userId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Retry ERC-8004 identity registration ─────────────────────────────────────
router.post('/:id/register-identity', async (req, res, next) => {
  try {
    const result = await agentService.retryErc8004Registration(req.params.id, req.user.userId);
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
