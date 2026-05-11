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
const { encrypt, decrypt } = require('../services/cryptoService');

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
  autoLockMinutes:   z.number().int().min(1).max(60).optional(),
  contractGuard:     z.boolean().optional(),
  // LLM — user provides their own key, encrypted at rest
  llmApiKey:         z.string().max(200).optional(),
  llmModel:          z.enum(['claude-sonnet-4-20250514','gemini-2.5-pro','gpt-4o']).optional(),
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
    res.json(agent);
  } catch (err) { next(err); }
});

// ── Update smart permissions ──────────────────────────────────────────────────
router.put('/:id/permissions', async (req, res, next) => {
  try {
    const schema = z.record(z.string(), z.boolean());
    const perms = schema.parse(req.body);
    const result = await agentService.updatePermissions(req.params.id, req.user.userId, perms);
    if (!result) return res.status(404).json({ error: 'Agent not found' });
    res.json({ ok: true });
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

// ── Deactivate agent ──────────────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await agentService.deactivateAgent(req.params.id, req.user.userId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
