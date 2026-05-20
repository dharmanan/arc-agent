import React, { useState, useEffect, useCallback } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { tasks as tasksApi, agents as agentsApi } from '../lib/api.js';
import { fetchAgentBalance, fetchUsdcBalance, fetchEurcBalance } from '../lib/agentBalances.js';
import {
  Card, Button, Alert, Spinner, AddressBox,
} from './ui/index.jsx';
import {
  Zap, Lock, CheckCircle, RefreshCw, Coins,
  Play, ChevronDown, ChevronUp, AlertTriangle, Clock, Brain,
  ShieldCheck, ExternalLink,
} from 'lucide-react';
import { CHAINS } from '../lib/chains.js';

const AUTOMATION_FEATURES = [
  {
    key: 'marketAnalysisEnabled',
    statusKey: 'marketAnalysis',
    title: 'Market Analysis',
    description: 'Background market checks before any automatic trade happens.',
    detail: 'Updates context only. It does not move funds by itself.',
  },
  {
    key: 'oracleEnabled',
    statusKey: 'oracle',
    title: 'Oracle Data Feed',
    description: 'Background price and opportunity updates.',
    detail: 'Keeps signals fresh. It does not trade by itself.',
  },
  {
    key: 'defiLoopEnabled',
    statusKey: 'defiLoop',
    title: 'Stable DeFi Loop',
    description: 'Automatic stablecoin actions within your limits.',
    detail: 'Moves funds only on the verified USDC/EURC stable lane.',
  },
  {
    key: 'cirbtcLpEnabled',
    statusKey: 'cirbtcLp',
    title: 'cirBTC LP Automation',
    description: 'Automatic bootstrap and exit rules for verified direct-pair cirBTC LP.',
    detail: 'Keeps cirBTC LP automation separate from the stable lane toggle.',
  },
  {
    key: 'reputationEnabled',
    statusKey: 'reputation',
    title: 'Reputation Tracking',
    description: 'Background reputation record for the agent.',
    detail: 'Keeps an activity trail and can post on-chain when connected.',
  },
];
const FULL_AUTONOMY_FEATURE_KEYS = AUTOMATION_FEATURES.map(feature => feature.key);
const ACTIVE_TASK_RUN_STATUSES = new Set(['queued', 'running']);
const EXECUTION_TASK_IDS = new Set([
  'EXEC_CURVE_SWAP',
  'EXEC_CURVE_LIQUIDITY_ADD',
  'EXEC_CURVE_LIQUIDITY_REMOVE',
  'EXEC_CIRBTC_USDC_ZAP_IN',
  'EXEC_CIRBTC_EURC_ZAP_IN',
  'EXEC_CIRBTC_USDC_LP_REMOVE',
  'EXEC_CIRBTC_EURC_LP_REMOVE',
  'EXEC_CCTP_BRIDGE',
  'EXEC_ARB',
  'EXEC_REBALANCE',
]);
const DIRECT_PAIR_ZAP_PRESETS = {
  EXEC_CIRBTC_USDC_ZAP_IN: {
    token: 'USDC',
    defaultAmountIn: '20',
    maxAmountIn: 20,
    maxSwapAmountIn: '10',
  },
  EXEC_CIRBTC_EURC_ZAP_IN: {
    token: 'EURC',
    defaultAmountIn: '16',
    maxAmountIn: 16,
    maxSwapAmountIn: '8',
  },
};
const DIRECT_PAIR_EXIT_PRESETS = {
  EXEC_CIRBTC_USDC_LP_REMOVE: {
    token: 'USDC',
    defaultWithdrawPct: '100',
  },
  EXEC_CIRBTC_EURC_LP_REMOVE: {
    token: 'EURC',
    defaultWithdrawPct: '100',
  },
};
const CCTP_CHAIN_OPTIONS = [
  'Arc Testnet',
  'Sepolia',
  'Base Sepolia',
  'Optimism Sepolia',
  'Arbitrum Sepolia',
];
const REBALANCE_TOKEN_OPTIONS = ['USDC', 'EURC'];
const REPUTATION_EVENT_LABELS = {
  TRANSACTION_COMPLETED: 'Completed Job',
  ARB_EXECUTED: 'Arbitrage Execution',
  DEFI_LOOP_COMPLETED: 'DeFi Loop',
  ORACLE_QUERY_COMPLETED: 'Oracle Query',
  DAILY_TASK_COMPLETED: 'Daily Task',
};
const REPUTATION_IMPORTANCE_ITEMS = [
  {
    title: 'Trust signal',
    description: 'Shows whether the agent consistently completes useful work instead of only staying active.',
  },
  {
    title: 'Reviewable history',
    description: 'Every reputation event becomes part of a visible score trail that users can inspect before granting more autonomy.',
  },
  {
    title: 'Portable proof',
    description: 'When identity and registry are ready, the same history can be mirrored on Arc and read outside this app.',
  },
];
const REPUTATION_SCORE_RULES = [
  {
    eventType: 'ARB_EXECUTED',
    label: 'Arbitrage Execution',
    delta: 2,
    description: 'Weighted higher because it represents a higher-value execution path.',
  },
  {
    eventType: 'TRANSACTION_COMPLETED',
    label: 'Completed Job',
    delta: 1,
    description: 'Recorded when a job or settlement completes successfully.',
  },
  {
    eventType: 'DAILY_TASK_COMPLETED',
    label: 'Daily Task',
    delta: 1,
    description: 'Awarded for successful manual or queued task activity.',
  },
  {
    eventType: 'ORACLE_QUERY_COMPLETED',
    label: 'Oracle Query',
    delta: 1,
    description: 'Recorded when an oracle-powered run completes successfully.',
  },
  {
    eventType: 'DEFI_LOOP_COMPLETED',
    label: 'DeFi Loop',
    delta: 1,
    description: 'Recorded after a completed DeFi automation cycle.',
  },
];

const PAID_TASK_GROUPS = [
  {
    key: 'stable_curve',
    title: 'Stable Curve Actions',
    description: 'Manual Arc actions on the verified USDC/EURC stable rail.',
    taskIds: ['EXEC_CURVE_SWAP', 'EXEC_CURVE_LIQUIDITY_ADD', 'EXEC_CURVE_LIQUIDITY_REMOVE', 'EXEC_REBALANCE'],
  },
  {
    key: 'cirbtc_direct_pairs',
    title: 'cirBTC Direct Pair Actions',
    description: 'Manual Arc actions on the live direct cirBTC/USDC and cirBTC/EURC pools.',
    taskIds: ['EXEC_CIRBTC_USDC_ZAP_IN', 'EXEC_CIRBTC_EURC_ZAP_IN', 'EXEC_CIRBTC_USDC_LP_REMOVE', 'EXEC_CIRBTC_EURC_LP_REMOVE'],
  },
  {
    key: 'cross_chain_signal',
    title: 'Bridge and Signal Actions',
    description: 'Manual bridge or signal-triggered execution paths outside the direct LP flows.',
    taskIds: ['EXEC_CCTP_BRIDGE', 'EXEC_ARB'],
  },
];
const PAID_TASK_GROUP_TASK_IDS = new Set(PAID_TASK_GROUPS.flatMap(group => group.taskIds));

function getTaskOperationalAlert(task) {
  switch (task?.id) {
    case 'EXEC_CURVE_SWAP':
      return {
        badge: 'Live now',
        title: 'Already used by live stable automation',
        body: 'This paid task uses the same verified Arc stable swap route that the live DeFi loop already uses today.',
      };

    case 'EXEC_CURVE_LIQUIDITY_ADD':
    case 'EXEC_CURVE_LIQUIDITY_REMOVE':
    case 'EXEC_REBALANCE':
      return {
        badge: 'Manual now',
        title: 'Next stable automation candidate',
        body: 'This task stays manual today, but it sits on the same verified stable route that is next in line for automation before cirBTC and other manual-only paths.',
      };

    case 'EXEC_CIRBTC_USDC_ZAP_IN':
    case 'EXEC_CIRBTC_EURC_ZAP_IN':
      return {
        badge: 'Direct pool',
        title: 'Runs on the live cirBTC pool',
        body: 'This task uses the live direct cirBTC pool on the current deployment. It stays manual today and does not rely on a Curve fallback.',
      };

    case 'EXEC_CIRBTC_USDC_LP_REMOVE':
    case 'EXEC_CIRBTC_EURC_LP_REMOVE':
      return {
        badge: 'LP exit',
        title: 'Closes a live cirBTC LP position',
        body: 'This task removes a live direct cirBTC LP position and returns the underlying assets to the agent wallet. It stays on the direct pool path, not a Curve fallback.',
      };

    default:
      return null;
  }
}

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

function formatCirclePaidFeeUsdc(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric >= 0.1) return numeric.toFixed(2);
  if (numeric >= 0.01) return numeric.toFixed(3);
  return numeric.toFixed(4);
}

function formatCirclePaidStatus(status) {
  if (!status) return 'Planned';
  if (status === 'planned') return 'Planned';

  return String(status)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatCirclePaidPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric >= 10) return `${numeric.toFixed(1)}%`;
  return `${numeric.toFixed(2)}%`;
}

function formatCirclePaidUsdCompact(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(2)}M`;
  if (numeric >= 1_000) return `$${(numeric / 1_000).toFixed(1)}k`;
  return `$${numeric.toFixed(0)}`;
}

function truncateCirclePaidText(value, maxLength = 140) {
  const normalized = String(value || '').trim();
  if (!normalized) return 'Saved live market snapshot';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function getCirclePaidRegimeClasses(regime) {
  switch (String(regime || '').toUpperCase()) {
    case 'CALM':
      return 'border-green-200 bg-green-50 text-green-700';
    case 'ELEVATED':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'UNSTABLE':
    case 'UNAVAILABLE':
      return 'border-red-200 bg-red-50 text-red-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600';
  }
}


function formatCirclePaidTopicLabel(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return 'Topic';

  return normalized
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatCirclePaidComparisonState(state) {
  switch (String(state || '').toLowerCase()) {
    case 'aligned':
      return 'Aligned';
    case 'split':
      return 'Split';
    case 'divergent':
      return 'Divergent';
    default:
      return 'Compared';
  }
}

function getCirclePaidComparisonStateClasses(state) {
  switch (String(state || '').toLowerCase()) {
    case 'aligned':
      return 'border-green-200 bg-green-50 text-green-700';
    case 'split':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'divergent':
      return 'border-red-200 bg-red-50 text-red-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600';
  }
}

function getCirclePaidSnapshotMeta(preview, isEventOddsCompare = false) {
  const meta = [];

  if (isEventOddsCompare && preview?.comparison?.state) {
    meta.push(formatCirclePaidComparisonState(preview.comparison.state));
  }

  if (preview?.metrics?.matchingMarkets != null) {
    meta.push(`${preview.metrics.matchingMarkets} ${isEventOddsCompare ? 'tracked' : 'matched'}`);
  }

  const moveValue = isEventOddsCompare ? preview?.metrics?.movementGapPct : preview?.metrics?.averageOneDayMovePct;
  if (Number.isFinite(Number(moveValue))) {
    meta.push(`${isEventOddsCompare ? 'Move gap' : 'Avg move'} ${formatCirclePaidPercent(moveValue)}`);
  }

  if (Number.isFinite(Number(preview?.metrics?.totalVolume24hrUsd))) {
    meta.push(`24h vol ${formatCirclePaidUsdCompact(preview.metrics.totalVolume24hrUsd)}`);
  }

  return meta;
}

function CirclePaidComparisonPanel({ comparison, highlightSets = null }) {
  if (!comparison?.primary || !comparison?.secondary) return null;

  const [expandedTopics, setExpandedTopics] = useState({});

  useEffect(() => {
    setExpandedTopics({});
  }, [comparison?.primary?.topic, comparison?.secondary?.topic]);

  const topics = [
    {
      key: 'primary',
      label: formatCirclePaidTopicLabel(comparison.primary.topic),
      data: comparison.primary,
      highlights: Array.isArray(highlightSets?.primary) ? highlightSets.primary : [],
    },
    {
      key: 'secondary',
      label: formatCirclePaidTopicLabel(comparison.secondary.topic),
      data: comparison.secondary,
      highlights: Array.isArray(highlightSets?.secondary) ? highlightSets.secondary : [],
    },
  ];

  const totalMatchedMarkets = topics.reduce(
    (sum, topic) => sum + Number(topic.data.matchingMarkets || topic.highlights.length || 0),
    0,
  );
  const hasVisibleHighlightSets = topics.some(topic => topic.highlights.length > 0);
  const visibleMarketCount = topics.reduce((sum, topic) => {
    const highlightCount = topic.highlights.length;
    return sum + (expandedTopics[topic.key] ? highlightCount : Math.min(highlightCount, 2));
  }, 0);

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Comparison frame</p>
          <p className="mt-1 text-xs text-slate-600">
            {comparison.dominantTopic
              ? `${formatCirclePaidTopicLabel(comparison.dominantTopic)} is currently the hotter side of this comparison.`
              : 'Neither side is cleanly dominating right now.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getCirclePaidComparisonStateClasses(comparison.state)}`}>
            {formatCirclePaidComparisonState(comparison.state)}
          </span>
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
            Move gap {formatCirclePaidPercent(comparison.movementGapPct)}
          </span>
        </div>
      </div>

      {hasVisibleHighlightSets && totalMatchedMarkets > visibleMarketCount && (
        <p className="text-[11px] leading-5 text-slate-500">
          Showing {visibleMarketCount} linked markets right now. Expand a topic below to inspect all {totalMatchedMarkets} matched markets.
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {topics.map(topic => (
          <div key={topic.key} className="rounded-lg border border-white bg-white px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-slate-900">{topic.label}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {topic.data.topMarketQuestion || topic.data.topMarket?.question || 'No lead market identified yet.'}
                </p>
              </div>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getCirclePaidRegimeClasses(topic.data.regime)}`}>
                {String(topic.data.regime || 'UNKNOWN').toLowerCase()}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Matches</p>
                <p className="mt-1 text-xs font-semibold tabular-nums text-slate-800">{topic.data.matchingMarkets ?? '—'}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Avg 24h move</p>
                <p className="mt-1 text-xs font-semibold tabular-nums text-slate-800">{formatCirclePaidPercent(topic.data.averageOneDayMovePct)}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Avg liquidity</p>
                <p className="mt-1 text-xs font-semibold tabular-nums text-slate-800">{formatCirclePaidUsdCompact(topic.data.averageLiquidityUsd)}</p>
              </div>
            </div>

            {topic.highlights.length > 0 && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] leading-5 text-slate-500">
                    Showing {expandedTopics[topic.key] ? topic.highlights.length : Math.min(topic.highlights.length, 2)} of {topic.data.matchingMarkets ?? topic.highlights.length} matched markets.
                  </p>
                  {topic.highlights.length > 2 && (
                    <button
                      type="button"
                      onClick={() => setExpandedTopics(current => ({
                        ...current,
                        [topic.key]: !current[topic.key],
                      }))}
                      className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
                    >
                      {expandedTopics[topic.key] ? 'Show fewer' : `Show all ${topic.highlights.length}`}
                    </button>
                  )}
                </div>

                {(expandedTopics[topic.key] ? topic.highlights : topic.highlights.slice(0, 2)).map((highlight, index) => (
                  <div key={`${topic.key}:highlight:${highlight.marketId || index}`} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 flex-1 text-[11px] font-semibold leading-5 text-slate-800">{highlight.question}</p>
                      {highlight.url && (
                        <a
                          href={highlight.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
                        >
                          <ExternalLink size={11} /> Open
                        </a>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                      <span>Yes {formatCirclePaidPercent(highlight.yesProbabilityPct)}</span>
                      <span>Move {formatCirclePaidPercent(highlight.oneDayPriceChangePct)}</span>
                      <span>Liquidity {formatCirclePaidUsdCompact(highlight.liquidityUsd)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
function getCirclePaidErrorMessage(message) {
  switch (message) {
    case 'circle_paid_item_required':
      return 'Choose a Circle Paid card before starting a preview.';
    case 'circle_paid_item_not_found':
      return 'This Circle Paid card is no longer available.';
    case 'preview_id_required':
      return 'Start a preview before trying to unlock the full result.';
    case 'preview_not_found':
      return 'This preview could not be found. Run the free preview again.';
    case 'preview_expired':
      return 'This preview expired before unlock. Run the free preview again to refresh it.';
    case 'preview_already_unlocked':
      return 'This preview is already unlocked and saved.';
    case 'insufficient_wallet_balance_for_gateway_deposit':
      return 'The agent wallet does not have enough USDC to pay for this unlock right now.';
    case 'payment_settlement_failed':
      return 'Payment settlement did not complete. Retry after the Gateway balance refreshes.';
    case 'snapshot_not_found':
      return 'That saved snapshot could not be opened.';
    default:
      return message || 'Circle Paid request failed.';
  }
}

function CirclePaidCard({ item, agentId }) {
  const [expanded, setExpanded] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [activeSnapshotId, setActiveSnapshotId] = useState('');
  const [runError, setRunError] = useState('');
  const [topic, setTopic] = useState(item.id === 'ARC_EVENT_ODDS_COMPARE' ? 'bitcoin' : 'crypto');
  const [comparisonTopic, setComparisonTopic] = useState(item.id === 'ARC_EVENT_ODDS_COMPARE' ? 'ethereum' : '');
  const [previewResponse, setPreviewResponse] = useState(null);
  const [unlockedResponse, setUnlockedResponse] = useState(null);
  const [savedSnapshots, setSavedSnapshots] = useState([]);
  const isEventOddsCompare = item.id === 'ARC_EVENT_ODDS_COMPARE';
  const isActionFirst = item.arcTestnetActionable;
  const hasLiveRuntime = item.status === 'live';
  const sourceServices = Array.isArray(item.sourceServices) ? item.sourceServices : [];
  const statusLabel = formatCirclePaidStatus(item.status);
  const preview = previewResponse?.preview || null;
  const liveResult = unlockedResponse?.liveResult || null;
  const previewComparison = preview?.comparison || null;
  const liveComparison = liveResult?.comparison || null;

  const loadSavedSnapshots = useCallback(async () => {
    if (!agentId || !hasLiveRuntime) return;

    setSnapshotBusy(true);
    try {
      const response = await tasksApi.circlePaidSnapshots(agentId, {
        itemId: item.id,
        status: 'unlocked',
        limit: 6,
      });
      setSavedSnapshots(Array.isArray(response?.snapshots) ? response.snapshots : []);
    } catch (_error) {
      setSavedSnapshots([]);
    } finally {
      setSnapshotBusy(false);
    }
  }, [agentId, hasLiveRuntime, item.id]);

  useEffect(() => {
    if (!expanded || !hasLiveRuntime || !agentId) return;
    loadSavedSnapshots();
  }, [agentId, expanded, hasLiveRuntime, loadSavedSnapshots]);

  async function handlePreviewRun() {
    if (!agentId || !hasLiveRuntime) return;

    setPreviewBusy(true);
    setRunError('');

    try {
      const response = await tasksApi.circlePaidPreview(
        agentId,
        item.id,
        isEventOddsCompare
          ? { primaryTopic: topic, secondaryTopic: comparisonTopic, limit: 4 }
          : { topic },
      );
      setActiveSnapshotId('');
      setPreviewResponse(response);
      setUnlockedResponse(null);
    } catch (e) {
      setRunError(getCirclePaidErrorMessage(e?.data?.error || e?.message));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function handleUnlock() {
    if (!agentId || !previewResponse?.previewId) return;

    setUnlockBusy(true);
    setRunError('');

    try {
      const response = await tasksApi.circlePaidUnlock(agentId, previewResponse.previewId);
      setActiveSnapshotId(response?.snapshotId || '');
      setUnlockedResponse(response);
      await loadSavedSnapshots();
    } catch (e) {
      setRunError(getCirclePaidErrorMessage(e?.data?.error || e?.message));
    } finally {
      setUnlockBusy(false);
    }
  }

  async function handleOpenSavedSnapshot(snapshotId) {
    if (!agentId || !snapshotId) return;

    setSnapshotBusy(true);
    setRunError('');

    try {
      const response = await tasksApi.circlePaidSnapshot(agentId, snapshotId);
      const snapshot = response?.snapshot;
      if (!snapshot) throw new Error('snapshot_not_found');

      setActiveSnapshotId(snapshot.snapshotId);
      setPreviewResponse(null);

      if (snapshot.fullResult) {
        setUnlockedResponse({
          snapshotId: snapshot.snapshotId,
          status: snapshot.status,
          liveResult: snapshot.fullResult,
          economy: snapshot.economy,
          recommendedTask: snapshot.recommendedTask,
          note: snapshot.note,
          savedSnapshot: {
            createdAt: snapshot.createdAt,
            unlockedAt: snapshot.unlockedAt,
          },
          nextAction: snapshot.nextAction,
        });
      } else {
        setUnlockedResponse(null);
      }
    } catch (e) {
      setRunError(getCirclePaidErrorMessage(e?.data?.error || e?.message));
    } finally {
      setSnapshotBusy(false);
    }
  }

  const previewTotalFeeUsdc = previewResponse?.pricing?.totalFeeUsdc;
  const previewExpiresAt = previewResponse?.unlock?.expiresAt;
  const previewActionHint = previewResponse?.nextAction?.hint || 'Unlock never auto-executes the suggested Arc action.';
  const isAnyBusy = previewBusy || unlockBusy;
  const savedSnapshotCount = savedSnapshots.length;
  const isViewingSavedSnapshot = Boolean(activeSnapshotId && savedSnapshots.some(snapshot => snapshot.snapshotId === activeSnapshotId));
  const liveResultNote = isViewingSavedSnapshot
    ? 'This is a saved result. Any next Arc action still needs a separate manual confirmation.'
    : unlockedResponse?.note;
  const hasInvalidComparisonTopics = isEventOddsCompare
    && topic.trim()
    && comparisonTopic.trim()
    && topic.trim().toLowerCase() === comparisonTopic.trim().toLowerCase();

  const todayCopy = hasLiveRuntime
    ? isEventOddsCompare
      ? 'Start with a free preview. Pay only if you want the full comparison saved to your account.'
      : 'Start with a free preview. Pay only if you want the full result saved to your account.'
    : 'This card is still a preview. Opening it does not charge anything and does not start any on-chain step yet.';

  const paymentCopy = hasLiveRuntime
    ? isEventOddsCompare
      ? 'Free preview is live. Payment unlocks the full comparison and saves it. Any later Arc action is still separate.'
      : 'Free preview is live. Payment unlocks the full result and saves it. Any later Arc action is still separate.'
    : 'This card is still in preview. Prices shown here are planning estimates until it goes live.';

  const currentSourceLabel = hasLiveRuntime ? 'Data source' : 'Planned source';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-slate-800">{item.title}</p>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              isActionFirst
                ? 'border-green-200 bg-green-50 text-green-700'
                : 'border-slate-200 bg-slate-50 text-slate-500'
            }`}>
              {isActionFirst ? 'Before you act' : 'Extra context'}
            </span>
            <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-500">{item.description}</p>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Reference provider fee</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatCirclePaidFeeUsdc(item.pricing?.providerFeeUsdc)} USDC</p>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Arc fee if paid later</p>
          <p className="mt-1 text-sm font-semibold text-amber-800">{formatCirclePaidFeeUsdc(item.pricing?.arcFeeUsdc)} USDC</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Reference total if paid later</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatCirclePaidFeeUsdc(item.pricing?.totalFeeUsdc)} USDC</p>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-slate-600">{item.whyItMatters || item.description}</p>
          <p className="mt-1 text-[11px] text-slate-400">
            {hasLiveRuntime
              ? 'Open the card to start a free preview. Paying later only unlocks the full result and saved copy.'
              : 'Open the card to see what is planned and what it may cost later.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(current => !current)}
          className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? 'Close' : hasLiveRuntime ? 'Open live preview' : 'View details'}
        </button>
      </div>
      {expanded && (
        <div className="mt-3 space-y-3 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
          <div className={`rounded-lg border px-3 py-2 text-xs ${hasLiveRuntime ? 'border-green-200 bg-green-50 text-green-700' : 'border-slate-200 bg-white text-slate-600'}`}>
            <strong>Today:</strong>{' '}
            {todayCopy}
          </div>

          {hasLiveRuntime && (
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
              <div className={`grid gap-2 ${isEventOddsCompare ? 'sm:grid-cols-2' : ''}`}>
                <label className="min-w-0 flex-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {isEventOddsCompare ? 'Primary topic' : 'Preview topic'}
                  </span>
                  <input
                    type="text"
                    value={topic}
                    maxLength={80}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder={isEventOddsCompare ? 'bitcoin' : 'crypto, bitcoin, stablecoin'}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                  />
                </label>
                {isEventOddsCompare && (
                  <label className="min-w-0 flex-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Comparison topic</span>
                    <input
                      type="text"
                      value={comparisonTopic}
                      maxLength={80}
                      onChange={(event) => setComparisonTopic(event.target.value)}
                      placeholder="ethereum"
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                    />
                  </label>
                )}
              </div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="button"
                  onClick={handlePreviewRun}
                  disabled={isAnyBusy || !agentId || !topic.trim() || (isEventOddsCompare && (!comparisonTopic.trim() || hasInvalidComparisonTopics))}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {previewBusy ? <Spinner size={11} /> : <Play size={11} />}
                  {previewBusy ? 'Starting...' : preview ? 'Run preview again' : 'Start free preview'}
                </button>
                {hasInvalidComparisonTopics && (
                  <p className="text-xs text-red-500">Use two different topics so this card compares something real.</p>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                {isEventOddsCompare
                  ? 'Free preview compares two topic clusters and shows whether they stay aligned, split, or diverge. Unlock is a separate paid step for the full comparison and saved snapshot only.'
                  : 'Free preview runs the live market adapter and returns a lightweight signal. Unlock is a separate paid step for the full result and saved snapshot only.'}
              </p>
              {runError && (
                <p className="mt-2 text-xs text-red-500">{runError}</p>
              )}
            </div>
          )}

          {hasLiveRuntime && preview && !liveResult && (
            <div className="space-y-3 rounded-xl border border-indigo-200 bg-white p-3">
              <div className="space-y-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Free preview</p>
                  <p className="mt-1 text-sm font-semibold leading-6 text-slate-900">{preview.summary}</p>
                  {previewResponse?.note && (
                    <p className="mt-1 text-xs leading-5 text-slate-500">{previewResponse.note}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getCirclePaidRegimeClasses(preview.regime)}`}>
                    {String(preview.regime || 'UNKNOWN').toLowerCase()}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    Confidence {String(preview.confidence || 'LOW').toLowerCase()}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{isEventOddsCompare ? 'Combined matches' : 'Matches'}</p>
                  <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{preview.metrics?.matchingMarkets ?? '—'}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{isEventOddsCompare ? 'Move gap' : 'Avg 24h move'}</p>
                  <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatCirclePaidPercent(isEventOddsCompare ? preview.metrics?.movementGapPct : preview.metrics?.averageOneDayMovePct)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{isEventOddsCompare ? 'Liquidity gap' : 'Avg liquidity'}</p>
                  <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatCirclePaidUsdCompact(isEventOddsCompare ? preview.metrics?.liquidityGapUsd : preview.metrics?.averageLiquidityUsd)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">24h volume</p>
                  <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatCirclePaidUsdCompact(preview.metrics?.totalVolume24hrUsd)}</p>
                </div>
              </div>

              {isEventOddsCompare && previewComparison && (
                <CirclePaidComparisonPanel comparison={previewComparison} />
              )}

              {!liveResult && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Unlock full result + save snapshot</p>
                      <p className="mt-1 leading-5">
                        Pay <strong>{formatCirclePaidFeeUsdc(previewTotalFeeUsdc)} USDC</strong> to reveal the {isEventOddsCompare ? 'full side-by-side comparison' : 'full matched markets'} and save this result as a reusable snapshot.
                      </p>
                      <p className="mt-1 leading-5">{previewActionHint}</p>
                      {previewExpiresAt && (
                        <p className="mt-1 text-[11px] text-amber-700">Preview expires at {formatTimestamp(previewExpiresAt)}.</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={handleUnlock}
                      disabled={unlockBusy || previewBusy || !previewResponse?.previewId}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {unlockBusy ? <Spinner size={11} /> : <Lock size={11} />}
                      {unlockBusy ? 'Unlocking...' : 'Unlock full result'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {hasLiveRuntime && liveResult && (
            <div className="space-y-3 rounded-xl border border-green-200 bg-white p-3">
              <div className="space-y-2.5">
                <div className="w-full min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {isViewingSavedSnapshot ? 'Saved snapshot result' : 'Unlocked result'}
                  </p>
                  <p className="mt-1 w-full min-w-0 text-sm font-semibold leading-6 text-slate-900">{liveResult.summary}</p>
                  {liveResultNote && (
                    <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{liveResultNote}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getCirclePaidRegimeClasses(liveResult.regime)}`}>
                    {String(liveResult.regime || 'UNKNOWN').toLowerCase()}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    Confidence {String(liveResult.confidence || 'LOW').toLowerCase()}
                  </span>
                  {unlockedResponse?.economy?.status && !isViewingSavedSnapshot && (
                    <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                      Payment {String(unlockedResponse.economy.status).toLowerCase()}
                    </span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{isEventOddsCompare ? 'Combined matches' : 'Matches'}</p>
                  <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{liveResult.metrics?.matchingMarkets ?? '—'}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{isEventOddsCompare ? 'Move gap' : 'Avg 24h move'}</p>
                  <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatCirclePaidPercent(isEventOddsCompare ? liveResult.metrics?.movementGapPct : liveResult.metrics?.averageOneDayMovePct)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{isEventOddsCompare ? 'Liquidity gap' : 'Avg liquidity'}</p>
                  <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatCirclePaidUsdCompact(isEventOddsCompare ? liveResult.metrics?.liquidityGapUsd : liveResult.metrics?.averageLiquidityUsd)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">24h volume</p>
                  <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatCirclePaidUsdCompact(liveResult.metrics?.totalVolume24hrUsd)}</p>
                </div>
              </div>

              {isEventOddsCompare && liveComparison && (
                <CirclePaidComparisonPanel comparison={liveComparison} highlightSets={liveResult.highlights} />
              )}

              {(unlockedResponse?.savedSnapshot?.unlockedAt || unlockedResponse?.savedSnapshot?.createdAt) && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Saved snapshot: <strong>{formatTimestamp(unlockedResponse?.savedSnapshot?.unlockedAt || unlockedResponse?.savedSnapshot?.createdAt)}</strong>
                </div>
              )}

              {!isEventOddsCompare && Array.isArray(liveResult.highlights) && liveResult.highlights.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Matched markets</p>
                  <div className="mt-2 space-y-2">
                    {liveResult.highlights.map((highlight, index) => (
                      <div key={`${item.id}:highlight:${highlight.marketId || index}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold leading-5 text-slate-800">{highlight.question}</p>
                            {highlight.eventTitle && (
                              <p className="mt-1 text-[11px] text-slate-500">{highlight.eventTitle}</p>
                            )}
                          </div>
                          {highlight.url && (
                            <a
                              href={highlight.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
                            >
                              <ExternalLink size={11} /> Open
                            </a>
                          )}
                        </div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-3">
                          <div className="rounded-lg border border-white bg-white px-2.5 py-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Yes price</p>
                            <p className="mt-1 text-xs font-semibold text-slate-800">{formatCirclePaidPercent(highlight.yesProbabilityPct)}</p>
                          </div>
                          <div className="rounded-lg border border-white bg-white px-2.5 py-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">24h move</p>
                            <p className="mt-1 text-xs font-semibold text-slate-800">{formatCirclePaidPercent(highlight.oneDayPriceChangePct)}</p>
                          </div>
                          <div className="rounded-lg border border-white bg-white px-2.5 py-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Liquidity</p>
                            <p className="mt-1 text-xs font-semibold text-slate-800">{formatCirclePaidUsdCompact(highlight.liquidityUsd)}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {liveResult.methodology && (
                <p className="text-[11px] leading-5 text-slate-500">{liveResult.methodology}</p>
              )}
            </div>
          )}

          {hasLiveRuntime && (
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Saved snapshots</p>
                  <p className="mt-1 text-xs text-slate-500">Only paid unlocked results appear here. Free previews do not become saved snapshots.</p>
                </div>
                <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                  {savedSnapshotCount} saved
                </span>
              </div>

              <div className="mt-3 space-y-2">
                {snapshotBusy && savedSnapshotCount === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Spinner size={11} /> Loading saved snapshots...
                  </div>
                ) : savedSnapshotCount === 0 ? (
                  <p className="text-xs text-slate-500">No paid saved snapshots yet for this card.</p>
                ) : (
                  savedSnapshots.map(snapshot => (
                    <div
                      key={snapshot.snapshotId}
                      className={`rounded-lg border px-3 py-3 ${
                        activeSnapshotId === snapshot.snapshotId
                          ? 'border-indigo-200 bg-indigo-50/40'
                          : 'border-slate-200 bg-slate-50'
                      }`}
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-xs font-semibold leading-5 text-slate-800">{truncateCirclePaidText(snapshot.preview?.summary || 'Saved live market snapshot')}</p>
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getCirclePaidRegimeClasses(snapshot.preview?.regime)}`}>
                              {String(snapshot.preview?.regime || 'UNKNOWN').toLowerCase()}
                            </span>
                            {activeSnapshotId === snapshot.snapshotId && (
                              <span className="inline-flex items-center rounded-full border border-indigo-200 bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                                Opened
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {getCirclePaidSnapshotMeta(snapshot.preview, isEventOddsCompare).map(meta => (
                              <span
                                key={`${snapshot.snapshotId}:${meta}`}
                                className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600"
                              >
                                {meta}
                              </span>
                            ))}
                          </div>
                          <p className="mt-1 text-[11px] text-slate-500">
                            Saved {formatTimestamp(snapshot.unlockedAt || snapshot.createdAt)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleOpenSavedSnapshot(snapshot.snapshotId)}
                          disabled={snapshotBusy}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {snapshotBusy ? <Spinner size={10} /> : <ChevronDown size={10} />}
                          {activeSnapshotId === snapshot.snapshotId ? 'Reload saved snapshot' : 'Open saved snapshot'}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">What this service is for</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">{item.whyItMatters || item.description}</p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">What the user gets back</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">{item.whatYouGet || 'A clearer decision before choosing a live Arc action.'}</p>
          </div>

          {Array.isArray(item.howItWorks) && item.howItWorks.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{hasLiveRuntime ? 'How the live card works' : 'When this goes live'}</p>
              <div className="mt-2 space-y-2">
                {item.howItWorks.map((step, index) => (
                  <div key={`${item.id}:step:${index + 1}`} className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-50 text-[11px] font-semibold text-slate-600 border border-slate-200">
                      {index + 1}
                    </span>
                    <p className="text-xs leading-5 text-slate-600">{step}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Payment model</p>
            <p className="mt-1 leading-5">{paymentCopy}</p>
          </div>

          {sourceServices.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{currentSourceLabel}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {sourceServices.map(service => (
                  <span
                    key={`${item.id}:${service}`}
                    className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600"
                  >
                    {service}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

}

function getTaskRunErrorMessage(message) {
  switch (message) {
    case 'daily_tasks_disabled':
      return 'Enable tasks for this agent before running tasks.';
    case 'daily_task_cap_reached':
      return 'This agent has reached its total free task limit for today.';
    case 'daily_paid_cap_reached':
      return 'This agent has reached its paid execution limit for today.';
    case 'params_required':
      return 'Configure this execution task before running it.';
    case 'curve_swap_amount_required':
      return 'Enter an amount for the curve swap.';
    case 'curve_swap_direction_required':
      return 'Choose a valid swap direction.';
    case 'curve_liquidity_add_amount_required':
      return 'Enter an amount for the liquidity add.';
    case 'curve_liquidity_add_token_required':
      return 'Choose the token used for the liquidity add.';
    case 'curve_liquidity_remove_amount_required':
      return 'Enter a Curve LP amount to withdraw.';
    case 'curve_liquidity_remove_token_required':
      return 'Choose which token should be withdrawn from Curve LP.';
    case 'position_guard_unavailable':
      return 'Live protocol positions could not be read right now. Retry after the positions view refreshes.';
    case 'lp_position_not_found':
      return 'This agent does not currently hold Curve LP in the selected pool.';
    case 'insufficient_lp_position':
      return 'The requested LP withdrawal is larger than the current live Curve LP balance.';
    case 'lp_position_exit_required':
      return 'This agent already has live Curve liquidity in the target stable pool. Exit or reduce that LP position before running rebalance.';
    case 'bridge_from_chain_required':
      return 'Choose a source chain.';
    case 'bridge_to_chain_required':
      return 'Choose a destination chain.';
    case 'bridge_route_invalid':
      return 'Choose different source and destination chains.';
    case 'bridge_amount_required':
      return 'Enter a bridge amount.';
    case 'arb_amount_required':
      return 'Enter an amount for arbitrage execution.';
    case 'rebalance_amount_required':
      return 'Enter an amount for portfolio rebalancing.';
    case 'rebalance_from_token_required':
      return 'Choose the source token for rebalancing.';
    case 'rebalance_to_token_required':
      return 'Choose the destination token for rebalancing.';
    case 'rebalance_route_invalid':
      return 'Choose different source and destination tokens for rebalancing.';
    case 'pair_zap_amount_required':
      return 'Enter a budget for the direct cirBTC LP bootstrap task.';
    case 'pair_zap_amount_exceeds_max':
      return 'This bootstrap task only supports the capped preset size for now.';
    case 'pair_exit_pct_invalid':
      return 'Enter a valid LP withdrawal percentage between 0 and 100.';
    case 'swap_not_configured':
      return 'No direct execution rail is configured for this task on this deployment.';
    case 'direct_pair_not_configured':
      return 'This direct cirBTC pair is not configured on the current deployment yet.';
    case 'direct_pair_seed_required':
      return 'The direct cirBTC pair exists but still needs initial seed liquidity before this task can run.';
    case 'wallet_not_configured':
      return 'This agent wallet is not ready for live protocol position checks yet.';
    case 'task_not_found':
      return 'This task is no longer available.';
    case 'agent_not_found':
      return 'This agent is no longer available.';
    case 'task_already_running':
      return 'This task is already running. Wait for the current run to finish before starting it again.';
    case 'manual_task_queue_unavailable':
      return 'The task worker is not ready right now. Retry in a moment.';
    case 'bridge_native_topup_error':
      return 'The native gas bridge did not complete successfully.';
    default:
      return message || 'Failed to run task';
  }
}

function isExecutionTask(taskId) {
  return EXECUTION_TASK_IDS.has(taskId);
}

function getInitialTaskParams(taskId) {
  switch (taskId) {
    case 'EXEC_CURVE_SWAP':
      return { amountIn: '', indexIn: 0, indexOut: 1 };
    case 'EXEC_CURVE_LIQUIDITY_ADD':
      return { tokenIn: 'USDC', amountIn: '' };
    case 'EXEC_CURVE_LIQUIDITY_REMOVE':
      return { tokenOut: 'USDC', lpAmount: '' };
    case 'EXEC_CIRBTC_USDC_ZAP_IN':
      return { amountIn: DIRECT_PAIR_ZAP_PRESETS.EXEC_CIRBTC_USDC_ZAP_IN.defaultAmountIn };
    case 'EXEC_CIRBTC_EURC_ZAP_IN':
      return { amountIn: DIRECT_PAIR_ZAP_PRESETS.EXEC_CIRBTC_EURC_ZAP_IN.defaultAmountIn };
    case 'EXEC_CIRBTC_USDC_LP_REMOVE':
      return { withdrawPct: DIRECT_PAIR_EXIT_PRESETS.EXEC_CIRBTC_USDC_LP_REMOVE.defaultWithdrawPct };
    case 'EXEC_CIRBTC_EURC_LP_REMOVE':
      return { withdrawPct: DIRECT_PAIR_EXIT_PRESETS.EXEC_CIRBTC_EURC_LP_REMOVE.defaultWithdrawPct };
    case 'EXEC_CCTP_BRIDGE':
      return { fromChain: 'Arc Testnet', toChain: 'Base Sepolia', amountUsdc: '' };
    case 'EXEC_ARB':
      return { amountIn: '' };
    case 'EXEC_REBALANCE':
      return { fromToken: 'USDC', toToken: 'EURC', amountIn: '' };
    default:
      return {};
  }
}

function getTaskParamError(taskId, params) {
  switch (taskId) {
    case 'EXEC_CURVE_SWAP':
      if (!(Number(params.amountIn) > 0)) return 'Enter an amount for the curve swap.';
      if (Number(params.indexIn) === Number(params.indexOut)) return 'Choose a valid swap direction.';
      return '';
    case 'EXEC_CURVE_LIQUIDITY_ADD':
      if (!params.tokenIn) return 'Choose the token used for the liquidity add.';
      if (!(Number(params.amountIn) > 0)) return 'Enter an amount for the liquidity add.';
      return '';
    case 'EXEC_CURVE_LIQUIDITY_REMOVE':
      if (!params.tokenOut) return 'Choose which token should be withdrawn from Curve LP.';
      if (!(Number(params.lpAmount) > 0)) return 'Enter a Curve LP amount to withdraw.';
      return '';
    case 'EXEC_CIRBTC_USDC_ZAP_IN':
    case 'EXEC_CIRBTC_EURC_ZAP_IN': {
      const preset = DIRECT_PAIR_ZAP_PRESETS[taskId];
      if (!(Number(params.amountIn) > 0)) return 'Enter a budget for the LP bootstrap task.';
      if (Number(params.amountIn) > Number(preset?.maxAmountIn || 0)) return `Keep this bootstrap task at or below ${preset?.maxAmountIn || 0} ${preset?.token || 'stable'}.`;
      return '';
    }
    case 'EXEC_CIRBTC_USDC_LP_REMOVE':
    case 'EXEC_CIRBTC_EURC_LP_REMOVE':
      if (!(Number(params.withdrawPct) > 0) || Number(params.withdrawPct) > 100) {
        return 'Enter an LP withdrawal percentage between 0 and 100.';
      }
      return '';
    case 'EXEC_CCTP_BRIDGE':
      if (!params.fromChain) return 'Choose a source chain.';
      if (!params.toChain) return 'Choose a destination chain.';
      if (params.fromChain === params.toChain) return 'Choose different source and destination chains.';
      if (!(Number(params.amountUsdc) > 0)) return 'Enter a bridge amount.';
      return '';
    case 'EXEC_ARB':
      if (!(Number(params.amountIn) > 0)) return 'Enter an amount for arbitrage execution.';
      return '';
    case 'EXEC_REBALANCE':
      if (!params.fromToken || !params.toToken) return 'Choose a rebalance token route.';
      if (params.fromToken === params.toToken) return 'Choose different source and destination tokens for rebalancing.';
      if (!(Number(params.amountIn) > 0)) return 'Enter an amount for portfolio rebalancing.';
      return '';
    default:
      return '';
  }
}

function buildTaskParams(taskId, params) {
  switch (taskId) {
    case 'EXEC_CURVE_SWAP':
      return {
        amountIn: Number(params.amountIn),
        indexIn: Number(params.indexIn),
        indexOut: Number(params.indexOut),
      };
    case 'EXEC_CURVE_LIQUIDITY_ADD':
      return {
        tokenIn: params.tokenIn,
        amountIn: Number(params.amountIn),
      };
    case 'EXEC_CURVE_LIQUIDITY_REMOVE':
      return {
        tokenOut: params.tokenOut,
        lpAmount: Number(params.lpAmount),
      };
    case 'EXEC_CIRBTC_USDC_ZAP_IN':
    case 'EXEC_CIRBTC_EURC_ZAP_IN':
      return {
        amountIn: Number(params.amountIn),
      };
    case 'EXEC_CIRBTC_USDC_LP_REMOVE':
    case 'EXEC_CIRBTC_EURC_LP_REMOVE':
      return {
        withdrawPct: Number(params.withdrawPct),
      };
    case 'EXEC_CCTP_BRIDGE':
      return {
        fromChain: params.fromChain,
        toChain: params.toChain,
        amountUsdc: Number(params.amountUsdc),
      };
    case 'EXEC_ARB':
      return {
        amountIn: Number(params.amountIn),
      };
    case 'EXEC_REBALANCE':
      return {
        fromToken: params.fromToken,
        toToken: params.toToken,
        amountIn: Number(params.amountIn),
      };
    default:
      return params;
  }
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function humanizeAutomationStatus(status) {
  const labels = {
    idle: 'Idle',
    running: 'Running',
    success: 'Healthy',
    db_only: 'Local Only',
    no_signal: 'No Signal',
    gate_blocked: 'Gate Hold',
    executed: 'Executed',
    dry_run: 'Dry Run',
    no_opportunity: 'No Opportunity',
    cap_reached: 'Daily Cap Reached',
    fetch_error: 'Fetch Error',
    decision_error: 'Decision Error',
    execution_error: 'Execution Error',
    dry_run_failed: 'Dry Run Failed',
    disabled: 'Disabled',
    missing_agent: 'Missing Agent',
    no_private_key: 'Missing Key',
    pool_unconfigured: 'Pool Missing',
    swap_error: 'Swap Error',
    db_error: 'DB Warning',
    chain_error: 'Chain Warning',
    error: 'Error',
  };

  return labels[status] || String(status || 'idle').replace(/_/g, ' ');
}

function getAutomationStatusClasses(status, enabled) {
  if (!enabled) return 'border-slate-200 bg-slate-50 text-slate-500';
  if (status === 'running') return 'border-blue-200 bg-blue-50 text-blue-700';
  if (['success', 'executed', 'dry_run'].includes(status)) return 'border-green-200 bg-green-50 text-green-700';
  if (['idle', 'no_signal'].includes(status)) return 'border-slate-200 bg-slate-50 text-slate-600';
  if (['gate_blocked', 'cap_reached', 'disabled', 'pool_unconfigured', 'no_private_key'].includes(status)) {
    return 'border-amber-200 bg-amber-50 text-amber-700';
  }
  return 'border-red-200 bg-red-50 text-red-700';
}

function getAutomationSummary(feature, state) {
  const bypassNote = state?.bypassDailyCap
    ? ' Daily cap bypass is active for this whitelisted testnet agent, so the nominal cap is informational only.'
    : '';

  switch (feature.statusKey) {
    case 'marketAnalysis':
      return state?.lastStatus === 'success'
        ? 'Latest market check completed. This step only refreshes context.'
        : 'Runs background market checks. No funds move here.';
    case 'oracle':
      return `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 48)} oracle updates completed. This keeps price and opportunity data fresh and does not trade by itself.${bypassNote}`;
    case 'defiLoop':
      if (state?.lastStatus === 'dry_run') {
        return `Simulation mode is active. ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} checks ran and ${Number(state?.autoTxToday || 0)} real auto trades were sent.${bypassNote}`;
      }
      return `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} auto checks ran and ${Number(state?.autoTxToday || 0)} trades were sent. This toggle controls only the verified USDC -> EURC stable lane.${bypassNote}`;
    case 'cirbtcLp':
      if (state?.lastStatus === 'dry_run') {
        return `Simulation mode is active. ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} shared DeFi loop checks ran and ${Number(state?.autoTxToday || 0)} real auto trades were sent.${bypassNote}`;
      }
      return `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} shared DeFi loop checks ran and ${Number(state?.autoTxToday || 0)} real auto trades were sent. This toggle controls only the verified cirBTC direct-pair LP lane.${bypassNote}`;
    case 'reputation':
      return state?.lastStatus === 'db_only'
        ? 'Saving reputation activity locally. On-chain posting is off right now.'
        : 'Updates when tasks, oracle events, or transactions create new reputation activity.';
    default:
      return 'Triggered when smart-mode analysis jobs are queued for this agent.';
  }
}

function formatReputationEventType(eventType) {
  return REPUTATION_EVENT_LABELS[eventType] || String(eventType || 'Unknown Event').replace(/_/g, ' ');
}

function getOnchainReputationLabel(onchain) {
  switch (onchain?.status) {
    case 'live':
      return 'On-chain live';
    case 'identity_required':
      return 'Identity required';
    case 'token_missing':
      return 'Token missing';
    case 'read_error':
      return 'Read error';
    default:
      return 'Local only';
  }
}

function getOnchainReputationMessage(onchain) {
  switch (onchain?.status) {
    case 'live':
      return 'Reputation writes are mirrored on-chain and can be read back from the registry.';
    case 'identity_required':
      return 'Register the agent identity first so reputation can be attached to an ERC-8004 token.';
    case 'token_missing':
      return 'Identity is marked registered, but no ERC-8004 token id was found on the agent record.';
    case 'read_error':
      return 'The registry address is configured, but the current on-chain score could not be read.';
    default:
      return 'Events are still counted locally even while the registry is not configured.';
  }
}

function getCurveStableTokenLabel(index) {
  const numeric = Number(index);
  if (numeric === 0) return 'USDC';
  if (numeric === 1) return 'EURC';
  return `coin ${index}`;
}

function getExecutionRailLabel(executionRail) {
  switch (String(executionRail || '').toLowerCase()) {
    case 'swap_kit':
      return 'Swap Kit';
    case 'curve_fallback':
      return 'Curve fallback';
    case 'uniswap_v2_fallback':
      return 'Uniswap V2 fallback';
    default:
      return executionRail || 'configured route';
  }
}

function isRealHash(hash) {
  return /^0x[0-9a-fA-F]{64}$/.test(hash || '');
}

function getTaskExplorerTxUrl(chainName, txHash) {
  const explorerBase = CHAINS[chainName]?.explorerUrl;
  if (!explorerBase || !isRealHash(txHash)) return null;
  return `${explorerBase}/tx/${txHash}`;
}

function getTaskExplorerAddressUrl(chainName, address) {
  const explorerBase = CHAINS[chainName]?.explorerUrl;
  if (!explorerBase || !address) return null;
  return `${explorerBase}/address/${address}`;
}

function pushTaskExecutionLink(links, { label, chainName = 'Arc Testnet', hash }) {
  const url = getTaskExplorerTxUrl(chainName, hash);
  if (!url) return;

  const key = `${label}:${hash}`;
  if (links.some(link => link.key === key)) return;

  links.push({ key, label, hash, url });
}

function getArbExecutionTokens(payload) {
  if (payload?.direction === 'sell_eurc') {
    return {
      fromToken: payload?.fromToken || 'EURC',
      toToken: payload?.toToken || 'USDC',
    };
  }

  return {
    fromToken: payload?.fromToken || 'USDC',
    toToken: payload?.toToken || 'EURC',
  };
}

function getTaskExecutionLinks(payload) {
  const links = [];
  if (!payload || typeof payload !== 'object') return links;

  const isCurveStableSwap = payload.poolAddress
    && payload.indexIn != null
    && payload.indexOut != null
    && payload.amountIn != null
    && !payload.signal;

  if (isCurveStableSwap) {
    pushTaskExecutionLink(links, {
      label: 'Swap tx',
      chainName: 'Arc Testnet',
      hash: payload.txHash || payload.hash,
    });
  }

  const isRebalancePayload = payload.fromToken
    && payload.toToken
    && payload.amountIn != null
    && payload.executionRail
    && !payload.signal;

  if (isRebalancePayload) {
    pushTaskExecutionLink(links, {
      label: 'Swap tx',
      chainName: 'Arc Testnet',
      hash: payload.txHash || payload.hash,
    });
  }

  if (payload.executionRail === 'curve_liquidity_add') {
    pushTaskExecutionLink(links, {
      label: 'Add liquidity tx',
      chainName: 'Arc Testnet',
      hash: payload.txHash || payload.hash,
    });
  }

  if (payload.executionRail === 'curve_liquidity_remove') {
    pushTaskExecutionLink(links, {
      label: 'Withdraw liquidity tx',
      chainName: 'Arc Testnet',
      hash: payload.txHash || payload.hash,
    });
  }

  pushTaskExecutionLink(links, {
    label: 'Swap tx',
    chainName: 'Arc Testnet',
    hash: payload.swapTxHash || payload.swap?.txHash || payload.swap?.hash,
  });

  pushTaskExecutionLink(links, {
    label: 'Burn tx',
    chainName: payload.fromChain || 'Arc Testnet',
    hash: payload.burnTxHash,
  });

  pushTaskExecutionLink(links, {
    label: 'Mint tx',
    chainName: payload.toChain || 'Arc Testnet',
    hash: payload.mintTxHash,
  });

  if (Array.isArray(payload.targets)) {
    payload.targets.forEach((target) => {
      pushTaskExecutionLink(links, {
        label: `${target.toChain} tx`,
        chainName: target.toChain,
        hash: target.topUpTxHash,
      });
    });
  }

  pushTaskExecutionLink(links, {
    label: 'Fee settlement tx',
    chainName: payload.economy?.destinationChain || 'Arc Testnet',
    hash: payload.economy?.gatewayMintTxHash,
  });

  return links;
}

function TaskExecutionLinks({ links }) {
  if (!Array.isArray(links) || links.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {links.map(link => (
        <a
          key={link.key}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-white px-2 py-1 text-[11px] font-mono text-emerald-700 hover:border-emerald-300 hover:text-emerald-800"
        >
          <span>{link.label}</span>
          <span>{link.hash.slice(0, 10)}…</span>
          <ExternalLink size={10} />
        </a>
      ))}
    </div>
  );
}

function getCompletedTaskLabel(task, payload) {
  switch (task?.id) {
    case 'EXEC_CURVE_SWAP':
      return 'Swap executed';
    case 'EXEC_REBALANCE':
      return 'Portfolio rebalanced';
    case 'EXEC_ARB':
      return payload?.swapTxHash || payload?.swap?.txHash || payload?.swap?.hash
        ? 'Signal trade executed'
        : 'Arbitrage evaluated';
    case 'EXEC_CCTP_BRIDGE':
      return 'Bridge completed';
    case 'EXEC_SEPOLIA_GAS_FANOUT':
      return 'Gas fanout completed';
    case 'EXEC_CURVE_LIQUIDITY_ADD':
      return 'Liquidity added';
    case 'EXEC_CURVE_LIQUIDITY_REMOVE':
      return 'Liquidity withdrawn';
    case 'EXEC_CIRBTC_USDC_ZAP_IN':
    case 'EXEC_CIRBTC_EURC_ZAP_IN':
      return 'LP bootstrap completed';
    case 'EXEC_CIRBTC_USDC_LP_REMOVE':
    case 'EXEC_CIRBTC_EURC_LP_REMOVE':
      return 'LP exit completed';
    default:
      return 'Task completed';
  }
}

function getTaskResultStatusMeta(task, payload) {
  if (payload?.dryRun) {
    if (task.id === 'EXEC_CCTP_BRIDGE') {
      return {
        label: 'Simulation only',
        buttonLabel: 'Simulated',
        panelClasses: 'bg-amber-50/80',
        iconClasses: 'text-amber-600',
        titleClasses: 'text-amber-800',
        detailClasses: 'text-amber-700',
        summary: `Simulation only. Would bridge ${payload.amountUsdc || '0'} USDC from ${payload.fromChain || 'source'} to ${payload.toChain || 'destination'}.`,
      };
    }

    if (task.id === 'EXEC_CURVE_SWAP') {
      return {
        label: 'Simulation only',
        buttonLabel: 'Simulated',
        panelClasses: 'bg-amber-50/80',
        iconClasses: 'text-amber-600',
        titleClasses: 'text-amber-800',
        detailClasses: 'text-amber-700',
        summary: `Simulation only. Would swap ${payload.amountIn || '0'} units through the configured Curve pool.`,
      };
    }

    if (task.id === 'EXEC_CURVE_LIQUIDITY_ADD') {
      return {
        label: 'Simulation only',
        buttonLabel: 'Simulated',
        panelClasses: 'bg-amber-50/80',
        iconClasses: 'text-amber-600',
        titleClasses: 'text-amber-800',
        detailClasses: 'text-amber-700',
        summary: `Simulation only. Would add ${payload.amountIn || '0'} ${payload.tokenIn || 'token'} as Curve liquidity.`,
      };
    }

    if (task.id === 'EXEC_CURVE_LIQUIDITY_REMOVE') {
      return {
        label: 'Simulation only',
        buttonLabel: 'Simulated',
        panelClasses: 'bg-amber-50/80',
        iconClasses: 'text-amber-600',
        titleClasses: 'text-amber-800',
        detailClasses: 'text-amber-700',
        summary: `Simulation only. Would withdraw ${payload.lpAmount || '0'} Curve LP into ${payload.tokenOut || 'token'}.`,
      };
    }

    if (task.id === 'EXEC_CIRBTC_USDC_ZAP_IN' || task.id === 'EXEC_CIRBTC_EURC_ZAP_IN') {
      return {
        label: 'Simulation only',
        buttonLabel: 'Simulated',
        panelClasses: 'bg-amber-50/80',
        iconClasses: 'text-amber-600',
        titleClasses: 'text-amber-800',
        detailClasses: 'text-amber-700',
        summary: `Simulation only. Would swap part of ${payload.amountIn || '0'} ${payload.stableToken || 'stable'} into cirBTC, then mint LP on the configured direct pair.`,
      };
    }

    if (task.id === 'EXEC_CIRBTC_USDC_LP_REMOVE' || task.id === 'EXEC_CIRBTC_EURC_LP_REMOVE') {
      return {
        label: 'Simulation only',
        buttonLabel: 'Simulated',
        panelClasses: 'bg-amber-50/80',
        iconClasses: 'text-amber-600',
        titleClasses: 'text-amber-800',
        detailClasses: 'text-amber-700',
        summary: `Simulation only. Would burn ${payload.withdrawPct || '0'}% of the current direct-pair LP position and return both underlying assets.`,
      };
    }

    if (task.id === 'EXEC_REBALANCE') {
      return {
        label: 'Simulation only',
        buttonLabel: 'Simulated',
        panelClasses: 'bg-amber-50/80',
        iconClasses: 'text-amber-600',
        titleClasses: 'text-amber-800',
        detailClasses: 'text-amber-700',
        summary: `Simulation only. Would rebalance ${payload.amountIn || '0'} from ${payload.fromToken || 'source'} to ${payload.toToken || 'destination'}.`,
      };
    }

    return {
      label: 'Simulation only',
      buttonLabel: 'Simulated',
      panelClasses: 'bg-amber-50/80',
      iconClasses: 'text-amber-600',
      titleClasses: 'text-amber-800',
      detailClasses: 'text-amber-700',
      summary: payload?.summary || `Simulation completed for ${task.title}. No on-chain transaction was sent.`,
    };
  }

  if (payload?.skipped) {
    return {
      label: 'No execution sent',
      buttonLabel: 'Skipped',
      panelClasses: 'bg-slate-50',
      iconClasses: 'text-slate-500',
      titleClasses: 'text-slate-700',
      detailClasses: 'text-slate-600',
      summary: payload?.summary || `${task.title} was evaluated, but market conditions did not justify an on-chain execution.`,
    };
  }

  return {
    label: getCompletedTaskLabel(task, payload),
    buttonLabel: 'Done',
    panelClasses: 'bg-green-50/60',
    iconClasses: 'text-green-600',
    titleClasses: 'text-green-800',
    detailClasses: 'text-slate-600',
    summary: payload?.summary || `${task.title} completed.`,
  };
}

function isTaskRunActive(run) {
  return ACTIVE_TASK_RUN_STATUSES.has(String(run?.status || '').toLowerCase());
}

function buildTaskRunResult(task, run) {
  if (!run || run.status !== 'completed') return null;

  const payload = run.result_payload || {};
  const meta = getTaskResultStatusMeta(task, payload);

  return {
    id: run.id,
    task_id: run.task_id || task.id,
    title: run.title || task.title,
    description: run.description || task.description,
    created_at: run.completed_at || run.updated_at || run.created_at,
    payload: {
      ...payload,
      summary: getTaskPayloadSummary(task, payload) || meta.summary,
    },
  };
}

function formatTaskMetricAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value || '0');
  if (numeric === 0) return '0';
  if (Math.abs(numeric) < 0.000001) return numeric.toExponential(6);
  if (Math.abs(numeric) < 0.01) return numeric.toFixed(10).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
  return numeric.toFixed(6).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

function formatTaskPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value || '0');
  return numeric.toFixed(2).replace(/\.00$/, '');
}

function getTaskPayloadSummary(task, payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (task?.id === 'EXEC_ARB') {
    const { fromToken, toToken } = getArbExecutionTokens(payload);
    const requestedAmount = formatTaskMetricAmount(payload.requestedAmountIn || payload.amountIn || 0);
    const hasExecutionTx = Boolean(
      payload.swapTxHash
      || payload.txHash
      || payload.bridgeTxHash
      || payload.swap?.txHash
      || payload.swap?.hash,
    );

    if (payload.dryRun) {
      return `Simulation only. Evaluated the latest signal for a requested ${requestedAmount} ${fromToken} Curve leg. This task does not complete the bridge or exit leg.`;
    }

    if (hasExecutionTx) {
      return `Executed a signal-driven Curve swap from ${requestedAmount} ${fromToken} to ${toToken}. This task does not complete the bridge or exit leg, so no realized arbitrage profit is claimed here.`;
    }

    if (payload.summary) return payload.summary;

    return `Evaluated the latest signal for a requested ${requestedAmount} ${fromToken} Curve leg. No on-chain trade was sent.`;
  }

  if (task?.id === 'EXEC_CURVE_SWAP') {
    const fromToken = getCurveStableTokenLabel(payload.indexIn);
    const toToken = getCurveStableTokenLabel(payload.indexOut);

    if (payload.txHash || payload.hash) {
      const amountIn = formatTaskMetricAmount(payload.amountIn || 0);
      const amountOut = payload.amountOut
        ? ` and received ${formatTaskMetricAmount(payload.amountOut)} ${toToken}`
        : '';
      return `Swapped ${amountIn} ${fromToken} to ${toToken} through the live Curve stable pool${amountOut}.`;
    }
  }

  if (task?.id === 'EXEC_REBALANCE' && (payload.txHash || payload.hash) && payload.fromToken && payload.toToken) {
    const amountIn = formatTaskMetricAmount(payload.amountIn || 0);
    const executionRail = getExecutionRailLabel(payload.executionRail);

    if (payload.amountOut) {
      return `Rebalanced ${amountIn} ${payload.fromToken} to ${formatTaskMetricAmount(payload.amountOut)} ${payload.toToken} via ${executionRail}.`;
    }

    return `Rebalanced ${amountIn} ${payload.fromToken} to ${payload.toToken} via ${executionRail}.`;
  }

  if (payload.summary) return payload.summary;

  return '';
}

function getTaskExecutionFactLines(payload) {
  const facts = [];
  if (!payload || typeof payload !== 'object') return facts;

  const isCurveStableSwap = payload.poolAddress
    && payload.indexIn != null
    && payload.indexOut != null
    && payload.amountIn != null
    && !payload.signal;

  if (isCurveStableSwap) {
    const fromToken = getCurveStableTokenLabel(payload.indexIn);
    const toToken = getCurveStableTokenLabel(payload.indexOut);
    facts.push(`Swap route: ${fromToken} -> ${toToken} via Curve stable pool`);
    if (payload.amountOut) {
      facts.push(`Received: ${formatTaskMetricAmount(payload.amountOut)} ${toToken}`);
    }
    if (payload.minDy) {
      facts.push(`Minimum protected output: ${formatTaskMetricAmount(payload.minDy)} ${toToken}`);
    }
  }

  const isRebalancePayload = payload.fromToken
    && payload.toToken
    && payload.amountIn != null
    && payload.executionRail
    && !payload.signal;

  if (isRebalancePayload) {
    facts.push(`Rebalance route: ${payload.fromToken} -> ${payload.toToken}`);
    facts.push(`Execution rail: ${getExecutionRailLabel(payload.executionRail)}`);
    if (payload.amountOut) {
      facts.push(`Received: ${formatTaskMetricAmount(payload.amountOut)} ${payload.toToken}`);
    }
  }

  if (payload.executionRail === 'curve_liquidity_add') {
    facts.push(`Liquidity route: ${payload.tokenIn || 'token'} -> Curve stable pool`);
    if (payload.lpAmount) {
      facts.push(`LP minted: ${formatTaskMetricAmount(payload.lpAmount)}`);
    }
    if (payload.minLpAmount) {
      facts.push(`Minimum LP protected: ${formatTaskMetricAmount(payload.minLpAmount)}`);
    }
  }

  if (payload.executionRail === 'curve_liquidity_remove') {
    facts.push(`Liquidity route: Curve LP -> ${payload.tokenOut || 'token'}`);
    if (payload.lpAmount) {
      facts.push(`LP burned: ${formatTaskMetricAmount(payload.lpAmount)}`);
    }
    if (payload.amountOut) {
      facts.push(`Returned: ${formatTaskMetricAmount(payload.amountOut)} ${payload.tokenOut || 'token'}`);
    }
    if (payload.minAmountOut) {
      facts.push(`Minimum protected output: ${formatTaskMetricAmount(payload.minAmountOut)} ${payload.tokenOut || 'token'}`);
    }
  }

  const arbOpportunity = payload.signal?.opportunity;

  if (arbOpportunity) {
    const { fromToken, toToken } = getArbExecutionTokens(payload);
    const hasExecutionTx = Boolean(
      payload.swapTxHash
      || payload.txHash
      || payload.bridgeTxHash
      || payload.swap?.txHash
      || payload.swap?.hash,
    );

    facts.push(`Signal: ${arbOpportunity.confidence || 'LOW'} confidence · spread ${formatTaskPercent(arbOpportunity.spreadPct || 0)}%`);
    facts.push(`Requested size: ${formatTaskMetricAmount(payload.requestedAmountIn || payload.amountIn || 0)} ${fromToken}`);
    if (hasExecutionTx) {
      facts.push(`Executed route: ${fromToken} -> ${toToken} via Curve stable pool`);
      if (payload.amountOut || payload.swap?.amountOut) {
        facts.push(`Received: ${formatTaskMetricAmount(payload.amountOut || payload.swap?.amountOut)} ${toToken}`);
      }
    } else if (payload.direction) {
      facts.push(`Current signal direction: ${payload.direction === 'buy_eurc' ? 'USDC -> EURC' : 'EURC -> USDC'}`);
    }
    if (arbOpportunity.found === false) {
      facts.push('Signal outcome: the full-route oracle model is not profitable right now.');
    }
    facts.push('Execution scope: this task only covers the Curve swap leg; bridge and exit legs are not executed here.');
  }

  if (payload.fromChain && payload.toChain && Number(payload.amountUsdc) > 0) {
    facts.push(`Bridge route: ${payload.fromChain} -> ${payload.toChain} · ${formatTaskMetricAmount(payload.amountUsdc)} USDC`);
  }

  if (payload.fromChain === 'Sepolia' && Array.isArray(payload.targets) && payload.targets.length > 0) {
    facts.push(`Fanout route: ${payload.targets.map(target => `${target.toChain} ${target.amountEth} ETH`).join(' · ')}`);
  }

  if (payload.swappedAmountIn && payload.amountOut && payload.stableToken) {
    facts.push(`Swap leg: ${formatTaskMetricAmount(payload.swappedAmountIn)} ${payload.stableToken} -> ${formatTaskMetricAmount(payload.amountOut)} ${payload.volatileToken || 'cirBTC'}`);
  }

  if (payload.swapExecutionRail || payload.swapRouteStrategy) {
    facts.push(`Swap route: ${payload.swapRouteStrategy || payload.swapExecutionRail}`);
  }

  if (payload.remainingAmountIn && payload.stableToken) {
    facts.push(`Liquidity budget: ${formatTaskMetricAmount(payload.remainingAmountIn)} ${payload.stableToken} reserved for the LP leg.`);
  }

  if (payload.liquidityStableAmountUsed && payload.liquidityVolatileAmountUsed) {
    facts.push(`LP leg used: ${formatTaskMetricAmount(payload.liquidityStableAmountUsed)} ${payload.stableToken} + ${formatTaskMetricAmount(payload.liquidityVolatileAmountUsed)} ${payload.volatileToken || 'cirBTC'}`);
  }

  if ((payload.liquidityStableAmountRemaining && Number(payload.liquidityStableAmountRemaining) > 0)
    || (payload.liquidityVolatileAmountRemaining && Number(payload.liquidityVolatileAmountRemaining) > 0)) {
    const leftovers = [
      Number(payload.liquidityStableAmountRemaining || 0) > 0 ? `${formatTaskMetricAmount(payload.liquidityStableAmountRemaining)} ${payload.stableToken}` : null,
      Number(payload.liquidityVolatileAmountRemaining || 0) > 0 ? `${formatTaskMetricAmount(payload.liquidityVolatileAmountRemaining)} ${payload.volatileToken || 'cirBTC'}` : null,
    ].filter(Boolean);
    facts.push(`Remainder kept in wallet: ${leftovers.join(' + ')}`);
  }

  if (payload.lpAmount && !['curve_liquidity_add', 'curve_liquidity_remove'].includes(payload.executionRail)) {
    facts.push(`LP minted: ${formatTaskMetricAmount(payload.lpAmount)}`);
  }

  if (payload.economy?.feeUsdc) {
    facts.push('Fee rail: x402 / Circle Gateway -> Arc revenue pool');
    facts.push(`Fee settled: ${formatTaskMetricAmount(payload.economy.feeUsdc)} USDC (${payload.economy.status || 'unknown'})`);
  }

  if (payload.token0Amount && payload.token0Symbol) {
    facts.push(`Returned: ${formatTaskMetricAmount(payload.token0Amount)} ${payload.token0Symbol}`);
  }

  if (payload.token1Amount && payload.token1Symbol) {
    facts.push(`Returned: ${formatTaskMetricAmount(payload.token1Amount)} ${payload.token1Symbol}`);
  }

  return facts;
}

function formatSignedScore(value) {
  const score = Number(value || 0);
  return score > 0 ? `+${score}` : `${score}`;
}

function getReputationSetupToneClasses(tone) {
  switch (tone) {
    case 'green':
      return 'border-green-200 bg-green-50 text-green-700';
    case 'red':
      return 'border-red-200 bg-red-50 text-red-700';
    case 'amber':
    default:
      return 'border-amber-200 bg-amber-50 text-amber-700';
  }
}

function getReputationSetupItems(reputationOverview) {
  const onchain = reputationOverview?.onchain || {};

  return [
    {
      key: 'tracking',
      title: 'Tracking switch',
      status: reputationOverview?.reputationEnabled ? 'Live' : 'Action needed',
      tone: reputationOverview?.reputationEnabled ? 'green' : 'amber',
      detail: reputationOverview?.reputationEnabled
        ? 'New qualifying activity can create reputation events.'
        : 'Turn on Reputation Tracking for this agent to start recording new events.',
    },
    {
      key: 'identity',
      title: 'Identity link',
      status: onchain.identityRegistered ? 'Registered' : 'Not ready',
      tone: onchain.identityRegistered ? 'green' : 'amber',
      detail: onchain.identityRegistered
        ? `Agent is linked to ERC-8004 token #${onchain.tokenId || '—'} for on-chain score sync.`
        : 'Register the agent identity so reputation can attach to an ERC-8004 token.',
    },
    {
      key: 'registry',
      title: 'Registry relay',
      status: !onchain.configured ? 'Local only' : onchain.status === 'read_error' ? 'Needs attention' : 'Connected',
      tone: !onchain.configured ? 'amber' : onchain.status === 'read_error' ? 'red' : 'green',
      detail: !onchain.configured
        ? 'Reputation still works locally, but score is not mirrored on-chain yet.'
        : onchain.status === 'read_error'
          ? 'Registry is configured, but the current on-chain score could not be read.'
          : 'Arc reputation registry is configured for score reads and writes.',
    },
  ];
}

function ReputationHeroCard({ reputationOverview, trackingBusy, onToggleTracking }) {
  const setupItems = getReputationSetupItems(reputationOverview);
  const onchain = reputationOverview?.onchain || {};
  const modeLabel = reputationOverview?.mode === 'hybrid' ? 'Local + On-Chain' : 'Local Only';
  const trackingEnabled = Boolean(reputationOverview?.reputationEnabled);
  const registryExplorerUrl = onchain.contractAddress
    ? getTaskExplorerAddressUrl('Arc Testnet', onchain.contractAddress)
    : null;

  return (
    <Card className="space-y-4 border-blue-100 bg-[radial-gradient(circle_at_top_left,rgba(219,234,254,0.9),rgba(236,253,245,0.9),rgba(255,255,255,1))]">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 flex-wrap">
            <ShieldCheck size={18} className="text-blue-600" />
            <h2 className="text-xl font-bold text-slate-900">Agent Reputation</h2>
            <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
              {getOnchainReputationLabel(onchain)}
            </span>
            <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              {modeLabel}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-600">
            Reputation is the trust layer for this agent. It explains what the agent has successfully completed, how that work becomes score, and whether the same history can be verified on Arc.
          </p>
        </div>

        <div className="max-w-sm rounded-xl border border-slate-200 bg-white/80 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Why users should care</p>
          <p className="mt-1 text-sm text-slate-600">
            A high score is not cosmetic. It is a compact record of useful work that helps users decide whether this agent deserves more trust, more automation, and eventually more capital.
          </p>
        </div>
      </div>

      <div className={`rounded-xl border px-4 py-3 ${trackingEnabled ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className={`text-sm ${trackingEnabled ? 'text-green-800' : 'text-amber-800'}`}>
            <strong>{trackingEnabled ? 'Reputation tracking is live.' : 'Reputation tracking is currently off.'}</strong>{' '}
            {trackingEnabled
              ? 'New task, oracle and transaction events can now contribute to the visible score.'
              : 'Enable it here so new task, oracle and transaction events start creating score immediately.'}
          </div>
          <button
            type="button"
            onClick={() => onToggleTracking?.(!trackingEnabled)}
            disabled={trackingBusy}
            className={`shrink-0 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-60 ${trackingEnabled ? 'bg-white text-slate-700 border border-green-200 hover:border-green-300' : 'bg-amber-500 text-white hover:bg-amber-600'}`}
          >
            {trackingBusy ? <Spinner size={12} /> : <ShieldCheck size={14} />}
            {trackingEnabled ? 'Disable Tracking' : 'Enable Tracking'}
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white/80 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Local Score</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{Number(reputationOverview?.localScore || 0)}</p>
          <p className="text-xs text-slate-500">Score recorded inside Arc Machina.</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white/80 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Recent Events</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{Number(reputationOverview?.totalEvents || 0)}</p>
          <p className="text-xs text-slate-500">Completed actions currently contributing to trust.</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white/80 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">On-Chain Score</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">
            {onchain.status === 'live' ? Number(onchain.score || 0) : '—'}
          </p>
          <p className="text-xs text-slate-500">{getOnchainReputationMessage(onchain)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white/80 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Identity Link</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">
            {onchain.identityRegistered ? `ERC-8004 #${onchain.tokenId || '—'}` : 'Not registered'}
          </p>
          <p className="text-xs text-slate-500">
            {onchain.identityRegistered
              ? 'This agent is linked to an ERC-8004 identity token for reputation sync.'
              : 'On-chain reputation becomes portable only after identity registration.'}
          </p>
          {registryExplorerUrl && (
            <a
              href={registryExplorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-700"
            >
              Registry contract
              {String(onchain.contractAddress).slice(0, 10)}…{String(onchain.contractAddress).slice(-6)}
              <ExternalLink size={10} />
            </a>
          )}
        </div>
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Why reputation matters</p>
        <div className="grid gap-3 md:grid-cols-3">
          {REPUTATION_IMPORTANCE_ITEMS.map(item => (
            <div key={item.title} className="rounded-xl border border-slate-200 bg-white/80 px-4 py-3">
              <p className="text-sm font-semibold text-slate-800">{item.title}</p>
              <p className="mt-1 text-xs text-slate-500">{item.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">How score is earned today</p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {REPUTATION_SCORE_RULES.map(rule => (
            <div key={rule.eventType} className="rounded-xl border border-slate-200 bg-white/80 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-slate-700">{rule.label}</p>
                <p className="text-sm font-semibold text-slate-900">{formatSignedScore(rule.delta)}</p>
              </div>
              <p className="mt-1 text-xs text-slate-500">{rule.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">How it works end to end</p>
        <div className="grid gap-3 md:grid-cols-3">
          {setupItems.map(item => (
            <div key={item.key} className="rounded-xl border border-slate-200 bg-white/80 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getReputationSetupToneClasses(item.tone)}`}>
                  {item.status}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{item.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {onchain.configured && onchain.contractAddress && (
        <AddressBox address={onchain.contractAddress} label="Reputation Registry Contract" compact />
      )}
    </Card>
  );
}

// ── Task Card with persistent run status ──────────────────────────────────────
function TaskCard({ task, agentId, tasksEnabled, latestRun, latestResult, onRunQueued, highlighted, recommendationReason }) {
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState('');
  const [expanded, setExpanded] = useState(false);
  const [params, setParams]     = useState(() => getInitialTaskParams(task.id));

  const isPaid      = task.tier === 2;
  const isBlocked   = !tasksEnabled;
  const needsParams = isExecutionTask(task.id);
  const activeRun   = isTaskRunActive(latestRun) ? latestRun : null;
  const failedRun   = latestRun?.status === 'failed' ? latestRun : null;
  const result      = activeRun
    ? null
    : buildTaskRunResult(task, latestRun) || latestResult || null;
  const resultFacts = result ? getTaskExecutionFactLines(result.payload) : [];
  const resultLinks = result ? getTaskExecutionLinks(result.payload) : [];
  const resultMeta  = result ? getTaskResultStatusMeta(task, result.payload || {}) : null;
  const summaryText = result ? getTaskPayloadSummary(task, result.payload || {}) : '';
  const operationalAlert = getTaskOperationalAlert(task);
  const errorMessage = err || (!activeRun && failedRun ? getTaskRunErrorMessage(failedRun.error || failedRun.stage_detail || failedRun.stage_label) : '');

  useEffect(() => {
    setParams(getInitialTaskParams(task.id));
  }, [task.id]);

  async function handleRun() {
    if (!agentId || isBlocked || activeRun) return;
    if (needsParams && !expanded) {
      setExpanded(true);
      return;
    }

    const paramError = needsParams ? getTaskParamError(task.id, params) : '';
    if (paramError) {
      setErr(paramError);
      setExpanded(true);
      return;
    }

    setBusy(true);
    setErr('');

    try {
      const response = await tasksApi.runTask(
        agentId,
        task.id,
        needsParams ? buildTaskParams(task.id, params) : undefined,
      );

      if (response?.run) {
        onRunQueued?.(response.run);
        setExpanded(true);
        return;
      }

      if (response?.inline) {
        onRunQueued?.({
          ...response.run,
          status: 'completed',
          result_payload: response.result || null,
          completed_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      if (e?.data?.run) {
        onRunQueued?.(e.data.run);
        setExpanded(true);
      }
      setErr(getTaskRunErrorMessage(e.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${highlighted ? 'border-blue-200 bg-blue-50/40' : expanded ? 'border-slate-300' : 'border-slate-200'}`}>
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
              {operationalAlert && (
                <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  {operationalAlert.badge}
                </span>
              )}
              {highlighted && (
                <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                  Circle Paid match
                </span>
              )}
            </div>
            {!expanded && (
              <>
                <p className="text-xs text-slate-500 mt-0.5 truncate">{task.description}</p>
                {operationalAlert && (
                  <p className="text-[11px] text-amber-700 mt-1 truncate">{operationalAlert.title}</p>
                )}
                {highlighted && recommendationReason && (
                  <p className="text-[11px] text-blue-700 mt-1 truncate">Why this is recommended now: {recommendationReason}</p>
                )}
              </>
            )}
          </div>
          {expanded
            ? <ChevronUp size={14} className="text-slate-400 shrink-0 mt-0.5" />
            : <ChevronDown size={14} className="text-slate-400 shrink-0 mt-0.5" />}
        </button>

        <button
          onClick={handleRun}
          disabled={busy || !agentId || Boolean(activeRun) || isBlocked}
          className={`shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition
            ${isBlocked
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : isPaid
                ? 'bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60'
                : 'bg-[#66D121] text-white hover:bg-[#55b81c] disabled:opacity-60'
            }`}
        >
          {busy
            ? <><Spinner size={11} /> Starting…</>
            : activeRun
              ? <><Spinner size={11} /> In Progress</>
              : result
              ? resultMeta?.buttonLabel === 'Simulated'
                ? <><AlertTriangle size={11} /> Simulated</>
                : resultMeta?.buttonLabel === 'Skipped'
                  ? <><Clock size={11} /> Skipped</>
                  : <><CheckCircle size={11} /> Done</>
              : needsParams && !expanded
                ? 'Configure'
              : isPaid
                ? <><Coins size={11} /> Pay &amp; Run</>
                : <><Play size={11} /> Run</>}
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-3 border-t border-slate-100 pt-2.5 space-y-2">
          <p className="text-xs text-slate-500">{task.description}</p>
          {operationalAlert && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <p className="font-semibold text-amber-900">{operationalAlert.title}</p>
              <p className="mt-1">{operationalAlert.body}</p>
            </div>
          )}
          {needsParams && (
            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Execution Parameters</p>

              {task.id === 'EXEC_CURVE_SWAP' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Amount (USDC or EURC)</span>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={params.amountIn}
                      onChange={e => setParams(current => ({ ...current, amountIn: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                      placeholder="1.00"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Direction</span>
                    <select
                      value={`${params.indexIn}-${params.indexOut}`}
                      onChange={e => {
                        const [indexIn, indexOut] = e.target.value.split('-').map(Number);
                        setParams(current => ({ ...current, indexIn, indexOut }));
                      }}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                    >
                      <option value="0-1">USDC → EURC</option>
                      <option value="1-0">EURC → USDC</option>
                    </select>
                  </label>
                </div>
              )}

              {task.id === 'EXEC_CURVE_LIQUIDITY_ADD' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Token In</span>
                    <select
                      value={params.tokenIn}
                      onChange={e => setParams(current => ({ ...current, tokenIn: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                    >
                      {REBALANCE_TOKEN_OPTIONS.map(token => (
                        <option key={token} value={token}>{token}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Amount</span>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={params.amountIn}
                      onChange={e => setParams(current => ({ ...current, amountIn: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                      placeholder="1.00"
                    />
                  </label>
                </div>
              )}

              {task.id === 'EXEC_CURVE_LIQUIDITY_REMOVE' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Token Out</span>
                    <select
                      value={params.tokenOut}
                      onChange={e => setParams(current => ({ ...current, tokenOut: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                    >
                      {REBALANCE_TOKEN_OPTIONS.map(token => (
                        <option key={token} value={token}>{token}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Curve LP Amount</span>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={params.lpAmount}
                      onChange={e => setParams(current => ({ ...current, lpAmount: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                      placeholder="1.00"
                    />
                  </label>
                </div>
              )}

              {(task.id === 'EXEC_CIRBTC_USDC_ZAP_IN' || task.id === 'EXEC_CIRBTC_EURC_ZAP_IN') && (() => {
                const preset = DIRECT_PAIR_ZAP_PRESETS[task.id];
                return (
                  <div className="space-y-2">
                    <label className="block">
                      <span className="block text-[11px] font-medium text-slate-500 mb-1">Budget ({preset.token})</span>
                      <input
                        type="number"
                        min="0"
                        step="0.000001"
                        max={preset.maxAmountIn}
                        value={params.amountIn}
                        onChange={e => setParams(current => ({ ...current, amountIn: e.target.value }))}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                        placeholder={preset.defaultAmountIn}
                      />
                    </label>
                    <p className="text-[11px] text-slate-500">
                      This task auto-swaps the optimal share into cirBTC and then adds both sides to the configured direct pair.
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Current cap: {preset.maxAmountIn} {preset.token} total budget, targeting up to {preset.maxSwapAmountIn} {preset.token} for the swap leg.
                    </p>
                  </div>
                );
              })()}

              {(task.id === 'EXEC_CIRBTC_USDC_LP_REMOVE' || task.id === 'EXEC_CIRBTC_EURC_LP_REMOVE') && (() => {
                const preset = DIRECT_PAIR_EXIT_PRESETS[task.id];
                return (
                  <div className="space-y-2">
                    <label className="block">
                      <span className="block text-[11px] font-medium text-slate-500 mb-1">Withdraw % of current LP position</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={params.withdrawPct}
                        onChange={e => setParams(current => ({ ...current, withdrawPct: e.target.value }))}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                        placeholder={preset.defaultWithdrawPct}
                      />
                    </label>
                    <p className="text-[11px] text-slate-500">
                      Burns the selected share of the current {preset.token}/cirBTC LP and returns both underlying assets to the agent wallet.
                    </p>
                  </div>
                );
              })()}

              {task.id === 'EXEC_CCTP_BRIDGE' && (
                <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <label className="block">
                      <span className="block text-[11px] font-medium text-slate-500 mb-1">From Chain</span>
                      <select
                        value={params.fromChain}
                        onChange={e => setParams(current => ({ ...current, fromChain: e.target.value }))}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                      >
                        {CCTP_CHAIN_OPTIONS.map(chain => (
                          <option key={chain} value={chain}>{chain}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="block text-[11px] font-medium text-slate-500 mb-1">To Chain</span>
                      <select
                        value={params.toChain}
                        onChange={e => setParams(current => ({ ...current, toChain: e.target.value }))}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                      >
                        {CCTP_CHAIN_OPTIONS.map(chain => (
                          <option key={chain} value={chain}>{chain}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="block text-[11px] font-medium text-slate-500 mb-1">Amount (USDC)</span>
                      <input
                        type="number"
                        min="0"
                        step="0.000001"
                        value={params.amountUsdc}
                        onChange={e => setParams(current => ({ ...current, amountUsdc: e.target.value }))}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                        placeholder="1.00"
                      />
                    </label>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    This card stays locked while the bridge runs. If you leave this screen and come back later, the latest backend stage is restored here automatically and the button stays disabled until the bridge finishes or fails.
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Arbitrum Sepolia is usually the slowest destination and can take up to 10 minutes during the attestation and mint leg.
                  </p>
                </div>
              )}

              {task.id === 'EXEC_ARB' && (
                <label className="block">
                  <span className="block text-[11px] font-medium text-slate-500 mb-1">Amount In (USDC)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.000001"
                    value={params.amountIn}
                    onChange={e => setParams(current => ({ ...current, amountIn: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                    placeholder="1.00"
                  />
                </label>
              )}

              {task.id === 'EXEC_REBALANCE' && (
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">From Token</span>
                    <select
                      value={params.fromToken}
                      onChange={e => setParams(current => ({ ...current, fromToken: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                    >
                      {REBALANCE_TOKEN_OPTIONS.map(token => (
                        <option key={token} value={token}>{token}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">To Token</span>
                    <select
                      value={params.toToken}
                      onChange={e => setParams(current => ({ ...current, toToken: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                    >
                      {REBALANCE_TOKEN_OPTIONS.map(token => (
                        <option key={token} value={token}>{token}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Amount</span>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={params.amountIn}
                      onChange={e => setParams(current => ({ ...current, amountIn: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                      placeholder="1.00"
                    />
                  </label>
                </div>
              )}

              <p className="text-[11px] text-slate-500">
                Fill the required fields before running this task.
              </p>
            </div>
          )}
          {task.id === 'EXEC_SEPOLIA_GAS_FANOUT' && (
            <div className="space-y-1">
              <p className="text-[11px] text-slate-500">
                This run waits for each destination ETH balance update before the card unlocks. If you leave this screen and return later, the latest backend stage is restored and the button remains disabled until all three destinations finish.
              </p>
              <p className="text-[11px] text-slate-500">
                Arbitrum Sepolia is usually the slowest leg and can take up to 10 minutes to reflect the bridged gas.
              </p>
            </div>
          )}
          <p className="text-[11px] text-slate-400 font-mono">{task.id}</p>
          {isPaid && (
            <p className="text-xs text-amber-700/80 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
              Fee path: <strong>x402 / Circle Gateway</strong>{' -> '}<strong>agentic task economy</strong>{' -> '}shared Arc revenue pool.
              The task tx and fee settlement tx appear below after confirmation.
            </p>
          )}
        </div>
      )}

      {/* Active run panel */}
      {activeRun && (
        <div className="px-4 pb-3 border-t border-slate-100 pt-2.5 bg-blue-50/70">
          <div className="flex items-start gap-2">
            {activeRun.status === 'queued' ? (
              <Clock size={13} className="text-blue-600 shrink-0 mt-0.5" />
            ) : (
              <Spinner size={13} className="text-blue-600 shrink-0 mt-0.5" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-blue-800">{activeRun.stage_label || (activeRun.status === 'queued' ? 'Queued' : 'Running')}</p>
              {activeRun.stage_detail && (
                <p className="text-xs mt-0.5 text-blue-700">{activeRun.stage_detail}</p>
              )}
              {['EXEC_CCTP_BRIDGE', 'EXEC_SEPOLIA_GAS_FANOUT'].includes(task.id) && (
                <p className="text-[11px] text-blue-700/90 mt-1">
                  Bridge tasks can remain active for several minutes. If you leave this screen and return, this card stays locked, reloads the latest backend stage, and prevents a duplicate run until the destination leg finishes.
                </p>
              )}
              <p className="text-[11px] text-slate-500 mt-1">
                Started {formatTimestamp(activeRun.created_at)} · Last update {formatTimestamp(activeRun.updated_at || activeRun.created_at)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Inline result */}
      {result && (
        <div className={`px-4 pb-3 border-t border-slate-100 pt-2.5 ${resultMeta?.panelClasses || 'bg-green-50/60'}`}>
          <div className="flex items-start gap-2">
            {resultMeta?.buttonLabel === 'Simulated' ? (
              <AlertTriangle size={13} className={`${resultMeta?.iconClasses || 'text-amber-600'} shrink-0 mt-0.5`} />
            ) : resultMeta?.buttonLabel === 'Skipped' ? (
              <Clock size={13} className={`${resultMeta?.iconClasses || 'text-slate-500'} shrink-0 mt-0.5`} />
            ) : (
              <CheckCircle size={13} className={`${resultMeta?.iconClasses || 'text-green-600'} shrink-0 mt-0.5`} />
            )}
            <div className="min-w-0 flex-1">
              <p className={`text-xs font-semibold ${resultMeta?.titleClasses || 'text-green-800'}`}>{resultMeta?.label || 'Task completed'}</p>
              {summaryText && (
                <p className={`text-xs mt-0.5 ${resultMeta?.detailClasses || 'text-slate-600'}`}>{summaryText}</p>
              )}
              {resultFacts.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {resultFacts.map(line => (
                    <p key={line} className="text-[11px] text-slate-500">{line}</p>
                  ))}
                </div>
              )}
              <TaskExecutionLinks links={resultLinks} />
              {result.payload?.dryRun && isPaid && (
                <p className="text-[11px] text-amber-700 mt-1">
                  No on-chain transaction was sent. Check dry-run mode, relayer funding and pool configuration before treating this as a live execution.
                </p>
              )}
              <p className="text-[11px] text-slate-400 mt-0.5">
                {new Date(result.created_at).toLocaleTimeString()}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {errorMessage && !activeRun && (
        <div className="px-4 pb-2">
          <Alert type="error" className="py-1 text-xs">{errorMessage}</Alert>
        </div>
      )}
    </div>
  );
}

// ── Recent result row (light mode) ────────────────────────────────────────────
function ResultRow({ result }) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(result.created_at).toLocaleTimeString();
  const factLines = getTaskExecutionFactLines(result.payload);
  const executionLinks = getTaskExecutionLinks(result.payload);
  const summaryText = getTaskPayloadSummary({ id: result.task_id, title: result.title }, result.payload || {});
  const hasRenderableContent = Boolean(summaryText) || factLines.length > 0 || executionLinks.length > 0;

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
        <div className="border-t border-slate-100 px-4 pb-3 pt-2 text-xs text-slate-500">
          {hasRenderableContent ? (
            <div className="space-y-1.5">
              {summaryText && (
                <p className="whitespace-pre-wrap text-slate-600">{summaryText}</p>
              )}
              {factLines.map(line => (
                <p key={line}>{line}</p>
              ))}
              <TaskExecutionLinks links={executionLinks} />
            </div>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(result.payload, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Tab ──────────────────────────────────────────────────────────────────
export default function TasksTab() {
  const { agent, setAgent } = useAgent();

  const [catalog, setCatalog]         = useState([]);
  const [circlePaidCatalog, setCirclePaidCatalog] = useState({ items: [], lanes: [], economy: null });
  const [taskRuns, setTaskRuns]       = useState([]);
  const [results, setResults]         = useState([]);
  const [poolBal, setPoolBal]         = useState(null);
  const [agentStatus, setAgentStatus] = useState(null);
  const [reputationOverview, setReputationOverview] = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [activeGroup, setActiveGroup] = useState('free');

  // Enable/disable tasks toggle
  const [tasksEnabled, setTasksEnabled] = useState(false);
  const [saving, setSaving]             = useState(false);
  const [saveMsg, setSaveMsg]           = useState('');
  const [automationSavingKey, setAutomationSavingKey] = useState('');
  const [automationMsg, setAutomationMsg]             = useState('');
  const [automationWalletSnapshot, setAutomationWalletSnapshot] = useState(null);

  useEffect(() => {
    setTasksEnabled(agent?.features?.dailyTasksEnabled ?? false);
  }, [agent?.id, agent?.features?.dailyTasksEnabled]);

  useEffect(() => {
    let cancelled = false;

    if (!agent?.walletAddress) {
      setAutomationWalletSnapshot(null);
      return () => {};
    }

    Promise.all([
      fetchAgentBalance(agent.walletAddress, 5042002),
      fetchUsdcBalance(agent.walletAddress, 5042002),
      fetchEurcBalance(agent.walletAddress, 5042002),
    ]).then(([nativeBalance, usdcBalance, eurcBalance]) => {
      if (!cancelled) {
        setAutomationWalletSnapshot({ nativeBalance, usdcBalance, eurcBalance });
      }
    }).catch(() => {
      if (!cancelled) {
        setAutomationWalletSnapshot(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [agent?.walletAddress]);

  const automationEnabledCount = AUTOMATION_FEATURES.filter(feature => agent?.features?.[feature.key]).length;
  const allAutomationEnabled = automationEnabledCount === AUTOMATION_FEATURES.length;
  const fullAutonomyBusy = automationSavingKey === 'fullAutonomous';

  function buildFullAutonomyPayload(nextValue) {
    return Object.fromEntries(FULL_AUTONOMY_FEATURE_KEYS.map(key => [key, nextValue]));
  }

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [catRes, circlePaidRes, poolRes, statusRes, reputationRes, resultsRes, runsRes] = await Promise.all([
        tasksApi.catalog(),
        tasksApi.circlePaidCatalog().catch(() => ({ items: [], lanes: [], economy: null })),
        tasksApi.poolBalance(),
        agent?.id
          ? agentsApi.status(agent.id).then(data => ({ data })).catch(err => ({ error: err.message }))
          : Promise.resolve(null),
        agent?.id
          ? agentsApi.reputation(agent.id, 8).then(data => ({ data })).catch(err => ({ error: err.message }))
          : Promise.resolve(null),
        agent?.id
          ? tasksApi.results(agent.id, 20).catch(() => ({ results: [] }))
          : Promise.resolve({ results: [] }),
        agent?.id
          ? tasksApi.runs(agent.id, 'recent', 20).catch(() => ({ runs: [] }))
          : Promise.resolve({ runs: [] }),
      ]);
      setCatalog(catRes.tasks || []);
      setCirclePaidCatalog(circlePaidRes || { items: [], lanes: [], economy: null });
      setPoolBal(poolRes);
      setResults(resultsRes.results || []);
      setTaskRuns(runsRes.runs || []);
      if (statusRes?.data) {
        setAgentStatus(statusRes.data);
      } else if (agent?.id) {
        setAgentStatus(null);
      }
      if (reputationRes?.data) {
        setReputationOverview(reputationRes.data);
      } else if (agent?.id) {
        setReputationOverview(null);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [agent?.id]);

  useEffect(() => { load(); }, [load]);

  const hasActiveTaskRun = taskRuns.some(isTaskRunActive);

  useEffect(() => {
    if (!agent?.id || !hasActiveTaskRun) return undefined;

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const runRes = await tasksApi.runs(agent.id, 'recent', 20);
        if (cancelled) return;

        let shouldReload = false;
        setTaskRuns((current) => {
          const nextRuns = runRes.runs || [];
          const prevActiveIds = new Set(current.filter(isTaskRunActive).map(run => run.id));
          const nextActiveIds = new Set(nextRuns.filter(isTaskRunActive).map(run => run.id));
          shouldReload = Array.from(prevActiveIds).some(id => !nextActiveIds.has(id));
          return nextRuns;
        });

        if (shouldReload) {
          await load();
        }
      } catch {
        // Keep the current UI state; the next poll tick can recover.
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [agent?.id, hasActiveTaskRun, load]);

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

  async function handleAutomationToggle(featureKey, nextValue) {
    if (!agent?.id) return;

    const feature = AUTOMATION_FEATURES.find(item => item.key === featureKey);
    setAutomationSavingKey(featureKey);
    setAutomationMsg('');

    try {
      await agentsApi.update(agent.id, { [featureKey]: nextValue });
      const [latestStatus, latestReputation] = await Promise.all([
        agentsApi.status(agent.id).catch(() => null),
        agentsApi.reputation(agent.id, 8).catch(() => null),
      ]);
      setAgent(current => ({
        ...current,
        features: {
          ...(current?.features || {}),
          [featureKey]: nextValue,
        },
      }));
      if (latestStatus) setAgentStatus(latestStatus);
      if (latestReputation) setReputationOverview(latestReputation);
      setAutomationMsg(`${feature?.title || 'Automation'} ${nextValue ? 'enabled' : 'disabled'}.`);
      setTimeout(() => setAutomationMsg(''), 3000);
    } catch (e) {
      setAutomationMsg(`Error: ${e.message}`);
    } finally {
      setAutomationSavingKey('');
    }
  }

  async function handleFullAutonomyToggle(nextValue) {
    if (!agent?.id) return;

    const payload = buildFullAutonomyPayload(nextValue);
    setAutomationSavingKey('fullAutonomous');
    setAutomationMsg('');

    try {
      await agentsApi.update(agent.id, payload);
      const [latestStatus, latestReputation] = await Promise.all([
        agentsApi.status(agent.id).catch(() => null),
        agentsApi.reputation(agent.id, 8).catch(() => null),
      ]);

      setAgent(current => ({
        ...current,
        features: {
          ...(current?.features || {}),
          ...payload,
        },
      }));

      if (latestStatus) setAgentStatus(latestStatus);
      if (latestReputation) setReputationOverview(latestReputation);

      setAutomationMsg(nextValue ? 'Full Autonomous mode enabled.' : 'Full Autonomous mode disabled.');
      setTimeout(() => setAutomationMsg(''), 3000);
    } catch (e) {
      setAutomationMsg(`Error: ${e.message}`);
    } finally {
      setAutomationSavingKey('');
    }
  }

  const freeTasks  = catalog.filter(t => t.tier === 1);
  const paidTasks  = catalog.filter(t => t.tier === 2);
  const circlePaidItems = circlePaidCatalog.items || [];
  const circlePaidLanes = circlePaidCatalog.lanes || [];
  const latestTaskRunById = new Map();
  for (const run of taskRuns) {
    if (!latestTaskRunById.has(run.task_id)) {
      latestTaskRunById.set(run.task_id, run);
    }
  }

  const latestTaskResultById = new Map();
  for (const result of results) {
    if (!latestTaskResultById.has(result.task_id)) {
      latestTaskResultById.set(result.task_id, result);
    }
  }

  const shownTasks = activeGroup === 'free'
    ? freeTasks
    : activeGroup === 'paid'
      ? paidTasks
      : [];
  const paidTaskGroups = PAID_TASK_GROUPS
    .map(group => ({
      ...group,
      tasks: paidTasks.filter(task => group.taskIds.includes(task.id)),
    }))
    .filter(group => group.tasks.length > 0);
  const ungroupedPaidTasks = paidTasks.filter(task => !PAID_TASK_GROUP_TASK_IDS.has(task.id));
  const taskSection = activeGroup === 'automation' ? (
    <div className="space-y-2">
      <div className="border border-blue-200 rounded-xl p-4 bg-blue-50/70">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-slate-800">Full Autonomous</p>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                allAutomationEnabled
                  ? 'border-green-200 bg-green-50 text-green-700'
                  : 'border-slate-200 bg-slate-50 text-slate-500'
              }`}>
                {allAutomationEnabled ? 'All automation features on' : `${automationEnabledCount}/${AUTOMATION_FEATURES.length} enabled`}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Toggle Market Analysis, Oracle Data Feed, DeFi Loop Execution and Reputation Tracking in one action.
            </p>
            <p className="text-xs text-slate-400 mt-1">
              The Tasks enable switch remains separate. This control only manages background automation features.
            </p>
          </div>

          <button
            onClick={() => handleFullAutonomyToggle(!allAutomationEnabled)}
            disabled={fullAutonomyBusy}
            className={`shrink-0 flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition ${
              allAutomationEnabled
                ? 'bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-60'
                : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60'
            }`}
          >
            {fullAutonomyBusy ? <Spinner size={11} /> : <Brain size={12} />}
            {allAutomationEnabled ? 'Disable All Automation' : 'Enable Full Autonomous'}
          </button>
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl p-4 bg-white">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-slate-800">What runs automatically today</p>
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
            {agent?.isSmartMode ? 'Smart Mode on' : 'Smart Mode off'}
          </span>
        </div>
        <div className="mt-2 space-y-1.5 text-xs text-slate-600">
          <p>Market Analysis refreshes context only. It does not move funds.</p>
          <p>Oracle Data Feed keeps stablecoin signals and pricing updates fresh.</p>
          <p>DeFi Loop Execution is the only feature that can move funds automatically today.</p>
          <p>Right now the only automatic on-chain trade is the verified USDC to EURC Curve route.</p>
          <p>cirBTC actions and LP changes are still manual.</p>
          <p>Maximum autonomous trade size is capped by your agent setting: <strong>{Number(agent?.settings?.maxTradeUsdc || 0).toFixed(2)} USDC</strong>. The loop uses the smaller of the strategy size and this cap.</p>
          <p>Automation needs funds in the agent wallet. Current Arc wallet snapshot: <strong>{automationWalletSnapshot?.nativeBalance ?? '—'} ARC</strong>, <strong>{automationWalletSnapshot?.usdcBalance ?? '—'} USDC</strong>, <strong>{automationWalletSnapshot?.eurcBalance ?? '—'} EURC</strong>.</p>
        </div>
      </div>

      {AUTOMATION_FEATURES.map(feature => {
        const enabled = agent?.features?.[feature.key] ?? false;
        const isSaving = automationSavingKey === feature.key || fullAutonomyBusy;
        const automationState = agentStatus?.automation?.[feature.statusKey] || null;
        const lastStatus = automationState?.lastStatus || (enabled ? 'idle' : 'disabled');
        const showReputationWarning = feature.statusKey === 'reputation' && agentStatus?.config?.reputationRegistryConfigured === false;
        const isReputationCard = feature.statusKey === 'reputation';

        return (
          <div key={feature.key} className="border border-slate-200 rounded-xl p-4 bg-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-slate-800">{feature.title}</p>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                    enabled
                      ? 'border-green-200 bg-green-50 text-green-700'
                      : 'border-slate-200 bg-slate-50 text-slate-500'
                  }`}>
                    {enabled ? 'On' : 'Off'}
                  </span>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getAutomationStatusClasses(lastStatus, enabled)}`}>
                    {humanizeAutomationStatus(lastStatus)}
                  </span>
                  {automationState?.bypassDailyCap && ['oracle', 'defiLoop'].includes(feature.statusKey) && (
                    <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                      Whitelist bypass active
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-1">{feature.description}</p>
                <p className="text-xs text-slate-400 mt-1">{feature.detail}</p>

                {showReputationWarning && (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    <strong>On-chain reputation is not connected yet.</strong> This feature is saving local activity only for now.
                  </div>
                )}

                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Last Run</p>
                    <p className="mt-1 text-sm font-medium text-slate-700">{formatTimestamp(automationState?.lastRunAt)}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 md:col-span-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Runtime Notes</p>
                    <p className="mt-1 text-sm text-slate-600">{getAutomationSummary(feature, automationState)}</p>
                  </div>
                </div>

                {isReputationCard && reputationOverview && (
                  <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">
                      Detailed scoring rules, importance and setup guidance appear in the Agent Reputation section at the top of this page.
                    </p>

                    <div className="grid gap-2 md:grid-cols-3">
                      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Local Score</p>
                        <p className="mt-1 text-lg font-semibold text-slate-900">{Number(reputationOverview.localScore || 0)}</p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Recent Events</p>
                        <p className="mt-1 text-lg font-semibold text-slate-900">{Number(reputationOverview.totalEvents || 0)}</p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">On-Chain Status</p>
                        <p className="mt-1 text-sm font-semibold text-slate-900">{getOnchainReputationLabel(reputationOverview.onchain)}</p>
                        <p className="mt-1 text-xs text-slate-500">{getOnchainReputationMessage(reputationOverview.onchain)}</p>
                      </div>
                    </div>

                    {reputationOverview.onchain?.configured && reputationOverview.onchain?.contractAddress && (
                      <AddressBox address={reputationOverview.onchain.contractAddress} label="Reputation Registry Contract" compact />
                    )}

                    {reputationOverview.onchain?.status === 'live' && (
                      <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                        On-chain score: <strong>{Number(reputationOverview.onchain?.score || 0)}</strong>
                      </div>
                    )}

                    {reputationOverview.breakdown?.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Score Breakdown</p>
                        <div className="grid gap-2 md:grid-cols-2">
                          {reputationOverview.breakdown.slice(0, 4).map(item => (
                            <div key={item.eventType} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-sm font-medium text-slate-700">{formatReputationEventType(item.eventType)}</p>
                                <p className="text-sm font-semibold text-slate-900">{formatSignedScore(item.score)}</p>
                              </div>
                              <p className="mt-1 text-xs text-slate-500">{Number(item.count || 0)} event(s)</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {reputationOverview.recentEvents?.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Recent Reputation Events</p>
                        <div className="space-y-2">
                          {reputationOverview.recentEvents.slice(0, 5).map((event, index) => (
                            <div key={`${event.eventType}-${event.createdAt}-${index}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-sm font-medium text-slate-700">{formatReputationEventType(event.eventType)}</p>
                                <p className="text-sm font-semibold text-slate-900">{formatSignedScore(event.scoreDelta)}</p>
                              </div>
                              <p className="mt-1 text-xs text-slate-500">{formatTimestamp(event.createdAt)}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <button
                onClick={() => handleAutomationToggle(feature.key, !enabled)}
                disabled={isSaving}
                className={`shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                  enabled
                    ? 'bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-60'
                    : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60'
                }`}
              >
                {isSaving ? <Spinner size={11} /> : null}
                {enabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>
        );
      })}

      {automationMsg && (
        <p className={`text-xs ${automationMsg.startsWith('Error') ? 'text-red-500' : 'text-green-600'}`}>
          {automationMsg}
        </p>
      )}
    </div>
  ) : activeGroup === 'circlePaid' ? (
    <div className="space-y-3">
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-slate-800">Circle Paid</p>
              <span className="inline-flex items-center rounded-full border border-indigo-200 bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                Live + preview cards
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Some cards are live today. Others stay visible as previews so you can see what is available now and what is still coming.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Only cards marked live can run today.
            </p>

            <div className="mt-3 grid gap-2 md:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Arc fee when paid</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{formatCirclePaidFeeUsdc(circlePaidCatalog.economy?.defaultArcFeeUsdc)} USDC</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Shared fee pool</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {poolBal?.balanceUsdc != null ? `${Number(poolBal.balanceUsdc).toFixed(4)} USDC live` : 'Same pool as Paid tasks'}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Visible right now</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">Live cards and previews</p>
              </div>
            </div>
          </div>

          {circlePaidCatalog.economy?.recipientAddress && (
            <div className="w-full lg:max-w-sm">
              <AddressBox address={circlePaidCatalog.economy.recipientAddress} label="Where the Arc fee goes" compact />
            </div>
          )}
        </div>
      </div>

      {loading && !circlePaidItems.length ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : !circlePaidItems.length ? (
        <Card>
          <p className="text-sm text-slate-500 text-center py-6">Circle Paid catalog is not available yet.</p>
        </Card>
      ) : (
        circlePaidLanes.map(lane => {
          const laneItems = circlePaidItems.filter(item => item.lane === lane.key);
          if (!laneItems.length) return null;

          return (
            <div key={lane.key} className="space-y-2">
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <ShieldCheck size={14} className={lane.key === 'arc_action' ? 'text-green-600' : 'text-slate-400'} />
                  <p className="text-sm font-semibold text-slate-800">{lane.title}</p>
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    {laneItems.length} card{laneItems.length === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{lane.description}</p>
              </div>

              <div className="grid gap-2 xl:grid-cols-2">
                {laneItems.map(item => (
                  <CirclePaidCard
                    key={item.id}
                    item={item}
                    agentId={agent?.id}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  ) : loading && !catalog.length ? (
    <div className="flex justify-center py-10"><Spinner /></div>
  ) : shownTasks.length === 0 ? (
    <Card>
      <p className="text-sm text-slate-500 text-center py-6">No tasks found.</p>
    </Card>
  ) : activeGroup === 'paid' ? (
    <div className="space-y-4">
      {paidTaskGroups.map(group => (
        <div key={group.key} className="space-y-2">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Lock size={14} className="text-amber-600" />
              <p className="text-sm font-semibold text-slate-800">{group.title}</p>
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                {group.tasks.length} task{group.tasks.length === 1 ? '' : 's'}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">{group.description}</p>
          </div>

          <div className="space-y-2">
            {group.tasks.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                agentId={agent?.id}
                tasksEnabled={tasksEnabled}
                latestRun={latestTaskRunById.get(task.id) || null}
                latestResult={latestTaskResultById.get(task.id) || null}
                onRunQueued={(run) => {
                  if (!run) return;
                  setTaskRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
                }}
              />
            ))}
          </div>
        </div>
      ))}

      {ungroupedPaidTasks.length > 0 && (
        <div className="space-y-2">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Lock size={14} className="text-amber-600" />
              <p className="text-sm font-semibold text-slate-800">Other Paid Actions</p>
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                {ungroupedPaidTasks.length} task{ungroupedPaidTasks.length === 1 ? '' : 's'}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">Paid tasks that do not belong to the main stable, cirBTC direct-pair or bridge/signal rails.</p>
          </div>

          <div className="space-y-2">
            {ungroupedPaidTasks.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                agentId={agent?.id}
                tasksEnabled={tasksEnabled}
                latestRun={latestTaskRunById.get(task.id) || null}
                latestResult={latestTaskResultById.get(task.id) || null}
                onRunQueued={(run) => {
                  if (!run) return;
                  setTaskRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  ) : (
    <div className="space-y-2">
      {shownTasks.map(task => (
        <TaskCard
          key={task.id}
          task={task}
          agentId={agent?.id}
          tasksEnabled={tasksEnabled}
          latestRun={latestTaskRunById.get(task.id) || null}
          latestResult={latestTaskResultById.get(task.id) || null}
          onRunQueued={(run) => {
            if (!run) return;
            setTaskRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
          }}
        />
      ))}
    </div>
  );

  if (!agent) {
    return (
      <Card>
        <p className="text-sm text-slate-500 text-center py-6">Connect your agent first.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <ReputationHeroCard
        reputationOverview={reputationOverview}
        trackingBusy={automationSavingKey === 'reputationEnabled'}
        onToggleTracking={(nextValue) => handleAutomationToggle('reputationEnabled', nextValue)}
      />

      <Card>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3">
            <Zap size={20} className="text-[#66D121] shrink-0 mt-1" />
            <div>
              <h2 className="text-xl font-bold text-slate-900">Agent Tasks</h2>
              <p className="text-sm text-slate-500">Run free informational jobs, paid Arc executions, Circle x402 cards and background automation from one screen.</p>
            </div>
          </div>
          <div className="flex items-center gap-3 lg:justify-end">
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

          {!tasksEnabled && (
            <div className="mt-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center">
              <AlertTriangle size={16} className="text-amber-600 shrink-0" />
              <p className="flex-1 text-sm text-amber-800">
                <strong>Tasks are disabled.</strong> Enable them to run free oracle tasks and paid execution tasks with your agent.
              </p>
              <button
                onClick={() => handleEnableToggle(true)}
                disabled={saving}
                className="shrink-0 flex items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-60 transition"
              >
                {saving ? <Spinner size={11} /> : <Zap size={11} />}
                Enable Tasks
              </button>
            </div>
          )}

          {tasksEnabled && (
            <div className="mt-4 flex flex-col gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-sm text-green-700">
                <CheckCircle size={14} className="text-green-600" />
                <span>Tasks are <strong>enabled</strong> for this agent.</span>
              </div>
              <button
                onClick={() => handleEnableToggle(false)}
                disabled={saving}
                className="text-sm text-slate-400 hover:text-red-500 transition disabled:opacity-50"
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

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <button
            onClick={() => setActiveGroup('free')}
            className={`w-full flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition ${
              activeGroup === 'free'
                ? 'bg-green-50 text-green-700 border-green-200 shadow-sm'
                : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            <Zap size={14} /> Free ({freeTasks.length})
          </button>
          <button
            onClick={() => setActiveGroup('paid')}
            className={`w-full flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition ${
              activeGroup === 'paid'
                ? 'bg-amber-50 text-amber-700 border-amber-200 shadow-sm'
                : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            <Lock size={14} /> Paid ({paidTasks.length})
          </button>
          <button
            onClick={() => setActiveGroup('circlePaid')}
            className={`w-full flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition ${
              activeGroup === 'circlePaid'
                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 shadow-sm'
                : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            <Coins size={14} /> Circle Paid ({circlePaidItems.length})
          </button>
          <button
            onClick={() => setActiveGroup('automation')}
            className={`w-full flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition ${
              activeGroup === 'automation'
                ? 'bg-blue-50 text-blue-700 border-blue-200 shadow-sm'
                : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            <Brain size={14} /> Automation ({AUTOMATION_FEATURES.length})
          </button>
        </div>
      </Card>

      {/* Info strip */}
      {activeGroup === 'free' && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-500 flex items-center gap-2">
          <Clock size={12} className="shrink-0" />
          Free runs: up to 5 total per day for this agent. Oracle status and buyer payment flow live in the Oracle tab.
        </div>
      )}
      {activeGroup === 'automation' && (
        <div className="rounded-xl border border-blue-100 bg-blue-50/70 px-3.5 py-2.5 text-xs text-blue-700 flex items-center gap-2">
          <Brain size={12} className="shrink-0" />
          Automation toggles only change background behavior. Use Free or Paid when you want to start a task yourself.
        </div>
      )}
      {activeGroup === 'circlePaid' && (
        <div className="rounded-xl border border-indigo-100 bg-indigo-50/70 px-3.5 py-2.5 text-xs text-indigo-700 flex items-center gap-2">
          <Coins size={12} className="shrink-0" />
          Live cards and roadmap cards stay visible here. Only live cards can run previews today.
        </div>
      )}
      {activeGroup === 'paid' && (
        <div className="rounded-xl border border-amber-100 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-700 flex items-center gap-2">
          <Lock size={12} className="shrink-0" />
          Paid is the manual on-chain lane. Use it when you already know which Arc action to run.
        </div>
      )}

      {error && <Alert type="error">{error}</Alert>}

      {taskSection}

      {/* Recent results */}
      {results.length > 0 && (
        <Card>
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Recent Executions</h3>
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

