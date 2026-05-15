import React, { useState, useEffect } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { jobs as jobsApi } from '../lib/api.js';
import {
  Card, Button, Input, Badge, Alert, Spinner, SectionHeader
} from './ui/index.jsx';
import { Briefcase, Plus, CheckCircle, XCircle, Package, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

const STATUS_COLORS = {
  open:       'bg-blue-50 text-blue-700 border-blue-200',
  funded:     'bg-amber-50 text-amber-700 border-amber-200',
  delivered:  'bg-purple-50 text-purple-700 border-purple-200',
  completed:  'bg-green-50 text-green-700 border-green-200',
  cancelled:  'bg-red-50 text-red-700 border-red-200',
};

const ECONOMY_COLORS = {
  confirmed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  skipped: 'bg-amber-50 text-amber-700 border-amber-200',
  pending: 'bg-slate-100 text-slate-600 border-slate-200',
};

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

function JobRow({ job, agentId, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState('');
  const [hashInput, setHashInput] = useState('');
  const economyBadge = getJobEconomyBadge(job);

  async function handleDeliver() {
    if (!hashInput.trim()) return;
    setBusy(true); setErr('');
    try {
      await jobsApi.deliver(agentId, job.id, hashInput.trim());
      onRefresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function handleComplete() {
    setBusy(true); setErr('');
    try {
      await jobsApi.complete(agentId, job.id);
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

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-slate-50 transition-colors"
      >
        <Briefcase size={14} className="text-[#66D121] shrink-0" />
        <p className="flex-1 text-sm text-slate-800 truncate">{job.description}</p>
        <StatusBadge status={job.status} />
        <span className={`hidden sm:inline-flex text-[11px] px-2 py-0.5 rounded-full border font-medium ${economyBadge.tone}`}>
          {economyBadge.label}
        </span>
        <span className="text-xs text-slate-500">{job.amount_usdc} USDC</span>
        {expanded ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-slate-100 space-y-2">
          {err && <Alert type="error">{err}</Alert>}

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
            <span className="text-slate-500">Provider</span>
            <span className="font-mono truncate">{job.provider_address || '—'}</span>
            <span className="text-gray-500">On-chain ID</span>
            <span className="font-mono">{job.job_id_onchain || 'offline'}</span>
            <span className="text-gray-500">Economy rail</span>
            <span>{job.economy?.rail || 'agentic_job_economy'}</span>
            <span className="text-gray-500">Create fee</span>
            <span>
              {job.economy?.createFee
                ? `${job.economy.createFee.status} · ${job.economy.createFee.feeUsdc} USDC`
                : 'not configured'}
            </span>
            <span className="text-gray-500">Payout rail</span>
            <span>{job.economy?.payout?.mode || 'agentic_commerce_escrow'} · {job.economy?.payout?.status || 'pending'}</span>
            {job.deliverable_hash && <>
              <span className="text-gray-500">Deliverable</span>
              <span className="font-mono truncate">{job.deliverable_hash}</span>
            </>}
            {job.tx_hash_create && <>
              <span className="text-gray-500">Create tx</span>
              <span className="font-mono truncate">{job.tx_hash_create.slice(0, 20)}…</span>
            </>}
            {job.economy?.createFee?.gatewayMintTxHash && <>
              <span className="text-gray-500">Gateway fee tx</span>
              <span className="font-mono truncate">{job.economy.createFee.gatewayMintTxHash.slice(0, 20)}…</span>
            </>}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2 mt-3">
            {job.status === 'funded' && (
              <div className="flex gap-2 items-center w-full">
                <Input
                  placeholder="Deliverable hash or URL"
                  value={hashInput}
                  onChange={e => setHashInput(e.target.value)}
                  className="flex-1 text-xs"
                />
                <Button size="sm" onClick={handleDeliver} disabled={busy || !hashInput.trim()}>
                  {busy ? <Spinner size={12} /> : <Package size={12} />}
                  Deliver
                </Button>
              </div>
            )}
            {job.status === 'delivered' && (
              <Button size="sm" variant="success" onClick={handleComplete} disabled={busy}>
                {busy ? <Spinner size={12} /> : <CheckCircle size={12} />}
                Mark Complete
              </Button>
            )}
            {(job.status === 'open' || job.status === 'funded') && (
              <Button size="sm" variant="danger" onClick={handleCancel} disabled={busy}>
                {busy ? <Spinner size={12} /> : <XCircle size={12} />}
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function JobsTab() {
  const { agent } = useAgent();

  const [jobList, setJobList]       = useState([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [onchainEnabled, setOnchain] = useState(false);
  const [jobEconomy, setJobEconomy] = useState(null);

  // Create form
  const [showForm, setShowForm]     = useState(false);
  const [creating, setCreating]     = useState(false);
  const [createErr, setCreateErr]   = useState('');
  const [providerAddr, setProvider] = useState('');
  const [amount, setAmount]         = useState('');
  const [description, setDesc]      = useState('');

  async function loadJobs() {
    if (!agent?.id) return;
    setLoading(true); setError('');
    try {
      const data = await jobsApi.list(agent.id);
      setJobList(data.jobs || []);
      setOnchain(!!data.onchainEnabled);
      setJobEconomy(data.jobEconomy || null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadJobs(); }, [agent?.id]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!agent?.id) return;
    setCreating(true); setCreateErr('');
    try {
      await jobsApi.create(agent.id, {
        providerAddress: providerAddr.trim(),
        amountUsdc:      parseFloat(amount),
        description:     description.trim(),
      });
      setProvider(''); setAmount(''); setDesc('');
      setShowForm(false);
      await loadJobs();
    } catch (e) { setCreateErr(e.message); }
    finally { setCreating(false); }
  }

  if (!agent) {
    return (
      <Card>
        <p className="text-sm text-slate-500 text-center py-6">Connect your agent first.</p>
      </Card>
    );
  }

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
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${onchainEnabled ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
              {onchainEnabled ? 'On-chain' : 'Offline mode'}
            </span>
            <Button size="sm" variant="ghost" onClick={loadJobs} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </Button>
            <Button size="sm" onClick={() => setShowForm(v => !v)}>
              <Plus size={12} /> New Job
            </Button>
          </div>
        </div>
        {!onchainEnabled && (
          <p className="text-xs text-amber-700/80 mt-2">
            AGENTIC_COMMERCE_ADDRESS not set — jobs are stored locally only until the contract is deployed.
          </p>
        )}
        <JobsEconomyBanner summary={jobEconomy} />
      </Card>

      {/* Create form */}
      {showForm && (
        <Card>
          <SectionHeader>Create New Job</SectionHeader>
          {createErr && <Alert type="error" className="mb-3">{createErr}</Alert>}
          <form onSubmit={handleCreate} className="space-y-3">
            <Input
              label="Provider Address"
              placeholder="0x..."
              value={providerAddr}
              onChange={e => setProvider(e.target.value)}
              required
            />
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
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={creating}>
                {creating ? <Spinner size={12} /> : <Plus size={12} />}
                Create Job
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Error */}
      {error && <Alert type="error">{error}</Alert>}

      {/* Job list */}
      {loading && !jobList.length ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : jobList.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Briefcase size={32} className="text-slate-300" />
            <p className="text-sm text-slate-500">No jobs yet.</p>
            <p className="text-xs text-slate-400">Arc Jobs is a peer-to-peer task marketplace. Post a job, set a USDC bounty, and let agents compete to deliver.</p>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="space-y-2">
            {jobList.map(job => (
              <JobRow key={job.id} job={job} agentId={agent.id} onRefresh={loadJobs} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
