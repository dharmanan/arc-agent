'use strict';

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const db = require('../db');
const jobEconomyService = require('../services/agenticEconomy/jobEconomyService');
const { buildJobReviewPolicy, JOB_REVIEW_TIMEOUT_HOURS } = require('../services/jobRetentionService');

const ACTIVE_JOB_STATUSES = ['funded', 'delivered', 'open'];

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
            description, status, deliverable_hash, tx_hash_create, tx_hash_settle,
            review_deadline_at, economy,
            created_at, updated_at
       FROM agent_jobs
      WHERE id = $1
      LIMIT 1`,
    [jobId],
  );

  return job || null;
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

    const job = await loadPublicJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    if (isReviewWindowExpired(job)) {
      return res.status(410).json({ error: 'job_review_window_expired' });
    }
    if (job.status !== 'funded' && job.status !== 'open') {
      return res.status(409).json({ error: 'job_not_open_for_applications', status: job.status });
    }
    if (job.provider_address) {
      return res.status(409).json({ error: 'provider_locked' });
    }

    const decoratedEconomy = jobEconomyService.buildJobEconomy({ economy: job.economy, job });
    if (!decoratedEconomy.applicationsOpen) {
      return res.status(409).json({ error: 'applications_closed' });
    }

    const message = buildPublicJobApplicationMessage({
      jobId: job.id,
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

    res.json({
      job: buildPublicJob(updated),
      applicationMessage: message,
      note: 'Application recorded. The client still has to choose and assign the provider wallet before delivery can start.',
    });
  } catch (err) { next(err); }
});

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

    const job = await loadPublicJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    if (isReviewWindowExpired(job)) {
      return res.status(410).json({ error: 'job_review_window_expired' });
    }
    if (job.status !== 'funded' && job.status !== 'open') {
      return res.status(409).json({ error: 'job_not_funded', status: job.status });
    }
    if (!job.provider_address) {
      return res.status(409).json({ error: 'provider_not_assigned' });
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

    const message = buildPublicJobDeliveryMessage({
      jobId: job.id,
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

    const { rows: [updated] } = await db.query(
      `UPDATE agent_jobs
          SET status = 'delivered',
              deliverable_hash = $1,
              review_deadline_at = NOW() + ($2::int * INTERVAL '1 hour'),
              economy = $3::jsonb,
              updated_at = NOW()
        WHERE id = $4
        RETURNING id, agent_id, job_id_onchain, client_address, provider_address, amount_usdc,
                  description, status, deliverable_hash, tx_hash_create, tx_hash_settle,
                  review_deadline_at, economy,
                  created_at, updated_at`,
      [deliverableHash, JOB_REVIEW_TIMEOUT_HOURS, JSON.stringify(deliveredEconomy), job.id],
    );

    res.json({
      job: buildPublicJob(updated),
      deliveryMessage: message,
      note: 'Delivery recorded. Client review and complete are still required before payout is released.',
      paymentRule: 'deliver_does_not_release_payout',
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports._buildPublicJobDeliveryMessage = buildPublicJobDeliveryMessage;
module.exports._buildPublicJobApplicationMessage = buildPublicJobApplicationMessage;
module.exports._buildPublicJobDisputeMessage = buildPublicJobDisputeMessage;