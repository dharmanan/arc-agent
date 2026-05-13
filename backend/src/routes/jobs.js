'use strict';
/**
 * ERC-8183 AgenticCommerce Jobs
 *
 * GET  /api/agents/:id/jobs                     — list jobs for agent
 * POST /api/agents/:id/jobs                     — create job (on-chain + DB)
 * GET  /api/agents/:id/jobs/:jobId              — single job detail
 * PUT  /api/agents/:id/jobs/:jobId/deliver      — submit deliverable hash
 * PUT  /api/agents/:id/jobs/:jobId/complete     — mark completed (payout)
 * PUT  /api/agents/:id/jobs/:jobId/cancel       — cancel open job
 *
 * On-chain calls require AGENTIC_COMMERCE_ADDRESS env; if absent, DB-only mode
 * (jobs are tracked off-chain until the contract is deployed on Arc Testnet).
 */
const router          = require('express').Router({ mergeParams: true });
const { z }           = require('zod');
const { ethers }      = require('ethers');
const { requireAuth } = require('../middleware/auth');
const db              = require('../db');
const { decrypt }     = require('../services/cryptoService');
const { recordReputationEvent, EVENT_TYPES } = require('../services/reputationService');

router.use(requireAuth);

const AGENTIC_COMMERCE_ADDRESS = process.env.AGENTIC_COMMERCE_ADDRESS || null;
const ARC_RPC_URL              = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';

// Minimal ABI — only what we need
const AGENTIC_COMMERCE_ABI = [
  'function createJob(address provider, uint256 amount, string description) returns (uint256 jobId)',
  'function deliver(uint256 jobId, bytes32 deliverableHash)',
  'function complete(uint256 jobId)',
  'function cancel(uint256 jobId)',
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, uint256 amount)',
  'event JobDelivered(uint256 indexed jobId, bytes32 deliverableHash)',
  'event JobCompleted(uint256 indexed jobId)',
  'event JobCancelled(uint256 indexed jobId)',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
async function _getAgentForUser(agentId, userId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, wallet_address, private_key_encrypted FROM agents WHERE id = $1 AND user_id = $2`,
    [agentId, userId],
  );
  return agent || null;
}

function _getContract(signerOrProvider) {
  if (!AGENTIC_COMMERCE_ADDRESS) return null;
  return new ethers.Contract(AGENTIC_COMMERCE_ADDRESS, AGENTIC_COMMERCE_ABI, signerOrProvider);
}

async function _getProviderAndSigner(privateKey) {
  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL, { chainId: 5042002, name: 'Arc Testnet' });
  const signer   = new ethers.Wallet(privateKey, provider);
  return { provider, signer };
}

// ── GET /api/agents/:id/jobs ──────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const agentId = req.params.id;
    const agent   = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const status = req.query.status?.toString() || null;
    const limit  = Math.min(parseInt(req.query.limit || '20', 10), 100);

    const { rows } = await db.query(
      `SELECT id, job_id_onchain, client_address, provider_address, amount_usdc,
              description, status, deliverable_hash, tx_hash_create, tx_hash_settle, created_at, updated_at
       FROM agent_jobs
       WHERE agent_id = $1 ${status ? 'AND status = $3' : ''}
       ORDER BY created_at DESC
       LIMIT $2`,
      status ? [agentId, limit, status] : [agentId, limit],
    );

    res.json({ jobs: rows, onchainEnabled: !!AGENTIC_COMMERCE_ADDRESS });
  } catch (err) { next(err); }
});

// ── GET /api/agents/:id/jobs/:jobId ───────────────────────────────────────────
router.get('/:jobId', async (req, res, next) => {
  try {
    const { id: agentId, jobId } = req.params;
    const agent = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const { rows: [job] } = await db.query(
      `SELECT * FROM agent_jobs WHERE id = $1 AND agent_id = $2`,
      [jobId, agentId],
    );
    if (!job) return res.status(404).json({ error: 'job_not_found' });

    res.json(job);
  } catch (err) { next(err); }
});

// ── POST /api/agents/:id/jobs ─────────────────────────────────────────────────
const createJobSchema = z.object({
  providerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid EVM address'),
  amountUsdc:      z.number().positive().max(100_000),
  description:     z.string().min(1).max(500),
});

router.post('/', async (req, res, next) => {
  try {
    const agentId = req.params.id;
    const agent   = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const { providerAddress, amountUsdc, description } = parsed.data;

    let jobIdOnchain = null;
    let txHashCreate = null;

    // On-chain: only if contract deployed
    if (AGENTIC_COMMERCE_ADDRESS && agent.encrypted_private_key) {
      try {
        const privateKey      = decrypt(agent.encrypted_private_key);
        const { signer }      = await _getProviderAndSigner(privateKey);
        const contract        = _getContract(signer);
        const amountWei       = ethers.parseUnits(String(amountUsdc), 6); // USDC 6 dec

        const tx      = await contract.createJob(providerAddress, amountWei, description);
        const receipt = await tx.wait(1);
        txHashCreate  = receipt.hash;

        // Parse JobCreated event for jobId
        const iface = new ethers.Interface(AGENTIC_COMMERCE_ABI);
        for (const log of receipt.logs) {
          try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === 'JobCreated') {
              jobIdOnchain = parsed.args.jobId.toString();
              break;
            }
          } catch { /* skip */ }
        }
      } catch (err) {
        console.error('[JOBS] on-chain createJob error:', err.message);
        // Non-fatal — fall through to DB-only record
      }
    }

    const { rows: [job] } = await db.query(
      `INSERT INTO agent_jobs
         (agent_id, job_id_onchain, client_address, provider_address, amount_usdc, description, status, tx_hash_create)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)
       RETURNING *`,
      [agentId, jobIdOnchain, agent.wallet_address, providerAddress, amountUsdc, description, txHashCreate],
    );

    res.status(201).json({ job, onchainEnabled: !!AGENTIC_COMMERCE_ADDRESS });
  } catch (err) { next(err); }
});

// ── PUT /api/agents/:id/jobs/:jobId/deliver ───────────────────────────────────
router.put('/:jobId/deliver', async (req, res, next) => {
  try {
    const { id: agentId, jobId } = req.params;
    const agent = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const deliverableHash = String(req.body?.deliverableHash || '').trim();
    if (!deliverableHash) return res.status(400).json({ error: 'deliverableHash required' });

    const { rows: [job] } = await db.query(
      `SELECT * FROM agent_jobs WHERE id = $1 AND agent_id = $2`,
      [jobId, agentId],
    );
    if (!job)                    return res.status(404).json({ error: 'job_not_found' });
    if (job.status !== 'funded') return res.status(409).json({ error: 'job_not_funded', status: job.status });

    let txHashDeliver = null;

    if (AGENTIC_COMMERCE_ADDRESS && job.job_id_onchain && agent.encrypted_private_key) {
      try {
        const privateKey  = decrypt(agent.encrypted_private_key);
        const { signer }  = await _getProviderAndSigner(privateKey);
        const contract    = _getContract(signer);
        const hashBytes   = deliverableHash.startsWith('0x')
          ? deliverableHash
          : ethers.keccak256(ethers.toUtf8Bytes(deliverableHash));

        const tx      = await contract.deliver(BigInt(job.job_id_onchain), hashBytes);
        const receipt = await tx.wait(1);
        txHashDeliver = receipt.hash;
      } catch (err) {
        console.error('[JOBS] on-chain deliver error:', err.message);
      }
    }

    const { rows: [updated] } = await db.query(
      `UPDATE agent_jobs
       SET status = 'delivered', deliverable_hash = $1, tx_hash_deliver = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [deliverableHash, txHashDeliver, jobId],
    );

    res.json(updated);
  } catch (err) { next(err); }
});

// ── PUT /api/agents/:id/jobs/:jobId/complete ──────────────────────────────────
router.put('/:jobId/complete', async (req, res, next) => {
  try {
    const { id: agentId, jobId } = req.params;
    const agent = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const { rows: [job] } = await db.query(
      `SELECT * FROM agent_jobs WHERE id = $1 AND agent_id = $2`,
      [jobId, agentId],
    );
    if (!job)                       return res.status(404).json({ error: 'job_not_found' });
    if (job.status !== 'delivered') return res.status(409).json({ error: 'job_not_delivered', status: job.status });

    let txHashSettle = null;

    if (AGENTIC_COMMERCE_ADDRESS && job.job_id_onchain && agent.encrypted_private_key) {
      try {
        const privateKey = decrypt(agent.encrypted_private_key);
        const { signer } = await _getProviderAndSigner(privateKey);
        const contract   = _getContract(signer);

        const tx = await contract.complete(BigInt(job.job_id_onchain));
        const receipt = await tx.wait(1);
        txHashSettle  = receipt.hash;
      } catch (err) {
        console.error('[JOBS] on-chain complete error:', err.message);
      }
    }

    const { rows: [updated] } = await db.query(
      `UPDATE agent_jobs
       SET status = 'completed', tx_hash_settle = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [txHashSettle, jobId],
    );

    // Reputation event — fire-and-forget
    recordReputationEvent(agentId, EVENT_TYPES.TX_COMPLETED).catch(() => {});

    res.json(updated);
  } catch (err) { next(err); }
});

// ── PUT /api/agents/:id/jobs/:jobId/cancel ────────────────────────────────────
router.put('/:jobId/cancel', async (req, res, next) => {
  try {
    const { id: agentId, jobId } = req.params;
    const agent = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const { rows: [job] } = await db.query(
      `SELECT * FROM agent_jobs WHERE id = $1 AND agent_id = $2`,
      [jobId, agentId],
    );
    if (!job)                    return res.status(404).json({ error: 'job_not_found' });
    if (job.status === 'completed' || job.status === 'cancelled') {
      return res.status(409).json({ error: 'job_already_finalized', status: job.status });
    }

    if (AGENTIC_COMMERCE_ADDRESS && job.job_id_onchain && agent.encrypted_private_key) {
      try {
        const privateKey = decrypt(agent.encrypted_private_key);
        const { signer } = await _getProviderAndSigner(privateKey);
        const contract   = _getContract(signer);
        const tx = await contract.cancel(BigInt(job.job_id_onchain));
        await tx.wait(1);
      } catch (err) {
        console.error('[JOBS] on-chain cancel error:', err.message);
      }
    }

    const { rows: [updated] } = await db.query(
      `UPDATE agent_jobs SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [jobId],
    );

    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
