import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { transactions as txApi, bridge as bridgeApi } from '../lib/api.js';
import { fetchAgentBalance, fetchUsdcBalance } from '../lib/agentBalances.js';
import { CHAINS } from '../lib/chains.js';
import { Card, Button, Input, Select, Alert } from './ui/index.jsx';
import {
  ArrowLeftRight, ChevronLeft, CheckCircle, Loader, Clock,
  Bot, Zap, ExternalLink, RefreshCw, HelpCircle, Bell, X, AlertCircle, AlertTriangle,
} from 'lucide-react';

// ── Chain list ───────────────────────────────────────────────────────────────
const CCTP_CHAIN_NAMES = [
  'Arc Testnet',
  'Sepolia',
  'Base Sepolia',
  'Optimism Sepolia',
  'Arbitrum Sepolia',
];

const BRIDGE_TOKEN_OPTIONS = ['USDC', 'ETH'];
const NATIVE_GAS_TOPUP_CHAIN_NAMES = ['Base Sepolia', 'Optimism Sepolia', 'Arbitrum Sepolia'];

function isEthBridgeRouteSupported(fromChain, toChain) {
  return fromChain === 'Sepolia' && NATIVE_GAS_TOPUP_CHAIN_NAMES.includes(toChain);
}

const EXPLORER_BASE = {
  'Arc Testnet':       'https://testnet.arcscan.app/tx/',
  'Sepolia':           'https://sepolia.etherscan.io/tx/',
  'Base Sepolia':      'https://sepolia.basescan.org/tx/',
  'Optimism Sepolia':  'https://sepolia-optimism.etherscan.io/tx/',
  'Arbitrum Sepolia':  'https://sepolia.arbiscan.io/tx/',
};

function explorerUrl(chain, hash) {
  if (!hash) return '#';
  return (EXPLORER_BASE[chain] || 'https://sepolia.etherscan.io/tx/') + hash;
}

// ── Activity status helpers ─────────────────────────────────────────────────
const STATUS_LABEL = {
  source_submitted:    'Submitting Source Tx',
  pending_destination: 'Awaiting Destination Receipt',
  awaiting_approve:    'Awaiting Approval',
  awaiting_burn:       'Awaiting Burn',
  pending_attestation: 'Awaiting Attestation',
  ready_to_mint:       'Ready to Mint',
  minted:              'Completed',
  failed:              'Failed',
  dismissed:           'Dismissed',
};

const STATUS_COLOR = {
  source_submitted:    'text-blue-600 bg-blue-50 border-blue-200',
  pending_destination: 'text-cyan-700 bg-cyan-50 border-cyan-200',
  awaiting_approve:    'text-yellow-600 bg-yellow-50 border-yellow-200',
  awaiting_burn:       'text-orange-600 bg-orange-50 border-orange-200',
  pending_attestation: 'text-blue-600 bg-blue-50 border-blue-200',
  ready_to_mint:       'text-arc-green bg-arc-green/10 border-arc-green/30',
  minted:              'text-green-700 bg-green-50 border-green-200',
  failed:              'text-red-600 bg-red-50 border-red-200',
  dismissed:           'text-slate-400 bg-slate-50 border-slate-200',
};

const IN_PROGRESS_STATUSES = ['source_submitted', 'pending_destination', 'awaiting_approve', 'awaiting_burn', 'pending_attestation'];

function isNativeBridge(act) {
  return act?.bridgeType === 'native' || act?.token === 'ETH';
}

function isAttestationStillPending(act) {
  if (!act || isNativeBridge(act)) return false;
  const error = String(act.error || '');
  if (!/attestation.*(timeout|zaman aşımı)/i.test(error)) return false;
  if (act.destinationTxHash || act.mintTxHash) return false;
  return Boolean(act.messageHash || act.sourceTxHash);
}

function getActivityStatus(act) {
  if (!act) return null;
  if (isAttestationStillPending(act)) {
    return 'pending_attestation';
  }
  if (act.autoRetryReason && !['dismissed', 'minted'].includes(act.status)) {
    return act.status;
  }
  if (act.error && !['failed', 'dismissed', 'minted'].includes(act.status)) {
    return 'failed';
  }
  return act.status;
}

function getProgressStatus(act) {
  const status = getActivityStatus(act);
  if (isNativeBridge(act)) {
    if (status === 'failed') {
      if (act.destinationTxHash || act.mintTxHash) return 'minted';
      if (act.sourceTxHash) return 'pending_destination';
      return 'source_submitted';
    }
    return status;
  }
  if (status === 'failed') {
    const failedStep = String(act.failedStep || act.bridgeStep || '').trim().toLowerCase();
    if (failedStep === 'burning' || failedStep === 'burned') {
      return 'awaiting_burn';
    }
    if (failedStep === 'attesting' || failedStep === 'attested') {
      return 'pending_attestation';
    }
    if (failedStep === 'minting' || failedStep === 'complete') {
      return 'ready_to_mint';
    }
    if (failedStep === 'approving' || failedStep === 'approved') {
      return 'awaiting_approve';
    }

    if (act.attestation || act.attestedMessage || act.autoRetryReason === 'destination_gas_low') {
      return 'ready_to_mint';
    }
    if (act.sourceTxHash || act.messageHash) {
      return 'pending_attestation';
    }
    if (act.approveTxHash) {
      return 'awaiting_burn';
    }
    if (STATUS_LABEL[act.status]) {
      return act.status;
    }
  }
  return status;
}

function isInProgress(act) { return IN_PROGRESS_STATUSES.includes(getActivityStatus(act)); }
function isReadyToMint(act) { return getActivityStatus(act) === 'ready_to_mint'; }
function isCompleted(act)   { return getActivityStatus(act) === 'minted'; }
function isDismissed(act)   { return ['dismissed', 'failed'].includes(getActivityStatus(act)); }

function formatActivityTimestamp(act) {
  const value = act.createdAt || act.startedAt || act.updatedAt;
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('en-US');
  } catch {
    return '';
  }
}

function getTrackerHeadline(act) {
  const status = getActivityStatus(act);
  if (status === 'source_submitted') return `Submitting on ${act.fromChain}`;
  if (status === 'pending_destination') return `Waiting for ${act.toChain} receipt`;
  if (status === 'ready_to_mint') return `Ready to mint on ${act.toChain}`;
  if (status === 'pending_attestation') return 'Wait up to 30 min';
  if (status === 'awaiting_burn') return 'Waiting for source-chain burn';
  if (status === 'awaiting_approve') return 'Waiting for approval';
  if (status === 'minted') return 'Bridge completed';
  if (status === 'failed') return 'Bridge failed';
  return STATUS_LABEL[status] || 'Bridge tracker available';
}

function formatActivityError(error) {
  if (!error) return '';
  if (/txpool is full/i.test(error)) return 'RPC mempool is full. Retry this bridge in a moment.';
  if (/attestation.*(timeout|zaman aşımı)/i.test(error)) return 'Attestation is still pending. Testnet minting can take up to 30 minutes.';
  if (/insufficient funds for gas \* price \+ value/i.test(error)) return 'Destination chain gas is too low for mint. Fund the agent wallet on that destination chain and the bridge can continue.';
  return error.split('\n')[0].trim();
}

function getAutoRetryMessage(act) {
  if (act.autoRetryReason === 'destination_gas_low') {
    const symbol = CHAINS[act.toChain]?.nativeCurrency?.symbol || 'ETH';
    return `Automatic mint is waiting for more ${symbol} on ${act.toChain}.`;
  }
  return '';
}

function getGasBalanceLabel(chainName) {
  const symbol = CHAINS[chainName]?.nativeCurrency?.symbol || 'ETH';
  return `${symbol} gas balance`;
}

function getSourceTxLabel(act) {
  return isNativeBridge(act) ? 'Source Tx' : 'Burn Tx';
}

function getDestinationTxLabel(act) {
  return isNativeBridge(act) ? 'Destination Tx' : 'Mint Tx';
}

// ── Activity Card ────────────────────────────────────────────────────────────
function ActivityCard({ act, onClaim, onDismiss, onOpenTracker, claiming, dismissing }) {
  const status    = getActivityStatus(act);
  const isPending = isInProgress(act);
  const isReady   = isReadyToMint(act);
  const isDone    = isCompleted(act);
  const isFailed  = status === 'failed';
  const isAuto    = act.mode !== 'manual';
  const tokenLabel = act.token || 'USDC';
  const destinationTxHash = act.destinationTxHash || act.mintTxHash;
  const nativeBridge = isNativeBridge(act);
  const attestationPending = isAttestationStillPending(act);

  return (
    <div className={`rounded-xl border p-3 space-y-2 ${STATUS_COLOR[status] || 'border-slate-200 bg-white'}`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">
            {act.amount ? `${act.amount} ${tokenLabel}` : tokenLabel}
            <span className="ml-2 font-normal text-xs opacity-75">{act.fromChain} → {act.toChain}</span>
          </p>
          <p className="text-xs opacity-60 mt-0.5">{formatActivityTimestamp(act)}</p>
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_COLOR[status] || STATUS_COLOR.failed}`}>
          {STATUS_LABEL[status] || status}
        </span>
      </div>

      {isPending && !nativeBridge && (
        <div className="flex items-center gap-1.5 pt-0.5">
          {['awaiting_approve', 'awaiting_burn', 'pending_attestation'].map(s => (
            <div key={s} className={`h-1.5 flex-1 rounded-full transition-all ${
              getProgressStatus(act) === s ? 'bg-blue-500' :
              IN_PROGRESS_STATUSES.indexOf(getProgressStatus(act)) > IN_PROGRESS_STATUSES.indexOf(s) ? 'bg-green-400' : 'bg-slate-200'
            }`} />
          ))}
          <span className="text-xs opacity-60 ml-1">
            {status === 'pending_attestation' ? 'Waiting for Circle…' : ''}
          </span>
        </div>
      )}

      {isPending && nativeBridge && (
        <p className="text-xs opacity-70">
          {status === 'source_submitted'
            ? `Submitting source bridge on ${act.fromChain}...`
            : `Source bridge confirmed. Waiting for ${act.toChain} receipt...`}
        </p>
      )}

      {act.autoRetryReason && (
        <p className="text-xs font-medium text-amber-700">{getAutoRetryMessage(act)}</p>
      )}
      {!act.autoRetryReason && act.error && !attestationPending && (
        <p className="break-all text-xs font-medium text-red-600">{formatActivityError(act.error)}</p>
      )}

      {/* TX links */}
      <div className="flex flex-wrap gap-3 text-xs">
        {act.sourceTxHash && (
          <a href={explorerUrl(act.fromChain, act.sourceTxHash)} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 underline opacity-70 hover:opacity-100">
            {getSourceTxLabel(act)} <ExternalLink size={10} />
          </a>
        )}
        {destinationTxHash && (
          <a href={explorerUrl(act.toChain, destinationTxHash)} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 underline opacity-70 hover:opacity-100">
            {getDestinationTxLabel(act)} <ExternalLink size={10} />
          </a>
        )}
      </div>

      {/* Actions */}
      {isReady && !isAuto && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={() => onClaim(act.id)} loading={claiming === act.id} className="flex-1">
            <CheckCircle size={13} className="mr-1" /> Claim
          </Button>
          <button
            onClick={() => onOpenTracker(act.id)}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-white"
            type="button"
          >
            Open tracker
          </button>
          <button
            onClick={() => onDismiss(act.id)}
            disabled={dismissing === act.id}
            className="text-xs text-slate-400 hover:text-red-500 transition"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {isReady && isAuto && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <p className="text-xs font-medium text-arc-green">{getAutoRetryMessage(act) || 'Agent will mint this transfer automatically.'}</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onOpenTracker(act.id)}
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-white"
              type="button"
            >
              Open tracker
            </button>
            <button
              onClick={() => onDismiss(act.id)}
              disabled={dismissing === act.id}
              className="text-xs text-slate-400 hover:text-red-500 transition"
              title="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      {(isPending || isFailed) && !isReady && (
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => onOpenTracker(act.id)}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-white"
            type="button"
          >
            Open tracker
          </button>
          <button
            onClick={() => onDismiss(act.id)}
            disabled={dismissing === act.id}
            className="text-xs text-slate-300 hover:text-red-400 transition"
            title="Remove from history"
          >
            <X size={13} />
          </button>
        </div>
      )}
      {isDone && !isReady && (
        <div className="flex justify-end">
          <button
            onClick={() => onDismiss(act.id)}
            disabled={dismissing === act.id}
            className="text-xs text-slate-300 hover:text-red-400 transition"
            title="Remove from history"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Activity Modal ───────────────────────────────────────────────────────────
function ActivityModal({ agent, activities, loadActivities, open, onClose, onOpenTracker }) {
  const [claiming,   setClaiming]   = useState(null);
  const [dismissing, setDismissing] = useState(null);
  const [err,        setErr]        = useState('');

  async function handleClaim(activityId) {
    setClaiming(activityId); setErr('');
    try {
      await bridgeApi.claim(activityId, agent.id);
      setTimeout(loadActivities, 3000);
    } catch (e) { setErr(e.message || 'Claim failed'); }
    finally { setClaiming(null); }
  }

  async function handleDismiss(activityId) {
    setDismissing(activityId); setErr('');
    try {
      await bridgeApi.dismiss(activityId, agent.id);
      loadActivities();
    } catch (e) { setErr(e.message || 'Dismiss failed'); }
    finally { setDismissing(null); }
  }

  const needed   = activities.filter(act => isReadyToMint(act) && act.mode === 'manual');
  const progress = activities.filter(act => isInProgress(act) || (isReadyToMint(act) && act.mode !== 'manual'));
  const done     = activities.filter(a => isCompleted(a) || isDismissed(a));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-title"
        className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full border border-slate-200 p-2 text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800"
          aria-label="Close activity"
        >
          <X size={16} />
        </button>

        <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eef7e8] text-[#2F6E0C]">
          <Bell size={22} />
        </div>

        <h2 id="activity-title" className="text-2xl font-semibold tracking-tight text-slate-900">
          Activity
        </h2>
        <p className="mt-2 text-sm text-slate-500">
          Completed bridges, ready-to-mint transfers, and pending items for this wallet.
        </p>

        <div className="mt-6 overflow-y-auto border-t border-slate-200 pt-5">
          {err && <Alert type="error">{err}</Alert>}
          {!activities.length && (
            <div className="py-12 text-center text-slate-400">
              <ArrowLeftRight size={28} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">No bridge activity yet</p>
            </div>
          )}

          {!!activities.length && (
            <div className="space-y-6 pr-1">
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">Action Needed</h3>
                  <button
                    type="button"
                    onClick={loadActivities}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#2F6E0C] hover:text-[#25580A]"
                  >
                    <RefreshCw size={12} /> Refresh
                  </button>
                </div>

                <div className="space-y-4">
                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">In Progress</h4>
                    {progress.length === 0 ? (
                      <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                        No transfer waiting for approvals or attestation.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {progress.map(act => (
                          <ActivityCard
                            key={act.id}
                            act={act}
                            onClaim={handleClaim}
                            onDismiss={handleDismiss}
                            onOpenTracker={onOpenTracker}
                            claiming={claiming}
                            dismissing={dismissing}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-700">Ready to Mint</h4>
                    {needed.length === 0 ? (
                      <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                        No ready-to-mint transfer right now.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {needed.map(act => (
                          <ActivityCard
                            key={act.id}
                            act={act}
                            onClaim={handleClaim}
                            onDismiss={handleDismiss}
                            onOpenTracker={onOpenTracker}
                            claiming={claiming}
                            dismissing={dismissing}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-5">
                <h3 className="mb-3 text-sm font-semibold text-slate-900">Completed</h3>
                {done.length === 0 ? (
                  <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                    No completed bridge activity yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {done.map(act => (
                      <ActivityCard
                        key={act.id}
                        act={act}
                        onClaim={handleClaim}
                        onDismiss={handleDismiss}
                        onOpenTracker={onOpenTracker}
                        claiming={claiming}
                        dismissing={dismissing}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepIcon({ state }) {
  if (state === 'done')   return <CheckCircle size={16} className="text-green-500 shrink-0" />;
  if (state === 'failed') return <AlertCircle size={16} className="text-red-500 shrink-0" />;
  if (state === 'active') return <Loader size={16} className="animate-spin text-arc-green shrink-0" />;
  return <Clock size={16} className="text-slate-300 shrink-0" />;
}

// Bridge steps — driven by Redis activity.status (persists across tab navigation)
const STATUS_ORDER = ['awaiting_approve', 'awaiting_burn', 'pending_attestation', 'ready_to_mint', 'minted'];
const USDC_BRIDGE_STEPS = [
  { actStatus: 'awaiting_approve',    label: 'Approve USDC',       activeLabel: 'Approving…',             manualStep: 'approve' },
  { actStatus: 'awaiting_burn',       label: 'Burn (source)',       activeLabel: 'Burning…',               manualStep: 'burn'    },
  { actStatus: 'pending_attestation', label: 'Attestation',         activeLabel: 'Waiting for Circle…',    manualStep: null      },
  { actStatus: 'ready_to_mint',       label: 'Mint (dest)',         activeLabel: 'Ready to Mint',          manualStep: null      },
  { actStatus: 'minted',              label: 'Completed',           activeLabel: 'Completed!',             manualStep: null      },
];

const NATIVE_STATUS_ORDER = ['source_submitted', 'pending_destination', 'minted'];
const NATIVE_BRIDGE_STEPS = [
  { actStatus: 'source_submitted',    label: 'Submit on Sepolia',      activeLabel: 'Submitting on Sepolia…',   manualStep: null },
  { actStatus: 'pending_destination', label: 'Receive on destination', activeLabel: 'Waiting for destination…', manualStep: null },
  { actStatus: 'minted',              label: 'Completed',              activeLabel: 'Completed!',               manualStep: null },
];

// ── Active Bridge Tracker ─────────────────────────────────────────────────────
// State comes from Redis activity only — survives tab switches / unmounts
function ActiveBridgeTracker({ activity, agentId, onClaim, onRefresh, claiming }) {
  const [execLoading, setExecLoading] = useState(false);
  const [execErr,     setExecErr]     = useState('');

  const status   = getActivityStatus(activity);
  const progress = getProgressStatus(activity);
  const isMinted = status === 'minted';
  const isFailed = status === 'failed';
  const isAuto   = activity.mode !== 'manual';
  const nativeBridge = isNativeBridge(activity);
  const bridgeSteps = nativeBridge ? NATIVE_BRIDGE_STEPS : USDC_BRIDGE_STEPS;
  const statusOrder = nativeBridge ? NATIVE_STATUS_ORDER : STATUS_ORDER;
  const curIdx   = isMinted ? bridgeSteps.length - 1 : Math.max(0, statusOrder.indexOf(progress));
  const destinationTxHash = activity.destinationTxHash || activity.mintTxHash;

  async function execManualStep(step) {
    setExecLoading(true); setExecErr('');
    try {
      await txApi.bridgeStep({ agentId, txId: activity.txId, step });
      setTimeout(onRefresh, 1000);
    } catch (e) { setExecErr(e.message || `${step} step failed`); }
    finally { setExecLoading(false); }
  }

  const wrapCls = isMinted
    ? 'border-green-200 bg-green-50'
    : isFailed
    ? 'border-red-200 bg-red-50'
    : 'border-arc-green/30 bg-arc-green/5';

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${wrapCls}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {!isMinted && !isFailed && <Loader size={13} className="animate-spin text-arc-green shrink-0" />}
          {isMinted  && <CheckCircle size={13} className="text-green-500 shrink-0" />}
          {isFailed  && <AlertCircle size={13} className="text-red-500 shrink-0" />}
          <span className="text-sm font-semibold text-slate-800 truncate">
            {activity.amount} {activity.token || 'USDC'} — {activity.fromChain} → {activity.toChain}
          </span>
        </div>
        <span className="text-xs text-slate-400 shrink-0">{isAuto ? 'Agentic' : 'Manual'}</span>
      </div>

      {/* Step list */}
      <div className="space-y-2 pl-1">
        {bridgeSteps.map((step, i) => {
          const state    = (isMinted || i < curIdx) ? 'done' : i === curIdx ? (isFailed ? 'failed' : 'active') : 'idle';
          const isActive = state === 'active';
          const isFailedStep = state === 'failed';
          return (
            <div key={step.actStatus} className="flex items-center gap-3">
              <StepIcon state={state} />
              <span className={`text-sm flex-1 ${
                state === 'done'   ? 'text-slate-700 font-medium' :
                state === 'active' ? 'text-arc-green font-medium' :
                state === 'failed' ? 'text-red-600 font-medium' : 'text-slate-400'
              }`}>
                {isActive ? step.activeLabel : isFailedStep ? `${step.label} failed` : step.label}
              </span>

              {/* Manual: execute step buttons */}
              {!isAuto && isActive && step.manualStep && (
                <Button size="sm" onClick={() => execManualStep(step.manualStep)} loading={execLoading}>
                  Execute
                </Button>
              )}

              {/* Claim button only for manual mode */}
              {!isAuto && isActive && step.actStatus === 'ready_to_mint' && (
                <Button size="sm" onClick={() => onClaim(activity.id)} loading={claiming === activity.id}>
                  <CheckCircle size={12} className="mr-1" /> Claim
                </Button>
              )}

              {/* TX links */}
              {state === 'done' && ((nativeBridge && step.actStatus === 'source_submitted') || (!nativeBridge && step.actStatus === 'awaiting_burn')) && activity.sourceTxHash && (
                <a href={explorerUrl(activity.fromChain, activity.sourceTxHash)} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-arc-green hover:underline shrink-0">
                  {getSourceTxLabel(activity)} <ExternalLink size={11} />
                </a>
              )}
              {state === 'done' && step.actStatus === 'minted' && destinationTxHash && (
                <a href={explorerUrl(activity.toChain, destinationTxHash)} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-arc-green hover:underline shrink-0">
                  {getDestinationTxLabel(activity)} <ExternalLink size={11} />
                </a>
              )}
            </div>
          );
        })}
      </div>

      {execErr && <Alert type="error">{execErr}</Alert>}

      {/* Attestation stuck warning */}
      {status === 'pending_attestation' && (() => {
        const ts = activity.createdAt || activity.startedAt || activity.updatedAt;
        if (!ts) return null;
        const elapsedMin = (Date.now() - new Date(ts).getTime()) / 60000;
        if (elapsedMin < 28) return null;
        return (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
            <AlertTriangle size={13} className="shrink-0 mt-0.5 text-amber-600" />
            <p className="text-xs text-amber-800">
              Attestation is taking longer than usual ({Math.round(elapsedMin)} min). On testnet this can take up to 30 minutes. No action needed — the agent will mint automatically once the attestation is ready.
            </p>
          </div>
        );
      })()}

      {!isMinted && !isFailed && (
        <p className="text-xs text-slate-400">
          {isAuto
            ? (nativeBridge
                ? (status === 'pending_destination'
                    ? `Source bridge confirmed. Waiting for ${activity.toChain} receipt...`
                    : `Submitting source bridge on ${activity.fromChain}...`)
                : activity.autoRetryReason === 'destination_gas_low'
                ? getAutoRetryMessage(activity)
                : status === 'ready_to_mint'
                  ? 'Attestation received. Agent is minting on the destination chain…'
                  : 'Agent is executing CCTP steps automatically…')
            : 'Click Execute for each step.'}
        </p>
      )}
      {isMinted && <p className="text-sm text-green-700 font-medium">✓ Bridge completed successfully!</p>}
      {isFailed  && <p className="text-sm text-red-600">{formatActivityError(activity.error) || 'Bridge failed — check agent balance / private key.'}</p>}
    </div>
  );
}

function TrackerModal({ activity, trackerPreview, agentId, open, onClose, onClaim, onRefresh, claiming }) {
  if (!open) return null;

  const status = activity ? getActivityStatus(activity) : 'loading';
  const Icon = !activity
    ? Loader
    : status === 'failed'
    ? AlertCircle
    : status === 'minted'
    ? CheckCircle
    : Clock;
  const iconClass = !activity
    ? 'bg-[#eef7e8] text-[#2F6E0C]'
    : status === 'failed'
    ? 'bg-red-50 text-red-600'
    : status === 'minted'
    ? 'bg-[#eef7e8] text-[#2F6E0C]'
    : 'bg-[#eef7e8] text-[#2F6E0C]';
  const previewLabel = trackerPreview
    ? `${trackerPreview.amount} ${trackerPreview.token} from ${trackerPreview.fromChain} to ${trackerPreview.toChain}`
    : 'Syncing the latest bridge activity.';

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center overflow-y-auto bg-slate-950/70 px-4 py-6 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bridge-tracker-title"
        className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full border border-slate-200 p-2 text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800"
          aria-label="Close bridge tracker"
        >
          <X size={16} />
        </button>

        <div className={`mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl ${iconClass}`}>
          <Icon size={22} className={!activity ? 'animate-spin' : ''} />
        </div>

        <h2 id="bridge-tracker-title" className="text-2xl font-semibold tracking-tight text-slate-900">
          Bridge Tracker
        </h2>
        <p className="mt-2 text-sm text-slate-500">
          {activity
            ? 'Follow this bridge step by step and complete required signatures.'
            : 'Opening the tracker now so the bridge does not look idle right after submission.'}
        </p>

        <div className="mt-6 overflow-y-auto pr-1">
          {activity ? (
            <ActiveBridgeTracker
              activity={activity}
              agentId={agentId}
              onClaim={onClaim}
              onRefresh={onRefresh}
              claiming={claiming}
            />
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-sm font-semibold text-slate-900">{previewLabel}</p>
              <p className="mt-2 text-sm text-slate-500">
                The first status update usually appears within a few seconds.
              </p>
            </div>
          )}
        </div>

        <div className="mt-6 border-t border-slate-200 pt-4">
          <p className="text-xs text-slate-500">
            Activity list is available from the bell icon. Use this tracker for the currently selected bridge flow.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────────
const ACTIVITY_POLL_INTERVAL_MS = 30_000;
const ACTIVE_ACTIVITY_STATUSES = ['source_submitted', 'pending_destination', 'awaiting_approve', 'awaiting_burn', 'pending_attestation', 'ready_to_mint'];

// Single source of truth: Redis activities (loaded on mount, polled while active).
// No local bridge state — navigating away and back keeps all progress visible.
export default function BridgeTab({ onBack }) {
  const { agent, isAuthenticated } = useAgent();

  // ── Redis activities (single polling source for everything) ──────────────
  const [activities,  setActivities]  = useState([]);
  const [fromChain,   setFromChain]   = useState('Arc Testnet');
  const [toChain,     setToChain]     = useState('Sepolia');
  const [token,       setToken]       = useState('USDC');
  const [amount,      setAmount]      = useState('');
  const [mode,        setMode]        = useState('agentic');
  const [activityOpen,setActivityOpen]= useState(false);
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [trackerId,   setTrackerId]   = useState(null);
  const [trackerPreview, setTrackerPreview] = useState(null);
  const [submitting,  setSubmitting]  = useState(false);
  const [claiming,    setClaiming]    = useState(null);
  const [dismissing,  setDismissing]  = useState(null);
  const [formErr,     setFormErr]     = useState('');
  const [sourceBalances, setSourceBalances] = useState({ native: null, usdc: null });
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [topUpMessage, setTopUpMessage] = useState(null);
  const pollRef        = useRef(null);
  const sourceChainConfig = CHAINS[fromChain];

  const loadActivities = useCallback(async () => {
    if (!agent) return;
    try {
      const res = await bridgeApi.getActivities(agent.id, 50);
      const list = res.activities || [];
      setActivities(list);
    } catch { /* ignore */ }
  }, [agent]);

  // Load once when the Bridge tab mounts for the current agent.
  // After that, polling only runs while there is an in-progress bridge.
  useEffect(() => {
    if (!agent) return;
    loadActivities();
    return () => clearTimeout(pollRef.current);
  }, [agent, loadActivities]);

  useEffect(() => {
    if (!agent) return;
    clearTimeout(pollRef.current);

    const hasActive = activities.some(a => ACTIVE_ACTIVITY_STATUSES.includes(getActivityStatus(a)));
    if (!hasActive) return () => clearTimeout(pollRef.current);

    const tick = async () => {
      await loadActivities();
      pollRef.current = setTimeout(tick, ACTIVITY_POLL_INTERVAL_MS);
    };

    pollRef.current = setTimeout(tick, ACTIVITY_POLL_INTERVAL_MS);
    return () => clearTimeout(pollRef.current);
  }, [agent, activities, loadActivities]);

  useEffect(() => {
    if (!agent || (!activityOpen && !trackerOpen)) return;
    loadActivities();
  }, [agent, activityOpen, trackerOpen, loadActivities]);

  useEffect(() => {
    let cancelled = false;

    async function loadSourceBalances() {
      if (!agent?.walletAddress || !sourceChainConfig) return;
      setLoadingBalances(true);
      try {
        const [native, usdc] = await Promise.all([
          fetchAgentBalance(agent.walletAddress, sourceChainConfig.chainId),
          fetchUsdcBalance(agent.walletAddress, sourceChainConfig.chainId),
        ]);
        if (!cancelled) setSourceBalances({ native, usdc });
      } finally {
        if (!cancelled) setLoadingBalances(false);
      }
    }

    loadSourceBalances();

    return () => {
      cancelled = true;
    };
  }, [agent?.walletAddress, sourceChainConfig]);

  useEffect(() => {
    if (token === 'ETH' && mode !== 'agentic') {
      setMode('agentic');
    }
  }, [token, mode]);

  // In-progress bridges to show as trackers above the form
  const activeActivities = activities.filter(a =>
    ACTIVE_ACTIVITY_STATUSES.includes(getActivityStatus(a))
  );
  const actionNeeded = activities.filter(a => getActivityStatus(a) === 'ready_to_mint' && a.mode === 'manual');
  const bannerActivity = activeActivities[0] || null;
  const trackedActivity = trackerId == null
    ? bannerActivity
    : activities.find(a => String(a.id) === String(trackerId)) || null;

  function openTracker(activityId, preview = null) {
    setTrackerId(activityId);
    setTrackerPreview(preview);
    setActivityOpen(false);
    setTrackerOpen(true);
  }

  async function handleClaim(activityId) {
    setClaiming(activityId);
    try {
      await bridgeApi.claim(activityId, agent.id);
      setTimeout(loadActivities, 3000);
    } catch { /* drawer shows error */ }
    finally { setClaiming(null); }
  }

  async function handleDismiss(activityId) {
    setDismissing(activityId);
    try {
      await bridgeApi.dismiss(activityId, agent.id);
      await loadActivities();
    } finally {
      setDismissing(null);
    }
  }

  const maxTrade   = agent?.settings?.maxTradeUsdc ?? 200;
  const amountNum  = parseFloat(amount) || 0;
  const isEthBridge = token === 'ETH';
  const exceedsMax = !isEthBridge && amountNum > maxTrade;
  const isEthRouteSupported = !isEthBridge || isEthBridgeRouteSupported(fromChain, toChain);
  const selectedTokenSymbol = isEthBridge ? (sourceChainConfig?.nativeCurrency?.symbol || 'ETH') : 'USDC';
  const displayedSourceBalance = isEthBridge ? sourceBalances.native : sourceBalances.usdc;

  async function refreshSourceBalances() {
    if (!agent?.walletAddress || !sourceChainConfig) return;
    setLoadingBalances(true);
    try {
      const [native, usdc] = await Promise.all([
        fetchAgentBalance(agent.walletAddress, sourceChainConfig.chainId),
        fetchUsdcBalance(agent.walletAddress, sourceChainConfig.chainId),
      ]);
      setSourceBalances({ native, usdc });
    } finally {
      setLoadingBalances(false);
    }
  }

  async function handleBridge() {
    if (!amount || amountNum <= 0)        { setFormErr('Enter a valid amount.'); return; }
    if (fromChain === toChain)             { setFormErr('Source and destination chains must be different.'); return; }
    if (isEthBridge && !isEthRouteSupported) {
      setFormErr('ETH bridge supports only Sepolia -> Base Sepolia / Optimism Sepolia / Arbitrum Sepolia.');
      return;
    }
    if (mode === 'agentic' && exceedsMax)  { setFormErr(`${amountNum} USDC exceeds agent limit (${maxTrade} USDC).`); return; }
    setFormErr(''); setSubmitting(true);
    setTopUpMessage(null);
    try {
      let result = null;
      if (isEthBridge) {
        result = await txApi.bridgeGasTopUp({
          agentId: agent.id,
          toChain,
          amountEth: amountNum,
        });
        setTopUpMessage({
          text: `Submitted ${result.amountEth} ETH bridge from Sepolia to ${toChain}.`,
        });
      } else {
        result = await txApi.bridge({
          agentId:    agent.id,
          fromChain,
          toChain,
          amountUsdc: amountNum,
          mode:       mode === 'agentic' ? 'auto' : 'manual',
        });
      }
      if (result?.txId) {
        openTracker(result.txId, {
          amount: isEthBridge ? (result.amountEth || amountNum) : amountNum,
          token,
          fromChain: isEthBridge ? 'Sepolia' : fromChain,
          toChain,
        });
      }
      setAmount('');
      void loadActivities();
      setTimeout(loadActivities, 800);
      setTimeout(loadActivities, 2500);
    } catch (e) { setFormErr(e.message || 'Failed to start bridge'); }
    finally { setSubmitting(false); }
  }

  if (!isAuthenticated || !agent) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ArrowLeftRight size={32} className="mb-4 text-slate-300" />
        <h2 className="text-lg font-bold text-slate-900">Agent Required</h2>
        <p className="mt-1 text-sm text-slate-500">Create an agent first to use the bridge.</p>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-arc-green transition">
            <ChevronLeft size={16} /> Back
          </button>
        )}
      </div>

      {/* ── Bridge form ─────────────────────────────────────────────────────── */}
      <Card>
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Bridge</h2>
            <p className="mt-2 text-sm text-slate-500">Choose token, route, and amount from the same bridge flow.</p>
          </div>
          <button
            type="button"
            onClick={() => setActivityOpen(true)}
            className="relative inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white p-2 text-slate-600 transition-colors hover:bg-slate-50"
            title="Open activity"
          >
            <Bell size={16} />
            {actionNeeded.length > 0 && (
              <span className="absolute -right-1 -top-1 inline-flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-semibold text-white">
                {actionNeeded.length}
              </span>
            )}
          </button>
        </div>

        {bannerActivity && (
          <div className="mb-5 flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-white p-2 text-[#2F6E0C] shadow-sm">
                <Clock size={16} />
              </div>
              <div>
                <p className="font-semibold">Bridge tracker available</p>
                <p className="mt-1 text-xs text-slate-500">
                  {bannerActivity.amount} {bannerActivity.token} from {bannerActivity.fromChain} to {bannerActivity.toChain}
                </p>
                <p className="mt-1 text-xs text-slate-500">{getTrackerHeadline(bannerActivity)}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => openTracker(bannerActivity.id)}
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-100"
            >
              Open tracker
            </button>
          </div>
        )}

        <div className="mb-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{fromChain} {token} balance</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
                {displayedSourceBalance ?? '—'} {selectedTokenSymbol}
              </p>
            </div>
            <div className="flex items-start gap-3">
              {!isEthBridge && fromChain !== 'Arc Testnet' && (
                <div className="text-right">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{getGasBalanceLabel(fromChain)}</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {sourceBalances.native ?? '—'} {sourceChainConfig?.nativeCurrency?.symbol || ''}
                  </p>
                </div>
              )}
              <Button
                variant="outline"
                className="px-3 py-2 text-xs"
                onClick={refreshSourceBalances}
                loading={loadingBalances}
              >
                <RefreshCw size={13} /> Refresh
              </Button>
            </div>
          </div>
        </div>

        {/* Mode selector */}
        <div className="flex gap-2 mb-5">
          <button
            onClick={() => setMode('agentic')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium border transition-all ${
              mode === 'agentic' ? 'bg-arc-green text-white border-arc-green' : 'bg-white text-slate-600 border-slate-200 hover:border-arc-green/50'
            }`}
          >
            <Zap size={14} /> Agentic
          </button>
          <button
            onClick={() => {
              if (!isEthBridge) setMode('manual');
            }}
            disabled={isEthBridge}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium border transition-all ${
              isEthBridge
                ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                : mode === 'manual'
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
            }`}
          >
            <Bot size={14} /> Manual
          </button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Select label="Source Chain" value={fromChain} onChange={e => setFromChain(e.target.value)}>
              {CCTP_CHAIN_NAMES.map(n => <option key={n}>{n}</option>)}
            </Select>
            <Select label="Destination Chain" value={toChain} onChange={e => setToChain(e.target.value)}>
              {CCTP_CHAIN_NAMES.map(n => <option key={n}>{n}</option>)}
            </Select>
          </div>

          <Select label="Token" value={token} onChange={e => setToken(e.target.value)}>
            {BRIDGE_TOKEN_OPTIONS.map(option => <option key={option}>{option}</option>)}
          </Select>

          <Input label={`${token} Amount`} type="number" placeholder={isEthBridge ? '0.01' : '10.00'} min="0" step={isEthBridge ? '0.0001' : '0.01'}
            value={amount} onChange={e => setAmount(e.target.value)} />

          {isEthBridge && !isEthRouteSupported && (
            <Alert type="warning">
              ETH bridge is available only for Sepolia -&gt; Base Sepolia / Optimism Sepolia / Arbitrum Sepolia.
            </Alert>
          )}

          {amountNum > 0 && (
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs text-slate-500 space-y-1">
              {isEthBridge ? (
                <>
                  <div className="flex items-center gap-2">
                    <Zap size={12} className="text-arc-green" />
                    <span>ETH bridge uses the same bridge form and supports only Sepolia to the supported L2 testnets.</span>
                  </div>
                  {isEthRouteSupported
                    ? <p className="text-green-600 pl-4">✓ Supported ETH route selected.</p>
                    : <p className="text-red-500 pl-4">⚠ Unsupported ETH route.</p>
                  }
                </>
              ) : mode === 'agentic' ? (
                <>
                  <div className="flex items-center gap-2">
                    <Zap size={12} className="text-arc-green" />
                    <span>Agent executes all 4 CCTP steps automatically — no MetaMask required</span>
                  </div>
                  {exceedsMax
                    ? <p className="text-red-500 pl-4">⚠ Exceeds agent limit ({maxTrade} USDC)</p>
                    : <p className="text-green-600 pl-4">✓ Within agent limit ({amountNum} / {maxTrade} USDC)</p>
                  }
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <HelpCircle size={12} className="text-slate-400" />
                  <span>You trigger each step — agent wallet signs, no MetaMask</span>
                </div>
              )}
              <p className="pl-4">Token: <strong>{token}</strong> | {fromChain} → {toChain}</p>
            </div>
          )}

          {formErr && <Alert type="error">{formErr}</Alert>}
          {topUpMessage && <Alert type="success">{topUpMessage.text}</Alert>}

          <Button
            onClick={handleBridge}
            loading={submitting}
            disabled={(mode === 'agentic' && exceedsMax) || (isEthBridge && !isEthRouteSupported)}
            className="w-full"
          >
            {isEthBridge
              ? <><Zap size={14} className="mr-1" />Start ETH Bridge</>
              : mode === 'agentic'
              ? <><Zap size={14} className="mr-1" />Start Agentic Bridge</>
              : <><Bot size={14} className="mr-1" />Start Manual Bridge</>}
          </Button>
        </div>
      </Card>

      <ActivityModal
        agent={agent}
        activities={activities}
        loadActivities={loadActivities}
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        onOpenTracker={openTracker}
      />

      <TrackerModal
        activity={trackedActivity}
        trackerPreview={trackerPreview}
        agentId={agent.id}
        open={trackerOpen}
        onClose={() => {
          setTrackerOpen(false);
          setTrackerId(null);
          setTrackerPreview(null);
        }}
        onClaim={handleClaim}
        onRefresh={loadActivities}
        claiming={claiming}
      />
    </div>
  );
}
