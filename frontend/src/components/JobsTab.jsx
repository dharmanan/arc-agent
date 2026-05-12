import React, { useState, useEffect } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { jobs as jobsApi } from '../lib/api.js';
import {
  Card, Button, Input, Badge, Alert, Spinner, SectionHeader
} from './ui/index.jsx';
import { Briefcase, Plus, CheckCircle, XCircle, Package, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

const STATUS_COLORS = {
  open:       'bg-blue-500/20 text-blue-400 border-blue-500/30',
  funded:     'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  delivered:  'bg-purple-500/20 text-purple-400 border-purple-500/30',
  completed:  'bg-green-500/20 text-green-400 border-green-500/30',
  cancelled:  'bg-red-500/20 text-red-400 border-red-500/30',
};

function StatusBadge({ status }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${STATUS_COLORS[status] || 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>
      {status}
    </span>
  );
}

function JobRow({ job, agentId, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState('');
  const [hashInput, setHashInput] = useState('');

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
    <div className="border border-white/10 rounded-lg overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-white/5 transition-colors"
      >
        <Briefcase size={14} className="text-arc-accent shrink-0" />
        <p className="flex-1 text-sm text-gray-200 truncate">{job.description}</p>
        <StatusBadge status={job.status} />
        <span className="text-xs text-gray-500">{job.amount_usdc} USDC</span>
        {expanded ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-white/10 space-y-2">
          {err && <Alert type="error">{err}</Alert>}

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
            <span className="text-gray-500">Provider</span>
            <span className="font-mono truncate">{job.provider_address || '—'}</span>
            <span className="text-gray-500">On-chain ID</span>
            <span className="font-mono">{job.job_id_onchain || 'offline'}</span>
            {job.deliverable_hash && <>
              <span className="text-gray-500">Deliverable</span>
              <span className="font-mono truncate">{job.deliverable_hash}</span>
            </>}
            {job.tx_hash_create && <>
              <span className="text-gray-500">Create tx</span>
              <span className="font-mono truncate">{job.tx_hash_create.slice(0, 20)}…</span>
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
        <p className="text-sm text-gray-400 text-center py-6">Connect your agent first.</p>
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
            <span className={`text-xs px-2 py-0.5 rounded-full border ${onchainEnabled ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'}`}>
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
          <p className="text-xs text-yellow-400/80 mt-2">
            AGENTIC_COMMERCE_ADDRESS not set — jobs are stored locally only until the contract is deployed.
          </p>
        )}
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
              <label className="block text-xs text-gray-400 mb-1">Description</label>
              <textarea
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-arc-accent resize-none"
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
            <Briefcase size={32} className="text-gray-600" />
            <p className="text-sm text-gray-400">No jobs yet.</p>
            <p className="text-xs text-gray-500">Create a job above to get started.</p>
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
