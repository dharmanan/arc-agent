'use strict';

const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
process.env.NODE_ENV = 'production';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);

const { Wallet } = require('ethers');
const db = require('../src/db');
const { signToken } = require('../src/middleware/auth');
const {
  _buildPublicJobApplicationMessage,
  _buildPublicJobDeliveryMessage,
  _buildPublicJobDisputeMessage,
} = require('../src/routes/publicJobs');
const { pruneExpiredJobs } = require('../src/services/jobRetentionService');

const DEFAULT_BASE_URL = String(
  process.env.JOBS_SMOKE_BASE_URL
    || process.env.BACKEND_URL
    || 'https://backend-production-597c.up.railway.app',
).replace(/\/+$/, '');
const SMOKE_PREFIX = 'jobs-smoke';

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--base-url') {
      options.baseUrl = String(argv[index + 1] || options.baseUrl).replace(/\/+$/, '');
      index += 1;
      continue;
    }

    if (arg === '--verbose') {
      options.verbose = true;
    }
  }

  return options;
}

function ensure(condition, message, extra = null) {
  if (!condition) {
    const error = new Error(message);
    if (extra) error.extra = extra;
    throw error;
  }
}

async function requestJson(baseUrl, method, routePath, token = null, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${method} ${routePath} failed with ${response.status}: ${data.error || response.statusText}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function runStep(steps, label, fn) {
  const startedAt = Date.now();

  try {
    const detail = await fn();
    steps.push({ label, ok: true, durationMs: Date.now() - startedAt, detail });
    return detail;
  } catch (error) {
    steps.push({
      label,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error.message,
      status: error.status || null,
      data: error.data || error.extra || null,
    });
    throw error;
  }
}

async function createSmokeClient(label, artifacts) {
  const wallet = Wallet.createRandom();
  const ownerAddress = wallet.address.toLowerCase();
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  const { rows: [user] } = await db.query(
    `INSERT INTO users (owner_address)
     VALUES ($1)
     RETURNING id`,
    [ownerAddress],
  );
  const { rows: [agent] } = await db.query(
    `INSERT INTO agents (user_id, name, wallet_address, passkey_enabled, reputation_enabled)
     VALUES ($1, $2, $3, FALSE, TRUE)
     RETURNING id, wallet_address`,
    [user.id, `${SMOKE_PREFIX}-${label}-${stamp}`, ownerAddress],
  );

  artifacts.userIds.push(user.id);
  artifacts.agentIds.push(agent.id);

  return {
    userId: user.id,
    agentId: agent.id,
    ownerAddress,
    token: signToken(user.id, ownerAddress),
  };
}

async function cleanupArtifacts(artifacts) {
  const jobIds = [...new Set(artifacts.jobIds)];
  const agentIds = [...new Set(artifacts.agentIds)];
  const userIds = [...new Set(artifacts.userIds)];

  if (jobIds.length) {
    await db.query(
      `DELETE FROM agentic_payment_events
        WHERE reference_type = 'job'
          AND reference_id = ANY($1::text[])`,
      [jobIds],
    ).catch(() => {});
  }

  if (agentIds.length) {
    await db.query(
      `DELETE FROM agent_reputation_events
        WHERE agent_id = ANY($1::uuid[])`,
      [agentIds],
    ).catch(() => {});
  }

  if (jobIds.length) {
    await db.query(
      `DELETE FROM agent_jobs
        WHERE id = ANY($1::uuid[])`,
      [jobIds],
    ).catch(() => {});
  }

  if (agentIds.length) {
    await db.query(
      `DELETE FROM agents
        WHERE id = ANY($1::uuid[])`,
      [agentIds],
    ).catch(() => {});
  }

  if (userIds.length) {
    await db.query(
      `DELETE FROM users
        WHERE id = ANY($1::uuid[])`,
      [userIds],
    ).catch(() => {});
  }
}

async function scenarioLockedProviderHappy(baseUrl, client, artifacts) {
  const steps = [];
  const provider = Wallet.createRandom();
  const deliverableHash = `ipfs://${SMOKE_PREFIX}-locked-happy-deliverable`;

  const created = await runStep(steps, 'client.createLockedJob', async () => {
    const data = await requestJson(baseUrl, 'POST', `/api/agents/${client.agentId}/jobs`, client.token, {
      providerAddress: provider.address,
      amountUsdc: 1.11,
      description: `${SMOKE_PREFIX} locked provider happy path`,
    });

    ensure(data.job?.status === 'funded', 'locked provider job did not start funded', data);
    artifacts.jobIds.push(data.job.id);
    return { jobId: data.job.id, status: data.job.status };
  });

  await runStep(steps, 'client.listJobs', async () => {
    const data = await requestJson(baseUrl, 'GET', `/api/agents/${client.agentId}/jobs`, client.token);
    const job = (data.jobs || []).find((entry) => entry.id === created.jobId);
    ensure(job, 'locked provider job missing from client list', data);
    return { found: true, status: job.status };
  });

  await runStep(steps, 'client.getJob', async () => {
    const data = await requestJson(baseUrl, 'GET', `/api/agents/${client.agentId}/jobs/${created.jobId}`, client.token);
    ensure(data.id === created.jobId, 'locked provider job detail mismatch', data);
    return { status: data.status };
  });

  await runStep(steps, 'public.boardHasLockedJob', async () => {
    const data = await requestJson(baseUrl, 'GET', '/api/jobs/public/board');
    const job = (data.jobs || []).find((entry) => entry.id === created.jobId);
    ensure(job, 'locked provider job missing from public board', data);
    ensure(job.boardMode === 'locked_provider', 'expected locked provider board mode', job);
    return { boardMode: job.boardMode, status: job.status };
  });

  await runStep(steps, 'public.getLockedJob', async () => {
    const data = await requestJson(baseUrl, 'GET', `/api/jobs/public/${created.jobId}`);
    ensure(data.job?.id === created.jobId, 'locked provider public detail mismatch', data);
    return { status: data.job.status, deliveryMode: data.job.deliveryMode };
  });

  await runStep(steps, 'provider.publicDeliver', async () => {
    const signature = await provider.signMessage(_buildPublicJobDeliveryMessage({
      jobId: created.jobId,
      providerAddress: provider.address,
      deliverableHash,
    }));

    const data = await requestJson(baseUrl, 'POST', `/api/jobs/public/${created.jobId}/deliver`, null, {
      providerAddress: provider.address,
      deliverableHash,
      signature,
    });

    ensure(data.job?.status === 'delivered', 'public delivery did not move job to delivered', data);
    ensure(data.job?.reviewDeadlineAt, 'public delivery did not set review deadline', data);
    return { status: data.job.status, reviewDeadlineAt: data.job.reviewDeadlineAt };
  });

  await runStep(steps, 'client.completeJob', async () => {
    const data = await requestJson(baseUrl, 'PUT', `/api/agents/${client.agentId}/jobs/${created.jobId}/complete`, client.token, {});
    ensure(data.status === 'completed', 'client complete did not finish the locked provider job', data);
    return { status: data.status };
  });

  return { scenario: 'locked_provider_happy', steps };
}

async function scenarioPreDeliveryCancel(baseUrl, client, artifacts) {
  const steps = [];
  const provider = Wallet.createRandom();

  const created = await runStep(steps, 'client.createPreDeliveryCancelJob', async () => {
    const data = await requestJson(baseUrl, 'POST', `/api/agents/${client.agentId}/jobs`, client.token, {
      providerAddress: provider.address,
      amountUsdc: 1.2,
      description: `${SMOKE_PREFIX} pre-delivery cancel path`,
    });

    ensure(data.job?.status === 'funded', 'pre-delivery cancel job did not start funded', data);
    artifacts.jobIds.push(data.job.id);
    return { jobId: data.job.id, status: data.job.status };
  });

  await runStep(steps, 'client.cancelBeforeDelivery', async () => {
    const data = await requestJson(baseUrl, 'PUT', `/api/agents/${client.agentId}/jobs/${created.jobId}/cancel`, client.token, {});
    ensure(data.status === 'cancelled', 'cancel route did not finalize funded job as cancelled', data);
    return { status: data.status };
  });

  return { scenario: 'pre_delivery_cancel', steps };
}

async function scenarioLockedProviderDisputeReject(baseUrl, client, artifacts) {
  const steps = [];
  const provider = Wallet.createRandom();
  const deliverableHash = `ipfs://${SMOKE_PREFIX}-locked-dispute-deliverable`;
  const disputeReason = 'Delivered the exact brief with sources, but client review is stalled.';

  const created = await runStep(steps, 'client.createLockedDisputeJob', async () => {
    const data = await requestJson(baseUrl, 'POST', `/api/agents/${client.agentId}/jobs`, client.token, {
      providerAddress: provider.address,
      amountUsdc: 1.22,
      description: `${SMOKE_PREFIX} locked provider dispute path`,
    });

    ensure(data.job?.status === 'funded', 'locked dispute job did not start funded', data);
    artifacts.jobIds.push(data.job.id);
    return { jobId: data.job.id, status: data.job.status };
  });

  await runStep(steps, 'provider.publicDeliverForDispute', async () => {
    const signature = await provider.signMessage(_buildPublicJobDeliveryMessage({
      jobId: created.jobId,
      providerAddress: provider.address,
      deliverableHash,
    }));

    const data = await requestJson(baseUrl, 'POST', `/api/jobs/public/${created.jobId}/deliver`, null, {
      providerAddress: provider.address,
      deliverableHash,
      signature,
    });

    ensure(data.job?.status === 'delivered', 'dispute path delivery failed', data);
    return { status: data.job.status, reviewDeadlineAt: data.job.reviewDeadlineAt };
  });

  await runStep(steps, 'provider.raiseDispute', async () => {
    const signature = await provider.signMessage(_buildPublicJobDisputeMessage({
      jobId: created.jobId,
      providerAddress: provider.address,
      reason: disputeReason,
    }));

    const data = await requestJson(baseUrl, 'POST', `/api/jobs/public/${created.jobId}/dispute`, null, {
      providerAddress: provider.address,
      reason: disputeReason,
      signature,
    });

    ensure(data.job?.reviewPolicy?.disputeState === 'raised', 'provider dispute was not recorded', data);
    return {
      disputeState: data.job.reviewPolicy.disputeState,
      disputeReason: data.job.reviewPolicy.disputeReason,
    };
  });

  await runStep(steps, 'client.getDisputedJob', async () => {
    const data = await requestJson(baseUrl, 'GET', `/api/agents/${client.agentId}/jobs/${created.jobId}`, client.token);
    ensure(data.economy?.reviewPolicy?.disputeState === 'raised', 'client detail did not expose dispute state', data);
    return { disputeState: data.economy.reviewPolicy.disputeState };
  });

  await runStep(steps, 'client.rejectDisputedJob', async () => {
    const data = await requestJson(baseUrl, 'PUT', `/api/agents/${client.agentId}/jobs/${created.jobId}/reject`, client.token, {});
    ensure(data.status === 'rejected', 'client reject did not finalize disputed job', data);
    return { status: data.status };
  });

  return { scenario: 'locked_provider_dispute_reject', steps };
}

async function scenarioOpenApplications(baseUrl, client, artifacts) {
  const steps = [];
  const applicant = Wallet.createRandom();
  const deliverableHash = `ipfs://${SMOKE_PREFIX}-open-app-deliverable`;
  const applicationNote = 'I will return a markdown brief with sources and timing notes.';

  const created = await runStep(steps, 'client.createOpenApplicationJob', async () => {
    const data = await requestJson(baseUrl, 'POST', `/api/agents/${client.agentId}/jobs`, client.token, {
      amountUsdc: 1.33,
      description: `${SMOKE_PREFIX} open application path`,
      acceptingApplications: true,
    });

    ensure(data.job?.status === 'funded', 'open application job did not start funded', data);
    ensure(data.job?.provider_address == null, 'open application job should not have a locked provider', data);
    artifacts.jobIds.push(data.job.id);
    return { jobId: data.job.id, status: data.job.status };
  });

  await runStep(steps, 'public.boardHasOpenApplicationJob', async () => {
    const data = await requestJson(baseUrl, 'GET', '/api/jobs/public/board');
    const job = (data.jobs || []).find((entry) => entry.id === created.jobId);
    ensure(job, 'open application job missing from public board', data);
    ensure(job.boardMode === 'open_applications', 'expected open application board mode', job);
    return { boardMode: job.boardMode, applicationsOpen: job.applicationsOpen };
  });

  await runStep(steps, 'provider.applyWithWallet', async () => {
    const signature = await applicant.signMessage(_buildPublicJobApplicationMessage({
      jobId: created.jobId,
      applicantAddress: applicant.address,
      note: applicationNote,
    }));

    const data = await requestJson(baseUrl, 'POST', `/api/jobs/public/${created.jobId}/apply`, null, {
      applicantAddress: applicant.address,
      note: applicationNote,
      signature,
    });

    ensure(data.job?.applicationCount >= 1, 'application did not increment application count', data);
    return { applicationCount: data.job.applicationCount };
  });

  await runStep(steps, 'client.seesApplication', async () => {
    const data = await requestJson(baseUrl, 'GET', `/api/agents/${client.agentId}/jobs/${created.jobId}`, client.token);
    ensure((data.economy?.applications || []).some((entry) => entry.applicantAddress.toLowerCase() === applicant.address.toLowerCase()), 'client detail did not expose the wallet application', data);
    return { applications: data.economy.applications.length };
  });

  await runStep(steps, 'client.assignProvider', async () => {
    const data = await requestJson(baseUrl, 'PUT', `/api/agents/${client.agentId}/jobs/${created.jobId}/assign-provider`, client.token, {
      providerAddress: applicant.address,
    });

    ensure(String(data.job?.provider_address || '').toLowerCase() === applicant.address.toLowerCase(), 'assign-provider did not lock the applicant wallet', data);
    return { providerAddress: data.job.provider_address };
  });

  await runStep(steps, 'assignedProvider.publicDeliver', async () => {
    const signature = await applicant.signMessage(_buildPublicJobDeliveryMessage({
      jobId: created.jobId,
      providerAddress: applicant.address,
      deliverableHash,
    }));

    const data = await requestJson(baseUrl, 'POST', `/api/jobs/public/${created.jobId}/deliver`, null, {
      providerAddress: applicant.address,
      deliverableHash,
      signature,
    });

    ensure(data.job?.status === 'delivered', 'assigned provider could not deliver open application job', data);
    return { status: data.job.status, reviewDeadlineAt: data.job.reviewDeadlineAt };
  });

  await runStep(steps, 'client.completeOpenApplicationJob', async () => {
    const data = await requestJson(baseUrl, 'PUT', `/api/agents/${client.agentId}/jobs/${created.jobId}/complete`, client.token, {});
    ensure(data.status === 'completed', 'client complete did not finish open application job', data);
    return { status: data.status };
  });

  return { scenario: 'open_applications_flow', steps };
}

async function scenarioOwnerDeliverFlow(baseUrl, client, artifacts) {
  const steps = [];
  const provider = Wallet.createRandom();
  const deliverableHash = `ipfs://${SMOKE_PREFIX}-owner-deliver`;

  const created = await runStep(steps, 'client.createOwnerDeliverJob', async () => {
    const data = await requestJson(baseUrl, 'POST', `/api/agents/${client.agentId}/jobs`, client.token, {
      providerAddress: provider.address,
      amountUsdc: 1.44,
      description: `${SMOKE_PREFIX} owner deliver route coverage`,
    });

    ensure(data.job?.status === 'funded', 'owner deliver job did not start funded', data);
    artifacts.jobIds.push(data.job.id);
    return { jobId: data.job.id };
  });

  await runStep(steps, 'client.authDeliver', async () => {
    const data = await requestJson(baseUrl, 'PUT', `/api/agents/${client.agentId}/jobs/${created.jobId}/deliver`, client.token, {
      deliverableHash,
    });

    ensure(data.status === 'delivered', 'authenticated deliver route did not move job to delivered', data);
    ensure(data.review_deadline_at, 'authenticated deliver route did not set review deadline', data);
    return { status: data.status, reviewDeadlineAt: data.review_deadline_at };
  });

  await runStep(steps, 'client.completeOwnerDeliveredJob', async () => {
    const data = await requestJson(baseUrl, 'PUT', `/api/agents/${client.agentId}/jobs/${created.jobId}/complete`, client.token, {});
    ensure(data.status === 'completed', 'owner deliver scenario did not complete', data);
    return { status: data.status };
  });

  return { scenario: 'owner_deliver_route', steps };
}

async function scenarioTimeoutCleanup(baseUrl, client, artifacts) {
  const steps = [];
  const provider = Wallet.createRandom();
  const deliverableHash = `ipfs://${SMOKE_PREFIX}-timeout-deliverable`;

  const created = await runStep(steps, 'client.createTimeoutJob', async () => {
    const data = await requestJson(baseUrl, 'POST', `/api/agents/${client.agentId}/jobs`, client.token, {
      providerAddress: provider.address,
      amountUsdc: 1.55,
      description: `${SMOKE_PREFIX} timeout cleanup path`,
    });

    ensure(data.job?.status === 'funded', 'timeout job did not start funded', data);
    artifacts.jobIds.push(data.job.id);
    return { jobId: data.job.id };
  });

  await runStep(steps, 'provider.deliverTimeoutJob', async () => {
    const signature = await provider.signMessage(_buildPublicJobDeliveryMessage({
      jobId: created.jobId,
      providerAddress: provider.address,
      deliverableHash,
    }));

    const data = await requestJson(baseUrl, 'POST', `/api/jobs/public/${created.jobId}/deliver`, null, {
      providerAddress: provider.address,
      deliverableHash,
      signature,
    });

    ensure(data.job?.status === 'delivered', 'timeout job delivery failed', data);
    return { status: data.job.status, reviewDeadlineAt: data.job.reviewDeadlineAt };
  });

  const beforePenaltyCount = await runStep(steps, 'db.readTimeoutPenaltyBaseline', async () => {
    const { rows: [row] } = await db.query(
      `SELECT COUNT(*)::int AS event_count
         FROM agent_reputation_events
        WHERE agent_id = $1
          AND event_type = 'JOB_REVIEW_TIMEOUT'`,
      [client.agentId],
    );

    return { eventCount: Number(row?.event_count || 0) };
  });

  await runStep(steps, 'db.backdateReviewDeadline', async () => {
    await db.query(
      `UPDATE agent_jobs
          SET review_deadline_at = NOW() - INTERVAL '5 minutes'
        WHERE id = $1`,
      [created.jobId],
    );
    return { reviewDeadlineForcedPast: true };
  });

  await runStep(steps, 'service.pruneExpiredJobs', async () => {
    const result = await pruneExpiredJobs();
    ensure(result.deletedCount >= 1, 'pruneExpiredJobs did not delete any expired job');
    return result;
  });

  await runStep(steps, 'db.confirmsTimeoutJobDeleted', async () => {
    const { rows } = await db.query(
      `SELECT id FROM agent_jobs WHERE id = $1 LIMIT 1`,
      [created.jobId],
    );
    ensure(rows.length === 0, 'timeout job still exists after prune', { jobId: created.jobId });
    return { deleted: true };
  });

  await runStep(steps, 'public.detailGoneAfterPrune', async () => {
    try {
      await requestJson(baseUrl, 'GET', `/api/jobs/public/${created.jobId}`);
      throw new Error('timeout job was still publicly reachable after prune');
    } catch (error) {
      ensure(error.status === 404, 'timeout job should return 404 after prune', { status: error.status, data: error.data });
      return { status: error.status };
    }
  });

  await runStep(steps, 'db.recordsTimeoutPenalty', async () => {
    const { rows: [row] } = await db.query(
      `SELECT COUNT(*)::int AS event_count
         FROM agent_reputation_events
        WHERE agent_id = $1
          AND event_type = 'JOB_REVIEW_TIMEOUT'`,
      [client.agentId],
    );

    const eventCount = Number(row?.event_count || 0);
    ensure(eventCount === beforePenaltyCount.eventCount + 1, 'timeout penalty count did not increase by one', {
      before: beforePenaltyCount.eventCount,
      after: eventCount,
    });
    return { before: beforePenaltyCount.eventCount, after: eventCount };
  });

  await runStep(steps, 'db.recordsTimeoutAudit', async () => {
    const { rows: [row] } = await db.query(
      `SELECT event_type, status
         FROM agentic_payment_events
        WHERE reference_type = 'job'
          AND reference_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [created.jobId],
    );

    ensure(row?.event_type === 'job_review_timeout', 'timeout audit row missing', row);
    return { eventType: row.event_type, status: row.status };
  });

  return { scenario: 'timeout_cleanup', steps };
}

async function main() {
  const options = parseArgs();
  const artifacts = {
    userIds: [],
    agentIds: [],
    jobIds: [],
  };

  const report = {
    baseUrl: options.baseUrl,
    startedAt: new Date().toISOString(),
    scenarios: [],
  };

  try {
    const client = await createSmokeClient('client', artifacts);
    report.client = {
      agentId: client.agentId,
      ownerAddress: client.ownerAddress,
    };

    report.scenarios.push(await scenarioLockedProviderHappy(options.baseUrl, client, artifacts));
    report.scenarios.push(await scenarioPreDeliveryCancel(options.baseUrl, client, artifacts));
    report.scenarios.push(await scenarioLockedProviderDisputeReject(options.baseUrl, client, artifacts));
    report.scenarios.push(await scenarioOpenApplications(options.baseUrl, client, artifacts));
    report.scenarios.push(await scenarioOwnerDeliverFlow(options.baseUrl, client, artifacts));
    report.scenarios.push(await scenarioTimeoutCleanup(options.baseUrl, client, artifacts));

    report.finishedAt = new Date().toISOString();
    report.status = 'passed';
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.status = 'failed';
    report.error = {
      message: error.message,
      status: error.status || null,
      data: error.data || error.extra || null,
    };
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    await cleanupArtifacts(artifacts);
  }
}

main().catch(async (error) => {
  console.error('[jobsE2ESmoke] fatal error:', error);
  process.exit(1);
});
