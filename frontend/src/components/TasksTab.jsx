import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { tasks as tasksApi, agents as agentsApi } from '../lib/api.js';
import {
  Card, Button, Alert, Spinner, SectionHeader,
} from './ui/index.jsx';
import {
  Zap, Lock, CheckCircle, RefreshCw, Coins,
  Play, ChevronDown, ChevronUp, AlertTriangle, Clock,
} from 'lucide-react';

// ── Tier badge (light mode) ───────────────────────────────────────────────────
function TierBadge({ tier }) {
  if (tier === 2) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-medium">
        <Lock size={10} /> Paid
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 font-medium">
      <Zap size={10} /> Free
    </span>
  );
}

function FeeTag({ feeUsdc }) {
  if (!feeUsdc || feeUsdc <= 0) return null;
  return (
    <span className="text-xs text-amber-700 font-semibold font-mono">{Number(feeUsdc).toFixed(2)} USDC</span>
  );
}

// ── Task Card with result polling ─────────────────────────────────────────────
function TaskCard({ task, agentId, tasksEnabled, onRefresh }) {
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState('');
  const [runState, setRunState] = useState(null); // null | 'queued' | 'done'
  const [result, setResult]     = useState(null);
  const pollRef                 = useRef(null);
  const startedAtRef            = useRef(null);

  const isPaid    = task.tier === 2;
  const isBlocked = !tasksEnabled;

  // On mount: check if there's a recent result (last 3 min) for this task
  useEffect(() => {
    if (!agentId) return;
    tasksApi.results(agentId, 20).then(data => {
      const cutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const found = (data.results || []).find(
        r => r.task_id === task.id && r.created_at >= cutoff,
      );
      if (found) { setResult(found); setRunState('done'); }
    }).catch(() => {});
  }, [agentId, task.id]);

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  async function handleRun() {
    if (!agentId || isBlocked) return;
    setBusy(true); setErr(''); setResult(null); setRunState('queued');
    startedAtRef.current = new Date().toISOString();
    try {
      await tasksApi.runTask(agentId, task.id);
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        try {
          const data = await tasksApi.results(agentId, 20);
          const found = (data.results || []).find(
            r => r.task_id === task.id && r.created_at >= startedAtRef.current,
          );
          if (found) {
            setResult(found);
            setRunState('done');
            stopPoll();
            onRefresh?.();
          }
        } catch { /* ignore poll errors */ }
        if (attempts >= 20) { stopPoll(); setRunState(null); }
      }, 3000);
    } catch (e) {
      setErr(e.message || 'Failed to queue task');
      setRunState(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => () => stopPoll(), []);

  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${expanded ? 'border-slate-300' : 'border-slate-200'}`}>
      {/* Header row */}
      <div className="flex items-center gap-3 p-3.5">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex-1 flex items-start gap-2 text-left min-w-0"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-slate-800">{task.title}</span>
              <TierBadge tier={task.tier} />
              {isPaid && <FeeTag feeUsdc={task.fee_usdc} />}
            </div>
            {!expanded && (
              <p className="text-xs text-slate-500 mt-0.5 truncate">{task.description}</p>
            )}
          </div>
          {expanded
            ? <ChevronUp size={14} className="text-slate-400 shrink-0 mt-0.5" />
            : <ChevronDown size={14} className="text-slate-400 shrink-0 mt-0.5" />}
        </button>

        <button
          onClick={handleRun}
          disabled={busy || !agentId || runState === 'queued' || isBlocked}
          className={`shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition
            ${isBlocked
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : isPaid
                ? 'bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60'
                : 'bg-[#66D121] text-white hover:bg-[#55b81c] disabled:opacity-60'
            }`}
        >
          {runState === 'queued'
            ? <><Spinner size={11} /> Running…</>
            : runState === 'done'
              ? <><CheckCircle size={11} /> Done</>
              : isPaid
                ? <><Coins size={11} /> Pay &amp; Run</>
                : <><Play size={11} /> Run</>}
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-3 border-t border-slate-100 pt-2.5 space-y-2">
          <p className="text-xs text-slate-500">{task.description}</p>
          <p className="text-[11px] text-slate-400 font-mono">{task.id}</p>
          {isPaid && (
            <p className="text-xs text-amber-700/80 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
              This task executes a real on-chain transaction via your agent wallet.
              A <strong>{Number(task.fee_usdc).toFixed(2)} USDC</strong> platform fee is deposited
              into ArcRevenuePool on execution.
            </p>
          )}
        </div>
      )}

      {/* Inline result */}
      {result && (
        <div className="px-4 pb-3 border-t border-slate-100 pt-2.5 bg-green-50/60">
          <div className="flex items-start gap-2">
            <CheckCircle size={13} className="text-green-600 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-green-800">Task completed</p>
              {result.payload?.summary && (
                <p className="text-xs text-slate-600 mt-0.5">{result.payload.summary}</p>
              )}
              <p className="text-[11px] text-slate-400 mt-0.5">
                {new Date(result.created_at).toLocaleTimeString()}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {err && (
        <div className="px-4 pb-2">
          <Alert type="error" className="py-1 text-xs">{err}</Alert>
        </div>
      )}
    </div>
  );
}

// ── Recent result row (light mode) ────────────────────────────────────────────
function ResultRow({ result }) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(result.created_at).toLocaleTimeString();

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-slate-50 transition-colors"
      >
        <CheckCircle size={12} className="text-green-500 shrink-0" />
        <span className="flex-1 text-xs text-slate-700">{result.title || result.task_id}</span>
        <span className="text-xs text-slate-400">{ts}</span>
        {expanded
          ? <ChevronUp size={12} className="text-slate-400" />
          : <ChevronDown size={12} className="text-slate-400" />}
      </button>
      {expanded && (
        <pre className="px-4 pb-3 pt-1 text-xs text-slate-500 overflow-x-auto border-t border-slate-100 max-h-40 whitespace-pre-wrap">
          {result.payload?.summary
            ? result.payload.summary
            : JSON.stringify(result.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Main Tab ──────────────────────────────────────────────────────────────────
export default function TasksTab() {
  const { agent, setAgent } = useAgent();

  const [catalog, setCatalog]         = useState([]);
  const [results, setResults]         = useState([]);
  const [poolBal, setPoolBal]         = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [activeGroup, setActiveGroup] = useState('free');

  // Enable/disable tasks toggle
  const [tasksEnabled, setTasksEnabled] = useState(false);
  const [saving, setSaving]             = useState(false);
  const [saveMsg, setSaveMsg]           = useState('');

  useEffect(() => {
    setTasksEnabled(agent?.features?.dailyTasksEnabled ?? false);
  }, [agent?.id, agent?.features?.dailyTasksEnabled]);

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

  async function handleEnableToggle(newVal) {
    if (!agent?.id) return;
    setSaving(true); setSaveMsg('');
    try {
      await agentsApi.update(agent.id, { dailyTasksEnabled: newVal });
      setTasksEnabled(newVal);
      setAgent(a => ({ ...a, features: { ...(a?.features || {}), dailyTasksEnabled: newVal } }));
      setSaveMsg(newVal ? 'Tasks enabled.' : 'Tasks disabled.');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (e) {
      setSaveMsg('Error: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  const freeTasks  = catalog.filter(t => t.tier === 1);
  const paidTasks  = catalog.filter(t => t.tier === 2);
  const shownTasks = activeGroup === 'free' ? freeTasks : paidTasks;

  if (!agent) {
    return (
      <Card>
        <p className="text-sm text-slate-500 text-center py-6">Connect your agent first.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header card */}
      <Card>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-[#66D121]" />
            <SectionHeader className="mb-0">Agent Tasks</SectionHeader>
          </div>
          <div className="flex items-center gap-3">
            {poolBal?.balanceUsdc != null && (
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <Coins size={12} className="text-amber-500" />
                <span>Pool: <strong className="text-amber-600">{Number(poolBal.balanceUsdc).toFixed(4)} USDC</strong></span>
              </div>
            )}
            <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>
        </div>

        {/* Disabled banner */}
        {!tasksEnabled && (
          <div className="mt-4 flex flex-col sm:flex-row items-start sm:items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <AlertTriangle size={16} className="text-amber-600 shrink-0" />
            <p className="flex-1 text-sm text-amber-800">
              <strong>Tasks are disabled.</strong> Enable them to run free oracle tasks and paid execution tasks with your agent.
            </p>
            <button
              onClick={() => handleEnableToggle(true)}
              disabled={saving}
              className="shrink-0 flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-60 transition"
            >
              {saving ? <Spinner size={11} /> : <Zap size={11} />}
              Enable Tasks
            </button>
          </div>
        )}

        {/* Enabled status bar */}
        {tasksEnabled && (
          <div className="mt-3 flex items-center justify-between rounded-xl border border-green-200 bg-green-50 px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs text-green-700">
              <CheckCircle size={13} className="text-green-600" />
              <span>Tasks are <strong>enabled</strong> for this agent.</span>
            </div>
            <button
              onClick={() => handleEnableToggle(false)}
              disabled={saving}
              className="text-xs text-slate-400 hover:text-red-500 transition disabled:opacity-50"
            >
              {saving ? <Spinner size={10} /> : 'Disable'}
            </button>
          </div>
        )}

        {saveMsg && (
          <p className={`mt-2 text-xs ${saveMsg.startsWith('Error') ? 'text-red-500' : 'text-green-600'}`}>
            {saveMsg}
          </p>
        )}

        {/* Free / Paid tab toggle */}
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => setActiveGroup('free')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition border ${
              activeGroup === 'free'
                ? 'bg-green-50 text-green-700 border-green-200'
                : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            <Zap size={11} /> Free ({freeTasks.length})
          </button>
          <button
            onClick={() => setActiveGroup('paid')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition border ${
              activeGroup === 'paid'
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            <Lock size={11} /> Paid ({paidTasks.length})
          </button>
        </div>
      </Card>

      {/* Info strip */}
      {activeGroup === 'free' && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-500 flex items-center gap-2">
          <Clock size={12} className="shrink-0" />
          Full catalog — each free task can be run up to 5 times per day. Tasks queued server-side and run autonomously even when you leave the page.
        </div>
      )}
      {activeGroup === 'paid' && (
        <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-3.5 py-2.5 text-xs text-amber-700 flex items-center gap-2">
          <Coins size={12} className="shrink-0" />
          Paid tasks execute real on-chain transactions via your agent wallet. CCTP Bridge is <strong>free</strong>. Other paid tasks incur a 0.10 USDC platform fee per run.
        </div>
      )}

      {error && <Alert type="error">{error}</Alert>}

      {/* Task list */}
      {loading && !catalog.length ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : shownTasks.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500 text-center py-6">No tasks found.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {shownTasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              agentId={agent?.id}
              tasksEnabled={tasksEnabled}
              onRefresh={load}
            />
          ))}
        </div>
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

