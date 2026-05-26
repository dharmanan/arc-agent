import React, { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, X, ExternalLink, RefreshCw, AlertTriangle, Copy, Check } from 'lucide-react';
import { Spinner } from './ui/index.jsx';
import { agents as agentsApi } from '../lib/api.js';
import { CHAINS } from '../lib/chains.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function explorerTxUrl(txHash) {
  const base = CHAINS['Arc Testnet']?.explorerUrl;
  return base && txHash ? `${base}/tx/${txHash}` : null;
}

function explorerAddressUrl(address) {
  const base = CHAINS['Arc Testnet']?.explorerUrl;
  return base && address ? `${base}/address/${address}` : null;
}

function shortHash(hash) {
  if (!hash || hash.length < 12) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function shortAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

const EVENT_TYPE_LABELS = {
  TRANSACTION_COMPLETED:  'Transaction',
  ARB_EXECUTED:           'Arb executed',
  DEFI_LOOP_COMPLETED:    'DeFi loop',
  ORACLE_QUERY_COMPLETED: 'Oracle query',
  DAILY_TASK_COMPLETED:   'Daily task',
  PAID_TASK_COMPLETED:    'Paid task',
  JOB_REVIEW_TIMEOUT:     'Job timeout',
};

function eventLabel(eventType) {
  return EVENT_TYPE_LABELS[eventType] || String(eventType || '—').replace(/_/g, ' ');
}

// ── Copy button ───────────────────────────────────────────────────────────────
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  function handleCopy(e) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }
  return (
    <button
      onClick={handleCopy}
      className="ml-1 inline-flex items-center rounded p-0.5 text-slate-400 hover:text-slate-700 transition"
      title="Copy"
    >
      {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
    </button>
  );
}

// ── Event type pill ───────────────────────────────────────────────────────────
const EVENT_COLORS = {
  TRANSACTION_COMPLETED:  'bg-violet-50 text-violet-700 border-violet-200',
  ARB_EXECUTED:           'bg-sky-50 text-sky-700 border-sky-200',
  DEFI_LOOP_COMPLETED:    'bg-emerald-50 text-emerald-700 border-emerald-200',
  ORACLE_QUERY_COMPLETED: 'bg-blue-50 text-blue-700 border-blue-200',
  DAILY_TASK_COMPLETED:   'bg-teal-50 text-teal-700 border-teal-200',
  PAID_TASK_COMPLETED:    'bg-amber-50 text-amber-700 border-amber-200',
  JOB_REVIEW_TIMEOUT:     'bg-red-50 text-red-700 border-red-200',
};

function EventPill({ eventType }) {
  const cls = EVENT_COLORS[eventType] || 'bg-slate-50 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {eventLabel(eventType)}
    </span>
  );
}

// ── Overlay wrapper ───────────────────────────────────────────────────────────
function Overlay({ onClose, children }) {
  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-16 pb-16"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-3xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {children}
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────
export default function ReputationProofModal({ agentId, onClose }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const proof = await agentsApi.reputationProof(agentId);
      setData(proof);
    } catch (err) {
      setError(err?.message || 'Could not load on-chain proof.');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const contractUrl = data?.contractAddress ? explorerAddressUrl(data.contractAddress) : null;

  return (
    <Overlay onClose={onClose}>
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 rounded-t-2xl border-b border-slate-100 bg-[radial-gradient(circle_at_top_left,rgba(219,234,254,0.8),rgba(236,253,245,0.6),rgba(255,255,255,1))] px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100">
            <ShieldCheck size={18} className="text-blue-600" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">On-Chain Reputation Proof</h2>
            <p className="text-xs text-slate-500">
              Live read from the Arc Testnet ReputationRegistry contract
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 transition"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="px-6 py-5 space-y-5">

        {/* Loading */}
        {loading && !data && (
          <div className="flex flex-col items-center justify-center gap-3 py-14 text-slate-500">
            <Spinner size={28} />
            <p className="text-sm">Reading from the blockchain…</p>
            <p className="text-xs text-slate-400">Scanning recent blocks in pages — this takes a few seconds.</p>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
            <div>
              <p className="text-sm font-medium text-red-700">Could not load proof</p>
              <p className="text-xs text-red-600">{error}</p>
            </div>
          </div>
        )}

        {/* Not configured */}
        {!loading && data?.status === 'not_configured' && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            The reputation registry is not yet configured. Score is tracked locally only.
          </div>
        )}

        {/* Identity required */}
        {!loading && data?.status === 'identity_required' && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Register the agent identity first so the reputation score can be attached to an ERC-8004 token.
          </div>
        )}

        {!loading && data?.status === 'rate_limited' && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This agent already used {Number(data?.dailyReadCount || 0)}/{Number(data?.dailyReadLimit || 0)} live proof reads today. Try again after the UTC reset.
          </div>
        )}

        {/* RPC read error — show contract + token info and let user retry */}
        {!loading && data?.status === 'read_error' && (
          <>
            <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
              <div>
                <p className="text-sm font-semibold text-red-700">Registry read failed</p>
                <p className="text-xs text-red-600 mt-0.5">
                  The score could not be read from the contract right now. The Arc Testnet RPC may be slow or temporarily unreachable. Hit Refresh to try again.
                </p>
              </div>
            </div>
            {/* Still show contract + token so the user can verify manually */}
            {(data.contractAddress || data.tokenId) && (
              <div className="grid grid-cols-2 gap-3">
                {data.tokenId && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Identity</p>
                    <p className="mt-1 text-sm font-bold text-slate-900">ERC-8004 #{data.tokenId}</p>
                    <p className="text-[11px] text-slate-500">Token ID linked to this agent</p>
                  </div>
                )}
                {data.contractAddress && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Contract</p>
                    <p className="mt-1 flex items-center gap-1 font-mono text-xs text-slate-700 truncate">
                      {shortAddress(data.contractAddress)}
                      <CopyButton text={data.contractAddress} />
                    </p>
                    {contractUrl && (
                      <a href={contractUrl} target="_blank" rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 transition">
                        View on explorer <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Live data */}
        {!loading && data && data.status === 'live' && (
          <>
            {/* Score summary row */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">On-Chain Score</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">{data.score ?? '—'}</p>
                <p className="text-[11px] text-slate-500">Read directly from the contract</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Total Events</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">{data.totalEvents ?? '—'}</p>
                <p className="text-[11px] text-slate-500">All time on-chain writes</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Events in View</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">{data.events.length}</p>
                <p className="text-[11px] text-slate-500">Most recent on-chain writes</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Identity</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  ERC-8004 #{data.tokenId ?? '—'}
                </p>
                <p className="text-[11px] text-slate-500">Token ID linked to agent</p>
              </div>
            </div>

            {/* Contract address */}
            {data.contractAddress && (
              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 shrink-0">Contract</p>
                <code className="flex-1 truncate text-xs text-slate-700 font-mono">{data.contractAddress}</code>
                <CopyButton text={data.contractAddress} />
                {contractUrl && (
                  <a
                    href={contractUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-white border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-blue-200 hover:text-blue-700 transition"
                  >
                    Explorer <ExternalLink size={10} />
                  </a>
                )}
              </div>
            )}

            {/* Events scan error notice */}
            {data.eventsStatus === 'error' && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
                <p className="text-xs text-amber-800">
                  Your score of <strong>{data.score}</strong> was confirmed on-chain, but the activity history could not be loaded right now. Hit Refresh to try again, or open the contract on the explorer to browse the full history.
                </p>
              </div>
            )}

            {/* Event table */}
            {data.events.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Event trail — last {data.events.length} events
                  {data.totalEvents > data.events.length && (
                    <span className="ml-1 normal-case font-normal text-slate-400">
                      ({data.totalEvents - data.events.length} older events not in this window)
                    </span>
                  )}
                </p>
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <th className="px-3 py-2 text-left font-semibold text-slate-500">#</th>
                        <th className="px-3 py-2 text-left font-semibold text-slate-500">Block</th>
                        <th className="px-3 py-2 text-left font-semibold text-slate-500">Event</th>
                        <th className="px-3 py-2 text-right font-semibold text-slate-500">Delta</th>
                        <th className="px-3 py-2 text-right font-semibold text-slate-500">Score</th>
                        <th className="px-3 py-2 text-left font-semibold text-slate-500">Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.events.map((ev, i) => {
                        const txUrl = explorerTxUrl(ev.txHash);
                        return (
                          <tr
                            key={`${ev.txHash}-${i}`}
                            className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors"
                          >
                            <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                            <td className="px-3 py-2 font-mono text-slate-600">{ev.blockNumber.toLocaleString()}</td>
                            <td className="px-3 py-2">
                              <EventPill eventType={ev.eventType} />
                            </td>
                            <td className="px-3 py-2 text-right font-semibold">
                              <span className={ev.scoreDelta >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                                {ev.scoreDelta >= 0 ? '+' : ''}{ev.scoreDelta}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-slate-800">
                              {ev.newScore}
                            </td>
                            <td className="px-3 py-2">
                              {txUrl ? (
                                <a
                                  href={txUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 font-mono text-blue-600 hover:text-blue-800 transition"
                                  title={ev.txHash}
                                >
                                  {shortHash(ev.txHash)}
                                  <ExternalLink size={10} />
                                </a>
                              ) : (
                                <span className="font-mono text-slate-500">{shortHash(ev.txHash)}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Empty events note */}
            {data.events.length === 0 && data.status === 'live' && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 text-center text-sm text-slate-500">
                No recent activity found in the current scan window. Your score of <strong>{data.score}</strong> is confirmed on-chain — older events are stored further back in the chain history.
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center justify-between gap-4 rounded-b-2xl border-t border-slate-100 bg-slate-50 px-6 py-3">
        <p className="text-[11px] text-slate-400">
          {data?.status === 'rate_limited'
            ? `Live proof reads for identity token${data?.tokenId ? ` #${data.tokenId}` : ''} are capped per agent each UTC day.`
            : `Score is read live from the Arc Testnet blockchain for identity token${data?.tokenId ? ` #${data.tokenId}` : ''} — no server cache or intermediary.`}
        </p>
        <button
          onClick={onClose}
          className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-300 hover:text-slate-900 transition"
        >
          Close
        </button>
      </div>
    </Overlay>
  );
}
