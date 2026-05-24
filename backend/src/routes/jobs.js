'use strict';
/**
 * ERC-8183 AgenticCommerce Jobs
 *
 * GET  /api/agents/:id/jobs                     — list jobs for agent
 * POST /api/agents/:id/jobs                     — create job (on-chain + DB)
 * GET  /api/agents/:id/jobs/:jobId              — single job detail
 * PUT  /api/agents/:id/jobs/:jobId/deliver      — submit deliverable hash
 * PUT  /api/agents/:id/jobs/:jobId/complete     — mark completed (payout)
 * PUT  /api/agents/:id/jobs/:jobId/reject       — reject delivered work
 * PUT  /api/agents/:id/jobs/:jobId/cancel       — cancel before delivery
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
const gatewayAuditService = require('../services/agenticEconomy/gatewayAuditService');
const jobEconomyService = require('../services/agenticEconomy/jobEconomyService');
const { recordReputationEvent, EVENT_TYPES } = require('../services/reputationService');
const { buildJobReviewPolicy, JOB_REVIEW_TIMEOUT_HOURS } = require('../services/jobRetentionService');
const { assertAgentOperational } = require('../services/securityEventService');

router.use(requireAuth);

const AGENTIC_COMMERCE_ADDRESS = process.env.AGENTIC_COMMERCE_ADDRESS || null;
const ARC_RPC_URL              = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const PROVIDER_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

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
    `SELECT id, wallet_address, private_key_encrypted, status, is_active,
            security_frozen_at, security_freeze_reason
       FROM agents WHERE id = $1 AND user_id = $2`,
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

function _decorateJob(job) {
  if (!job) return job;

  return {
    ...job,
    economy: jobEconomyService.buildJobEconomy({ economy: job.economy, job }),
  };
}

function isReviewWindowExpired(job) {
  if (!job || job.status !== 'delivered' || !job.review_deadline_at) return false;
  return new Date(job.review_deadline_at).getTime() <= Date.now();
}

function isFinalizedJobStatus(status) {
  return status === 'completed' || status === 'cancelled' || status === 'rejected';
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
              description, status, deliverable_hash, tx_hash_create, tx_hash_settle,
              review_deadline_at, economy, created_at, updated_at
       FROM agent_jobs
       WHERE agent_id = $1
         AND NOT (
           status = 'delivered'
           AND review_deadline_at IS NOT NULL
           AND review_deadline_at <= NOW()
         )
         ${status ? 'AND status = $3' : ''}
       ORDER BY created_at DESC
       LIMIT $2`,
      status ? [agentId, limit, status] : [agentId, limit],
    );

    res.json({
      jobs: rows.map(_decorateJob),
      onchainEnabled: !!AGENTIC_COMMERCE_ADDRESS,
      jobEconomy: jobEconomyService.getJobEconomyConfigSummary(),
      jobReviewTimeoutHours: JOB_REVIEW_TIMEOUT_HOURS,
    });
  } catch (err) { next(err); }
});

// ── GET /api/agents/:id/jobs/:jobId ───────────────────────────────────────────
router.get('/:jobId', async (req, res, next) => {
  try {
    const { id: agentId, jobId } = req.params;
    const agent = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const { rows: [job] } = await db.query(
      `SELECT *
         FROM agent_jobs
        WHERE id = $1
          AND agent_id = $2`,
      [jobId, agentId],
    );
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    if (isReviewWindowExpired(job)) {
      return res.status(410).json({ error: 'job_review_window_expired' });
    }

    res.json(_decorateJob(job));
  } catch (err) { next(err); }
});

// ── POST /api/agents/:id/jobs ─────────────────────────────────────────────────
const createJobSchema = z.object({
  providerAddress: z.preprocess(
    (value) => {
      const normalized = String(value || '').trim();
      return normalized || undefined;
    },
    z.string().regex(PROVIDER_ADDRESS_PATTERN, 'Invalid EVM address').optional(),
  ),
  amountUsdc:      z.number().positive().max(100_000),
  description:     z.string().min(1).max(500),
  acceptingApplications: z.boolean().optional(),
});

router.post('/', async (req, res, next) => {
  try {
    const agentId = req.params.id;
    const agent   = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    assertAgentOperational(agent);

    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const { amountUsdc, description } = parsed.data;
    const providerAddress = parsed.data.providerAddress || null;
    const acceptingApplications = Boolean(parsed.data.acceptingApplications) && !providerAddress;
    if (!providerAddress && !acceptingApplications) {
      return res.status(400).json({ error: 'provider_or_manual_applications_required' });
    }

    let jobIdOnchain = null;
    let txHashCreate = null;
    const initialStatus = 'funded';

    // On-chain: only if contract deployed
    if (providerAddress && AGENTIC_COMMERCE_ADDRESS && agent.private_key_encrypted) {
      try {
        const privateKey      = decrypt(agent.private_key_encrypted);
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

    let createFee = null;
    try {
      createFee = await jobEconomyService.settleJobCreateFee({
        agent,
        jobId: jobIdOnchain,
        amountUsdc,
        providerAddress,
        description,
      });
    } catch (err) {
      console.warn('[JOB_ECONOMY] create fee settlement failed:', err.message);
      createFee = jobEconomyService.buildJobCreateFeeFailure({
        jobId: jobIdOnchain,
        amountUsdc,
        providerAddress,
        description,
        error: err.message,
      });
    }

    const economy = jobEconomyService.buildJobEconomy({
      economy: {
        createFee,
        applicationsOpen: acceptingApplications,
        applications: [],
        reviewPolicy: buildJobReviewPolicy(),
      },
      job: {
        job_id_onchain: jobIdOnchain,
        status: initialStatus,
        tx_hash_settle: null,
      },
    });

    const { rows: [job] } = await db.query(
      `INSERT INTO agent_jobs
         (agent_id, job_id_onchain, client_address, provider_address, amount_usdc, description, status, tx_hash_create, economy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [agentId, jobIdOnchain, agent.wallet_address, providerAddress, amountUsdc, description, initialStatus, txHashCreate, JSON.stringify(economy)],
    );

    await gatewayAuditService.recordAgenticPaymentEventSafe({
      agentId,
      eventType: 'job_create_fee',
      rail: createFee?.rail || 'agentic_job_economy',
      referenceType: 'job',
      referenceId: job.id,
      txHash: createFee?.gatewayMintTxHash || null,
      amountUsdc: createFee?.feeUsdc ?? null,
      token: 'USDC',
      status: createFee?.status || 'skipped',
      sourceChain: createFee?.sourceChain || 'Arc Testnet',
      destinationChain: createFee?.destinationChain || 'Arc Testnet',
      counterpartyAddress: createFee?.recipient || createFee?.sellerAddress || null,
      payload: createFee || { status: 'missing' },
    });

    res.status(201).json({
      job: _decorateJob(job),
      onchainEnabled: !!AGENTIC_COMMERCE_ADDRESS,
      jobEconomy: jobEconomyService.getJobEconomyConfigSummary(),
    });
  } catch (err) { next(err); }
});

// ── PUT /api/agents/:id/jobs/:jobId/assign-provider ──────────────────────────
router.put('/:jobId/assign-provider', async (req, res, next) => {
  try {
    const { id: agentId, jobId } = req.params;
    const agent = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    assertAgentOperational(agent);

    const providerAddress = String(req.body?.providerAddress || '').trim();
    if (!PROVIDER_ADDRESS_PATTERN.test(providerAddress)) {
      return res.status(400).json({ error: 'Invalid EVM address' });
    }

    const { rows: [job] } = await db.query(
      `SELECT * FROM agent_jobs WHERE id = $1 AND agent_id = $2`,
      [jobId, agentId],
    );
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    if (isFinalizedJobStatus(job.status)) {
      return res.status(409).json({ error: 'job_already_finalized', status: job.status });
    }
    if (job.provider_address) {
      return res.status(409).json({ error: 'provider_already_assigned' });
    }

    const updatedEconomy = jobEconomyService.buildJobEconomy({
      economy: {
        ...(job.economy || {}),
        applicationsOpen: false,
      },
      job: {
        ...job,
        provider_address: providerAddress,
      },
    });

    const { rows: [updated] } = await db.query(
      `UPDATE agent_jobs
          SET provider_address = $1,
              economy = $2::jsonb,
              updated_at = NOW()
        WHERE id = $3
        RETURNING *`,
      [providerAddress, JSON.stringify(updatedEconomy), jobId],
    );

    res.json({
      job: _decorateJob(updated),
      assignmentMode: updated.job_id_onchain ? 'provider_locked' : 'local_provider_locked',
    });
  } catch (err) { next(err); }
});

// ── PUT /api/agents/:id/jobs/:jobId/deliver ───────────────────────────────────
router.put('/:jobId/deliver', async (req, res, next) => {
  try {
    const { id: agentId, jobId } = req.params;
    const agent = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    assertAgentOperational(agent);

    const deliverableHash = String(req.body?.deliverableHash || '').trim();
    if (!deliverableHash) return res.status(400).json({ error: 'deliverableHash required' });

    const { rows: [job] } = await db.query(
      `SELECT * FROM agent_jobs WHERE id = $1 AND agent_id = $2`,
      [jobId, agentId],
    );
    if (!job)                    return res.status(404).json({ error: 'job_not_found' });
    if (job.status !== 'funded') return res.status(409).json({ error: 'job_not_funded', status: job.status });
    if (!job.provider_address)   return res.status(409).json({ error: 'provider_not_assigned' });

    let txHashDeliver = null;

    if (AGENTIC_COMMERCE_ADDRESS && job.job_id_onchain && agent.private_key_encrypted) {
      try {
        const privateKey  = decrypt(agent.private_key_encrypted);
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

    const deliveredEconomy = jobEconomyService.buildJobEconomy({
      economy: {
        ...(job.economy || {}),
        reviewPolicy: buildJobReviewPolicy({
          ...(job.economy?.reviewPolicy || {}),
          disputeState: 'none',
          disputeReason: '',
          disputeRaisedAt: null,
          disputeRaisedBy: null,
        }),
      },
      job: {
        ...job,
        status: 'delivered',
        tx_hash_deliver: txHashDeliver,
      },
    });

    const { rows: [updated] } = await db.query(
      `UPDATE agent_jobs
       SET status = 'delivered',
           deliverable_hash = $1,
           tx_hash_deliver = $2,
           review_deadline_at = NOW() + ($3::int * INTERVAL '1 hour'),
           economy = $4::jsonb,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [deliverableHash, txHashDeliver, JOB_REVIEW_TIMEOUT_HOURS, JSON.stringify(deliveredEconomy), jobId],
    );

    res.json(_decorateJob(updated));
  } catch (err) { next(err); }
});

// ── PUT /api/agents/:id/jobs/:jobId/complete ──────────────────────────────────
router.put('/:jobId/complete', async (req, res, next) => {
  try {
    const { id: agentId, jobId } = req.params;
    const agent = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    assertAgentOperational(agent);

    const { rows: [job] } = await db.query(
      `SELECT * FROM agent_jobs WHERE id = $1 AND agent_id = $2`,
      [jobId, agentId],
    );
    if (!job)                       return res.status(404).json({ error: 'job_not_found' });
    if (job.status !== 'delivered') return res.status(409).json({ error: 'job_not_delivered', status: job.status });
    if (isReviewWindowExpired(job)) return res.status(410).json({ error: 'job_review_window_expired' });

    let txHashSettle = null;

    if (AGENTIC_COMMERCE_ADDRESS && job.job_id_onchain && agent.private_key_encrypted) {
      try {
        const privateKey = decrypt(agent.private_key_encrypted);
        const { signer } = await _getProviderAndSigner(privateKey);
        const contract   = _getContract(signer);

        const tx = await contract.complete(BigInt(job.job_id_onchain));
        const receipt = await tx.wait(1);
        txHashSettle  = receipt.hash;
      } catch (err) {
        console.error('[JOBS] on-chain complete error:', err.message);
      }
    }

    const completedEconomy = jobEconomyService.buildJobEconomy({
      economy: job.economy,
      job: {
        ...job,
        status: 'completed',
        tx_hash_settle: txHashSettle,
      },
    });

    const { rows: [updated] } = await db.query(
      `UPDATE agent_jobs
       SET status = 'completed', tx_hash_settle = $1, review_deadline_at = NULL, economy = $2::jsonb, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [txHashSettle, JSON.stringify(completedEconomy), jobId],
    );

    await gatewayAuditService.recordAgenticPaymentEventSafe({
      agentId,
      eventType: 'job_payout',
      rail: completedEconomy.payout?.rail || 'agentic_job_escrow',
      referenceType: 'job',
      referenceId: updated.id,
      txHash: txHashSettle,
      amountUsdc: updated.amount_usdc,
      token: 'USDC',
      status: completedEconomy.payout?.status || 'completed',
      sourceChain: 'Arc Testnet',
      destinationChain: 'Arc Testnet',
      counterpartyAddress: updated.provider_address || null,
      payload: completedEconomy.payout || {},
    });

    // Reputation event — fire-and-forget
    recordReputationEvent(agentId, EVENT_TYPES.TX_COMPLETED).catch(() => {});

    res.json(_decorateJob(updated));
  } catch (err) { next(err); }
});

// ── PUT /api/agents/:id/jobs/:jobId/cancel ────────────────────────────────────
router.put('/:jobId/cancel', async (req, res, next) => {
  try {
    const { id: agentId, jobId } = req.params;
    const agent = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    assertAgentOperational(agent);

    const { rows: [job] } = await db.query(
      `SELECT * FROM agent_jobs WHERE id = $1 AND agent_id = $2`,
      [jobId, agentId],
    );
    if (!job)                    return res.status(404).json({ error: 'job_not_found' });
    if (isReviewWindowExpired(job)) return res.status(410).json({ error: 'job_review_window_expired' });
    if (isFinalizedJobStatus(job.status)) {
      return res.status(409).json({ error: 'job_already_finalized', status: job.status });
    }
    if (job.status === 'delivered') {
      return res.status(409).json({ error: 'job_requires_reject', status: job.status });
    }

    if (AGENTIC_COMMERCE_ADDRESS && job.job_id_onchain && agent.private_key_encrypted) {
      try {
        const privateKey = decrypt(agent.private_key_encrypted);
        const { signer } = await _getProviderAndSigner(privateKey);
        const contract   = _getContract(signer);
        const tx = await contract.cancel(BigInt(job.job_id_onchain));
        await tx.wait(1);
      } catch (err) {
        console.error('[JOBS] on-chain cancel error:', err.message);
      }
    }

    const cancelledEconomy = jobEconomyService.buildJobEconomy({
      economy: job.economy,
      job: {
        ...job,
        status: 'cancelled',
        review_deadline_at: null,
      },
    });

    const { rows: [updated] } = await db.query(
      `UPDATE agent_jobs
          SET status = 'cancelled', review_deadline_at = NULL, economy = $1::jsonb, updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [JSON.stringify(cancelledEconomy), jobId],
    );

    res.json(_decorateJob(updated));
  } catch (err) { next(err); }
});

// ── PUT /api/agents/:id/jobs/:jobId/reject ───────────────────────────────────
router.put('/:jobId/reject', async (req, res, next) => {
  try {
    const { id: agentId, jobId } = req.params;
    const agent = await _getAgentForUser(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    assertAgentOperational(agent);

    const { rows: [job] } = await db.query(
      `SELECT * FROM agent_jobs WHERE id = $1 AND agent_id = $2`,
      [jobId, agentId],
    );
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    if (isReviewWindowExpired(job)) return res.status(410).json({ error: 'job_review_window_expired' });
    if (isFinalizedJobStatus(job.status)) {
      return res.status(409).json({ error: 'job_already_finalized', status: job.status });
    }
    if (job.status !== 'delivered') {
      return res.status(409).json({ error: 'job_not_delivered', status: job.status });
    }

    if (AGENTIC_COMMERCE_ADDRESS && job.job_id_onchain && agent.private_key_encrypted) {
      try {
        const privateKey = decrypt(agent.private_key_encrypted);
        const { signer } = await _getProviderAndSigner(privateKey);
        const contract   = _getContract(signer);
        const tx = await contract.cancel(BigInt(job.job_id_onchain));
        await tx.wait(1);
      } catch (err) {
        console.error('[JOBS] on-chain reject error:', err.message);
      }
    }

    const rejectedEconomy = jobEconomyService.buildJobEconomy({
      economy: job.economy,
      job: {
        ...job,
        status: 'rejected',
        review_deadline_at: null,
      },
    });

    const { rows: [updated] } = await db.query(
      `UPDATE agent_jobs
          SET status = 'rejected', review_deadline_at = NULL, economy = $1::jsonb, updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [JSON.stringify(rejectedEconomy), jobId],
    );

    res.json(_decorateJob(updated));
  } catch (err) { next(err); }
});

module.exports = router;
