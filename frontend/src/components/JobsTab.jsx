import React, { useState, useEffect } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { useAgent } from '../providers/AgentProvider.jsx';
import { jobs as jobsApi } from '../lib/api.js';
import {
  Card, Button, Input, Alert, Spinner, SectionHeader
} from './ui/index.jsx';
import { Briefcase, Plus, CheckCircle, XCircle, Package, RefreshCw, ChevronDown, ChevronUp, Download, TerminalSquare } from 'lucide-react';

const STATUS_COLORS = {
  open:       'bg-blue-50 text-blue-700 border-blue-200',
  funded:     'bg-amber-50 text-amber-700 border-amber-200',
  delivered:  'bg-purple-50 text-purple-700 border-purple-200',
  completed:  'bg-green-50 text-green-700 border-green-200',
  rejected:   'bg-rose-50 text-rose-700 border-rose-200',
  cancelled:  'bg-red-50 text-red-700 border-red-200',
};

const ECONOMY_COLORS = {
  confirmed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  skipped: 'bg-amber-50 text-amber-700 border-amber-200',
  pending: 'bg-slate-100 text-slate-600 border-slate-200',
};

const JOB_TEMPLATES = [
  {
    id: 'x-memecoin-weekly',
    title: 'Top 10 X Memecoin Radar',
    amountUsdc: '6.00',
    category: 'Social',
    description: 'Find the 10 memecoins discussed most on X during the last 7 days. Return ticker, mention count, main narrative, three representative posts per coin and one short note on whether the attention looks organic or bot-amplified.',
    deliverable: 'Ranked list + post links + attention notes',
    note: 'Useful when you want fast social attention discovery instead of an Arc-native tool output.',
    sources: 'X search, social dashboards, public post links',
  },
  {
    id: 'dex-volume-leaderboard',
    title: 'Highest Volume DEX Coin',
    amountUsdc: '4.50',
    category: 'DEX Flow',
    description: 'Identify the highest-volume DEX venue in the requested time window, then report which coin or pair is trading most there. Return venue, pair, 24h volume, trade count, fee tier if relevant and one note on whether the move looks trend-following or rotation-driven.',
    deliverable: 'DEX venue summary + top pair table',
    note: 'Good for spotting where real trading attention is concentrated right now.',
    sources: 'DEX Screener, Dune, protocol analytics, public APIs',
  },
  {
    id: 'eth-whale-watch',
    title: 'ETH Whale Wallet Watch',
    amountUsdc: '7.00',
    category: 'Whales',
    description: 'Track the most notable recent ETH whale wallet movements. Return the top active wallets, transaction direction, asset mix, destination tags if known and one short interpretation of whether the flow looks like accumulation, distribution or rotation.',
    deliverable: 'Wallet watchlist + transaction summary',
    note: 'Best when you want recent on-chain behavior, not a static market summary.',
    sources: 'Etherscan, Nansen-style labels, Arkham, public on-chain dashboards',
  },
  {
    id: 'solana-launchpad-breakouts',
    title: 'Solana Launchpad Breakout Scan',
    amountUsdc: '5.50',
    category: 'Momentum',
    description: 'Scan the latest launchpad and meme-token activity on Solana. Return the fastest breakouts, launch time, liquidity, social traction and one warning flag for rugs, copied metadata or inorganic volume.',
    deliverable: 'Breakout shortlist + risk flags',
    note: 'Useful for catching very early momentum before it hits the broader feed.',
    sources: 'Pump.fun, Dexscreener, Birdeye, X',
  },
  {
    id: 'stablecoin-depeg-rumor-sweep',
    title: 'Stablecoin Depeg Rumor Sweep',
    amountUsdc: '4.00',
    category: 'Risk',
    description: 'Check whether any major stablecoin depeg rumor is spreading right now. Return the rumor source, price dislocation evidence, exchange or pool reaction and a short verdict on whether the story looks real, stale or overblown.',
    deliverable: 'Rumor summary + market reaction check',
    note: 'Good for fast risk triage before acting on social noise.',
    sources: 'X, CoinGecko, exchange charts, Curve or DEX pool views',
  },
];

const PUBLIC_JOB_PAID_EXAMPLE_URL = '/downloads/publicJobPaidIntakeExample.js';
const PUBLIC_JOB_PAID_HELPER_URL = '/downloads/arcOracleBuyerHelper.js';
const DOWNLOAD_LINK_CLASS = 'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-[#66D121]/40 hover:bg-arc-greenBg hover:text-arc-green';
const DEFAULT_PUBLIC_JOB_APPLY_NOTE = 'Short note about what the external agent will deliver';
const DEFAULT_PUBLIC_JOB_DELIVERABLE_HASH = 'https://example.com/deliverable';

function normalizePublicJobIntakeSummary(summary) {
  const paid = summary?.paid || {};

  return {
    legacy: {
      applicationMode: summary?.legacy?.applicationMode || 'wallet_signature',
      deliveryMode: summary?.legacy?.deliveryMode || 'wallet_signature',
    },
    paid: {
      configured: Boolean(paid.configured),
      paymentRail: paid.paymentRail || 'circle_gateway',
      paidIdentity: paid.paidIdentity || 'x402_payer',
      sellerAddress: paid.sellerAddress || null,
      applyFeeUsdc: Number(paid.applyFeeUsdc || 0),
      deliverFeeUsdc: Number(paid.deliverFeeUsdc || 0),
      applyPath: paid.applyPath || '/api/jobs/public/:jobId/apply-paid',
      deliverPath: paid.deliverPath || '/api/jobs/public/:jobId/deliver-paid',
    },
  };
}

function getPublicApiBaseUrl() {
  if (typeof window === 'undefined') return 'https://arcmachina.xyz/api';

  return new URL(import.meta.env.VITE_API_URL || '/api', window.location.origin)
    .toString()
    .replace(/\/$/, '');
}

function buildPublicJobCurlCommand({ jobId, action, note, deliverableHash }) {
  const endpoint = action === 'deliver'
    ? `/jobs/public/${jobId}/deliver-paid`
    : `/jobs/public/${jobId}/apply-paid`;
  const payload = action === 'deliver'
    ? { deliverableHash: deliverableHash || DEFAULT_PUBLIC_JOB_DELIVERABLE_HASH }
    : { note: note || DEFAULT_PUBLIC_JOB_APPLY_NOTE };
  const escapedBody = JSON.stringify(payload).replace(/"/g, '\\"');

  return [
    `curl -i -X POST "${getPublicApiBaseUrl()}${endpoint}"`,
    '-H "Content-Type: application/json"',
    `-d "${escapedBody}"`,
  ].join(' \\\n  ');
}

async function copyToClipboard(value) {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('Clipboard is not available in this browser');
  }

  await navigator.clipboard.writeText(value);
}

function getJobCreateFeeSummary(summary) {
  if (!summary) {
    return {
      title: 'Fee rail unknown',
      body: 'Refresh this page to load the current job fee rail state.',
      tone: 'border-slate-200 bg-slate-50 text-slate-600',
    };
  }

  if (summary.createFeeUsdc <= 0) {
    return {
      title: 'No extra create fee',
      body: 'Creating a job only records the escrow or local lifecycle right now. No separate Gateway fee is configured.',
      tone: 'border-slate-200 bg-slate-50 text-slate-600',
    };
  }

  if (summary.dryRun) {
    return {
      title: `${summary.createFeeUsdc} USDC fee in dry-run`,
      body: 'The Gateway fee path is configured, but this deployment still simulates settlement instead of charging it live.',
      tone: 'border-amber-200 bg-amber-50 text-amber-800',
    };
  }

  if (!summary.configured) {
    return {
      title: `${summary.createFeeUsdc} USDC fee blocked`,
      body: 'A seller address is missing, so the job create fee cannot settle yet even though the amount is defined.',
      tone: 'border-red-200 bg-red-50 text-red-700',
    };
  }

  return {
    title: `${summary.createFeeUsdc} USDC create fee`,
    body: 'Creating a job will try to settle the Gateway service fee and then keep the funded -> delivered -> completed workflow on the job rail.',
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  };
}

function normalizeJob(job) {
  const applications = Array.isArray(job.applications)
    ? job.applications
    : Array.isArray(job.economy?.applications)
      ? job.economy.applications
      : [];
  const providerAddress = job.providerAddress || job.provider_address || null;
  const applicationsOpen = Boolean(job.applicationsOpen ?? job.economy?.applicationsOpen ?? false);

  return {
    ...job,
    agentId: job.agentId || job.agent_id || null,
    jobIdOnchain: job.jobIdOnchain || job.job_id_onchain || null,
    clientAddress: job.clientAddress || job.client_address || null,
    providerAddress,
    amountUsdc: Number(job.amountUsdc ?? job.amount_usdc ?? 0),
    deliverableHash: job.deliverableHash || job.deliverable_hash || null,
    txHashCreate: job.txHashCreate || job.tx_hash_create || null,
    txHashSettle: job.txHashSettle || job.tx_hash_settle || null,
    reviewDeadlineAt: job.reviewDeadlineAt || job.review_deadline_at || null,
    createdAt: job.createdAt || job.created_at || null,
    updatedAt: job.updatedAt || job.updated_at || null,
    reviewRequired: Boolean(job.reviewRequired ?? job.status === 'delivered'),
    payoutBlocked: Boolean(job.payoutBlocked ?? job.status !== 'completed'),
    applicationsOpen,
    boardMode: job.boardMode || (applicationsOpen && !providerAddress ? 'open_applications' : 'locked_provider'),
    applicationCount: Number(job.applicationCount ?? applications.length ?? 0),
    applications,
    reviewPolicy: job.reviewPolicy || job.economy?.reviewPolicy || null,
    economy: job.economy || {},
  };
}

function addressesEqual(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function shortenAddress(value) {
  if (!value) return '—';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function getJobPreviewText(value, maxLength = 88) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Untitled job';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatUsdc(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return String(value || '0');
  return numeric.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

function buildPublicJobDeliveryMessage({ jobId, providerAddress, deliverableHash }) {
  return [
    'Arc Machina Public Job Delivery',
    `job:${jobId}`,
    `provider:${String(providerAddress || '').trim()}`,
    `deliverable:${String(deliverableHash || '').trim()}`,
  ].join('\n');
}

function buildPublicJobApplicationMessage({ jobId, applicantAddress, note }) {
  return [
    'Arc Machina Public Job Application',
    `job:${jobId}`,
    `applicant:${String(applicantAddress || '').trim()}`,
    `note:${String(note || '').trim()}`,
  ].join('\n');
}

function buildPublicJobDisputeMessage({ jobId, providerAddress, reason }) {
  return [
    'Arc Machina Public Job Dispute',
    `job:${jobId}`,
    `provider:${String(providerAddress || '').trim()}`,
    `reason:${String(reason || '').trim()}`,
  ].join('\n');
}

function formatDateTime(value) {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function getBoardModeBadge(job) {
  if (job.boardMode === 'open_applications') {
    return {
      label: 'Open applications',
      tone: 'bg-blue-50 text-blue-700 border-blue-200',
      description: 'Anyone can apply with a signed wallet note until the client assigns a provider.',
    };
  }

  return {
    label: 'Locked provider',
    tone: 'bg-amber-50 text-amber-700 border-amber-200',
    description: 'Only the configured provider wallet can deliver or raise a dispute.',
  };
}

function getReviewStatusCard(job) {
  if (job.status !== 'delivered') {
    return null;
  }

  const deadlineLabel = formatDateTime(job.reviewDeadlineAt);

  if (job.reviewPolicy?.disputeState === 'raised') {
    return {
      title: 'Provider dispute is raised',
      body: `The provider says the brief was met. The client still has to resolve this by ${deadlineLabel} or the job is deleted without payout and the client agent receives a review-timeout reputation penalty.`,
      tone: 'border-red-200 bg-red-50 text-red-700',
    };
  }

  return {
    title: '48-hour review SLA is active',
    body: `The client must complete before ${deadlineLabel}. If the client does nothing, the job is deleted without payout and the client agent receives a review-timeout reputation penalty.`,
    tone: 'border-amber-200 bg-amber-50 text-amber-800',
  };
}

function getJobSettlementMessage(job) {
  const reviewNote = job.reviewPolicy?.note || 'Client review is still required before completion.';

  if (job.status === 'funded' || job.status === 'open') {
    if (job.applicationsOpen && !job.providerAddress) {
      return 'This job is still collecting open applications. Any wallet can apply until the client assigns one provider.';
    }

    return 'A deliver step only moves the job into review. It does not release payment, and the 48-hour client review SLA starts only after delivery is recorded.';
  }

  if (job.status === 'delivered') {
    return `${reviewNote} The client must review the result and either mark the job complete or reject it before payout is released. If the deadline passes, the job is deleted without payout and the client agent takes a review-timeout reputation penalty.`;
  }

  if (job.status === 'completed') {
    return 'Client review passed and the payout rail reached its final completed state.';
  }

  if (job.status === 'rejected') {
    return 'Client reviewed the delivered result and rejected it. This job is closed without payout.';
  }

  if (job.status === 'cancelled') {
    return 'This job was cancelled and will not move through payout.';
  }

  return 'Inspect the job details to confirm which side still needs to act.';
}

function StatusBadge({ status }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${STATUS_COLORS[status] || 'bg-slate-100 text-slate-500 border-slate-200'}`}>
      {status}
    </span>
  );
}

function getJobEconomyBadge(job) {
  const createFee = job.economy?.createFee;
  if (!createFee) {
    return {
      label: 'Escrow only',
      tone: ECONOMY_COLORS.pending,
    };
  }

  if (createFee.status === 'confirmed') {
    return {
      label: 'Gateway fee settled',
      tone: ECONOMY_COLORS.confirmed,
    };
  }

  if (createFee.status === 'failed') {
    return {
      label: 'Gateway fee failed',
      tone: ECONOMY_COLORS.failed,
    };
  }

  if (createFee.reason === 'dry_run') {
    return {
      label: 'Gateway fee dry-run',
      tone: ECONOMY_COLORS.skipped,
    };
  }

  return {
    label: 'Gateway fee skipped',
    tone: ECONOMY_COLORS.skipped,
  };
}

function JobsEconomyBanner({ summary }) {
  if (!summary) return null;

  const title = summary.createFeeUsdc > 0
    ? 'Escrow + Gateway fee'
    : 'Escrow only';
  const tone = summary.createFeeUsdc > 0
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : 'bg-slate-100 text-slate-600 border-slate-200';
  const description = summary.createFeeUsdc > 0
    ? (summary.dryRun
        ? `Jobs keep AgenticCommerce escrow and simulate a ${summary.createFeeUsdc} USDC Gateway service fee on create while DRY_RUN is enabled.`
        : `Jobs keep AgenticCommerce escrow and add a ${summary.createFeeUsdc} USDC Gateway service fee on create.`)
    : 'Jobs use the AgenticCommerce escrow flow only. No extra Gateway job fee is currently configured.';

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${tone}`}>
          {title}
        </span>
        {summary.sellerAddress && (
          <span className="text-[11px] text-slate-500 font-mono truncate max-w-full">
            {summary.sellerAddress}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-600">{description}</p>
    </div>
  );
}

function getJobsNextStep(jobList, onchainEnabled, hasAgent) {
  const applicationJob = jobList.find(job => job.applicationsOpen && !job.providerAddress);
  if (applicationJob) {
    return applicationJob.applicationCount > 0
      ? 'Client should review the incoming applications and assign one provider wallet next.'
      : 'Applicants can now send a short signed application from the public board.';
  }

  const fundedJob = jobList.find(job => job.status === 'funded');
  if (fundedJob) {
    return 'Provider should submit a deliverable hash or URL next so the client can review the result.';
  }

  const deliveredJob = jobList.find(job => job.status === 'delivered');
  if (deliveredJob) {
    return 'Client should review the delivered work and either approve it or reject it.';
  }

  if (jobList.length === 0) {
    if (!hasAgent) {
      return 'Open jobs are public to everyone. Connect a client agent to create a new job or connect the provider wallet to deliver an existing one.';
    }

    return onchainEnabled
      ? 'Create the first job with a provider address, USDC amount and a clear deliverable.'
      : 'Create the first job now; the same funded -> delivered -> completed flow will be tracked locally until on-chain escrow is configured.';
  }

  return 'Open any job row to inspect the payout rail, Gateway fee state and the next actionable status.';
}

function JobsWorkflowGuide({ hasAgent, nextStep }) {
  return (
    <Card>
      <div className="space-y-3">
        <div>
          <SectionHeader className="mb-0">How To Read This Page</SectionHeader>
          <p className="mt-1 text-xs text-slate-500">
            The top section is public. The bottom section is only for the agent owner who created the job.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Top Section</p>
            <p className="mt-1 text-sm font-semibold text-slate-800">Public board</p>
            <p className="mt-1 text-xs text-slate-500">Everyone sees this. Jobs here are split into two groups: jobs anyone can apply to, and jobs already assigned to one provider wallet.</p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Bottom Section</p>
            <p className="mt-1 text-sm font-semibold text-slate-800">Your jobs</p>
            <p className="mt-1 text-xs text-slate-500">
              {hasAgent
                ? 'This is your private manager for jobs you created. Use it to choose an applicant, cancel before delivery, or approve or reject the result after delivery.'
                : 'This section appears only after you connect your own agent.'}
            </p>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-600">After Delivery</p>
            <p className="mt-1 text-sm font-semibold text-amber-900">48-hour review rule</p>
            <p className="mt-1 text-xs text-amber-800">Once a provider delivers, the client has 48 hours to approve or reject. If nothing happens, the job is deleted and no payout is released.</p>
          </div>
        </div>

        <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-500">Right Now</p>
          <p className="mt-1 text-sm font-semibold text-blue-900">Current next action</p>
          <p className="mt-1 text-xs text-blue-700">{nextStep}</p>
        </div>
      </div>
    </Card>
  );
}

function JobsTrustPanel({ hasAgent, onchainEnabled, jobEconomy, nextStep }) {
  const createFee = getJobCreateFeeSummary(jobEconomy);

  return (
    <Card>
      <div className="grid gap-3 md:grid-cols-3">
        <div className={`rounded-xl border px-4 py-3 text-xs ${hasAgent ? (onchainEnabled ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-800') : 'border-blue-200 bg-blue-50 text-blue-800'}`}>
          <p className="text-[11px] font-semibold uppercase tracking-wide">Mode</p>
          <p className="mt-1 text-sm font-semibold">{hasAgent ? (onchainEnabled ? 'On-chain escrow is active' : 'Offline tracking is active') : 'Public view-only mode'}</p>
          <p className="mt-1 leading-5">
            {hasAgent
              ? (onchainEnabled
                  ? 'Create and complete can touch the live AgenticCommerce rail, so the client agent wallet may need Arc gas in addition to the job amount.'
                  : 'The same funded -> delivered -> completed statuses stay visible here, but no escrow transaction is sent until the contract address is configured.')
              : 'Public jobs stay visible without login. Connect the client agent only if you want to create jobs or release payout after review.'}
          </p>
        </div>

        <div className={`rounded-xl border px-4 py-3 text-xs ${createFee.tone}`}>
          <p className="text-[11px] font-semibold uppercase tracking-wide">Create Fee</p>
          <p className="mt-1 text-sm font-semibold">{createFee.title}</p>
          <p className="mt-1 leading-5">{createFee.body}</p>
        </div>

        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-500">Review And Payout</p>
          <p className="mt-1 text-sm font-semibold text-blue-900">Delivery does not auto-pay</p>
          <p className="mt-1 leading-5">The client still decides whether the deliverable is correct. Payment stays blocked until the client reviews the result and marks the job complete. If the client stalls for more than 48 hours after delivery, the job is deleted and the client agent gets a review-timeout penalty. Current next step: {nextStep}</p>
        </div>
      </div>
    </Card>
  );
}

function JobTemplateLibrary({ onUseTemplate }) {
  return (
    <Card>
      <div className="space-y-3">
        <div>
          <SectionHeader className="mb-0">Example Jobs</SectionHeader>
          <p className="mt-1 text-xs text-slate-500">
            These templates are intentionally broader than the built-in Arc tools. They prefill the amount and description only; you still choose the provider wallet and the actual researcher or operator can use any external sources needed.
          </p>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          {JOB_TEMPLATES.map(template => (
            <div key={template.id} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">{template.title}</p>
                  {template.category && (
                    <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{template.category}</p>
                  )}
                  <p className="mt-1 text-xs text-slate-500">{template.note}</p>
                </div>
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                  {template.amountUsdc} USDC
                </span>
              </div>

              <p className="mt-3 text-xs text-slate-600">{template.description}</p>
              <p className="mt-3 text-[11px] text-slate-500">
                <strong className="text-slate-700">Deliverable:</strong> {template.deliverable}
              </p>
              {template.sources && (
                <p className="mt-2 text-[11px] text-slate-500">
                  <strong className="text-slate-700">Suggested sources:</strong> {template.sources}
                </p>
              )}

              <button
                type="button"
                onClick={() => onUseTemplate(template)}
                className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
              >
                <Plus size={12} /> Use Example
              </button>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function JobRow({ job, agentId, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState('');
  const boardModeBadge = getBoardModeBadge(job);
  const reviewStatusCard = getReviewStatusCard(job);

  async function handleComplete() {
    setBusy(true); setErr('');
    try {
      await jobsApi.complete(agentId, job.id);
      onRefresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function handleReject() {
    if (!window.confirm('Reject this delivered result? This will close the job without payout.')) return;
    setBusy(true); setErr('');
    try {
      await jobsApi.reject(agentId, job.id);
      onRefresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function handleCancel() {
    if (!window.confirm('Cancel this job?')) return;
    setBusy(true); setErr('');
    try {
      await jobsApi.cancel(agentId, job.id);
      onRefresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function handleAssignProvider(providerAddress) {
    if (!providerAddress) return;
    setBusy(true); setErr('');
    try {
      await jobsApi.assignProvider(agentId, job.id, providerAddress);
      await onRefresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-slate-50 transition-colors"
      >
        <Briefcase size={14} className="text-[#66D121] shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="truncate text-sm text-slate-800" title={job.description}>{getJobPreviewText(job.description)}</p>
          {job.applicationsOpen && !job.providerAddress && (
            <p className="mt-0.5 text-[11px] text-blue-600">Open applications{job.applicationCount ? ` • ${job.applicationCount} received` : ''}</p>
          )}
          {!job.applicationsOpen && job.providerAddress && (
            <p className="mt-0.5 text-[11px] text-slate-500">Assigned provider: {shortenAddress(job.providerAddress)}</p>
          )}
        </div>
        <span className={`hidden sm:inline-flex text-[11px] px-2 py-0.5 rounded-full border font-medium ${boardModeBadge.tone}`}>
          {boardModeBadge.label}
        </span>
        {job.reviewPolicy?.disputeState === 'raised' && (
          <span className="hidden sm:inline-flex text-[11px] px-2 py-0.5 rounded-full border font-medium bg-red-50 text-red-700 border-red-200">
            Dispute raised
          </span>
        )}
        <StatusBadge status={job.status} />
        <span className="text-xs text-slate-500">{formatUsdc(job.amountUsdc)} USDC</span>
        {expanded ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-slate-100 space-y-2">
          {err && <Alert type="error">{err}</Alert>}

          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-700">
            <p className="font-semibold text-slate-900">What you can do here</p>
            <p className="mt-1 leading-5">
              {job.applicationsOpen && !job.providerAddress
                ? 'Review the incoming applications below and choose one provider wallet.'
                : job.status === 'funded'
                  ? 'Wait for the assigned provider to deliver, or cancel the job before delivery if needed.'
                  : job.status === 'delivered'
                    ? 'Review the result and either approve it or reject it before the 48-hour deadline.'
                    : job.status === 'completed'
                      ? 'This job is finished.'
                      : job.status === 'rejected'
                        ? 'You rejected the delivered result. This job is closed without payout.'
                      : 'This job is no longer active.'}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">What Needs To Be Delivered</p>
            <p className="mt-2 whitespace-pre-wrap break-words leading-6">{job.description}</p>
          </div>

          <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-800">
            <p className="font-semibold text-blue-900">What happens next</p>
            <p className="mt-1 leading-5">{getJobSettlementMessage(job)}</p>
          </div>

          {job.providerAddress && (
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-xs text-slate-600">
              Assigned provider: <span className="font-mono text-slate-700">{job.providerAddress}</span>
            </div>
          )}

          {job.deliverableHash && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-800">
              <p className="font-semibold text-emerald-900">Delivered Reference</p>
              {String(job.deliverableHash).startsWith('http://') || String(job.deliverableHash).startsWith('https://') ? (
                <a
                  href={job.deliverableHash}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block break-all font-mono text-emerald-700 underline underline-offset-2"
                >
                  {job.deliverableHash}
                </a>
              ) : (
                <p className="mt-1 break-all font-mono text-emerald-700">{job.deliverableHash}</p>
              )}
            </div>
          )}

          {reviewStatusCard && (
            <div className={`rounded-xl border px-3 py-3 text-xs ${reviewStatusCard.tone}`}>
              <p className="font-semibold">{reviewStatusCard.title}</p>
              <p className="mt-1 leading-5">{reviewStatusCard.body}</p>
            </div>
          )}

          {job.reviewPolicy?.disputeState === 'raised' && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700">
              <p className="font-semibold">Provider dispute note</p>
              <p className="mt-1 leading-5">{job.reviewPolicy.disputeReason || 'A dispute was raised by the provider.'}</p>
            </div>
          )}

          {job.applicationsOpen && !job.providerAddress && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-700 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-slate-800">Applications</p>
                <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500">
                  {job.applicationCount} applications
                </span>
              </div>

              {job.applications.length === 0 ? (
                <p className="text-slate-500">No one has applied yet. Public users can sign a short application note from the public board.</p>
              ) : (
                <div className="space-y-2">
                  {job.applications.map((application) => (
                    <div key={application.applicantAddress} className="rounded-lg border border-slate-200 bg-white px-3 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-mono text-[11px] text-slate-700">{application.applicantAddress}</p>
                          <p className="mt-1 text-slate-600 whitespace-pre-wrap break-words">{application.note}</p>
                        </div>
                        <Button size="sm" onClick={() => handleAssignProvider(application.applicantAddress)} disabled={busy}>
                          {busy ? <Spinner size={12} /> : <CheckCircle size={12} />}
                          Assign Provider
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 mt-3">
            {job.status === 'delivered' && (
              <>
                <Button size="sm" variant="success" onClick={handleComplete} disabled={busy}>
                  {busy ? <Spinner size={12} /> : <CheckCircle size={12} />}
                  Approve Result
                </Button>
                <Button size="sm" variant="danger" onClick={handleReject} disabled={busy}>
                  {busy ? <Spinner size={12} /> : <XCircle size={12} />}
                  Reject Result
                </Button>
              </>
            )}
            {(job.status === 'open' || job.status === 'funded') && (
              <Button size="sm" variant="danger" onClick={handleCancel} disabled={busy}>
                {busy ? <Spinner size={12} /> : <XCircle size={12} />}
                Cancel Job
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PublicJobRow({ job, walletAddress, signMessageAsync, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [success, setSuccess] = useState('');
  const [hashInput, setHashInput] = useState('');
  const [applicationNote, setApplicationNote] = useState('');
  const [disputeReason, setDisputeReason] = useState('');

  const providerMatches = addressesEqual(walletAddress, job.providerAddress);
  const publicIntake = normalizePublicJobIntakeSummary(job.publicIntake);
  const boardModeBadge = getBoardModeBadge(job);
  const reviewStatusCard = getReviewStatusCard(job);
  const viewerGuidance = job.applicationsOpen && !job.providerAddress
    ? (walletAddress
        ? {
            title: 'Your role here',
            body: 'You can apply to this job with the connected wallet. The client will choose one provider after reviewing applications.',
            tone: 'border-blue-200 bg-blue-50 text-blue-800',
          }
        : {
            title: 'Your role here',
            body: 'This job is open for applications. Connect any wallet, including an external agent wallet, to apply.',
            tone: 'border-slate-200 bg-slate-50 text-slate-700',
          })
    : providerMatches
      ? {
          title: 'Your role here',
          body: job.status === 'delivered'
            ? 'You are the assigned provider and the delivery is now under client review. You can raise a dispute below if the client stalls.'
            : 'You are the assigned provider. Deliver the result from this card when it is ready.',
          tone: 'border-emerald-200 bg-emerald-50 text-emerald-800',
        }
      : {
          title: 'Your role here',
          body: 'This job is view-only for your current wallet. Only the assigned provider wallet can act on it right now.',
          tone: 'border-slate-200 bg-slate-50 text-slate-700',
        };

  async function handlePublicDeliver() {
    if (!hashInput.trim() || !walletAddress) return;

    setBusy(true);
    setErr('');
    setSuccess('');

    try {
      const deliverableHash = hashInput.trim();
      const signature = await signMessageAsync({
        message: buildPublicJobDeliveryMessage({
          jobId: job.id,
          providerAddress: walletAddress,
          deliverableHash,
        }),
      });

      await jobsApi.publicDeliver(job.id, {
        providerAddress: walletAddress,
        deliverableHash,
        signature,
      });

      setHashInput('');
      setSuccess('Delivery recorded. The job is now waiting for client review and complete.');
      await onRefresh();
    } catch (e) {
      setErr(e.shortMessage || e.message || 'Unable to record delivery');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyPaidApplyPreview() {
    try {
      await copyToClipboard(buildPublicJobCurlCommand({
        jobId: job.id,
        action: 'apply',
        note: applicationNote.trim() || DEFAULT_PUBLIC_JOB_APPLY_NOTE,
      }));
      setErr('');
      setSuccess('Preview cURL copied. Run it first to receive the 402 challenge, then use the downloaded buyer script to pay with the external wallet.');
    } catch (e) {
      setSuccess('');
      setErr(e.message || 'Unable to copy preview command');
    }
  }

  async function handleCopyPaidDeliverPreview() {
    try {
      await copyToClipboard(buildPublicJobCurlCommand({
        jobId: job.id,
        action: 'deliver',
        deliverableHash: hashInput.trim() || DEFAULT_PUBLIC_JOB_DELIVERABLE_HASH,
      }));
      setErr('');
      setSuccess('Preview cURL copied. Run it first to receive the 402 challenge, then use the downloaded buyer script to pay from the assigned provider wallet.');
    } catch (e) {
      setSuccess('');
      setErr(e.message || 'Unable to copy preview command');
    }
  }

  async function handleApply() {
    if (!applicationNote.trim() || !walletAddress) return;

    setBusy(true);
    setErr('');
    setSuccess('');

    try {
      const note = applicationNote.trim();
      const signature = await signMessageAsync({
        message: buildPublicJobApplicationMessage({
          jobId: job.id,
          applicantAddress: walletAddress,
          note,
        }),
      });

      await jobsApi.publicApply(job.id, {
        applicantAddress: walletAddress,
        note,
        signature,
      });

      setApplicationNote('');
      setSuccess('Application recorded. The client can now review it and assign a provider wallet.');
      await onRefresh();
    } catch (e) {
      setErr(e.shortMessage || e.message || 'Unable to submit application');
    } finally {
      setBusy(false);
    }
  }

  async function handleDispute() {
    if (!disputeReason.trim() || !walletAddress) return;

    setBusy(true);
    setErr('');
    setSuccess('');

    try {
      const reason = disputeReason.trim();
      const signature = await signMessageAsync({
        message: buildPublicJobDisputeMessage({
          jobId: job.id,
          providerAddress: walletAddress,
          reason,
        }),
      });

      await jobsApi.publicDispute(job.id, {
        providerAddress: walletAddress,
        reason,
        signature,
      });

      setDisputeReason('');
      setSuccess('Dispute recorded. The client still has to resolve the job before the review deadline expires.');
      await onRefresh();
    } catch (e) {
      setErr(e.shortMessage || e.message || 'Unable to submit dispute');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-slate-50 transition-colors"
      >
        <Briefcase size={14} className="text-[#66D121] shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="truncate text-sm text-slate-800" title={job.description}>{getJobPreviewText(job.description)}</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {job.applicationsOpen && !job.providerAddress
              ? 'Anyone can apply here with a wallet signature.'
              : providerMatches
                ? (job.status === 'delivered' ? 'You delivered this job. It is waiting for client review.' : 'You are the assigned provider for this job.')
              : `Assigned provider: ${shortenAddress(job.providerAddress)}`}
          </p>
        </div>
        <span className={`hidden sm:inline-flex text-[11px] px-2 py-0.5 rounded-full border font-medium ${boardModeBadge.tone}`}>
          {boardModeBadge.label}
        </span>
        {job.applicationsOpen && !job.providerAddress && (
          <span className="hidden sm:inline-flex text-[11px] px-2 py-0.5 rounded-full border font-medium bg-slate-100 text-slate-600 border-slate-200">
            {job.applicationCount} applications
          </span>
        )}
        {job.reviewPolicy?.disputeState === 'raised' && (
          <span className="hidden sm:inline-flex text-[11px] px-2 py-0.5 rounded-full border font-medium bg-red-50 text-red-700 border-red-200">
            Dispute raised
          </span>
        )}
        <StatusBadge status={job.status} />
        <span className="text-xs text-slate-500">{formatUsdc(job.amountUsdc)} USDC</span>
        {expanded ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
      </button>

      {job.applicationsOpen && !job.providerAddress && !expanded && (
        <div className="border-t border-slate-100 bg-blue-50/70 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-blue-900">Open applications are live</p>
              <p className="mt-1 text-xs text-blue-700">
                {walletAddress
                  ? 'Use Apply Now to send a short signed application. If the client later assigns your wallet, the delivery form appears here in the same card.'
                  : 'Connect any wallet, then use Apply Now from this card. Delivery appears here only after your wallet is assigned.'}
              </p>
            </div>
            <Button size="sm" type="button" onClick={() => setExpanded(true)}>
              {walletAddress ? 'Apply Now' : 'Connect Wallet To Apply'}
            </Button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-slate-100 space-y-2">
          {err && <Alert type="error">{err}</Alert>}
          {success && <Alert type="success">{success}</Alert>}

          {job.applicationsOpen && !job.providerAddress && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-800 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-blue-900">Apply To This Job</p>
                  <p className="mt-1 leading-5">Write one short note about what you will deliver, then sign it with your wallet. Delivery is a later step that appears here only after the client assigns your wallet.</p>
                </div>
                <span className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-[11px] text-blue-700">
                  {job.applicationCount} applications so far
                </span>
              </div>

              <textarea
                className="w-full bg-white border border-blue-200 rounded-lg px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#66D121] resize-none"
                rows={3}
                maxLength={280}
                placeholder="Short application note: what you will deliver, format, and timing"
                value={applicationNote}
                onChange={e => setApplicationNote(e.target.value)}
              />

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={handleApply} disabled={busy || !walletAddress || !applicationNote.trim()}>
                  {busy ? <Spinner size={12} /> : <Plus size={12} />}
                  Apply With Wallet
                </Button>
                <Button size="sm" variant="outline" type="button" onClick={handleCopyPaidApplyPreview}>
                  <TerminalSquare size={12} />
                  Copy Paid Preview cURL
                </Button>
                {!walletAddress && <span className="text-[11px] text-blue-700">Connect a wallet to submit this application.</span>}
              </div>

              <p className="text-[11px] leading-5 text-blue-700">
                External x402 path: preview <span className="font-semibold">{publicIntake.paid.applyPath.replace(':jobId', job.id)}</span>, expect a 402 challenge, then pay it with the downloadable buyer script. The x402 payer becomes the applicant wallet. Current fee: <span className="font-semibold">{formatUsdc(publicIntake.paid.applyFeeUsdc)} USDC</span>.
              </p>
            </div>
          )}

          <div className={`rounded-xl border px-3 py-3 text-xs ${viewerGuidance.tone}`}>
            <p className="font-semibold">{viewerGuidance.title}</p>
            <p className="mt-1 leading-5">{viewerGuidance.body}</p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">What Needs To Be Delivered</p>
            <p className="mt-2 whitespace-pre-wrap break-words leading-6">{job.description}</p>
          </div>

          <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-800">
            <p className="font-semibold text-blue-900">What happens next</p>
            <p className="mt-1 leading-5">{getJobSettlementMessage(job)}</p>
          </div>

          {job.reviewDeadlineAt && (
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-xs text-slate-700">
              Review deadline: <span className="font-semibold text-slate-900">{formatDateTime(job.reviewDeadlineAt)}</span>
            </div>
          )}

          {job.deliverableHash && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-800">
              <p className="font-semibold text-emerald-900">Delivered Reference</p>
              {String(job.deliverableHash).startsWith('http://') || String(job.deliverableHash).startsWith('https://') ? (
                <a
                  href={job.deliverableHash}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block break-all font-mono text-emerald-700 underline underline-offset-2"
                >
                  {job.deliverableHash}
                </a>
              ) : (
                <p className="mt-1 break-all font-mono text-emerald-700">{job.deliverableHash}</p>
              )}
            </div>
          )}

          {reviewStatusCard && (
            <div className={`rounded-xl border px-3 py-3 text-xs ${reviewStatusCard.tone}`}>
              <p className="font-semibold">{reviewStatusCard.title}</p>
              <p className="mt-1 leading-5">{reviewStatusCard.body}</p>
            </div>
          )}

          {job.reviewPolicy?.disputeState === 'raised' && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700">
              <p className="font-semibold">Provider dispute note</p>
              <p className="mt-1 leading-5">{job.reviewPolicy.disputeReason || 'A dispute was raised by the provider.'}</p>
            </div>
          )}

          {job.status === 'funded' && providerMatches && !job.applicationsOpen && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2 items-center w-full">
                <Input
                  placeholder="Deliverable hash or URL"
                  value={hashInput}
                  onChange={e => setHashInput(e.target.value)}
                  className="flex-1 text-xs"
                />
                <Button size="sm" onClick={handlePublicDeliver} disabled={busy || !hashInput.trim()}>
                  {busy ? <Spinner size={12} /> : <Package size={12} />}
                  Deliver As Provider
                </Button>
                <Button size="sm" variant="outline" type="button" onClick={handleCopyPaidDeliverPreview}>
                  <TerminalSquare size={12} />
                  Copy Paid Preview cURL
                </Button>
              </div>

              <p className="text-[11px] leading-5 text-slate-500">
                External x402 path: preview <span className="font-semibold text-slate-700">{publicIntake.paid.deliverPath.replace(':jobId', job.id)}</span>, expect a 402 challenge, then pay it with the downloadable buyer script. The x402 payer must match the assigned provider wallet. Current fee: <span className="font-semibold text-slate-700">{formatUsdc(publicIntake.paid.deliverFeeUsdc)} USDC</span>.
              </p>
            </div>
          )}

          {job.status === 'delivered' && (
            <div className="space-y-2">
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
                Delivery is recorded, but payout is still blocked. The client must approve or reject the result before the SLA deadline.
              </div>

              {providerMatches && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700 space-y-3">
                  <div>
                    <p className="font-semibold text-red-800">Raise dispute if the client stalls</p>
                    <p className="mt-1 leading-5">Use this only when the brief was delivered correctly but the client is not responding. It does not release payout, but it stays visible to the client until the review deadline.</p>
                  </div>
                  <textarea
                    className="w-full bg-white border border-red-200 rounded-lg px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-red-400 resize-none"
                    rows={3}
                    maxLength={280}
                    placeholder="Short dispute note: what was delivered and why review is blocked"
                    value={disputeReason}
                    onChange={e => setDisputeReason(e.target.value)}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={handleDispute} disabled={busy || !disputeReason.trim()}>
                      {busy ? <Spinner size={12} /> : <XCircle size={12} />}
                      Raise Dispute
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function JobsTab() {
  const { agent } = useAgent();
  const { address: walletAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [jobList, setJobList]       = useState([]);
  const [publicJobList, setPublicJobList] = useState([]);
  const [publicIntakeSummary, setPublicIntakeSummary] = useState(() => normalizePublicJobIntakeSummary(null));
  const [loading, setLoading]       = useState(false);
  const [publicLoading, setPublicLoading] = useState(false);
  const [error, setError]           = useState('');
  const [publicError, setPublicError] = useState('');
  const [onchainEnabled, setOnchain] = useState(false);
  const [jobEconomy, setJobEconomy] = useState(null);

  // Create form
  const [showForm, setShowForm]     = useState(false);
  const [creating, setCreating]     = useState(false);
  const [createErr, setCreateErr]   = useState('');
  const [providerAddr, setProvider] = useState('');
  const [amount, setAmount]         = useState('');
  const [description, setDesc]      = useState('');
  const [acceptingApplications, setAcceptingApplications] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');

  async function loadPublicJobs() {
    setPublicLoading(true);
    setPublicError('');

    try {
      const data = await jobsApi.board({ limit: 40 });
      setPublicJobList((data.jobs || []).map(normalizeJob));
      setPublicIntakeSummary(normalizePublicJobIntakeSummary(data.publicIntake));
    } catch (e) {
      setPublicError(e.message);
    } finally {
      setPublicLoading(false);
    }
  }

  async function loadJobs() {
    if (!agent?.id) {
      setJobList([]);
      setOnchain(false);
      setJobEconomy(null);
      return;
    }

    setLoading(true); setError('');
    try {
      const data = await jobsApi.list(agent.id);
      setJobList((data.jobs || []).map(normalizeJob));
      setOnchain(!!data.onchainEnabled);
      setJobEconomy(data.jobEconomy || null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function refreshAll() {
    if (agent?.id) {
      await Promise.all([loadPublicJobs(), loadJobs()]);
      return;
    }

    await loadPublicJobs();
  }

  useEffect(() => { loadPublicJobs(); }, []);
  useEffect(() => { loadJobs(); }, [agent?.id]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!agent?.id) return;
    setCreating(true); setCreateErr('');
    try {
      await jobsApi.create(agent.id, {
        providerAddress: acceptingApplications ? undefined : providerAddr.trim() || undefined,
        amountUsdc:      parseFloat(amount),
        description:     description.trim(),
        acceptingApplications,
      });
      setProvider(''); setAmount(''); setDesc('');
      setAcceptingApplications(false);
      setSelectedTemplateId('');
      setShowForm(false);
      await refreshAll();
    } catch (e) { setCreateErr(e.message); }
    finally { setCreating(false); }
  }

  function handleUseTemplate(template) {
    setShowForm(true);
    setSelectedTemplateId(template.id);
    setAmount(template.amountUsdc);
    setDesc(template.description);
    setAcceptingApplications(false);
    setCreateErr('');
  }

  const hasAgent = Boolean(agent?.id);
  const isRefreshing = loading || publicLoading;
  const nextJobsStep = getJobsNextStep(publicJobList, onchainEnabled, hasAgent);
  const openApplicationJobs = publicJobList.filter(job => job.boardMode === 'open_applications');
  const lockedProviderJobs = publicJobList.filter(job => job.boardMode !== 'open_applications');

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Briefcase size={18} className="text-arc-accent" />
            <SectionHeader className="mb-0">Agent Jobs</SectionHeader>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded-full border font-medium bg-blue-50 text-blue-700 border-blue-200">
              Public board
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${onchainEnabled ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
              {hasAgent ? (onchainEnabled ? 'On-chain' : 'Offline mode') : 'View only'}
            </span>
            <Button size="sm" variant="ghost" onClick={refreshAll} disabled={isRefreshing}>
              <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
            </Button>
            {hasAgent && (
              <Button size="sm" onClick={() => setShowForm(v => !v)}>
                <Plus size={12} /> New Job
              </Button>
            )}
          </div>
        </div>

        {!hasAgent && (
          <p className="text-xs text-blue-700/80 mt-2">
            Everyone can inspect the public board here. Connect your own agent only if you want to create jobs or approve results.
          </p>
        )}

        {hasAgent && !onchainEnabled && (
          <p className="text-xs text-amber-700/80 mt-2">
            AGENTIC_COMMERCE_ADDRESS not set — jobs are stored locally only until the contract is deployed.
          </p>
        )}
      </Card>

      <Card>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <SectionHeader className="mb-0">Open Jobs Board</SectionHeader>
              <p className="mt-1 text-xs text-slate-500">
                Open and review-stage jobs stay at the top and remain visible to everyone. If you created a job yourself, it can appear here and again below in Your Jobs because the same job is both public and privately manageable by you.
              </p>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full border font-medium bg-slate-100 text-slate-600 border-slate-200">
              {publicJobList.length} live jobs
            </span>
          </div>

          {publicError && <Alert type="error">{publicError}</Alert>}

          {publicLoading && !publicJobList.length ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : publicJobList.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
              <p className="text-sm text-slate-500">No public jobs are live yet.</p>
              <p className="mt-2 text-xs text-slate-400">The first funded job created by any client agent will appear here for everyone.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-700">
                <p><span className="font-semibold text-slate-900">Humans and agent wallets both apply from this public board.</span> Open a card in Anyone Can Apply, write a short note, then use Apply With Wallet.</p>
              </div>

              <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 px-4 py-4 text-xs text-emerald-800">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-emerald-900">Headless paid intake is live</p>
                    <p className="mt-1 leading-5">
                      This page keeps the browser flow on wallet signatures. Outside agents can use the new x402 routes instead: preview the endpoint, receive the 402 challenge, then retry with the buyer script. The payer wallet becomes the applicant or provider identity.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] font-medium">
                    <span className="rounded-full border border-emerald-200 bg-white px-2 py-0.5 text-emerald-700">
                      Apply fee {formatUsdc(publicIntakeSummary.paid.applyFeeUsdc)} USDC
                    </span>
                    <span className="rounded-full border border-emerald-200 bg-white px-2 py-0.5 text-emerald-700">
                      Deliver fee {formatUsdc(publicIntakeSummary.paid.deliverFeeUsdc)} USDC
                    </span>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <a href={PUBLIC_JOB_PAID_EXAMPLE_URL} download className={DOWNLOAD_LINK_CLASS}>
                    <Download size={12} />
                    Download Buyer Example
                  </a>
                  <a href={PUBLIC_JOB_PAID_HELPER_URL} download className={DOWNLOAD_LINK_CLASS}>
                    <Download size={12} />
                    Download Buyer Helper
                  </a>
                </div>
              </div>

              <div className="rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-blue-900">Anyone Can Apply</p>
                    <p className="mt-1 text-xs text-blue-700">Use this group when the client is still looking for a provider. Humans and agent wallets both apply here from the job card, and delivery appears only after the client assigns one wallet.</p>
                  </div>
                  <span className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-[11px] font-medium text-blue-700">
                    {openApplicationJobs.length} jobs
                  </span>
                </div>
                <div className="mt-3 space-y-2">
                  {openApplicationJobs.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-blue-200 bg-white px-3 py-4 text-xs text-blue-700">
                      <p className="font-semibold text-blue-900">Manual apply and manual delivery both happen from the job card in this section.</p>
                      <p className="mt-1">There are no open-application jobs right now, so no apply or delivery controls are visible yet.</p>
                      <p className="mt-1">When a job appears here, open that card and apply first. If the client assigns your wallet, the same card switches to the delivery step.</p>
                    </div>
                  ) : openApplicationJobs.map(job => (
                    <PublicJobRow
                      key={job.id}
                      job={job}
                      walletAddress={walletAddress}
                      signMessageAsync={signMessageAsync}
                      onRefresh={refreshAll}
                    />
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-amber-900">Assigned To One Provider</p>
                    <p className="mt-1 text-xs text-amber-700">Use this group when the client has already chosen one provider wallet. Only that wallet can deliver the result.</p>
                  </div>
                  <span className="rounded-full border border-amber-200 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    {lockedProviderJobs.length} jobs
                  </span>
                </div>
                <div className="mt-3 space-y-2">
                  {lockedProviderJobs.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-amber-200 bg-white px-3 py-4 text-xs text-amber-700">
                      No jobs are currently locked to a provider wallet.
                    </div>
                  ) : lockedProviderJobs.map(job => (
                    <PublicJobRow
                      key={job.id}
                      job={job}
                      walletAddress={walletAddress}
                      signMessageAsync={signMessageAsync}
                      onRefresh={refreshAll}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      <JobsWorkflowGuide
        hasAgent={hasAgent}
        nextStep={nextJobsStep}
      />

      {/* Create form */}
      {hasAgent && showForm && (
        <Card>
          <SectionHeader>Create New Job</SectionHeader>
          {createErr && <Alert type="error" className="mb-3">{createErr}</Alert>}
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600 space-y-1.5">
              <p><strong className="text-slate-800">How to add a job:</strong> set the reward, describe the exact result you want, then either choose one provider now or open the job to applicants.</p>
              <p>Templates only prefill the reward and the brief. You can still edit everything before creating the job.</p>
              {selectedTemplateId && (
                <p className="text-slate-500">
                  Active example: <strong className="text-slate-700">{JOB_TEMPLATES.find(template => template.id === selectedTemplateId)?.title || 'Custom job'}</strong>
                </p>
              )}
              <p className="text-slate-500">After a provider delivers, you have 48 hours to approve or reject. If nothing happens, the job is deleted and no payout is released.</p>
            </div>
            <label className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700">
              <input
                type="checkbox"
                className="mt-1"
                checked={acceptingApplications}
                onChange={e => {
                  const checked = e.target.checked;
                  setAcceptingApplications(checked);
                  if (checked) setProvider('');
                }}
              />
              <span>
                <strong className="text-slate-800">Open applications before choosing provider</strong>
                <span className="block mt-1 text-xs text-slate-500">Enable this when you want any wallet, including an external agent wallet, to apply before you lock one provider.</span>
              </span>
            </label>
            {acceptingApplications ? (
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-800">
                Open application mode is on. This job will be posted without a locked provider, and any wallet will be able to apply from the public board.
              </div>
            ) : (
              <>
                <Input
                  label="Provider Address"
                  placeholder="0x..."
                  value={providerAddr}
                  onChange={e => setProvider(e.target.value)}
                  required
                />
                <p className="-mt-2 text-[11px] text-slate-500">Use the provider wallet that should deliver the result for this job.</p>
              </>
            )}
            <Input
              label="Amount (USDC)"
              type="number"
              placeholder="e.g. 5.00"
              min="0.000001"
              max="100000"
              step="0.000001"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              required
            />
            <div>
              <label className="block text-xs text-slate-500 mb-1">Description</label>
              <textarea
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#66D121] resize-none"
                rows={3}
                maxLength={500}
                placeholder="Describe the task or deliverable…"
                value={description}
                onChange={e => setDesc(e.target.value)}
                required
              />
              <p className="mt-1 text-[11px] text-slate-500">Ask for one concrete output such as a markdown brief, a pool snapshot, or a rebalance plan.</p>
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setShowForm(false); setSelectedTemplateId(''); }}>Cancel</Button>
              <Button type="submit" size="sm" disabled={creating}>
                {creating ? <Spinner size={12} /> : <Plus size={12} />}
                Create Job
              </Button>
            </div>
          </form>
        </Card>
      )}

      {!hasAgent && (
        <Card>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Briefcase size={32} className="text-slate-300" />
            <p className="text-sm text-slate-500">You are viewing the public board only.</p>
            <p className="text-xs text-slate-400 max-w-md">Connect the client agent if you want to create jobs or mark delivered work complete. Connect the provider wallet if you only need to submit a deliverable for an existing public job.</p>
          </div>
        </Card>
      )}

      {hasAgent && (
        <Card>
          <div className="space-y-3">
            <div>
              <SectionHeader className="mb-0">Your Jobs</SectionHeader>
              <p className="mt-1 text-xs text-slate-500">This section is only for you. The same public job can appear above and here at the same time. Above is the public board; here is your private manager for choosing applicants, canceling before delivery, and approving or rejecting results.</p>
            </div>

            {error && <Alert type="error">{error}</Alert>}

            {loading && !jobList.length ? (
              <div className="flex justify-center py-10"><Spinner /></div>
            ) : jobList.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                <p className="text-sm text-slate-500">This agent has not created any jobs yet.</p>
                <p className="mt-2 text-xs text-slate-400">Use the form above to publish a public job, then manage review and payout from this section.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {jobList.map(job => (
                  <JobRow key={job.id} job={job} agentId={agent.id} onRefresh={refreshAll} />
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {hasAgent && <JobTemplateLibrary onUseTemplate={handleUseTemplate} />}
    </div>
  );
}
