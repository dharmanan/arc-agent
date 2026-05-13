import React, { useState, useEffect, useCallback } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { tasks as tasksApi } from '../lib/api.js';
import {
  Card, Button, Alert, Spinner, SectionHeader,
} from './ui/index.jsx';
import {
  Zap, Lock, CheckCircle, RefreshCw, Coins,
  Play, ChevronDown, ChevronUp,
} from 'lucide-react';

// ── Helpers ───────────────────────────────────────────────────────────────────
function TierBadge({ tier }) {
  if (tier === 2) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 font-medium">
        <Lock size={10} /> Paid
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30 font-medium">
      <Zap size={10} /> Free
    </span>
  );
}

function FeeTag({ feeUsdc }) {
  if (!feeUsdc || feeUsdc <= 0) return null;
  return (
    <span className="text-xs text-yellow-400 font-mono">{Number(feeUsdc).toFixed(2)} USDC</span>
  );
}

// ── Task Card ─────────────────────────────────────────────────────────────────
function TaskCard({ task, agentId, onResult }) {
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');
  const [success, setSuccess] = useState('');
  const [expanded, setExpanded] = useState(false);

  async function handleRun() {
    setBusy(true); setErr(''); setSuccess('');
    try {
      const res = await tasksApi.runTask(agentId, task.id);
      setSuccess(`Queued — job #${res.jobId}`);
      onResult?.();
    } catch (e) {
      setErr(e.message || 'Failed to queue task');
    } finally {
      setBusy(false);
    }
  }

  const isPaid = task.tier === 2;

  return (
    <div className="border border-white/10 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex-1 flex items-center gap-3 text-left min-w-0"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-gray-200">{task.title}</span>
              <TierBadge tier={task.tier} />
              {isPaid && <FeeTag feeUsdc={task.fee_usdc} />}
            </div>
            {!expanded && (
              <p className="text-xs text-gray-500 mt-0.5 truncate">{task.description}</p>
            )}
          </div>
          {expanded
            ? <ChevronUp size={14} className="text-gray-500 shrink-0" />
            : <ChevronDown size={14} className="text-gray-500 shrink-0" />}
        </button>

        <Button
          size="sm"
          variant={isPaid ? 'warning' : 'primary'}
          onClick={handleRun}
          disabled={busy || !agentId}
          className="shrink-0"
        >
          {busy
            ? <Spinner size={12} />
            : isPaid ? <><Coins size={12} /> Pay & Run</> : <><Play size={12} /> Run</>}
        </Button>
      </div>

      {/* Expanded description + feedback */}
      {expanded && (
        <div className="px-4 pb-3 border-t border-white/10 pt-2 space-y-1.5">
          <p className="text-xs text-gray-400">{task.description}</p>
          <p className="text-xs text-gray-500 font-mono">{task.id}</p>
          {isPaid && (
            <p className="text-xs text-yellow-400/80">
              A platform fee of <strong>{Number(task.fee_usdc).toFixed(2)} USDC</strong> is deposited
              into the ArcRevenuePool on execution.
            </p>
          )}
        </div>
      )}

      {/* Feedback row */}
      {(err || success) && (
        <div className="px-3 pb-2">
          {err     && <Alert type="error"   className="py-1 text-xs">{err}</Alert>}
          {success && <Alert type="success" className="py-1 text-xs">{success}</Alert>}
        </div>
      )}
    </div>
  );
}

// ── Recent Results ────────────────────────────────────────────────────────────
function ResultRow({ result }) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(result.created_at).toLocaleTimeString();

  return (
    <div className="border border-white/10 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-white/5 transition-colors"
      >
        <CheckCircle size={12} className="text-green-400 shrink-0" />
        <span className="flex-1 text-xs text-gray-300">{result.title || result.task_id}</span>
        <span className="text-xs text-gray-500">{ts}</span>
        {expanded ? <ChevronUp size={12} className="text-gray-500" /> : <ChevronDown size={12} className="text-gray-500" />}
      </button>
      {expanded && (
        <pre className="px-4 pb-3 pt-1 text-xs text-gray-400 overflow-x-auto border-t border-white/10 max-h-40">
          {JSON.stringify(result.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Main Tab ──────────────────────────────────────────────────────────────────
export default function TasksTab() {
  const { agent } = useAgent();

  const [catalog, setCatalog]     = useState([]);
  const [results, setResults]     = useState([]);
  const [poolBal, setPoolBal]     = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [activeGroup, setActiveGroup] = useState('free'); // 'free' | 'paid'

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [catRes, poolRes] = await Promise.all([
        tasksApi.catalog(),
        tasksApi.poolBalance(),
      ]);
      setCatalog(catRes.tasks || []);
      setPoolBal(poolRes);

      if (agent?.id) {
        const resRes = await tasksApi.results(agent.id, 20);
        setResults(resRes.results || []);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [agent?.id]);

  useEffect(() => { load(); }, [load]);

  const freeTasks = catalog.filter(t => t.tier === 1);
  const paidTasks = catalog.filter(t => t.tier === 2);
  const shownTasks = activeGroup === 'free' ? freeTasks : paidTasks;

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
            <Zap size={18} className="text-arc-accent" />
            <SectionHeader className="mb-0">Agent Tasks</SectionHeader>
          </div>
          <div className="flex items-center gap-3">
            {poolBal?.balanceUsdc != null && (
              <div className="flex items-center gap-1.5 text-xs text-gray-400">
                <Coins size={12} className="text-yellow-400" />
                <span>Pool: <strong className="text-yellow-400">{Number(poolBal.balanceUsdc).toFixed(4)} USDC</strong></span>
              </div>
            )}
            <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>
        </div>

        {/* Free / Paid toggle */}
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => setActiveGroup('free')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition border ${
              activeGroup === 'free'
                ? 'bg-green-500/20 text-green-400 border-green-500/40'
                : 'border-white/10 text-gray-500 hover:text-gray-300'
            }`}
          >
            <Zap size={11} /> Free ({freeTasks.length})
          </button>
          <button
            onClick={() => setActiveGroup('paid')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition border ${
              activeGroup === 'paid'
                ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40'
                : 'border-white/10 text-gray-500 hover:text-gray-300'
            }`}
          >
            <Lock size={11} /> Paid ({paidTasks.length})
          </button>
        </div>
      </Card>

      {error && <Alert type="error">{error}</Alert>}

      {/* Task list */}
      {loading && !catalog.length ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : shownTasks.length === 0 ? (
        <Card>
          <p className="text-sm text-gray-400 text-center py-6">No tasks found.</p>
        </Card>
      ) : (
        <Card>
          <div className="space-y-2">
            {shownTasks.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                agentId={agent?.id}
                onResult={load}
              />
            ))}
          </div>
        </Card>
      )}

      {/* Recent results */}
      {results.length > 0 && (
        <Card>
          <SectionHeader>Recent Executions</SectionHeader>
          <div className="space-y-1.5">
            {results.slice(0, 10).map(r => (
              <ResultRow key={r.id} result={r} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
