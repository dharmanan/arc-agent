'use strict';

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const { paymentMiddleware } = require('@x402/express');
const db = require('../db');
const { decrypt } = require('../services/cryptoService');
const jobEconomyService = require('../services/agenticEconomy/jobEconomyService');
const {
  createGatewayRouteConfig,
  createGatewayResourceServer,
} = require('../services/agenticEconomy/gatewaySeller');
const { buildJobReviewPolicy, JOB_REVIEW_TIMEOUT_HOURS } = require('../services/jobRetentionService');
const { assertAgentOperational } = require('../services/securityEventService');

const ACTIVE_JOB_STATUSES = ['funded', 'delivered', 'open'];
const PUBLIC_JOB_PAYMENT_CONTEXT_KEY = 'arcX402';
const JOB_PUBLIC_APPLY_FEE_USDC = Number(process.env.JOB_PUBLIC_APPLY_FEE_USDC || '0.01');
const JOB_PUBLIC_DELIVER_FEE_USDC = Number(process.env.JOB_PUBLIC_DELIVER_FEE_USDC || '0.02');
const AGENTIC_COMMERCE_ADDRESS = process.env.AGENTIC_COMMERCE_ADDRESS || null;
const ARC_RPC_URL = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const AGENTIC_COMMERCE_ABI = [
  'function deliver(uint256 jobId, bytes32 deliverableHash)',
];

const publicJobsReadRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'public_job_read_rate_limit_reached' },
});

const publicJobsWriteRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'public_job_write_rate_limit_reached' },
});

function normalizeAddress(value) {
  return ethers.getAddress(String(value || '').trim());
}

function getContract(signerOrProvider) {
  if (!AGENTIC_COMMERCE_ADDRESS) return null;
  return new ethers.Contract(AGENTIC_COMMERCE_ADDRESS, AGENTIC_COMMERCE_ABI, signerOrProvider);
}

async function getProviderAndSigner(privateKey) {
  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL, { chainId: 5042002, name: 'Arc Testnet' });
  const signer = new ethers.Wallet(privateKey, provider);
  return { provider, signer };
}

async function loadJobOwnerAgent(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, wallet_address, private_key_encrypted, status, is_active,
            security_frozen_at, security_freeze_reason
       FROM agents
      WHERE id = $1
      LIMIT 1`,
    [agentId],
  );

  return agent || null;
}

async function deliverPublicJobOnchain(job, deliverableHash) {
  if (!AGENTIC_COMMERCE_ADDRESS || !job?.job_id_onchain) {
    return null;
  }

  try {
    const agent = await loadJobOwnerAgent(job.agent_id);
    if (!agent?.private_key_encrypted) return null;

    let agentWalletAddress;
    let providerAddress;
    try {
      agentWalletAddress = normalizeAddress(agent.wallet_address || '');
      providerAddress = normalizeAddress(job.provider_address || '');
    } catch {
      return null;
    }

    if (agentWalletAddress !== providerAddress) {
      return null;
    }

    assertAgentOperational(agent);

    const privateKey = decrypt(agent.private_key_encrypted);
    const { signer } = await getProviderAndSigner(privateKey);
    const contract = getContract(signer);
    const hashBytes = String(deliverableHash || '').startsWith('0x')
      ? deliverableHash
      : ethers.keccak256(ethers.toUtf8Bytes(deliverableHash));

    const tx = await contract.deliver(BigInt(job.job_id_onchain), hashBytes);
    const receipt = await tx.wait(1);
    return receipt.hash;
  } catch (error) {
    console.error('[PUBLIC_JOBS] on-chain deliver error:', error.message);
    return null;
  }
}

function normalizeGatewayPayer(value) {
  const normalized = String(value || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(normalized) ? normalized.toLowerCase() : null;
}

function normalizePublicJobGatewayFee(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatGatewayPrice(priceUsdc) {
  return `$${String(priceUsdc)}`;
}

function setPublicJobPaymentContext(req, payer) {
  const normalizedPayer = normalizeGatewayPayer(payer);
  if (!req || !normalizedPayer) return;

  req[PUBLIC_JOB_PAYMENT_CONTEXT_KEY] = {
    payer: normalizedPayer,
    rail: 'circle_gateway',
  };
}

function getPublicJobPaymentContext(req) {
  const payer = normalizeGatewayPayer(req?.[PUBLIC_JOB_PAYMENT_CONTEXT_KEY]?.payer);
  if (!payer) return null;

  return {
    payer,
    rail: 'circle_gateway',
  };
}

function getPublicJobGatewaySummary() {
  const summary = typeof jobEconomyService.getJobEconomyConfigSummary === 'function'
    ? jobEconomyService.getJobEconomyConfigSummary()
    : {};

  return {
    sellerAddress: typeof summary?.sellerAddress === 'string' ? summary.sellerAddress : null,
    configured: Boolean(summary?.sellerAddress),
    applyFeeUsdc: normalizePublicJobGatewayFee(JOB_PUBLIC_APPLY_FEE_USDC),
    deliverFeeUsdc: normalizePublicJobGatewayFee(JOB_PUBLIC_DELIVER_FEE_USDC),
  };
}

function buildPublicJobIntakeSummary() {
  const gatewaySummary = getPublicJobGatewaySummary();

  return {
    legacy: {
      applicationMode: 'wallet_signature',
      deliveryMode: 'wallet_signature',
    },
    paid: {
      configured: Boolean(gatewaySummary.configured),
      paymentRail: 'circle_gateway',
      paidIdentity: 'x402_payer',
      sellerAddress: gatewaySummary.sellerAddress,
      applyFeeUsdc: gatewaySummary.applyFeeUsdc,
      deliverFeeUsdc: gatewaySummary.deliverFeeUsdc,
      applyPath: '/api/jobs/public/:jobId/apply-paid',
      deliverPath: '/api/jobs/public/:jobId/deliver-paid',
    },
  };
}

function createGatewayUnavailableMiddleware(reason, detail) {
  return (_req, res) => {
    res.status(503).json({
      error: 'gateway_not_configured',
      reason,
      detail: detail || null,
      sellerMode: 'circle_gateway',
    });
  };
}

function buildPublicJobUnpaidResponse(action, feeUsdc) {
  return () => ({
    contentType: 'application/json',
    body: {
      error: 'payment_required',
      action,
      feeUsdc,
      paymentRail: 'circle_gateway',
      paidIdentity: 'x402_payer',
    },
  });
}

function buildPublicJobSettlementFailedResponse(action, feeUsdc) {
  return () => ({
    contentType: 'application/json',
    body: {
      error: 'payment_settlement_failed',
      action,
      feeUsdc,
      paymentRail: 'circle_gateway',
      paidIdentity: 'x402_payer',
    },
  });
}

function createPublicJobGatewayMiddleware(path, { action, description, feeUsdc }) {
  const summary = getPublicJobGatewaySummary();
  if (!summary.sellerAddress) {
    return createGatewayUnavailableMiddleware('job_economy_pay_address_missing');
  }
  if (!feeUsdc) {
    return createGatewayUnavailableMiddleware('job_public_fee_missing', action);
  }

  try {
    const server = createGatewayResourceServer();
    server.onAfterVerify(async ({ result, transportContext }) => {
      const req = transportContext?.request?.adapter?.req;
      setPublicJobPaymentContext(req, result?.payer);
    });

    return paymentMiddleware(
      {
        [`POST ${path}`]: createGatewayRouteConfig({
          sellerAddress: summary.sellerAddress,
          price: formatGatewayPrice(feeUsdc),
          description,
          resource: path,
          unpaidResponseBody: buildPublicJobUnpaidResponse(action, feeUsdc),
          settlementFailedResponseBody: buildPublicJobSettlementFailedResponse(action, feeUsdc),
        }),
      },
      server,
      undefined,
      undefined,
      true,
    );
  } catch (error) {
    return createGatewayUnavailableMiddleware('gateway_middleware_init_failed', error.message);
  }
}

const publicJobApplyPaidGateway = createPublicJobGatewayMiddleware('/public/:jobId/apply-paid', {
  action: 'public_job_apply_paid',
  description: 'Paid public job application intake',
  feeUsdc: getPublicJobGatewaySummary().applyFeeUsdc,
});

const publicJobDeliverPaidGateway = createPublicJobGatewayMiddleware('/public/:jobId/deliver-paid', {
  action: 'public_job_deliver_paid',
  description: 'Paid public job delivery intake',
  feeUsdc: getPublicJobGatewaySummary().deliverFeeUsdc,
});

function buildPublicJobDeliveryMessage({ jobId, providerAddress, deliverableHash }) {
  return [
    'Arc Machina Public Job Delivery',
    `job:${jobId}`,
    `provider:${normalizeAddress(providerAddress)}`,
    `deliverable:${String(deliverableHash || '').trim()}`,
  ].join('\n');
}

function buildPublicJobApplicationMessage({ jobId, applicantAddress, note }) {
  return [
    'Arc Machina Public Job Application',
    `job:${jobId}`,
    `applicant:${normalizeAddress(applicantAddress)}`,
    `note:${String(note || '').trim()}`,
  ].join('\n');
}

function buildPublicJobDisputeMessage({ jobId, providerAddress, reason }) {
  return [
    'Arc Machina Public Job Dispute',
    `job:${jobId}`,
    `provider:${normalizeAddress(providerAddress)}`,
    `reason:${String(reason || '').trim()}`,
  ].join('\n');
}

function isReviewWindowExpired(job) {
  if (!job || job.status !== 'delivered' || !job.review_deadline_at) return false;
  return new Date(job.review_deadline_at).getTime() <= Date.now();
}

function buildPublicJob(job) {
  const decoratedEconomy = jobEconomyService.buildJobEconomy({ economy: job.economy, job });
  const applicationCount = Array.isArray(decoratedEconomy.applications)
    ? decoratedEconomy.applications.length
    : 0;
  const applicationsOpen = Boolean(decoratedEconomy.applicationsOpen) && !job.provider_address;
  const boardMode = applicationsOpen ? 'open_applications' : 'locked_provider';
  const publicIntake = buildPublicJobIntakeSummary();

  return {
    id: job.id,
    agentId: job.agent_id,
    jobIdOnchain: job.job_id_onchain || null,
    clientAddress: job.client_address || null,
    providerAddress: job.provider_address || null,
    amountUsdc: Number(job.amount_usdc || 0),
    description: job.description || '',
    status: job.status,
    deliverableHash: job.deliverable_hash || null,
    txHashCreate: job.tx_hash_create || null,
    txHashDeliver: job.tx_hash_deliver || null,
    txHashSettle: job.tx_hash_settle || null,
    reviewDeadlineAt: job.review_deadline_at || null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    reviewRequired: job.status === 'delivered',
    payoutBlocked: job.status !== 'completed',
    deliveryMode: 'provider_wallet_signature',
    boardMode,
    reviewSlaHours: decoratedEconomy.reviewPolicy?.timeoutHours || JOB_REVIEW_TIMEOUT_HOURS,
    applicationsOpen,
    applicationCount,
    reviewPolicy: decoratedEconomy.reviewPolicy || null,
    economy: decoratedEconomy,
    visibility: 'public_board',
    publicIntake,
    notes: {
      overview: applicationsOpen
        ? 'Anyone can view this job and manually apply with a wallet signature. The client still chooses the provider before delivery can start.'
        : 'Anyone can view this job. Delivery can be recorded by the provider wallet without platform membership, but payout still waits for client review and complete.',
      nextStep: applicationsOpen
        ? 'Applicants should submit a short note and wallet signature so the client can choose the provider.'
        : decoratedEconomy.reviewPolicy?.disputeState === 'raised'
          ? 'A provider-side dispute is raised. The client still has to complete or reject before the review deadline expires.'
        : job.status === 'funded'
          ? 'Provider should submit the deliverable and sign it with the provider wallet.'
        : job.status === 'delivered'
          ? `Client review is still required. Payment stays blocked until the client marks the job complete, rejects the result, or the ${decoratedEconomy.reviewPolicy?.timeoutHours || JOB_REVIEW_TIMEOUT_HOURS}h review window expires.`
          : job.status === 'completed'
            ? 'Client accepted the result and the payout rail reached its final state.'
            : job.status === 'rejected'
              ? 'Client rejected the delivered result. This job is closed without payout.'
            : 'This job is no longer active.',
    },
  };
}

async function loadPublicJob(jobId) {
  const { rows: [job] } = await db.query(
    `SELECT id, agent_id, job_id_onchain, client_address, provider_address, amount_usdc,
            description, status, deliverable_hash, tx_hash_create, tx_hash_deliver, tx_hash_settle,
            review_deadline_at, economy,
            created_at, updated_at
       FROM agent_jobs
      WHERE id = $1
      LIMIT 1`,
    [jobId],
  );

  return job || null;
}

async function recordPublicJobApplication({ jobId, applicantAddress, note }) {
  const job = await loadPublicJob(jobId);
  if (!job) return { error: { status: 404, body: { error: 'job_not_found' } } };
  if (isReviewWindowExpired(job)) {
    return { error: { status: 410, body: { error: 'job_review_window_expired' } } };
  }
  if (job.status !== 'funded' && job.status !== 'open') {
    return {
      error: {
        status: 409,
        body: { error: 'job_not_open_for_applications', status: job.status },
      },
    };
  }
  if (job.provider_address) {
    return { error: { status: 409, body: { error: 'provider_locked' } } };
  }

  const decoratedEconomy = jobEconomyService.buildJobEconomy({ economy: job.economy, job });
  if (!decoratedEconomy.applicationsOpen) {
    return { error: { status: 409, body: { error: 'applications_closed' } } };
  }

  const applications = Array.isArray(decoratedEconomy.applications)
    ? decoratedEconomy.applications.filter((entry) => {
        try {
          return normalizeAddress(entry.applicantAddress) !== applicantAddress;
        } catch {
          return true;
        }
      })
    : [];

  applications.push({
    applicantAddress,
    note,
    createdAt: new Date().toISOString(),
  });

  const updatedEconomy = jobEconomyService.buildJobEconomy({
    economy: {
      ...decoratedEconomy,
      applicationsOpen: true,
      applications,
    },
    job,
  });

  const { rows: [updated] } = await db.query(
    `UPDATE agent_jobs
        SET economy = $1::jsonb,
            updated_at = NOW()
      WHERE id = $2
      RETURNING id, agent_id, job_id_onchain, client_address, provider_address, amount_usdc,
                description, status, deliverable_hash, tx_hash_create, tx_hash_settle, economy,
                created_at, updated_at`,
    [JSON.stringify(updatedEconomy), job.id],
  );

  return { job: updated };
}

async function recordPublicJobDelivery({ jobId, providerAddress, deliverableHash }) {
  const job = await loadPublicJob(jobId);
  if (!job) return { error: { status: 404, body: { error: 'job_not_found' } } };
  if (isReviewWindowExpired(job)) {
    return { error: { status: 410, body: { error: 'job_review_window_expired' } } };
  }
  if (job.status !== 'funded' && job.status !== 'open') {
    return { error: { status: 409, body: { error: 'job_not_funded', status: job.status } } };
  }
  if (!job.provider_address) {
    return { error: { status: 409, body: { error: 'provider_not_assigned' } } };
  }

  let expectedProviderAddress;
  try {
    expectedProviderAddress = normalizeAddress(job.provider_address || '');
  } catch {
    return { error: { status: 409, body: { error: 'provider_not_configured' } } };
  }

  if (expectedProviderAddress !== providerAddress) {
    return { error: { status: 403, body: { error: 'provider_mismatch' } } };
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
    },
  });

  const txHashDeliver = await deliverPublicJobOnchain(job, deliverableHash);

  const { rows: [updated] } = await db.query(
    `UPDATE agent_jobs
        SET status = 'delivered',
            deliverable_hash = $1,
            tx_hash_deliver = COALESCE($2, tx_hash_deliver),
            review_deadline_at = NOW() + ($3::int * INTERVAL '1 hour'),
            economy = $4::jsonb,
            updated_at = NOW()
      WHERE id = $5
      RETURNING id, agent_id, job_id_onchain, client_address, provider_address, amount_usdc,
                description, status, deliverable_hash, tx_hash_create, tx_hash_deliver, tx_hash_settle,
                review_deadline_at, economy,
                created_at, updated_at`,
    [deliverableHash, txHashDeliver, JOB_REVIEW_TIMEOUT_HOURS, JSON.stringify(deliveredEconomy), job.id],
  );

  return { job: updated };
}

// ── GET /api/jobs/public/board ───────────────────────────────────────────────
router.get('/public/board', publicJobsReadRateLimit, async (req, res, next) => {
  try {
    const includeFinalized = req.query.includeFinalized === 'true';
    const limit = Math.min(parseInt(req.query.limit || '40', 10), 100);

    const params = [limit];
    let whereClause = `WHERE NOT (
      status = 'delivered'
      AND review_deadline_at IS NOT NULL
      AND review_deadline_at <= NOW()
    )`;
    if (!includeFinalized) params.push(ACTIVE_JOB_STATUSES);
    if (!includeFinalized) whereClause += ` AND status = ANY($2::text[])`;

    const { rows } = await db.query(
      `SELECT id, agent_id, job_id_onchain, client_address, provider_address, amount_usdc,
              description, status, deliverable_hash, tx_hash_create, tx_hash_settle,
              review_deadline_at, economy,
              created_at, updated_at
         FROM agent_jobs
         ${whereClause}
        ORDER BY CASE status
          WHEN 'funded' THEN 0
          WHEN 'delivered' THEN 1
          WHEN 'open' THEN 2
          WHEN 'completed' THEN 3
          WHEN 'rejected' THEN 4
          WHEN 'cancelled' THEN 5
          ELSE 6
        END,
        created_at DESC
        LIMIT $1`,
      params,
    );

    res.json({
      jobs: rows.map(buildPublicJob),
      visibility: 'public_board',
      deliveryMode: 'provider_wallet_signature',
      paymentRule: 'deliver_does_not_release_payout',
      publicIntake: buildPublicJobIntakeSummary(),
    });
  } catch (err) { next(err); }
});

// ── GET /api/jobs/public/:jobId ──────────────────────────────────────────────
router.get('/public/:jobId', publicJobsReadRateLimit, async (req, res, next) => {
  try {
    const job = await loadPublicJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    if (isReviewWindowExpired(job)) {
      return res.status(410).json({ error: 'job_review_window_expired' });
    }

    res.json({
      job: buildPublicJob(job),
      paymentRule: 'deliver_does_not_release_payout',
      publicIntake: buildPublicJobIntakeSummary(),
    });
  } catch (err) { next(err); }
});

// ── POST /api/jobs/public/:jobId/apply ───────────────────────────────────────
router.post('/public/:jobId/apply', publicJobsWriteRateLimit, async (req, res, next) => {
  try {
    const applicantAddressRaw = String(req.body?.applicantAddress || '').trim();
    const note = String(req.body?.note || '').trim();
    const signature = String(req.body?.signature || '').trim();

    if (!applicantAddressRaw) return res.status(400).json({ error: 'applicant_address_required' });
    if (!note) return res.status(400).json({ error: 'application_note_required' });
    if (note.length > 280) return res.status(400).json({ error: 'application_note_too_long' });
    if (!signature) return res.status(400).json({ error: 'signature_required' });

    let applicantAddress;
    try {
      applicantAddress = normalizeAddress(applicantAddressRaw);
    } catch {
      return res.status(400).json({ error: 'invalid_applicant_address' });
    }

    const message = buildPublicJobApplicationMessage({
      jobId: req.params.jobId,
      applicantAddress,
      note,
    });

    let recoveredAddress;
    try {
      recoveredAddress = normalizeAddress(ethers.verifyMessage(message, signature));
    } catch {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    if (recoveredAddress !== applicantAddress) {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const result = await recordPublicJobApplication({
      jobId: req.params.jobId,
      applicantAddress,
      note,
    });
    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }

    res.json({
      job: buildPublicJob(result.job),
      applicationMessage: message,
      note: 'Application recorded. The client still has to choose and assign the provider wallet before delivery can start.',
    });
  } catch (err) { next(err); }
});

// ── POST /api/jobs/public/:jobId/apply-paid ─────────────────────────────────
router.post(
  '/public/:jobId/apply-paid',
  publicJobsWriteRateLimit,
  publicJobApplyPaidGateway,
  async (req, res, next) => {
    try {
      const note = String(req.body?.note || '').trim();
      if (!note) return res.status(400).json({ error: 'application_note_required' });
      if (note.length > 280) return res.status(400).json({ error: 'application_note_too_long' });

      const paymentContext = getPublicJobPaymentContext(req);
      if (!paymentContext?.payer) {
        return res.status(502).json({ error: 'payment_identity_missing' });
      }

      const applicantAddress = normalizeAddress(paymentContext.payer);
      const result = await recordPublicJobApplication({
        jobId: req.params.jobId,
        applicantAddress,
        note,
      });
      if (result.error) {
        return res.status(result.error.status).json(result.error.body);
      }

      res.json({
        job: buildPublicJob(result.job),
        note: 'Paid application recorded. The x402 payer identity is stored as the applicant wallet and the client still has to assign the provider before delivery can start.',
        paymentRail: paymentContext.rail,
        paidIdentity: 'x402_payer',
        applicantAddress,
      });
    } catch (err) { next(err); }
  },
);

// ── POST /api/jobs/public/:jobId/dispute ────────────────────────────────────
router.post('/public/:jobId/dispute', publicJobsWriteRateLimit, async (req, res, next) => {
  try {
    const providerAddressRaw = String(req.body?.providerAddress || '').trim();
    const reason = String(req.body?.reason || '').trim();
    const signature = String(req.body?.signature || '').trim();

    if (!providerAddressRaw) return res.status(400).json({ error: 'provider_address_required' });
    if (!reason) return res.status(400).json({ error: 'dispute_reason_required' });
    if (reason.length > 280) return res.status(400).json({ error: 'dispute_reason_too_long' });
    if (!signature) return res.status(400).json({ error: 'signature_required' });

    let providerAddress;
    try {
      providerAddress = normalizeAddress(providerAddressRaw);
    } catch {
      return res.status(400).json({ error: 'invalid_provider_address' });
    }

    const job = await loadPublicJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    if (isReviewWindowExpired(job)) {
      return res.status(410).json({ error: 'job_review_window_expired' });
    }
    if (job.status !== 'delivered') {
      return res.status(409).json({ error: 'job_not_delivered', status: job.status });
    }

    let expectedProviderAddress;
    try {
      expectedProviderAddress = normalizeAddress(job.provider_address || '');
    } catch {
      return res.status(409).json({ error: 'provider_not_configured' });
    }

    if (expectedProviderAddress !== providerAddress) {
      return res.status(403).json({ error: 'provider_mismatch' });
    }

    const message = buildPublicJobDisputeMessage({
      jobId: job.id,
      providerAddress,
      reason,
    });

    let recoveredAddress;
    try {
      recoveredAddress = normalizeAddress(ethers.verifyMessage(message, signature));
    } catch {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    if (recoveredAddress !== providerAddress) {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const updatedEconomy = jobEconomyService.buildJobEconomy({
      economy: {
        ...(job.economy || {}),
        reviewPolicy: buildJobReviewPolicy({
          ...(job.economy?.reviewPolicy || {}),
          disputeState: 'raised',
          disputeReason: reason,
          disputeRaisedAt: new Date().toISOString(),
          disputeRaisedBy: providerAddress,
        }),
      },
      job,
    });

    const { rows: [updated] } = await db.query(
      `UPDATE agent_jobs
          SET economy = $1::jsonb,
              updated_at = NOW()
        WHERE id = $2
        RETURNING id, agent_id, job_id_onchain, client_address, provider_address, amount_usdc,
                  description, status, deliverable_hash, tx_hash_create, tx_hash_settle,
                  review_deadline_at, economy, created_at, updated_at`,
      [JSON.stringify(updatedEconomy), job.id],
    );

    res.json({
      job: buildPublicJob(updated),
      disputeMessage: message,
      note: `Dispute recorded. The client still has ${JOB_REVIEW_TIMEOUT_HOURS} hour(s) from delivery to resolve the job before it is deleted without payout.`,
    });
  } catch (err) { next(err); }
});

// ── POST /api/jobs/public/:jobId/deliver ─────────────────────────────────────
router.post('/public/:jobId/deliver', publicJobsWriteRateLimit, async (req, res, next) => {
  try {
    const providerAddressRaw = String(req.body?.providerAddress || '').trim();
    const deliverableHash = String(req.body?.deliverableHash || '').trim();
    const signature = String(req.body?.signature || '').trim();

    if (!providerAddressRaw) return res.status(400).json({ error: 'provider_address_required' });
    if (!deliverableHash) return res.status(400).json({ error: 'deliverableHash required' });
    if (!signature) return res.status(400).json({ error: 'signature_required' });

    let providerAddress;
    try {
      providerAddress = normalizeAddress(providerAddressRaw);
    } catch {
      return res.status(400).json({ error: 'invalid_provider_address' });
    }

    const message = buildPublicJobDeliveryMessage({
      jobId: req.params.jobId,
      providerAddress,
      deliverableHash,
    });

    let recoveredAddress;
    try {
      recoveredAddress = normalizeAddress(ethers.verifyMessage(message, signature));
    } catch {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    if (recoveredAddress !== providerAddress) {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const result = await recordPublicJobDelivery({
      jobId: req.params.jobId,
      providerAddress,
      deliverableHash,
    });
    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }

    res.json({
      job: buildPublicJob(result.job),
      deliveryMessage: message,
      note: 'Delivery recorded. Client review and complete are still required before payout is released.',
      paymentRule: 'deliver_does_not_release_payout',
    });
  } catch (err) { next(err); }
});

// ── POST /api/jobs/public/:jobId/deliver-paid ───────────────────────────────
router.post(
  '/public/:jobId/deliver-paid',
  publicJobsWriteRateLimit,
  publicJobDeliverPaidGateway,
  async (req, res, next) => {
    try {
      const deliverableHash = String(req.body?.deliverableHash || '').trim();
      if (!deliverableHash) return res.status(400).json({ error: 'deliverableHash required' });

      const paymentContext = getPublicJobPaymentContext(req);
      if (!paymentContext?.payer) {
        return res.status(502).json({ error: 'payment_identity_missing' });
      }

      const providerAddress = normalizeAddress(paymentContext.payer);
      const result = await recordPublicJobDelivery({
        jobId: req.params.jobId,
        providerAddress,
        deliverableHash,
      });
      if (result.error) {
        return res.status(result.error.status).json(result.error.body);
      }

      res.json({
        job: buildPublicJob(result.job),
        note: 'Paid delivery recorded. The x402 payer identity is treated as the provider wallet, but client review and complete are still required before payout is released.',
        paymentRule: 'deliver_does_not_release_payout',
        paymentRail: paymentContext.rail,
        paidIdentity: 'x402_payer',
        providerAddress,
      });
    } catch (err) { next(err); }
  },
);

module.exports = router;
module.exports._buildPublicJobDeliveryMessage = buildPublicJobDeliveryMessage;
module.exports._buildPublicJobApplicationMessage = buildPublicJobApplicationMessage;
module.exports._buildPublicJobDisputeMessage = buildPublicJobDisputeMessage;