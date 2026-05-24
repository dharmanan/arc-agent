import React, { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { useAgent } from '../providers/AgentProvider';
import { agents, transactions } from '../lib/api.js';
import { authenticatePasskey } from '../lib/passkey.js';
import { fetchAgentPortfolio } from '../lib/agentBalances.js';
import { Card, Badge, Button, AddressBox, Alert, Spinner } from './ui/index.jsx';
import PaymentModal from './PaymentModal.jsx';
import { Wallet, Activity, ArrowRight, ArrowUpRight, ArrowDownLeft, Repeat2, Zap, LogIn, ExternalLink, RefreshCw, QrCode, Send, Coins } from 'lucide-react';
import { CHAINS } from '../lib/chains.js';

const AUTOMATION_SNAPSHOT_TOLERANCE_MS = 60 * 1000;

function formatAddress(address, startChars = 8, endChars = 6) {
  if (!address || address.length <= startChars + endChars) return address;
  return `${address.slice(0, startChars)}....${address.slice(-endChars)}`;
}

function getTxMeta(tx) {
  return tx?.meta && typeof tx.meta === 'object' ? tx.meta : {};
}

function getAutomationPolicyMeta(meta) {
  const automationPolicy = meta?.automationPolicy && typeof meta.automationPolicy === 'object'
    ? meta.automationPolicy
    : null;
  const stablePolicy = meta?.stablePolicy && typeof meta.stablePolicy === 'object'
    ? meta.stablePolicy
    : null;

  return {
    executionSource: String(meta?.executionSource || '').trim(),
    policyId: String(meta?.policyId || automationPolicy?.policyId || stablePolicy?.policyId || '').trim(),
    policyLane: String(meta?.policyLane || automationPolicy?.verdict?.lane || stablePolicy?.verdict?.lane || '').trim(),
  };
}

function getActivityPolicyBadge(tx) {
  const meta = getTxMeta(tx);
  const { executionSource, policyId, policyLane } = getAutomationPolicyMeta(meta);

  if (tx?.type === 'curve_lp_add' || tx?.type === 'curve_lp_remove') {
    if (executionSource === 'stable_policy_v1' || policyId === 'stable_usdc_eurc_curve_v1') {
      return {
        label: 'Legacy mixed policy',
        variant: 'yellow',
        note: 'Historical row from the older mixed stable policy before LP and oracle lanes were separated.',
      };
    }

    if (executionSource === 'stable_lp_policy_v2' || policyId === 'stable_usdc_eurc_lp_manager_v2' || policyLane === 'stable_curve_lp') {
      return {
        label: 'Stable LP lane',
        variant: 'green',
        note: null,
      };
    }
  }

  if (['defi_loop_swap', 'defi_loop_dry', 'rebalance'].includes(tx?.type)) {
    if (executionSource === 'oracle_strategy' && !policyId) {
      return {
        label: 'Legacy mixed policy',
        variant: 'yellow',
        note: 'Historical row from before LP and oracle decisions were split into separate lanes.',
      };
    }

    if (executionSource === 'oracle_strategy_v1' || policyId === 'oracle_stable_curve_strategy_v1' || policyLane === 'oracle_strategy') {
      return {
        label: 'Oracle lane',
        variant: 'green',
        note: null,
      };
    }
  }

  return null;
}

function isRealHash(hash) {
  return /^0x[0-9a-fA-F]{64}$/.test(hash || '');
}

function formatTokenAmount(amount, token) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const digits = token === 'cirBTC' ? 8 : 4;
  return `${numeric.toFixed(digits).replace(/\.0+$|(?<=\.\d*?)0+$/g, '')} ${token}`;
}

function formatTokenAmountWithZero(amount, token) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  if (numeric === 0) return `0 ${token}`;
  return formatTokenAmount(numeric, token);
}

function getExecutionRailLabel(executionRail) {
  switch (String(executionRail || '').toLowerCase()) {
    case 'swap_kit':
      return 'app route';
    case 'curve_fallback':
      return 'Curve pool';
    case 'uniswap_v2_fallback':
      return 'direct pool';
    default:
      return 'swap route';
  }
}

function normalizeActivitySummary(summary) {
  const raw = String(summary || '').trim();
  if (!raw) return null;
  return raw.replace(/\s+/g, ' ').trim();
}

function isMachineLikeActivitySummary(summary) {
  const compact = normalizeActivitySummary(summary);
  if (!compact) return false;

  return /CALL_EXCEPTION|REPLACEMENT_UNDERPRICED|replacement fee too low|transaction=|invocation=|revert=|code=-?\d+|version=|info=\{|error=\{|0x[0-9a-f]{48,}/i.test(compact);
}

function summarizeActivityError(error) {
  const raw = String(error || '').trim();
  if (!raw) return null;

  if (/replacement fee too low|replacement transaction underpriced|REPLACEMENT_UNDERPRICED/i.test(raw)) {
    return 'The network rejected the retry because its gas fee was not high enough to replace the pending transaction.';
  }

  if (/nonce too low|nonce has already been used|NONCE_EXPIRED/i.test(raw)) {
    return 'Another transaction already used this wallet nonce before this swap was submitted.';
  }

  if (/ERC20:\s*transfer amount exceeds balance/i.test(raw)) {
    return 'Agent wallet balance was too low for this trade.';
  }

  if (/insufficient funds for (gas|intrinsic transaction cost)/i.test(raw)) {
    return 'The wallet did not have enough native gas to submit this transaction.';
  }

  if ((/transaction execution reverted/i.test(raw) || /CALL_EXCEPTION/i.test(raw)) && /reason=null/i.test(raw)) {
    return 'The on-chain swap reverted, but the RPC node did not return a decoded contract reason.';
  }

  if (/exceeds agent auto-approve limit/i.test(raw)) {
    return 'Trade size was above the current auto-approve limit.';
  }

  if (/Daily limit exceeded/i.test(raw)) {
    return 'Daily spend limit blocked this autonomous trade.';
  }

  const compact = normalizeActivitySummary(raw);
  const quotedReason = compact.match(/reason[=:]\s*["']([^"']+)["']/i)?.[1];
  const primary = quotedReason || compact.split(' (action=')[0] || compact;

  return primary.length > 180 ? `${primary.slice(0, 177)}...` : primary;
}

function summarizeActivityFailureReason(meta, actionLabel) {
  const reason = String(meta?.reason || '').trim();
  if (!reason) return null;

  if (reason === 'position_guard_unavailable') {
    return `${actionLabel} failed: The app could not verify the current LP position, so it skipped the exit before sending a transaction.`;
  }

  if (reason === 'lp_position_not_found') {
    return `${actionLabel} failed: No active LP position was available to exit.`;
  }

  if (reason === 'insufficient_lp_position') {
    return `${actionLabel} failed: The requested LP exit size was larger than the current LP balance.`;
  }

  return null;
}

function getUserFacingFailedActivityPhase(meta, actionLabel, fallbackLabel) {
  const structuredReason = summarizeActivityFailureReason(meta, actionLabel);
  if (structuredReason) {
    return structuredReason;
  }

  const summary = normalizeActivitySummary(meta.summary);
  const machineLikeSummary = isMachineLikeActivitySummary(summary);
  const summarizedError = summarizeActivityError(meta.error || (machineLikeSummary ? summary : ''));

  if (summarizedError) {
    return `${actionLabel} failed: ${summarizedError}`;
  }

  if (summary && !machineLikeSummary) {
    return summary;
  }

  return fallbackLabel;
}

function getOracleStrategyFailureContext(meta, inputToken) {
  const attemptedAmount = Number(meta.amountIn);
  const requestedAmount = Number(meta.requestedAmountIn);
  const availableAmount = Number(meta.availableBalanceUsdc);
  const tradableAmount = Number(meta.availableToTradeUsdc);
  const reservedAmount = Number(meta.walletReserveUsdc);
  const attemptedAmountLabel = formatTokenAmountWithZero(meta.amountIn, inputToken);
  const requestedAmountLabel = formatTokenAmount(meta.requestedAmountIn, inputToken);
  const availableAmountLabel = formatTokenAmountWithZero(meta.availableBalanceUsdc, inputToken);
  const tradableAmountLabel = formatTokenAmountWithZero(meta.availableToTradeUsdc, inputToken);
  const reservedAmountLabel = formatTokenAmountWithZero(meta.walletReserveUsdc, inputToken);

  if (/nonce too low|nonce has already been used|NONCE_EXPIRED/i.test(String(meta.error || ''))) {
    return attemptedAmountLabel
      ? ` The failed on-chain attempt size was ${attemptedAmountLabel}.`
      : '';
  }

  if (
    Number.isFinite(requestedAmount)
    && Number.isFinite(attemptedAmount)
    && Number.isFinite(tradableAmount)
    && requestedAmount > attemptedAmount
    && Math.abs(tradableAmount - attemptedAmount) < 0.000001
    && /transaction execution reverted|CALL_EXCEPTION/i.test(String(meta.error || ''))
  ) {
    if (Number.isFinite(reservedAmount) && reservedAmount > 0) {
      return ` The loop had already reduced the trade from ${requestedAmountLabel || `${requestedAmount} ${inputToken}`} to ${attemptedAmountLabel || `${attemptedAmount} ${inputToken}`} based on the wallet's tradable balance (${tradableAmountLabel || `${tradableAmount} ${inputToken}`}) after keeping ${reservedAmountLabel || `${reservedAmount} ${inputToken}`} reserved, so this was not blocked by the pre-trade balance guard.`;
    }

    return ` The loop had already reduced the trade from ${requestedAmountLabel || `${requestedAmount} ${inputToken}`} to ${attemptedAmountLabel || `${attemptedAmount} ${inputToken}`} based on the wallet's available balance (${availableAmountLabel || `${availableAmount} ${inputToken}`}), so this was not blocked by the pre-trade balance guard.`;
  }

  return attemptedAmountLabel
    ? ` The failed on-chain attempt size was ${attemptedAmountLabel}.`
    : '';
}

function formatPositionAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric === 0) return '0';
  if (Math.abs(numeric) < 0.000001) return numeric.toExponential(6);
  if (Math.abs(numeric) < 0.01) return numeric.toFixed(10).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
  return numeric.toFixed(6).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

function formatLpAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric === 0) return '0';
  if (Math.abs(numeric) < 0.001) return '<0.001';
  return numeric.toFixed(3).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

function formatUsdAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric === 0) return '$0.00';
  if (Math.abs(numeric) < 0.01) return '<$0.01';

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: numeric >= 100 ? 0 : 2,
    maximumFractionDigits: numeric >= 100 ? 0 : 2,
  }).format(numeric);
}

function formatUsdUnitPrice(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric === 0) return '$0.0000';
  if (Math.abs(numeric) < 0.0001) return '<$0.0001';

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(numeric);
}

function formatRewardAmount(amount, token = 'USDC') {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return `0 ${token}`;
  if (numeric === 0) return `0 ${token}`;

  const digits = Math.abs(numeric) >= 100 ? 0 : Math.abs(numeric) >= 1 ? 2 : 4;
  return `${numeric.toFixed(digits).replace(/\.0+$|(?<=\.\d*?)0+$/g, '')} ${token}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

function formatPercentAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric === 0) return '0%';
  if (Math.abs(numeric) < 0.01) return '<0.01%';
  return `${numeric.toFixed(2).replace(/\.0+$|(?<=\.\d*?)0+$/g, '')}%`;
}

function formatStatusPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return `${numeric.toFixed(numeric >= 1 ? 2 : 3).replace(/\.0+$|(?<=\.\d*?)0+$/g, '')}%`;
}

function getPositionRiskStatus(position) {
  const protocol = String(position?.protocol || position?.poolModel || '').toLowerCase();
  const liquidityState = String(position?.analytics?.liquidityState || position?.liquidityState || '').toLowerCase();
  const priceImpact10kPct = Number(position?.analytics?.priceImpact10kPct ?? position?.yieldMetrics?.priceImpact10kPct);

  if (liquidityState === 'empty') {
    return {
      tone: 'red',
      label: 'No depth',
      detail: 'This pool needs live liquidity before fee estimates become meaningful.',
    };
  }

  if (protocol === 'curve') {
    if (Number.isFinite(priceImpact10kPct) && priceImpact10kPct > 1.5) {
      return {
        tone: 'amber',
        label: 'Watch depth',
        detail: 'Stable pool depth is weaker right now. Keep size smaller until conditions improve.',
      };
    }

    return {
      tone: 'green',
      label: 'Stable',
      detail: 'This is the lowest-volatility LP option on the page right now.',
    };
  }

  if (Number.isFinite(priceImpact10kPct) && priceImpact10kPct > 3) {
    return {
      tone: 'red',
      label: 'Thin',
      detail: 'Low depth can move price quickly. Better for careful manual use only.',
    };
  }

  return {
    tone: 'amber',
    label: 'Volatile',
    detail: 'Price can move quickly here. Keep size small and watch pool depth before adding more.',
  };
}

function getPositionStatusCards(position) {
  const poolFeeLabel = formatStatusPercent(position?.yieldMetrics?.poolFeePct ?? position?.feePct);

  return [
    {
      title: 'Reward Source',
      tone: 'green',
      label: 'Pool fees',
      detail: poolFeeLabel
        ? `${poolFeeLabel} pool fees stay inside the LP position. Extra reward campaigns are not active.`
        : 'LP rewards come only from pool trading fees when this pool is actually used. Extra reward campaigns are not active.',
    },
    {
      title: 'Claim Status',
      tone: 'slate',
      label: 'On exit',
      detail: 'LP fees are not claimed separately. They are realized when you remove liquidity or close the position.',
    },
    {
      title: 'Risk Status',
      ...getPositionRiskStatus(position),
    },
  ];
}

function formatHealthFactor(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric === 0) return '0';
  return numeric.toFixed(numeric >= 10 ? 2 : 3).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

function getLendingExecutionStatus(surface) {
  const execution = surface?.execution || {};

  if (execution.globalPaused) {
    return {
      tone: 'red',
      label: 'Paused',
      detail: 'Lending actions are paused right now.',
    };
  }

  if (execution.ready) {
    return {
      tone: 'green',
      label: 'Ready',
      detail: 'Stable lending actions are available from the DeFi tab.',
    };
  }

  if (execution.contractAddress && execution.buildState === 'scaffold_only') {
    return {
      tone: 'amber',
      label: 'Limited',
      detail: 'A lending contract is connected, but the current setup still blocks full live writes.',
    };
  }

  return {
    tone: 'amber',
    label: 'Coming soon',
    detail: 'This lending surface is wired, but a live contract is not connected yet.',
  };
}

function getLendingPriceStatus(surface) {
  const priceAssets = Array.isArray(surface?.prices?.assets) ? surface.prices.assets : [];
  const fallbackAssets = priceAssets.filter((asset) => asset?.isFallback);

  if (priceAssets.length === 0) {
    return {
      tone: 'slate',
      label: 'Waiting',
      detail: 'Price data has not loaded yet.',
    };
  }

  if (fallbackAssets.length > 0) {
    return {
      tone: 'amber',
      label: 'Backup in use',
      detail: `${fallbackAssets.map((asset) => asset.symbol).join(', ')} is currently using backup price data.`,
    };
  }

  return {
    tone: 'green',
    label: 'Live prices',
    detail: 'This summary is using the current stable price feed.',
  };
}

function getLendingRiskStatus(risk) {
  if (!risk) {
    return {
      tone: 'slate',
      label: 'Waiting',
      detail: 'Lending risk has not loaded yet.',
    };
  }

  if (risk.band === 'healthy') {
    return {
      tone: 'green',
      label: risk.label || 'Buffered',
      detail: `${risk.detail} Health factor ${formatHealthFactor(risk.healthFactor)}.`,
    };
  }

  if (risk.band === 'warning') {
    return {
      tone: 'amber',
      label: risk.label || 'Watch closely',
      detail: `${risk.detail} Health factor ${formatHealthFactor(risk.healthFactor)}.`,
    };
  }

  if (risk.band === 'critical') {
    return {
      tone: 'red',
      label: risk.label || 'Critical',
      detail: `${risk.detail} Health factor ${formatHealthFactor(risk.healthFactor)}.`,
    };
  }

  return {
    tone: 'slate',
    label: risk.label || 'No debt',
    detail: risk.detail || 'No active lending debt is visible yet.',
  };
}

function humanizeAutomationSource(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Policy default';
  if (raw === 'policy_default') return 'Policy default';

  const [prefix, suffix] = raw.split(':');
  if (prefix === 'market_analysis') {
    return `Market analysis (${String(suffix || 'unknown').toUpperCase()})`;
  }

  return humanizeAutomationAction(raw, 'Policy default');
}

function formatAllocationBandPct(minPct, targetPct, maxPct) {
  const minLabel = formatPercentAmount(minPct);
  const targetLabel = formatPercentAmount(targetPct);
  const maxLabel = formatPercentAmount(maxPct);
  if ([minLabel, targetLabel, maxLabel].includes('—')) return '—';
  return `${minLabel} · ${targetLabel} · ${maxLabel}`;
}

function getMarketAnalysisStatus(marketAnalysisState, lastDecision) {
  if (!marketAnalysisState?.enabled) {
    return {
      tone: 'slate',
      label: 'Disabled',
      detail: 'Market analysis is off, so no advisory signal will be refreshed for this agent.',
    };
  }

  const status = String(marketAnalysisState?.lastStatus || 'idle');
  const signal = lastDecision?.signal || null;

  if (status === 'running') {
    return {
      tone: 'blue',
      label: 'Running',
      detail: 'Market analysis is refreshing the current advisory signal right now.',
    };
  }

  if (status === 'success') {
    return {
      tone: 'green',
      label: 'Healthy',
      detail: signal?.lane === 'stable_curve'
        ? 'The latest advisory signal is feeding the stable policy allocation band.'
        : 'The latest advisory signal stayed in observe-only mode.',
    };
  }

  if (['permission_blocked', 'disabled'].includes(status)) {
    return {
      tone: 'amber',
      label: humanizeAutomationStatus(status),
      detail: 'Market analysis is enabled, but it cannot currently refresh a usable advisory signal.',
    };
  }

  if (['error', 'missing_agent'].includes(status)) {
    return {
      tone: 'red',
      label: humanizeAutomationStatus(status),
      detail: 'The latest market analysis cycle did not finish cleanly.',
    };
  }

  return {
    tone: 'slate',
    label: humanizeAutomationStatus(status),
    detail: 'Market analysis is waiting for the next eligible cycle.',
  };
}

function humanizeAutomationStatus(status) {
  const labels = {
    idle: 'Idle',
    running: 'Running',
    success: 'Healthy',
    executed: 'Executed',
    dry_run: 'Dry Run',
    policy_hold: 'Policy Hold',
    insufficient_balance: 'Balance Hold',
    permission_blocked: 'Permission Blocked',
    cap_reached: 'Cap Reached',
    fetch_error: 'Fetch Error',
    position_guard_unavailable: 'Position Guard',
    balance_check_failed: 'Balance Check',
    execution_blocked: 'Execution Blocked',
    execution_error: 'Execution Error',
    dry_run_failed: 'Dry Run Failed',
    pool_unconfigured: 'Pool Missing',
    disabled: 'Disabled',
    missing_agent: 'Missing Agent',
    no_private_key: 'Missing Key',
    error: 'Error',
  };

  return labels[status] || String(status || 'idle').replace(/_/g, ' ');
}

function humanizeAutomationAction(value, fallback = 'No action') {
  if (!value) return fallback;
  return String(value)
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isAutomationErrorStatus(status) {
  return [
    'fetch_error',
    'position_guard_unavailable',
    'balance_check_failed',
    'execution_blocked',
    'execution_error',
    'dry_run_failed',
    'pool_unconfigured',
    'missing_agent',
    'error',
  ].includes(String(status || 'idle'));
}

function getAutomationStatusSummary(status, lastDecision) {
  if (!lastDecision) return null;

  if (isAutomationErrorStatus(status)) {
    return lastDecision.error || lastDecision.reason || lastDecision.summary || null;
  }

  return lastDecision.summary || lastDecision.reason || lastDecision.error || null;
}

function getStableAutomationStatus(defiLoopState, lastDecision) {
  if (!defiLoopState?.enabled) {
    return {
      tone: 'slate',
      label: 'Disabled',
      detail: 'Stable automation is off for this agent. No autonomous LP or swap decision will run until it is enabled again.',
    };
  }

  const status = String(defiLoopState?.lastStatus || 'idle');
  const summary = getAutomationStatusSummary(status, lastDecision);

  if (status === 'running') {
    return {
      tone: 'blue',
      label: 'Running',
      detail: 'Stable automation is evaluating the next verified USDC/EURC cycle right now.',
    };
  }

  if (status === 'executed') {
    return {
      tone: 'green',
      label: 'Executed',
      detail: summary || 'The last stable automation cycle submitted an on-chain action.',
    };
  }

  if (['success', 'dry_run'].includes(status)) {
    return {
      tone: status === 'success' ? 'green' : 'amber',
      label: humanizeAutomationStatus(status),
      detail: summary || 'The last stable automation cycle completed without a fatal error.',
    };
  }

  if (['policy_hold', 'insufficient_balance', 'permission_blocked', 'cap_reached', 'disabled', 'no_private_key'].includes(status)) {
    return {
      tone: 'amber',
      label: humanizeAutomationStatus(status),
      detail: summary || 'The last stable automation cycle held instead of sending a transaction.',
    };
  }

  if (['fetch_error', 'position_guard_unavailable', 'balance_check_failed', 'execution_blocked', 'execution_error', 'dry_run_failed', 'pool_unconfigured', 'missing_agent', 'error'].includes(status)) {
    return {
      tone: 'red',
      label: humanizeAutomationStatus(status),
      detail: summary || 'The last stable automation cycle hit an error before it could finish cleanly.',
    };
  }

  return {
    tone: 'slate',
    label: humanizeAutomationStatus(status),
    detail: summary || 'Stable automation is waiting for the next eligible cycle.',
  };
}

function getStableOracleGuardContext(lastDecision) {
  if (!lastDecision || lastDecision.lane !== 'oracle_strategy') {
    return null;
  }

  const blockedBy = String(lastDecision?.blockedBy || '').trim();
  const exitQuote = lastDecision?.exitQuote && typeof lastDecision.exitQuote === 'object'
    ? lastDecision.exitQuote
    : null;
  const sameChainSellBackQuote = lastDecision?.sameChainSellBackQuote && typeof lastDecision.sameChainSellBackQuote === 'object'
    ? lastDecision.sameChainSellBackQuote
    : null;

  if (sameChainSellBackQuote) {
    const inputUsdc = Number(sameChainSellBackQuote.inputUsdc);
    const expectedEurcOut = Number(sameChainSellBackQuote.expectedEurcOut);
    const entryPriceUsdc = Number.isFinite(inputUsdc)
      && Number.isFinite(expectedEurcOut)
      && expectedEurcOut > 0
      ? inputUsdc / expectedEurcOut
      : null;

    return {
      reasonLabel: blockedBy === 'same_chain_exit_unprofitable'
        ? 'Live Arc exit quote below round-trip floor'
        : null,
      reasonDetail: blockedBy === 'same_chain_exit_unprofitable'
        ? 'A fresh Curve buy stays blocked until the matching live Arc EURC -> USDC quote clears the required round-trip floor.'
        : null,
      title: 'Oracle Guard Check',
      detail: 'Fresh Curve entries only run when the same-cycle live Arc exit quote still clears the required floor after minimum profit.',
      quoteAmountLabel: formatRewardAmount(expectedEurcOut, 'EURC'),
      entryPriceUsdc,
      entryPriceTracked: Number.isFinite(entryPriceUsdc) && entryPriceUsdc > 0,
      currentExitQuoteUsdc: Number(sameChainSellBackQuote.expectedUsdcOut),
      requiredFloorUsdc: Number(sameChainSellBackQuote.minimumExpectedUsdcOut),
      exitRail: getExecutionRailLabel(sameChainSellBackQuote.exitExecutionRail),
    };
  }

  if (exitQuote) {
    const costFloorActive = exitQuote.profitBasis === 'oracle_inventory_cost_basis';

    return {
      reasonLabel: blockedBy
        ? (costFloorActive ? 'Live Arc exit quote below cost floor' : 'Live Arc exit quote below required floor')
        : null,
      reasonDetail: blockedBy
        ? (costFloorActive
          ? 'Protected EURC inventory stays on hold until the live Arc EURC -> USDC quote clears the tracked cost-basis floor.'
          : 'Protected EURC inventory stays on hold until the live Arc EURC -> USDC quote clears the required floor.')
        : null,
      title: costFloorActive ? 'Oracle Cost Floor Check' : 'Oracle Exit Check',
      detail: costFloorActive
        ? 'Excess EURC inventory only exits when the live Arc quote is above tracked cost basis plus the minimum profit buffer.'
        : 'Excess EURC inventory only exits when the live Arc quote is above the current required floor.',
      quoteAmountLabel: formatRewardAmount(exitQuote.inputEurc, 'EURC'),
      entryPriceUsdc: Number(exitQuote.averageEntryPriceUsdc),
      entryPriceTracked: Number(exitQuote.averageEntryPriceUsdc) > 0,
      currentExitQuoteUsdc: Number(exitQuote.expectedUsdcOut),
      requiredFloorUsdc: Number(exitQuote.minimumExpectedUsdcOut),
      exitRail: getExecutionRailLabel(exitQuote.exitExecutionRail),
    };
  }

  return null;
}

function getCirbtcAutomationStatus(cirbtcLoopState, lastDecision) {
  if (!cirbtcLoopState?.enabled) {
    return {
      tone: 'slate',
      label: 'Disabled',
      detail: 'cirBTC LP automation is off for this agent. No autonomous bootstrap, trim, or exit cycle will run until it is enabled again.',
    };
  }

  const status = String(cirbtcLoopState?.lastStatus || 'idle');
  const summary = getAutomationStatusSummary(status, lastDecision);

  if (status === 'running') {
    return {
      tone: 'blue',
      label: 'Running',
      detail: 'cirBTC LP automation is evaluating the next verified direct-pair cycle right now.',
    };
  }

  if (status === 'executed') {
    return {
      tone: 'green',
      label: 'Executed',
      detail: summary || 'The last cirBTC LP automation cycle submitted an on-chain action.',
    };
  }

  if (['success', 'dry_run'].includes(status)) {
    return {
      tone: status === 'success' ? 'green' : 'amber',
      label: humanizeAutomationStatus(status),
      detail: summary || 'The last cirBTC LP automation cycle completed without a fatal error.',
    };
  }

  if (['policy_hold', 'insufficient_balance', 'permission_blocked', 'cap_reached', 'disabled', 'no_private_key'].includes(status)) {
    return {
      tone: 'amber',
      label: humanizeAutomationStatus(status),
      detail: summary || 'The last cirBTC LP automation cycle held instead of sending a transaction.',
    };
  }

  if (['fetch_error', 'position_guard_unavailable', 'balance_check_failed', 'execution_blocked', 'execution_error', 'dry_run_failed', 'pool_unconfigured', 'missing_agent', 'error'].includes(status)) {
    return {
      tone: 'red',
      label: humanizeAutomationStatus(status),
      detail: summary || 'The last cirBTC LP automation cycle hit an error before it could finish cleanly.',
    };
  }

  return {
    tone: 'slate',
    label: humanizeAutomationStatus(status),
    detail: summary || 'cirBTC LP automation is waiting for the next eligible cycle.',
  };
}

function getCirbtcAutomationFreshness(defiLoopState, cirbtcLoopState, lastDecision) {
  const cirbtcDecisionAtMs = Date.parse(lastDecision?.recordedAt || '');
  const cirbtcRunAtMs = Date.parse(cirbtcLoopState?.lastRunAt || '');
  const latestCirbtcSnapshotAtMs = [cirbtcDecisionAtMs, cirbtcRunAtMs]
    .filter(value => Number.isFinite(value))
    .sort((left, right) => right - left)[0] || null;
  const latestDefiLoopAtMs = Date.parse(defiLoopState?.lastRunAt || '');
  const latestCirbtcSnapshotAt = lastDecision?.recordedAt || cirbtcLoopState?.lastRunAt || null;

  if (!Number.isFinite(latestDefiLoopAtMs)) {
    return {
      hasNewerDefiLoop: false,
      displayLastSeenAt: latestCirbtcSnapshotAt,
      detail: null,
    };
  }

  if (
    !Number.isFinite(latestCirbtcSnapshotAtMs)
    || (latestDefiLoopAtMs - latestCirbtcSnapshotAtMs) > AUTOMATION_SNAPSHOT_TOLERANCE_MS
  ) {
    return {
      hasNewerDefiLoop: true,
      displayLastSeenAt: latestCirbtcSnapshotAt || defiLoopState?.lastRunAt || null,
      detail: latestCirbtcSnapshotAt
        ? `Last cirBTC review was at ${formatDateTime(latestCirbtcSnapshotAt)}. Another auto cycle ran at ${formatDateTime(defiLoopState?.lastRunAt)}, and the next cirBTC review is still pending.`
        : `Another auto cycle ran at ${formatDateTime(defiLoopState?.lastRunAt)}. The first cirBTC LP review is still pending.`,
    };
  }

  return {
    hasNewerDefiLoop: false,
    displayLastSeenAt: latestCirbtcSnapshotAt,
    detail: null,
  };
}

function findLatestCirbtcLpTx(txs = []) {
  return [...txs]
    .filter((tx) => {
      if (!['direct_lp_add', 'direct_lp_remove'].includes(tx?.type)) return false;
      const meta = getTxMeta(tx);
      return getAutomationPolicyMeta(meta).executionSource === 'cirbtc_lp_policy_v1';
    })
    .sort((left, right) => Date.parse(right?.created_at || '') - Date.parse(left?.created_at || ''))[0] || null;
}

function getCirbtcLpMoveLabel(tx) {
  if (!tx) return 'No LP move yet';
  return tx.type === 'direct_lp_remove' ? 'Removed LP' : 'Added LP';
}

function getCirbtcPairStatusLabel(status) {
  const labels = {
    executed: 'Sent',
    ready: 'Ready',
    eligible: 'Ready next',
    cooldown: 'Cooldown',
    needs_funds: 'Needs funds',
    position_open: 'Position open',
    pool_inactive: 'Pool inactive',
    impact_guard: 'Impact limit',
    exit_ready: 'Needs review',
    blocked: 'Blocked',
  };

  return labels[status] || 'Waiting';
}

function getCirbtcPairStatusTone(status) {
  if (status === 'executed' || status === 'ready' || status === 'eligible') return 'green';
  if (status === 'cooldown' || status === 'needs_funds' || status === 'impact_guard') return 'amber';
  if (status === 'pool_inactive' || status === 'exit_ready' || status === 'blocked') return 'red';
  return 'slate';
}

function formatAutomationDecisionSize(decision) {
  if (!decision) return '—';

  if (decision.operationType === 'remove_liquidity') {
    const lpAmount = Number(decision.suggestedLpExitAmount);
    const notionalUsd = Number(decision.suggestedLpExitValueUsd);
    if (Number.isFinite(lpAmount) && lpAmount > 0) {
      const lpLabel = `${formatLpAmount(lpAmount)} LP`;
      return Number.isFinite(notionalUsd) && notionalUsd > 0
        ? `${lpLabel} · ${formatUsdAmount(notionalUsd)}`
        : lpLabel;
    }
    return '—';
  }

  const actionAmount = Number(decision?.actionParams?.amountIn ?? decision?.suggestedAmountUsdc);
  if (!Number.isFinite(actionAmount) || actionAmount <= 0) return '—';

  return formatRewardAmount(actionAmount, decision?.actionAssetSymbol || 'USDC');
}

function getStatusBadgeClasses(tone) {
  if (tone === 'blue') return 'border-sky-200 bg-sky-50 text-sky-700';
  if (tone === 'green') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (tone === 'amber') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (tone === 'red') return 'border-rose-200 bg-rose-50 text-rose-700';
  return 'border-slate-200 bg-slate-100 text-slate-700';
}

function formatPositionVenue(position) {
  const chain = position?.chain || 'Arc Testnet';
  const protocol = String(position?.protocol || '').toLowerCase();
  const poolModel = String(position?.poolModel || '').toLowerCase();

  let venueLabel = 'Liquidity pool';
  if (protocol === 'curve') {
    venueLabel = 'Curve stable pool';
  } else if (protocol === 'uniswap_v2_like' && poolModel === 'constant_product') {
    venueLabel = 'Direct liquidity pool';
  } else if (protocol === 'uniswap_v2_like') {
    venueLabel = 'Direct swap pool';
  }

  return `${chain} · ${venueLabel}`;
}

function normalizeExplorerChainName(chainName) {
  const normalized = String(chainName || '').trim().toLowerCase();

  if (!normalized) return 'Arc Testnet';
  if (normalized === 'arc-testnet' || normalized === 'arc testnet') return 'Arc Testnet';
  if (normalized === 'sepolia') return 'Sepolia';
  if (normalized === 'base-sepolia' || normalized === 'base sepolia') return 'Base Sepolia';
  if (normalized === 'optimism-sepolia' || normalized === 'optimism sepolia') return 'Optimism Sepolia';
  if (normalized === 'arbitrum-sepolia' || normalized === 'arbitrum sepolia') return 'Arbitrum Sepolia';

  return chainName;
}

function formatActivityChainLabel(chainName) {
  return normalizeExplorerChainName(chainName || 'Arc Testnet');
}

function getExplorerTxUrl(chainName, txHash) {
  const explorerBase = CHAINS[normalizeExplorerChainName(chainName)]?.explorerUrl;
  if (!explorerBase || !isRealHash(txHash)) return null;
  return `${explorerBase}/tx/${txHash}`;
}

function getOracleStrategyLabel(meta) {
  return meta.signal?.strategy === 'stablecoin_fx'
    ? 'EURC/USDC oracle strategy'
    : 'Oracle strategy';
}

function getOracleSignalKey(meta) {
  const timestamp = meta.signal?.timestamp;
  if (!timestamp) return null;

  return [
    meta.signal?.strategy || 'oracle',
    timestamp,
    Number(meta.signal?.opportunity?.amountUsdc || 0),
  ].join(':');
}

function isOracleFollowUpTxType(type) {
  return [
    'defi_loop_swap',
    'defi_loop_dry',
    'curve_lp_add',
    'curve_lp_remove',
    'rebalance',
    'direct_lp_add',
    'direct_lp_remove',
  ].includes(type);
}

function getOracleSignalFollowUp(tx, allTxs) {
  const signalKey = getOracleSignalKey(getTxMeta(tx));
  if (!signalKey) return null;

  return allTxs.find(candidate => {
    if (!isOracleFollowUpTxType(candidate?.type)) return false;
    return getOracleSignalKey(getTxMeta(candidate)) === signalKey;
  }) || null;
}

function getVisibleRecentActivity(allTxs = [], agentStatus = null) {
  const visible = [];
  const seenOracleSnapshots = new Set();
  const stableLoopState = agentStatus?.automation?.defiLoop || null;
  const legacyStableSnapshotActive = stableLoopState?.lastStatus === 'policy_hold'
    && ['manualCooldown', 'legacySnapshot'].includes(stableLoopState?.lastDecision?.blockedBy);
  const latestManualStableAddAtMs = allTxs
    .filter(tx => tx?.type === 'curve_lp_add' && String(getTxMeta(tx)?.taskId || '').startsWith('EXEC_MANUAL_CURVE_LIQUIDITY_ADD'))
    .map(tx => Date.parse(tx?.created_at || ''))
    .filter(timestamp => Number.isFinite(timestamp))
    .sort((left, right) => right - left)[0] || null;

  allTxs.forEach(tx => {
    if (legacyStableSnapshotActive && tx?.type === 'curve_lp_remove') {
      const policyBadge = getActivityPolicyBadge(tx);
      const txCreatedAtMs = Date.parse(tx?.created_at || '');
      if (
        policyBadge?.label === 'Legacy mixed policy'
        && Number.isFinite(txCreatedAtMs)
        && Number.isFinite(latestManualStableAddAtMs)
        && txCreatedAtMs >= latestManualStableAddAtMs
      ) {
        return;
      }
    }

    if (tx?.type !== 'oracle_signal') {
      visible.push(tx);
      return;
    }

    if (getOracleSignalFollowUp(tx, allTxs)) {
      visible.push(tx);
      return;
    }

    const meta = getTxMeta(tx);
    const snapshotKey = [
      meta.signal?.strategy || 'oracle',
      meta.executionState || 'unknown',
      meta.executionPermissionGranted === true ? 'auto' : 'snapshot',
    ].join(':');

    if (seenOracleSnapshots.has(snapshotKey)) {
      return;
    }

    seenOracleSnapshots.add(snapshotKey);
    visible.push(tx);
  });

  return visible;
}

function getTxDisplay(tx, { allTxs = [], agentStatus = null } = {}) {
  const meta = getTxMeta(tx);
  const activityPolicyBadge = getActivityPolicyBadge(tx);
  const isOracleSignal = tx.type === 'oracle_signal';
  const isOracleStrategyExecution = tx.type === 'defi_loop_swap';
  const isOracleStrategyDryRun = tx.type === 'defi_loop_dry';
  const isSwap = tx.type === 'swap';
  const isDirectLpAdd = tx.type === 'direct_lp_add';
  const isDirectLpRemove = tx.type === 'direct_lp_remove';
  const isCurveLpAdd = tx.type === 'curve_lp_add';
  const isCurveLpRemove = tx.type === 'curve_lp_remove';
  const isTaskArb = tx.type === 'task_arb';
  const isRebalance = tx.type === 'rebalance';
  const isGasFanout = tx.type === 'gas_topup' && Array.isArray(meta.targets) && meta.targets.length > 0;

  if (isOracleSignal) {
    const strategy = meta.signal?.strategy === 'stablecoin_fx'
      ? 'EURC/USDC oracle snapshot'
      : 'Oracle snapshot';
    const isDailyCapReached = meta.executionState === 'daily_cap_reached';
    const followUpTx = getOracleSignalFollowUp(tx, allTxs);
    const signalCreatedAtMs = Date.parse(tx.created_at || meta.signal?.timestamp || '');
    const defiLoopState = agentStatus?.automation?.defiLoop || null;
    const lastDefiRunAtMs = Date.parse(defiLoopState?.lastRunAt || '');
    const latestDefiLoopStatus = String(defiLoopState?.lastStatus || 'idle');
    const latestDefiLoopDetail = getAutomationStatusSummary(latestDefiLoopStatus, defiLoopState?.lastDecision);
    const manualCooldownUntil = defiLoopState?.manualCooldownUntil || defiLoopState?.lastDecision?.manualCooldownUntil || null;
    const manualCooldownUntilMs = Date.parse(manualCooldownUntil || '');

    let signalReason = meta.signalOnlyReason
      || (meta.executionPermissionGranted
        ? 'This is a normal oracle snapshot, not a separate trade. The stable automation card shows the latest committed policy result.'
        : 'Signal only — this agent does not currently have permission to auto-execute oracle strategies.');

    if (followUpTx) {
      const followUpMeta = getTxMeta(followUpTx);
      if (followUpMeta.executionState === 'daily_cap_reached') {
        signalReason = `This signal later hit the daily DeFi loop cap at ${Number(followUpMeta.dailyCapCount || 0)}/${Number(followUpMeta.dailyCap || 10)}. See the matching oracle strategy hold row.`;
      } else if (followUpMeta.executionState === 'insufficient_balance') {
        const tradableAmountLabel = formatTokenAmountWithZero(followUpMeta.availableToTradeUsdc, 'USDC');
        const reservedAmountLabel = formatTokenAmountWithZero(followUpMeta.walletReserveUsdc, 'USDC');
        signalReason = tradableAmountLabel && reservedAmountLabel && Number(followUpMeta.walletReserveUsdc) > 0
          ? `This signal later reached the DeFi loop, but only ${tradableAmountLabel} was tradable after keeping ${reservedAmountLabel} reserved in the agent wallet. See the matching oracle strategy hold row.`
          : 'This signal later reached the DeFi loop, but the agent wallet did not have enough balance. See the matching oracle strategy hold row.';
      } else if (followUpTx.status === 'confirmed') {
        signalReason = 'This signal later produced the executed oracle strategy row below.';
      } else if (followUpTx.status === 'failed') {
        signalReason = 'This signal later produced a failed oracle strategy row below.';
      } else {
        signalReason = 'This signal later produced a separate DeFi loop result row below.';
      }
    } else if (meta.executionPermissionGranted && Number.isFinite(signalCreatedAtMs) && Number.isFinite(manualCooldownUntilMs) && manualCooldownUntilMs > signalCreatedAtMs) {
      signalReason = `This is a normal oracle snapshot. Stable automation stayed in manual LP cooldown until ${formatDateTime(manualCooldownUntil)}, so no soft trim or exit was allowed for this signal.`;
    } else if (meta.executionPermissionGranted) {
      if (Number.isFinite(signalCreatedAtMs) && Number.isFinite(lastDefiRunAtMs) && lastDefiRunAtMs < signalCreatedAtMs) {
        signalReason = 'This is a normal oracle snapshot. The latest recorded DeFi loop run happened before this signal arrived, so no newer execution result exists for this exact opportunity yet.';
      } else if (Number.isFinite(signalCreatedAtMs) && Number.isFinite(lastDefiRunAtMs) && lastDefiRunAtMs >= signalCreatedAtMs && isAutomationErrorStatus(latestDefiLoopStatus)) {
        signalReason = latestDefiLoopDetail
          ? `This is a normal oracle snapshot. The latest DeFi loop run later failed with ${humanizeAutomationStatus(latestDefiLoopStatus)}: ${latestDefiLoopDetail}. No per-signal execution row was recorded for this opportunity.`
          : `This is a normal oracle snapshot. The latest DeFi loop run later failed with ${humanizeAutomationStatus(latestDefiLoopStatus)}. No per-signal execution row was recorded for this opportunity.`;
      } else {
        signalReason = 'This is a normal oracle snapshot. Autonomous execution can approve the signal without creating a one-to-one transaction row for every snapshot.';
      }
    }

    return {
      title: isDailyCapReached ? 'oracle snapshot not executed' : 'oracle snapshot',
      routeLabel: `Arc Testnet · ${strategy}`,
      amountLabel: Number(tx.amount_usdc) > 0
        ? `${parseFloat(tx.amount_usdc).toFixed(2)} ${tx.token || 'USDC'}`
        : null,
      phase: signalReason,
      links: [],
      tagLabel: activityPolicyBadge?.label || null,
      tagVariant: activityPolicyBadge?.variant || 'slate',
    };
  }

  if (isOracleStrategyExecution || isOracleStrategyDryRun) {
    const inputToken = meta.fromToken || 'USDC';
    const outputToken = meta.toToken || tx.token || 'EURC';
    const inputAmountLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, inputToken);
    const outputAmountLabel = formatTokenAmount(meta.amountOut, outputToken);
    const requestedAmountLabel = formatTokenAmountWithZero(meta.requestedAmountIn, inputToken);
    const availableBalanceLabel = formatTokenAmountWithZero(meta.availableBalanceUsdc, inputToken);
    const tradableBalanceLabel = formatTokenAmountWithZero(meta.availableToTradeUsdc, inputToken);
    const reservedBalanceLabel = formatTokenAmountWithZero(meta.walletReserveUsdc, inputToken);
    const summarizedError = summarizeActivityError(meta.error);
    const txHash = tx.tx_hash || tx.txHash || null;
    const txUrl = getExplorerTxUrl('Arc Testnet', txHash);

    let phase = null;
    if (meta.executionState === 'daily_cap_reached') {
      phase = `Autonomous execution did not run because this agent already used ${Number(meta.dailyCapCount || 0)}/${Number(meta.dailyCap || 10)} daily DeFi loop runs. No on-chain trade was submitted.`;
    } else if (meta.executionState === 'insufficient_balance') {
      phase = tradableBalanceLabel && reservedBalanceLabel && Number(meta.walletReserveUsdc) > 0
        ? `Skipped before execution. Requested ${requestedAmountLabel || inputAmountLabel || `1 ${inputToken}`}, the wallet held ${availableBalanceLabel || `0 ${inputToken}`}, but ${reservedBalanceLabel} was kept reserved, leaving ${tradableBalanceLabel} available for autonomous trading. No on-chain trade was submitted.`
        : availableBalanceLabel
        ? `Skipped before execution. Requested ${requestedAmountLabel || inputAmountLabel || `1 ${inputToken}`}, but the agent wallet only had ${availableBalanceLabel}. No on-chain trade was submitted.`
        : 'Skipped before execution because the agent wallet did not have enough balance for this trade.';
    } else if (isOracleStrategyDryRun || meta.executionState === 'dry_run') {
      phase = 'Autonomous execution is enabled, but this run stayed in dry-run mode and did not submit an on-chain trade.';
    } else if (tx.status === 'confirmed') {
      phase = outputAmountLabel
        ? `Executed autonomously — received ${outputAmountLabel}`
        : 'Executed autonomously on-chain';
    } else if (tx.status === 'failed') {
      phase = summarizedError
        ? `Autonomous execution failed: ${summarizedError}${getOracleStrategyFailureContext(meta, inputToken)}`
        : 'Autonomous execution failed before confirmation';
    }

    return {
      title: meta.executionState === 'daily_cap_reached'
        ? 'oracle strategy hold'
        : meta.executionState === 'insufficient_balance'
        ? 'oracle strategy hold'
        : isOracleStrategyDryRun
          ? 'oracle strategy dry run'
          : 'executed oracle strategy',
      routeLabel: `Arc Testnet · ${getOracleStrategyLabel(meta)}`,
      amountLabel: inputAmountLabel || requestedAmountLabel,
      phase,
      links: txUrl
        ? [{
            key: `${tx.id}-oracle-strategy`,
            label: 'Tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
      tagLabel: activityPolicyBadge?.label || null,
      tagVariant: activityPolicyBadge?.variant || 'slate',
    };
  }

  if (isSwap) {
    const fromToken = meta.fromToken || tx.token || 'USDC';
    const toToken = meta.toToken || 'USDC';
    const inputAmountLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, fromToken);
    const outputAmountLabel = formatTokenAmount(meta.amountOut, toToken);
    const swapTxHash = tx.tx_hash || tx.txHash || null;
    const swapUrl = getExplorerTxUrl('Arc Testnet', swapTxHash);
    const failedSwapPhase = getUserFacingFailedActivityPhase(meta, 'This swap', 'This swap failed before confirmation.');

    return {
      title: 'swap',
      routeLabel: `Arc Testnet · ${fromToken} → ${toToken}`,
      amountLabel: inputAmountLabel,
      phase: tx.status === 'failed'
        ? failedSwapPhase
        : outputAmountLabel
          ? `${tx.status === 'confirmed' ? 'Received' : 'Estimated out'}: ${outputAmountLabel}`
          : (tx.status === 'executing' ? 'Awaiting on-chain confirmation' : null),
      links: swapUrl
        ? [{
            key: `${tx.id}-swap`,
            label: 'Tx',
            hash: swapTxHash,
            url: swapUrl,
          }]
        : [],
    };
  }

  if (isDirectLpAdd) {
    const stableToken = meta.stableToken || tx.token || 'USDC';
    const volatileToken = meta.volatileToken || 'cirBTC';
    const amountInLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, stableToken);
    const swappedLabel = meta.swappedAmountIn && meta.amountOut
      ? `${formatTokenAmount(meta.swappedAmountIn, stableToken)} -> ${formatTokenAmount(meta.amountOut, volatileToken)}`
      : null;
    const lpMintedLabel = meta.lpAmount ? `${formatLpAmount(meta.lpAmount)} LP minted` : null;
    const lpUsedLabel = meta.liquidityStableAmountUsed && meta.liquidityVolatileAmountUsed
      ? `LP leg used ${formatTokenAmount(meta.liquidityStableAmountUsed, stableToken)} + ${formatTokenAmount(meta.liquidityVolatileAmountUsed, volatileToken)}`
      : null;
    const leftoverParts = [
      Number(meta.liquidityStableAmountRemaining || 0) > 0 ? formatTokenAmount(meta.liquidityStableAmountRemaining, stableToken) : null,
      Number(meta.liquidityVolatileAmountRemaining || 0) > 0 ? formatTokenAmount(meta.liquidityVolatileAmountRemaining, volatileToken) : null,
    ].filter(Boolean);
    const primaryHash = meta.mintTxHash || tx.tx_hash || null;
    const swapUrl = getExplorerTxUrl('Arc Testnet', meta.swapTxHash);
    const mintUrl = getExplorerTxUrl('Arc Testnet', primaryHash);
    const failedLpAddPhase = getUserFacingFailedActivityPhase(meta, 'This LP add', 'This LP add failed before confirmation.');

    return {
      title: 'direct pair lp add',
      routeLabel: `Arc Testnet · ${stableToken}/${volatileToken} direct pair`,
      amountLabel: amountInLabel,
      phase: tx.status === 'failed'
        ? failedLpAddPhase
        : swappedLabel
          ? `Swap leg ${swappedLabel}${meta.swapRouteStrategy ? ` via ${meta.swapRouteStrategy}` : ''}. ${lpUsedLabel || lpMintedLabel || 'LP minted.'}${leftoverParts.length > 0 ? ` Wallet kept ${leftoverParts.join(' + ')} unmatched to the pair ratio.` : ''}`
          : (meta.summary || lpMintedLabel || 'Direct-pair LP minted on-chain'),
      links: [
        swapUrl ? {
          key: `${tx.id}-direct-lp-add-swap`,
          label: 'Swap tx',
          hash: meta.swapTxHash,
          url: swapUrl,
        } : null,
        mintUrl ? {
          key: `${tx.id}-direct-lp-add-mint`,
          label: 'Mint tx',
          hash: primaryHash,
          url: mintUrl,
        } : null,
      ].filter(Boolean),
    };
  }

  if (isDirectLpRemove) {
    const stableToken = meta.stableToken || tx.token || 'USDC';
    const volatileToken = meta.volatileToken || 'cirBTC';
    const burnHash = meta.burnTxHash || tx.tx_hash || null;
    const burnUrl = getExplorerTxUrl('Arc Testnet', burnHash);
    const returnedStable = meta.token0Symbol === stableToken
      ? formatTokenAmount(meta.token0Amount, stableToken)
      : meta.token1Symbol === stableToken
        ? formatTokenAmount(meta.token1Amount, stableToken)
        : null;
    const returnedVolatile = meta.token0Symbol === volatileToken
      ? formatTokenAmount(meta.token0Amount, volatileToken)
      : meta.token1Symbol === volatileToken
        ? formatTokenAmount(meta.token1Amount, volatileToken)
        : null;
    const failedLpExitPhase = getUserFacingFailedActivityPhase(meta, 'This LP exit', 'This LP exit failed before confirmation.');

    return {
      title: 'direct pair lp exit',
      routeLabel: `Arc Testnet · ${stableToken}/${volatileToken} direct pair`,
      amountLabel: meta.lpAmount ? `${formatLpAmount(meta.lpAmount)} LP burned` : null,
      phase: tx.status === 'failed'
        ? failedLpExitPhase
        : [
            Number(meta.withdrawPct) > 0 ? `Withdrew ${Number(meta.withdrawPct).toFixed(0)}% of the position.` : null,
            returnedStable ? `Returned ${returnedStable}` : null,
            returnedVolatile ? `Returned ${returnedVolatile}` : null,
          ].filter(Boolean).join(' '),
      links: burnUrl ? [{
        key: `${tx.id}-direct-lp-remove-burn`,
        label: 'Burn tx',
        hash: burnHash,
        url: burnUrl,
      }] : [],
    };
  }

  if (isCurveLpAdd) {
    const tokenIn = meta.tokenIn || tx.token || 'USDC';
    const amountInLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, tokenIn);
    const lpMintedLabel = meta.lpAmount ? `${formatLpAmount(meta.lpAmount)} LP minted` : null;
    const txHash = tx.tx_hash || tx.txHash || meta.txHash || null;
    const txUrl = getExplorerTxUrl('Arc Testnet', txHash);
    const failedCurveAddPhase = getUserFacingFailedActivityPhase(meta, 'This Curve LP add', 'This Curve LP add failed before confirmation.');

    return {
      title: 'curve liquidity add',
      routeLabel: `Arc Testnet · ${tokenIn} -> Curve stable pool`,
      amountLabel: amountInLabel,
      phase: tx.status === 'dry_run'
        ? 'Simulation only. No on-chain liquidity add was submitted.'
        : tx.status === 'skipped'
          ? ([meta.summary, activityPolicyBadge?.note].filter(Boolean).join(' ')) || 'No on-chain liquidity add was submitted.'
          : tx.status === 'failed'
            ? ([failedCurveAddPhase, activityPolicyBadge?.note].filter(Boolean).join(' '))
          : meta.minLpAmount
            ? `${lpMintedLabel || 'LP minted.'} Minimum protected LP: ${formatLpAmount(meta.minLpAmount)}.`
            : ([lpMintedLabel || meta.summary || 'Curve liquidity added on-chain', activityPolicyBadge?.note].filter(Boolean).join(' ')),
      links: txUrl
        ? [{
            key: `${tx.id}-curve-lp-add`,
            label: 'Add tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
      tagLabel: activityPolicyBadge?.label || null,
      tagVariant: activityPolicyBadge?.variant || 'slate',
    };
  }

  if (isCurveLpRemove) {
    const tokenOut = meta.tokenOut || tx.token || 'USDC';
    const isDualCurveExit = meta.executionRail === 'curve_liquidity_remove_dual'
      || (!meta.tokenOut && (meta.token0Symbol || meta.token1Symbol));
    const burnLabel = meta.lpAmount ? `${formatLpAmount(meta.lpAmount)} LP burned` : null;
    const returnedLabel = formatTokenAmount(meta.amountOut, tokenOut);
    const returnedBothTokens = [
      meta.token0Symbol && meta.token0Amount ? formatTokenAmount(meta.token0Amount, meta.token0Symbol) : null,
      meta.token1Symbol && meta.token1Amount ? formatTokenAmount(meta.token1Amount, meta.token1Symbol) : null,
    ].filter(Boolean);
    const txHash = tx.tx_hash || tx.txHash || meta.txHash || null;
    const txUrl = getExplorerTxUrl('Arc Testnet', txHash);
    const failedCurveExitPhase = getUserFacingFailedActivityPhase(meta, 'This Curve LP exit', 'This Curve LP exit failed before confirmation.');

    return {
      title: 'curve liquidity remove',
      routeLabel: isDualCurveExit
        ? 'Arc Testnet · Curve stable pool -> both pool tokens'
        : `Arc Testnet · Curve stable pool -> ${tokenOut}`,
      amountLabel: burnLabel,
      phase: tx.status === 'dry_run'
        ? 'Simulation only. No on-chain liquidity removal was submitted.'
        : tx.status === 'skipped'
          ? ([meta.summary, activityPolicyBadge?.note].filter(Boolean).join(' ')) || 'No on-chain liquidity removal was submitted.'
          : tx.status === 'failed'
            ? ([failedCurveExitPhase, activityPolicyBadge?.note].filter(Boolean).join(' '))
          : [
              burnLabel,
              isDualCurveExit && returnedBothTokens.length > 0 ? `Returned ${returnedBothTokens.join(' + ')}` : null,
              !isDualCurveExit && returnedLabel ? `Returned ${returnedLabel}` : null,
              !isDualCurveExit && meta.minAmountOut ? `Minimum protected output ${formatTokenAmount(meta.minAmountOut, tokenOut)}` : null,
              activityPolicyBadge?.note,
            ].filter(Boolean).join('. '),
      links: txUrl
        ? [{
            key: `${tx.id}-curve-lp-remove`,
            label: 'Withdraw tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
      tagLabel: activityPolicyBadge?.label || null,
      tagVariant: activityPolicyBadge?.variant || 'slate',
    };
  }

  if (isTaskArb) {
    const fromToken = meta.fromToken || 'USDC';
    const toToken = meta.toToken || 'EURC';
    const amountLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, fromToken);
    const outputAmountLabel = formatTokenAmount(meta.amountOut, toToken);
    const entryTxHash = meta.entryTxHash || meta.swapTxHash || tx.tx_hash || tx.txHash || null;
    const sellBackTxHash = meta.sellBackTxHash || null;
    const entryTxUrl = getExplorerTxUrl('Arc Testnet', entryTxHash);
    const sellBackTxUrl = getExplorerTxUrl('Arc Testnet', sellBackTxHash);
    const finalUsdcAmountLabel = formatTokenAmount(meta.finalAmountOutUsdc, 'USDC');
    const entryEurcAmountLabel = formatTokenAmount(meta.entryAmountOutEurc || meta.amountOut, 'EURC');
    const failedSignalTradePhase = getUserFacingFailedActivityPhase(meta, 'This signal trade', 'This signal trade failed before confirmation.');

    let phase = meta.summary || null;
    if (tx.status === 'confirmed') {
      if (meta.roundTripCompleted) {
        phase = finalUsdcAmountLabel
          ? `Bought ${entryEurcAmountLabel || 'EURC'} on Curve, then sold it back for ${finalUsdcAmountLabel}.`
          : 'Bought EURC on Curve and completed the same-chain sell-back.';
      } else if (meta.sameChainSellBackPlanned && meta.sellBackError) {
        phase = `Bought ${entryEurcAmountLabel || 'EURC'} on Curve. Immediate sell-back did not complete, so the agent kept EURC for a later rebalance.`;
      } else {
        phase = outputAmountLabel
          ? `Executed the Curve entry leg and received ${outputAmountLabel}.`
          : 'Executed the Curve entry leg on-chain.';
      }
    } else if (tx.status === 'failed') {
      phase = failedSignalTradePhase;
    } else if (tx.status === 'dry_run') {
      phase = 'Simulation only. No on-chain trade was submitted.';
    }

    return {
      title: 'signal trade',
      routeLabel: meta.roundTripCompleted
        ? 'Arc Testnet · USDC -> EURC -> USDC'
        : `Arc Testnet · ${fromToken} -> ${toToken} Curve entry`,
      amountLabel,
      phase,
      links: [
        entryTxUrl
          ? {
              key: `${tx.id}-task-arb-entry`,
              label: meta.roundTripCompleted ? 'Buy tx' : 'Swap tx',
              hash: entryTxHash,
              url: entryTxUrl,
            }
          : null,
        sellBackTxUrl
          ? {
              key: `${tx.id}-task-arb-sell-back`,
              label: 'Sell-back tx',
              hash: sellBackTxHash,
              url: sellBackTxUrl,
            }
          : null,
      ].filter(Boolean),
    };
  }

  if (isRebalance) {
    const fromToken = meta.fromToken || tx.token || 'USDC';
    const toToken = meta.toToken || 'EURC';
    const amountLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, fromToken);
    const outputAmountLabel = formatTokenAmount(meta.amountOut, toToken);
    const txHash = tx.tx_hash || tx.txHash || meta.txHash || null;
    const txUrl = getExplorerTxUrl('Arc Testnet', txHash);
    const failedRebalancePhase = getUserFacingFailedActivityPhase(meta, 'This rebalance', 'This rebalance failed before confirmation.');

    return {
      title: 'rebalance',
      routeLabel: `Arc Testnet · ${fromToken} -> ${toToken}`,
      amountLabel,
      phase: tx.status === 'dry_run'
        ? 'Simulation only. No on-chain rebalance was submitted.'
        : tx.status === 'skipped'
          ? ([meta.summary, activityPolicyBadge?.note].filter(Boolean).join(' ')) || 'No on-chain rebalance was submitted.'
          : tx.status === 'failed'
            ? ([failedRebalancePhase, activityPolicyBadge?.note].filter(Boolean).join(' '))
          : outputAmountLabel
            ? `Received ${outputAmountLabel}${meta.executionRail ? ` via ${getExecutionRailLabel(meta.executionRail)}` : ''}`
            : ([meta.summary || 'Portfolio rebalanced on-chain', activityPolicyBadge?.note].filter(Boolean).join(' ')),
      links: txUrl
        ? [{
            key: `${tx.id}-rebalance`,
            label: 'Swap tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
      tagLabel: activityPolicyBadge?.label || null,
      tagVariant: activityPolicyBadge?.variant || 'slate',
    };
  }

  if (tx.type === 'carry_automation') {
    const actionLabel = humanizeAutomationAction(meta.operationType || meta.action || 'carry_automation');
    const stableToken = meta.stableToken || meta.actionAssetSymbol || meta.tokenIn || tx.token || 'USDC';
    const amountInLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, stableToken);
    const txHash = tx.tx_hash || tx.txHash || meta.txHash || null;
    const txUrl = getExplorerTxUrl(tx.from_chain || meta.sourceChain || 'Arc Testnet', txHash);

    return {
      title: 'Auto Carry',
      routeLabel: `${formatActivityChainLabel(tx.from_chain || meta.sourceChain || 'Arc Testnet')} · ${actionLabel}`,
      amountLabel: amountInLabel,
      phase: meta.summary || meta.reason || 'Carry automation submitted an on-chain action.',
      links: txUrl
        ? [{
            key: `${tx.id}-carry-automation`,
            label: 'Tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
    };
  }

  if (['lending_supply', 'lending_withdraw', 'lending_borrow', 'lending_repay'].includes(tx.type)) {
    const token = meta.toToken || meta.fromToken || tx.token || 'USDC';
    const txHash = tx.tx_hash || tx.txHash || meta.txHash || null;
    const txUrl = getExplorerTxUrl(tx.from_chain || meta.sourceChain || 'Arc Testnet', txHash);
    const titleMap = {
      lending_supply: 'Lending Supply',
      lending_withdraw: 'Lending Withdraw',
      lending_borrow: 'Lending Borrow',
      lending_repay: 'Lending Repay',
    };

    return {
      title: titleMap[tx.type] || 'Lending Action',
      routeLabel: `${formatActivityChainLabel(tx.from_chain || meta.sourceChain || 'Arc Testnet')} · Native lending · ${token}`,
      amountLabel: formatTokenAmount(tx.amount_usdc ?? meta.amountIn ?? meta.amountOut, token),
      phase: meta.summary || 'Executed on the Arc-native lending lane.',
      links: txUrl
        ? [{
            key: `${tx.id}-lending-action`,
            label: 'Tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
    };
  }

  if (isGasFanout) {
    const sourceChain = tx.from_chain || meta.fromChain || 'Sepolia';
    const amountEach = meta.amountEth ? `${Number(meta.amountEth).toFixed(4).replace(/\.0+$|(?<=\.\d*?)0+$/g, '')} ETH each` : null;
    const targetChains = meta.targets.map(target => target.toChain).filter(Boolean);

    return {
      title: 'gas fanout',
      routeLabel: `${sourceChain} -> ${targetChains.join(', ')}`,
      amountLabel: amountEach,
      phase: tx.status === 'dry_run'
        ? 'Simulation only. No on-chain gas top-ups were submitted.'
        : `Confirmed native gas top-ups for ${targetChains.join(', ')}.`,
      links: meta.targets.map((target, index) => {
        const url = getExplorerTxUrl(target.toChain, target.topUpTxHash);
        if (!url) return null;

        return {
          key: `${tx.id}-gas-fanout-${index}`,
          label: `${target.toChain} tx`,
          hash: target.topUpTxHash,
          url,
        };
      }).filter(Boolean),
    };
  }

  const fromChain = tx.from_chain || tx.fromChain || meta.fromChain || '';
  const toChain = tx.to_chain || tx.toChain || meta.toChain || '';
  const bridgeKind = meta.bridgeType || meta.kind || null;
  const isNativeBridge = bridgeKind === 'native'
    || tx.type === 'gas_topup'
    || ['native_gas_topup', 'native_eth_bridge'].includes(meta.kind);
  const token = tx.token || (isNativeBridge ? 'ETH' : 'USDC');
  const isBridge = tx.type === 'bridge' || isNativeBridge;
  const receiveTokenAmount = Number(meta.tokenAmount);

  const sourceTxHash = meta.sourceTxHash || meta.burnTxHash || meta.topUpTxHash || (isBridge ? tx.tx_hash || tx.txHash : null);
  const destinationTxHash = meta.destinationTxHash || meta.mintTxHash || null;
  const amountValue = token === 'ETH'
    ? meta.amountEth
    : tx.type === 'receive' && Number.isFinite(receiveTokenAmount) && receiveTokenAmount > 0
      ? receiveTokenAmount
    : (tx.amount_usdc ?? tx.amountUsdc ?? 0);

  const amountLabel = token === 'ETH'
    ? (amountValue ? `${parseFloat(amountValue).toFixed(4)} ETH` : null)
    : formatTokenAmount(amountValue, token);

  const formattedFromChain = fromChain ? formatActivityChainLabel(fromChain) : null;
  const formattedToChain = toChain ? formatActivityChainLabel(toChain) : null;
  const routeLabel = formattedFromChain && formattedToChain && formattedFromChain !== formattedToChain
    ? `${formattedFromChain} → ${formattedToChain}`
    : formattedFromChain || formattedToChain || null;
  const sourceLabel = `${isNativeBridge ? 'Source tx' : 'Burn tx'}${fromChain ? ` (${fromChain})` : ''}`;
  const destinationLabel = `${isNativeBridge ? 'Destination tx' : 'Mint tx'}${toChain ? ` (${toChain})` : ''}`;

  let title = tx.type;
  if (isBridge) title = `${token} bridge`;
  else if (tx.type === 'nano_payment') title = 'nano payment';

  let phase = null;
  if (isBridge) {
    if (meta.bridgeCompletionStatus === 'source_submitted' || meta.bridgeStep === 'source_submitted') {
      phase = fromChain ? `Submitting on ${fromChain}` : 'Submitting source bridge';
    } else if (meta.bridgeCompletionStatus === 'destination_pending' || meta.bridgeStep === 'destination_pending') {
      phase = toChain ? `Awaiting ${toChain} receipt` : 'Awaiting destination receipt';
    }
    else if (meta.bridgeStep === 'attesting') phase = 'Awaiting attestation';
    else if (meta.bridgeStep === 'ready_to_mint') phase = 'Ready to mint';
    else if (meta.bridgeCompletionStatus === 'complete' || meta.bridgeStep === 'complete') phase = 'Destination received';
  }

  const links = [
    sourceTxHash && getExplorerTxUrl(fromChain, sourceTxHash)
      ? {
          key: `${tx.id}-source`,
          label: isBridge ? sourceLabel : 'Tx',
          hash: sourceTxHash,
          url: getExplorerTxUrl(fromChain, sourceTxHash),
        }
      : null,
    destinationTxHash && getExplorerTxUrl(toChain, destinationTxHash)
      ? {
          key: `${tx.id}-destination`,
          label: destinationLabel,
          hash: destinationTxHash,
          url: getExplorerTxUrl(toChain, destinationTxHash),
        }
      : null,
    // For send/receive/swap — use tx_hash directly if no bridge links
    (!isBridge && !sourceTxHash && !destinationTxHash && isRealHash(tx.tx_hash || tx.txHash))
      ? {
          key: `${tx.id}-tx`,
          label: 'Tx',
          hash: tx.tx_hash || tx.txHash,
          url: getExplorerTxUrl(fromChain || 'Arc Testnet', tx.tx_hash || tx.txHash),
        }
      : null,
  ].filter(Boolean);

  return { title, routeLabel, amountLabel, phase, links };
}

export default function DashboardTab({ onNavigate }) {
  const { address: ownerAddress } = useAccount();
  const { agent, setAgent, setJwt, isAuthenticated } = useAgent();
  const [portfolio, setPortfolio]         = useState([]);
  const [loadingPortfolio, setLoadingPortfolio] = useState(false);
  const [portfolioError, setPortfolioError] = useState('');
  const [positions, setPositions] = useState([]);
  const [loadingPositions, setLoadingPositions] = useState(false);
  const [positionsError, setPositionsError] = useState('');
  const [positionWarnings, setPositionWarnings] = useState([]);
  const [lendingOverview, setLendingOverview] = useState(null);
  const [loadingLending, setLoadingLending] = useState(false);
  const [lendingError, setLendingError] = useState('');
  const [txs, setTxs]             = useState([]);
  const [loadingTxs, setLoadingTxs] = useState(false);
  const [txError, setTxError]     = useState('');
  const [agentStatus, setAgentStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [paymentMode, setPaymentMode] = useState(null); // 'send' | 'receive' | null
  const agentWalletAddress = agent?.walletAddress || agent?.wallet_address;

  const arcPortfolio = portfolio.find(entry => entry.chainName === 'Arc Testnet');
  const sepoliaPortfolio = portfolio.find(entry => entry.chainName === 'Sepolia');
  const lendingExecutionStatus = getLendingExecutionStatus(lendingOverview);
  const lendingPriceStatus = getLendingPriceStatus(lendingOverview);
  const lendingRiskStatus = getLendingRiskStatus(lendingOverview?.risk || null);
  const lendingActiveAssets = Array.isArray(lendingOverview?.assets)
    ? lendingOverview.assets.filter((entry) => Number(entry?.position?.suppliedAmount || 0) > 0 || Number(entry?.position?.borrowAmount || 0) > 0)
    : [];
  const lendingExecutionNotes = Array.isArray(lendingOverview?.execution?.notes) ? lendingOverview.execution.notes : [];
  const marketAnalysisState = agentStatus?.automation?.marketAnalysis || null;
  const lastMarketAnalysisDecision = marketAnalysisState?.lastDecision || null;
  const marketAnalysisStatus = getMarketAnalysisStatus(marketAnalysisState, lastMarketAnalysisDecision);
  const marketAnalysisLastSeenAt = lastMarketAnalysisDecision?.recordedAt || marketAnalysisState?.lastRunAt || null;
  const marketAnalysisBandLabel = formatAllocationBandPct(
    lastMarketAnalysisDecision?.signal?.stableLpMinAllocationPct,
    lastMarketAnalysisDecision?.signal?.stableLpTargetAllocationPct,
    lastMarketAnalysisDecision?.signal?.stableLpMaxAllocationPct,
  );
  const defiLoopState = agentStatus?.automation?.defiLoop || null;
  const lastStableDecision = defiLoopState?.lastDecision || null;
  const stableAutomationStatus = getStableAutomationStatus(defiLoopState, lastStableDecision);
  const stableAutomationDecisionSize = formatAutomationDecisionSize(lastStableDecision);
  const stableAutomationAllocationPctLabel = formatAllocationBandPct(
    lastStableDecision?.targetLpMinAllocationPct,
    lastStableDecision?.targetLpTargetAllocationPct,
    lastStableDecision?.targetLpMaxAllocationPct,
  );
  const stableAutomationAllocationSourceLabel = humanizeAutomationSource(lastStableDecision?.targetLpAllocationSource);
  const stableAutomationBandLabel = Number(lastStableDecision?.targetLpMinUsd) > 0 && Number(lastStableDecision?.targetLpMaxUsd) > 0
    ? `${formatUsdAmount(lastStableDecision.targetLpMinUsd)} - ${formatUsdAmount(lastStableDecision.targetLpMaxUsd)}`
    : '—';
  const stableDecisionPolicyMeta = getAutomationPolicyMeta(lastStableDecision || {});
  const stableDecisionIsLegacy = stableDecisionPolicyMeta.executionSource === 'stable_policy_v1'
    || stableDecisionPolicyMeta.policyId === 'stable_usdc_eurc_curve_v1';
  const stableAutomationLastSeenAt = lastStableDecision?.recordedAt || defiLoopState?.lastRunAt || null;
  const stableAutomationPositionValue = Number.isFinite(Number(lastStableDecision?.positionValueUsd))
    ? formatUsdAmount(lastStableDecision?.positionValueUsd)
    : '—';
  const stableOracleGuardContext = getStableOracleGuardContext(lastStableDecision);
  const stableManualCooldownUntil = defiLoopState?.manualCooldownUntil || lastStableDecision?.manualCooldownUntil || null;
  const stableManualCooldownActive = Number.isFinite(Date.parse(stableManualCooldownUntil || '')) && Date.parse(stableManualCooldownUntil) > Date.now();
  const cirbtcStatusMissingFromBackend = Boolean(agentStatus?.automation && !agentStatus?.automation?.cirbtcLp);
  const cirbtcLoopState = agentStatus?.automation?.cirbtcLp || null;
  const lastCirbtcDecision = cirbtcLoopState?.lastDecision || null;
  const cirbtcAutomationFreshness = getCirbtcAutomationFreshness(defiLoopState, cirbtcLoopState, lastCirbtcDecision);
  const cirbtcAutomationBaseStatus = getCirbtcAutomationStatus(cirbtcLoopState, lastCirbtcDecision);
  const latestCirbtcLpTx = findLatestCirbtcLpTx(txs || []);
  const cirbtcAutomationStatus = cirbtcAutomationFreshness.hasNewerDefiLoop
    ? {
        tone: 'slate',
        label: 'Waiting',
        detail: cirbtcAutomationFreshness.detail,
      }
    : cirbtcAutomationBaseStatus;
  const cirbtcAutomationStatusDetail = cirbtcAutomationFreshness.hasNewerDefiLoop
    ? cirbtcAutomationFreshness.detail
    : lastCirbtcDecision?.execute === true
      ? 'The latest cirBTC review sent an LP transaction.'
      : lastCirbtcDecision
        ? 'The latest cirBTC review kept the current LP setup unchanged.'
        : cirbtcAutomationBaseStatus.detail;
  const cirbtcAutomationDecisionSize = formatAutomationDecisionSize(lastCirbtcDecision);
  const cirbtcAutomationBandLabel = Number(lastCirbtcDecision?.targetLpMinUsd) > 0 && Number(lastCirbtcDecision?.targetLpMaxUsd) > 0
    ? `${formatUsdAmount(lastCirbtcDecision.targetLpMinUsd)} - ${formatUsdAmount(lastCirbtcDecision.targetLpMaxUsd)}`
    : '—';
  const cirbtcSnapshotSeenAt = lastCirbtcDecision?.recordedAt || cirbtcLoopState?.lastRunAt || null;
  const cirbtcAutomationLastSeenAt = cirbtcAutomationFreshness.displayLastSeenAt;
  const cirbtcAutomationPositionValue = Number.isFinite(Number(lastCirbtcDecision?.positionValueUsd))
    ? formatUsdAmount(lastCirbtcDecision?.positionValueUsd)
    : '—';
  const cirbtcAutomationPairSummaries = Array.isArray(lastCirbtcDecision?.pairSummaries) && lastCirbtcDecision.pairSummaries.length > 0
    ? lastCirbtcDecision.pairSummaries
    : [{
        poolKey: lastCirbtcDecision?.poolKey || 'No pair selected yet',
        status: lastCirbtcDecision?.blockedBy ? 'blocked' : (lastCirbtcDecision?.execute ? 'executed' : 'waiting'),
        summary: lastCirbtcDecision?.selectedStableToken
          ? `Uses ${lastCirbtcDecision.selectedStableToken} for the latest cirBTC LP review.`
          : 'The next cirBTC check will choose the supported pair.',
      }];
  const cirbtcAutomationPrimarySummary = lastCirbtcDecision?.summary || cirbtcAutomationBaseStatus.detail;
  const cirbtcAutomationPreviousSnapshotSummary = cirbtcAutomationFreshness.hasNewerDefiLoop
    ? cirbtcAutomationFreshness.detail
    : null;
  const cirbtcAutomationReasonLabel = lastCirbtcDecision?.execute === true
      ? 'Action approved'
      : lastCirbtcDecision?.blockedBy
        ? humanizeAutomationAction(String(lastCirbtcDecision.blockedBy).replace(/([a-z])([A-Z])/g, '$1_$2'))
        : 'Waiting';
  const cirbtcAutomationReasonDetail = lastCirbtcDecision?.execute === true
      ? 'The latest cirBTC review approved an LP action.'
      : lastCirbtcDecision
        ? 'The latest cirBTC review kept funds unchanged.'
        : 'The first cirBTC review has not been saved yet.';
  const cirbtcAutomationMoveLabel = getCirbtcLpMoveLabel(latestCirbtcLpTx);
  const cirbtcAutomationMoveDetail = latestCirbtcLpTx
    ? formatDateTime(latestCirbtcLpTx.created_at)
    : 'No confirmed cirBTC LP transaction yet.';
  const cirbtcAutomationTxLabel = latestCirbtcLpTx?.tx_hash
    ? `${latestCirbtcLpTx.tx_hash.slice(0, 10)}…`
    : 'No LP tx yet';
  const cirbtcAutomationTxDetail = latestCirbtcLpTx?.summary
    ? latestCirbtcLpTx.summary
    : latestCirbtcLpTx?.tx_hash
      ? 'The latest confirmed cirBTC LP transaction is recorded on-chain.'
      : 'No confirmed cirBTC LP transaction has been saved yet.';
  const visibleTxs = getVisibleRecentActivity(txs, agentStatus);
  const recentActivityItems = visibleTxs.slice(0, 20);

  function getGasLabel(entry) {
    const symbol = entry?.nativeSymbol || 'ETH';
    return `${symbol} gas`;
  }

  function shouldShowNativeBalance(entry) {
    return entry?.chainName !== 'Arc Testnet';
  }

  async function loadFirstAgentWithDetails() {
    const list = await agents.list();
    if (!list.length) return null;

    try {
      return await agents.get(list[0].id);
    } catch {
      return list[0];
    }
  }

  async function handleReconnect() {
    if (!ownerAddress) return;
    setConnectError('');
    setConnecting(true);
    try {
      const result = await authenticatePasskey(ownerAddress);
      setJwt(result.token);
      const fullAgent = await loadFirstAgentWithDetails();
      if (fullAgent) setAgent(fullAgent);
    } catch (e) {
      setConnectError(e.message);
    } finally {
      setConnecting(false);
    }
  }

  const loadPortfolio = useCallback(async (targetAddress = agentWalletAddress) => {
    if (!targetAddress) return;

    setLoadingPortfolio(true);
    setPortfolioError('');
    try {
      const data = await fetchAgentPortfolio(targetAddress);
      setPortfolio(data);
    } catch (e) {
      setPortfolioError(e.message || 'Failed to load balances');
    } finally {
      setLoadingPortfolio(false);
    }
  }, [agentWalletAddress]);

  const loadPositions = useCallback(async ({ silent = false } = {}) => {
    if (!agent?.id || !isAuthenticated) {
      setPositions([]);
      setPositionWarnings([]);
      return;
    }

    if (!silent) setLoadingPositions(true);
    setPositionsError('');
    try {
      const data = await agents.positions(agent.id);
      setPositions(Array.isArray(data.positions) ? data.positions : []);
      setPositionWarnings(Array.isArray(data.warnings) ? data.warnings : []);
    } catch (e) {
      setPositionsError(e.message || 'Failed to load live protocol positions');
    } finally {
      if (!silent) setLoadingPositions(false);
    }
  }, [agent?.id, isAuthenticated]);

  const loadLending = useCallback(async ({ silent = false } = {}) => {
    if (!agent?.id || !isAuthenticated) {
      setLendingOverview(null);
      setLendingError('');
      return;
    }

    if (!silent) setLoadingLending(true);
    setLendingError('');
    try {
      const data = await agents.lending(agent.id);
      setLendingOverview(data || null);
    } catch (e) {
      setLendingError(e.message || 'Failed to load lending summary');
    } finally {
      if (!silent) setLoadingLending(false);
    }
  }, [agent?.id, isAuthenticated]);

  const loadTransactions = useCallback(async ({ silent = false } = {}) => {
    if (!agent?.id || !isAuthenticated) {
      setTxs([]);
      return;
    }

    if (!silent) setLoadingTxs(true);
    setTxError('');
    try {
      const data = await transactions.list(agent.id);
      setTxs(Array.isArray(data) ? data.slice(0, 50) : []);
    } catch (e) {
      setTxError(e.message || 'Failed to load recent activity');
    } finally {
      if (!silent) setLoadingTxs(false);
    }
  }, [agent?.id, isAuthenticated]);

  const loadAgentStatus = useCallback(async () => {
    if (!agent?.id || !isAuthenticated) {
      setAgentStatus(null);
      return;
    }

    try {
      const data = await agents.status(agent.id);
      setAgentStatus(data || null);
    } catch {
      setAgentStatus(null);
    }
  }, [agent?.id, isAuthenticated]);

  useEffect(() => {
    loadPortfolio(agentWalletAddress);
  }, [agentWalletAddress, loadPortfolio]);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  useEffect(() => {
    loadLending();
  }, [loadLending]);

  useEffect(() => {
    if (!agentWalletAddress) return;

    const intervalId = setInterval(() => {
      loadPortfolio(agentWalletAddress);
    }, 30_000);

    return () => clearInterval(intervalId);
  }, [agentWalletAddress, loadPortfolio]);

  useEffect(() => {
    if (!agent?.id || !isAuthenticated) return undefined;

    const intervalId = setInterval(() => {
      loadPositions({ silent: true });
    }, 30_000);

    return () => clearInterval(intervalId);
  }, [agent?.id, isAuthenticated, loadPositions]);

  useEffect(() => {
    if (!agent?.id || !isAuthenticated) return undefined;

    const intervalId = setInterval(() => {
      loadLending({ silent: true });
    }, 30_000);

    return () => clearInterval(intervalId);
  }, [agent?.id, isAuthenticated, loadLending]);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  useEffect(() => {
    loadAgentStatus();
  }, [loadAgentStatus]);

  useEffect(() => {
    if (!agent?.id || !isAuthenticated) return undefined;

    const intervalId = setInterval(() => {
      loadTransactions({ silent: true });
    }, 15_000);

    return () => clearInterval(intervalId);
  }, [agent?.id, isAuthenticated, loadTransactions]);
  useEffect(() => {
    if (!agent?.id || !isAuthenticated) return undefined;

    const intervalId = setInterval(() => {
      loadAgentStatus();
    }, 30_000);

    return () => clearInterval(intervalId);
  }, [agent?.id, isAuthenticated, loadAgentStatus]);

  if (!ownerAddress) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-card">
          <Wallet size={28} className="text-slate-400" />
        </div>
        <h2 className="mb-2 text-xl font-bold text-slate-900">Connect Your Wallet</h2>
        <p className="max-w-sm text-sm text-slate-500">
          Connect your MetaMask or another wallet to start using Arc Machina. Your agent wallet will be a separate EOA managed by the backend.
        </p>
      </div>
    );
  }

  if (!agent || !isAuthenticated) {
    return (
      <div className="space-y-6">
        {/* Quick-start guide */}
        <Card>
          <h2 className="mb-1 text-lg font-bold text-slate-900">Get Started with Arc Machina</h2>
          <p className="mb-6 text-sm text-slate-500">Follow these steps to set up your autonomous agent wallet.</p>
          <div className="flex flex-col gap-4 sm:flex-row">
            {[
              { step: 1, title: 'Connect Wallet', desc: 'Use the button in the top-right corner to connect MetaMask or another EVM wallet.' },
              { step: 2, title: 'Create Agent', desc: 'Go to the Agent tab, name your agent, then configure limits and task access.' },
              { step: 3, title: 'Fund Agent', desc: 'Send ARC or ETH to the agent wallet address shown after creation.' },
              { step: 4, title: 'Bridge & Swap', desc: 'Use the Bridge and Swap tabs to move assets cross-chain.' },
            ].map(({ step, title, desc }) => (
              <div key={step} className="flex flex-1 gap-3 rounded-xl border border-slate-100 bg-slate-50 p-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-arc-green text-sm font-bold text-white">
                  {step}
                </div>
                <div>
                  <p className="font-semibold text-slate-800">{title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={() => onNavigate('agent')}>
              Create Agent Wallet <ArrowRight size={16} />
            </Button>
            {ownerAddress && (
              <Button variant="outline" onClick={handleReconnect} loading={connecting}>
                <LogIn size={14} className="mr-2" />
                Reconnect Existing Agent
              </Button>
            )}
          </div>
          {connectError && <Alert type="error" className="mt-3">{connectError}</Alert>}
        </Card>

        <Card>
          <div className="flex items-center gap-3 text-slate-500">
            <Wallet size={18} />
            <span className="text-sm font-medium">Your owner wallet:</span>
            <span className="font-mono text-sm text-slate-700">{formatAddress(ownerAddress)}</span>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Payment modal */}
      {paymentMode && (
        <PaymentModal mode={paymentMode} onClose={() => setPaymentMode(null)} />
      )}

      {/* Agent wallet card */}
      <Card className="border-[#66D121]/30 bg-gradient-to-br from-arc-greenBg to-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Badge variant="green">Active Agent</Badge>
              <span className="text-sm font-semibold text-slate-700">{agent.name}</span>
            </div>
            <p className="text-xs text-slate-500">Independent EOA — runs autonomously on your behalf</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-arc-green">
              {arcPortfolio?.usdcBalance !== null && arcPortfolio?.usdcBalance !== undefined ? `${arcPortfolio.usdcBalance} USDC` : '— USDC'}
            </div>
            <div className="rounded-xl border border-[#627eea]/30 bg-white px-4 py-2 text-sm font-bold text-[#627eea]">
              {sepoliaPortfolio?.nativeBalance !== null && sepoliaPortfolio?.nativeBalance !== undefined ? `${sepoliaPortfolio.nativeBalance} ETH (Sepolia)` : '— ETH'}
            </div>
            {/* Send / Receive */}
            <Button
              variant="outline"
              className="px-4 py-2 text-sm"
              onClick={() => setPaymentMode('send')}
            >
              <Send size={14} /> Send
            </Button>
            <Button
              className="px-4 py-2 text-sm"
              onClick={() => setPaymentMode('receive')}
            >
              <QrCode size={14} /> Receive
            </Button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <AddressBox address={agent.walletAddress} label="Agent Wallet Address" compact />
          <AddressBox address={ownerAddress} label="Owner Wallet (MetaMask)" compact />
        </div>
        <div className="mt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Balances By Network</p>
            <div className="flex items-center gap-2">
              {loadingPortfolio && <span className="text-xs text-slate-400">Loading balances…</span>}
              <Button
                variant="outline"
                className="px-3 py-2 text-xs"
                onClick={() => loadPortfolio()}
                loading={loadingPortfolio}
              >
                <RefreshCw size={13} /> Refresh
              </Button>
            </div>
          </div>

          {portfolioError && <Alert type="error">{portfolioError}</Alert>}

          {!portfolioError && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {portfolio.map(entry => (
                <div key={entry.chainId} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">{entry.chainName}</p>
                    <span className="text-[11px] font-medium text-slate-400">Agent wallet</span>
                  </div>
                  <div className="mt-3 space-y-1.5 text-sm">
                    {shouldShowNativeBalance(entry) && (
                      <div className="flex items-center justify-between gap-3 text-slate-600">
                        <span>{getGasLabel(entry)}</span>
                        <span className="font-semibold text-slate-900">
                          {entry.nativeBalance ?? '—'}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3 text-slate-600">
                      <span>USDC</span>
                      <span className="font-semibold text-slate-900">{entry.usdcBalance ?? '—'}</span>
                    </div>
                    {entry.eurcBalance !== null && entry.eurcBalance !== undefined && (
                      <div className="flex items-center justify-between gap-3 text-slate-600">
                        <span>EURC</span>
                        <span className="font-semibold text-slate-900">{entry.eurcBalance}</span>
                      </div>
                    )}
                    {entry.cirbtcBalance !== null && entry.cirbtcBalance !== undefined && (
                      <div className="flex items-center justify-between gap-3 text-slate-600">
                        <span>cirBTC</span>
                        <span className="font-semibold text-slate-900">{entry.cirbtcBalance}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Fund this address with USDC on Arc Testnet and gas tokens on the EVM testnets you plan to use.
        </p>
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-slate-400" />
            <div>
              <h3 className="font-semibold text-slate-800">Market Analysis State</h3>
              <p className="text-xs text-slate-500">This is the advisory market signal layer. Recent Activity may still show oracle snapshots, and that is normal.</p>
            </div>
          </div>
          <Button
            variant="outline"
            className="px-3 py-2 text-xs"
            onClick={() => loadAgentStatus()}
          >
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>

        {!marketAnalysisState ? (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            Market analysis state is not available for this agent yet.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 md:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Loop Status</p>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(marketAnalysisStatus.tone)}`}>
                    {marketAnalysisStatus.label}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">{formatDateTime(marketAnalysisLastSeenAt)}</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">{marketAnalysisStatus.detail}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Latest Lane</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {lastMarketAnalysisDecision?.signal?.lane
                    ? humanizeAutomationAction(lastMarketAnalysisDecision.signal.lane)
                    : 'Observe only'}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                  Confidence {humanizeAutomationAction(lastMarketAnalysisDecision?.signal?.confidence || 'medium')}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Suggested LP Band</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">{marketAnalysisBandLabel}</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">Latest advisory allocation band for the stable lane.</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">DeFi Review</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {lastMarketAnalysisDecision?.queuedDefiReview ? 'Queued' : 'Snapshot only'}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                  {lastMarketAnalysisDecision?.queuedDefiReview
                    ? 'A follow-up DeFi review job was queued from the latest advisory signal.'
                    : 'No extra DeFi review was queued from the latest advisory signal.'}
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">
                {lastMarketAnalysisDecision?.opportunity || 'No advisory opportunity recorded yet'}
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {lastMarketAnalysisDecision?.action || 'Market analysis has not recorded an advisory action yet.'}
              </p>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Repeat2 size={16} className="text-slate-400" />
            <div>
              <h3 className="font-semibold text-slate-800">Stable Automation State</h3>
              <p className="text-xs text-slate-500">The verified USDC/EURC lane can hold, swap, add liquidity, trim, or exit based on the current stable policy.</p>
            </div>
          </div>
          <Button
            variant="outline"
            className="px-3 py-2 text-xs"
            onClick={() => loadAgentStatus()}
          >
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>

        {!defiLoopState ? (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            Stable automation state is not available for this agent yet.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 md:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Loop Status</p>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(stableAutomationStatus.tone)}`}>
                    {stableAutomationStatus.label}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">{formatDateTime(stableAutomationLastSeenAt)}</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">{stableAutomationStatus.detail}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Last Decision</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {lastStableDecision
                    ? humanizeAutomationAction(lastStableDecision.operationType, lastStableDecision.execute === false ? 'Hold' : 'No action')
                    : 'No decision yet'}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                  {stableAutomationDecisionSize !== '—'
                    ? stableAutomationDecisionSize
                    : 'No sized action was selected in the latest cycle.'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Target LP Band</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">{stableAutomationBandLabel}</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">{stableAutomationAllocationPctLabel} of stable capital via {stableAutomationAllocationSourceLabel}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Today</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {Number(defiLoopState?.todayCount || 0)}/{Number(defiLoopState?.dailyCap || 10)} checks
                </p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                  {Number(defiLoopState?.autoTxToday || 0)} real auto tx sent{defiLoopState?.bypassDailyCap ? ' · daily cap bypass active' : ''}
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {lastStableDecision
                      ? humanizeAutomationAction(lastStableDecision.operationType, lastStableDecision.execute === false ? 'Hold' : 'No action')
                      : 'Awaiting first stable automation cycle'}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Last update {formatDateTime(stableAutomationLastSeenAt)}</p>
                </div>
                {lastStableDecision?.lpAction && (
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(lastStableDecision.lpAction === 'full_exit' ? 'red' : lastStableDecision.lpAction === 'trim_to_target' ? 'amber' : 'green')}`}>
                    {humanizeAutomationAction(lastStableDecision.lpAction)}
                  </span>
                )}
              </div>

              <p className="mt-3 text-sm leading-6 text-slate-700">
                {lastStableDecision?.summary || stableAutomationStatus.detail}
              </p>

              {stableDecisionIsLegacy && (
                <div className="mt-3 rounded-xl border border-yellow-200 bg-yellow-50 px-3 py-3 text-[11px] leading-5 text-yellow-800">
                  This snapshot was recorded by the older mixed stable policy before LP and oracle decisions were separated. The next stable automation cycle will refresh this card with the new Stable LP lane metadata.
                </div>
              )}

              {stableManualCooldownActive && (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-[11px] leading-5 text-amber-800">
                  Manual stable LP cooldown is active until {formatDateTime(stableManualCooldownUntil)}. Soft trims and non-emergency exits are paused during this window.
                </div>
              )}

              <div className="mt-3 grid gap-2 md:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Blocked By</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {stableOracleGuardContext?.reasonLabel || (lastStableDecision?.blockedBy ? humanizeAutomationAction(lastStableDecision.blockedBy) : 'None')}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {stableOracleGuardContext?.reasonDetail || 'Hold reason appears here when the policy refuses execution.'}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Wallet Inventory</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {formatRewardAmount(lastStableDecision?.availableUsdcBalance || 0, 'USDC')}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {formatRewardAmount(lastStableDecision?.availableEurcBalance || 0, 'EURC')} · reserve {formatRewardAmount(lastStableDecision?.walletReserveUsdc || 0, 'USDC')} · current LP value {stableAutomationPositionValue}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Execution Rail</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {lastStableDecision?.executionSource ? humanizeAutomationAction(lastStableDecision.executionSource) : '—'}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {lastStableDecision?.txHash
                      ? `Latest tx ${lastStableDecision.txHash.slice(0, 10)}…`
                      : 'No transaction hash recorded for the latest cycle.'}
                  </p>
                </div>
              </div>

              {stableOracleGuardContext && (
                <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">{stableOracleGuardContext.title}</p>
                      <p className="mt-1 text-[11px] leading-5 text-sky-800">{stableOracleGuardContext.detail}</p>
                    </div>
                    <p className="text-[11px] leading-5 text-sky-700">
                      {stableOracleGuardContext.quoteAmountLabel || 'Quote size unavailable'} via {stableOracleGuardContext.exitRail || 'swap route'}
                    </p>
                  </div>

                  <div className="mt-3 grid gap-2 md:grid-cols-3">
                    <div className="rounded-xl border border-sky-200 bg-white px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Entry Price</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        {stableOracleGuardContext.entryPriceTracked
                          ? `${formatUsdUnitPrice(stableOracleGuardContext.entryPriceUsdc)} / EURC`
                          : 'Not tracked yet'}
                      </p>
                      {!stableOracleGuardContext.entryPriceTracked && (
                        <p className="mt-1 text-xs text-slate-500">Manual or older EURC inventory is using the standard floor right now.</p>
                      )}
                    </div>
                    <div className="rounded-xl border border-sky-200 bg-white px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Current Exit Quote</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(stableOracleGuardContext.currentExitQuoteUsdc)}</p>
                    </div>
                    <div className="rounded-xl border border-sky-200 bg-white px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Required Floor</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(stableOracleGuardContext.requiredFloorUsdc)}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Repeat2 size={16} className="text-slate-400" />
            <div>
              <h3 className="font-semibold text-slate-800">cirBTC Automation State</h3>
              <p className="text-xs text-slate-500">See whether the agent is adding, holding, or reducing the cirBTC LP position.</p>
            </div>
          </div>
          <Button
            variant="outline"
            className="px-3 py-2 text-xs"
            onClick={() => loadAgentStatus()}
          >
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>

        {!cirbtcLoopState ? (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            {cirbtcStatusMissingFromBackend
              ? 'cirBTC status is not available yet. Refresh again after the next update.'
              : 'cirBTC automation state is not available for this agent yet.'}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 md:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Loop Status</p>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(cirbtcAutomationStatus.tone)}`}>
                    {cirbtcAutomationStatus.label}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">{formatDateTime(cirbtcAutomationLastSeenAt)}</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">{cirbtcAutomationStatusDetail}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Last LP Move</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {cirbtcAutomationMoveLabel}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                  {cirbtcAutomationMoveDetail}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Target LP Band</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">{cirbtcAutomationBandLabel}</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">Current LP value {cirbtcAutomationPositionValue}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Today</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {Number(cirbtcLoopState?.todayCount || 0)}/{Number(cirbtcLoopState?.dailyCap || 10)} checks
                </p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                  {Number(cirbtcLoopState?.autoTxToday || 0)} real auto tx sent{cirbtcLoopState?.bypassDailyCap ? ' · daily cap bypass active' : ''}
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {lastCirbtcDecision
                      ? humanizeAutomationAction(lastCirbtcDecision.operationType, lastCirbtcDecision.execute === false ? 'Hold' : 'No action')
                      : 'Awaiting first cirBTC automation cycle'}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {cirbtcAutomationFreshness.hasNewerDefiLoop
                      ? `Last cirBTC snapshot ${formatDateTime(cirbtcSnapshotSeenAt)}`
                      : `Last update ${formatDateTime(cirbtcAutomationLastSeenAt)}`}
                  </p>
                </div>
                {lastCirbtcDecision?.lpAction && (
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(lastCirbtcDecision.lpAction === 'full_exit' ? 'red' : lastCirbtcDecision.lpAction === 'trim_to_target' ? 'amber' : 'green')}`}>
                    {humanizeAutomationAction(lastCirbtcDecision.lpAction)}
                  </span>
                )}
              </div>

              <p className="mt-3 text-sm leading-6 text-slate-700">
                {cirbtcAutomationPrimarySummary}
              </p>

              {cirbtcAutomationPreviousSnapshotSummary && (
                <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                  Latest saved cirBTC note: {cirbtcAutomationPreviousSnapshotSummary}
                </p>
              )}

              <div className="mt-3 grid gap-2 md:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Current Reason</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {cirbtcAutomationReasonLabel}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">{cirbtcAutomationReasonDetail}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">LP Pairs</p>
                  <div className="mt-2 space-y-2">
                    {cirbtcAutomationPairSummaries.map((pairSummary) => (
                      <div key={pairSummary.poolKey} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-slate-900">{pairSummary.poolKey}</p>
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getStatusBadgeClasses(getCirbtcPairStatusTone(pairSummary.status))}`}>
                            {getCirbtcPairStatusLabel(pairSummary.status)}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500">{pairSummary.summary}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Last Transaction</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {cirbtcAutomationTxLabel}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">{cirbtcAutomationTxDetail}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-slate-400" />
            <div>
              <h3 className="font-semibold text-slate-800">Agent Positions</h3>
              <p className="text-xs text-slate-500">Live DeFi LP positions currently held by the agent wallet.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="px-3 py-2 text-xs"
              onClick={() => onNavigate?.('defi')}
            >
              Open DeFi <ArrowRight size={13} />
            </Button>
            <Button
              variant="outline"
              className="px-3 py-2 text-xs"
              onClick={() => loadPositions()}
              loading={loadingPositions}
            >
              <RefreshCw size={13} /> Refresh
            </Button>
          </div>
        </div>

        {positionsError && <Alert type="error">{positionsError}</Alert>}

        {!positionsError && positionWarnings.length > 0 && (
          <Alert type="warning" className="mb-3">
            {positionWarnings[0].message}
          </Alert>
        )}

        {loadingPositions ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : positions.length === 0 ? (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            No live DeFi LP position is currently detected for this agent wallet.
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {positions.map(position => (
              <div key={`${position.protocol}-${position.poolAddress}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{position.poolKey}</p>
                    <p className="mt-1 text-xs text-slate-500">{formatPositionVenue(position)}</p>
                  </div>
                  <Badge variant="slate">{formatPercentAmount(position.sharePct)} share</Badge>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">LP Balance</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatLpAmount(position.lpToken?.balance || 0)}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{position.lpToken?.symbol}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {position.protocol === 'curve' ? 'Virtual Price' : 'Pool Model'}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {position.protocol === 'curve'
                        ? (position.virtualPrice ? Number(position.virtualPrice).toFixed(6) : '—')
                        : String(position.poolModel || 'constant_product').replace(/_/g, ' ')}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {position.protocol === 'curve'
                        ? position.liquidityState
                        : `${Number(position.feePct || 0.3).toFixed(1)}% fee tier`}
                    </p>
                  </div>
                </div>

                <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Position Value</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(position.valuation?.totalUsd)}</p>
                    <p className="mt-1 text-[11px] text-slate-500">Approximate USD spot valuation</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Est. Fee APR</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatPercentAmount(position.yieldMetrics?.aprPct)}</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Trading fees only, not claimable rewards
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Est. Fee APY</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatPercentAmount(position.yieldMetrics?.apyPct)}</p>
                    <p className="mt-1 text-[11px] text-slate-500">Compounded run-rate estimate</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Yield Run-Rate</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(position.yieldMetrics?.dailyUsd)}</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Weekly {formatUsdAmount(position.yieldMetrics?.weeklyUsd)}
                    </p>
                  </div>
                </div>

                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {getPositionStatusCards(position).map((card) => (
                    <div key={`${position.poolAddress}-${card.title}`} className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{card.title}</p>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(card.tone)}`}>
                          {card.label}
                        </span>
                      </div>
                      <p className="mt-2 text-[11px] leading-5 text-slate-500">{card.detail}</p>
                    </div>
                  ))}
                </div>

                <div className="mt-4 rounded-xl border border-slate-200 bg-white px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Current Redeemable Underlying</p>
                  <p className="mt-1 text-[11px] leading-5 text-slate-500">This is the live token mix the LP can withdraw now, not the last token amounts you originally deposited.</p>
                  <div className="mt-2 space-y-1.5 text-sm text-slate-600">
                    {position.underlying.map(asset => (
                      <div key={`${position.poolAddress}-${asset.symbol}`} className="flex items-start justify-between gap-3">
                        <div>
                          <span>{asset.symbol}</span>
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            {formatUsdAmount(asset.usdValue)} · {formatPercentAmount(asset.exposurePct)} exposure
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="font-semibold text-slate-900">{formatPositionAmount(asset.amount || 0)}</span>
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            Spot {formatUsdAmount(asset.usdPrice)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {position.yieldMetrics?.note && (
                  <p className="mt-3 text-[11px] leading-5 text-slate-500">
                    {position.yieldMetrics.note}
                    {position.yieldMetrics?.isCapped ? ' Safety cap applied to keep the estimate in a realistic range.' : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Coins size={16} className="text-slate-400" />
            <div>
              <h3 className="font-semibold text-slate-800">Lending Summary</h3>
              <p className="text-xs text-slate-500">Stable supply and borrow state for this agent wallet. Open DeFi for the full lending controls.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="px-3 py-2 text-xs"
              onClick={() => onNavigate?.('defi')}
            >
              Open DeFi <ArrowRight size={13} />
            </Button>
            <Button
              variant="outline"
              className="px-3 py-2 text-xs"
              onClick={() => loadLending()}
              loading={loadingLending}
            >
              <RefreshCw size={13} /> Refresh
            </Button>
          </div>
        </div>

        {lendingError && <Alert type="error">{lendingError}</Alert>}

        {loadingLending ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : !lendingOverview ? (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            No lending summary is available for this agent yet.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 md:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Execution Status</p>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(lendingExecutionStatus.tone)}`}>
                    {lendingExecutionStatus.label}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {lendingOverview.execution?.contractAddress ? formatAddress(lendingOverview.execution.contractAddress) : 'No contract connected'}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">{lendingExecutionStatus.detail}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Price Guard</p>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(lendingPriceStatus.tone)}`}>
                    {lendingPriceStatus.label}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">Updated {formatDateTime(lendingOverview.prices?.fetchedAt)}</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">{lendingPriceStatus.detail}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Account Risk</p>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(lendingRiskStatus.tone)}`}>
                    {lendingRiskStatus.label}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  HF {formatHealthFactor(lendingOverview.risk?.healthFactor)} · LTV {formatPercentAmount(lendingOverview.risk?.ltvPct)}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">{lendingRiskStatus.detail}</p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Total Supplied</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(lendingOverview.risk?.totalSuppliedUsd)}</p>
                <p className="mt-1 text-[11px] text-slate-500">Current supplied collateral value</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Total Borrowed</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(lendingOverview.risk?.totalBorrowUsd)}</p>
                <p className="mt-1 text-[11px] text-slate-500">Current outstanding stable debt</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Available Borrow</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(lendingOverview.risk?.availableBorrowUsd)}</p>
                <p className="mt-1 text-[11px] text-slate-500">Headroom before the next borrow</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Health Factor</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{formatHealthFactor(lendingOverview.risk?.healthFactor)}</p>
                <p className="mt-1 text-[11px] text-slate-500">Liquidation buffer snapshot</p>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Active Lending Assets</p>
                    <p className="mt-1 text-xs text-slate-500">Assets with current supplied or borrowed balances.</p>
                  </div>
                  <span className="text-xs font-medium text-slate-400">{lendingActiveAssets.length} rows</span>
                </div>

                {lendingActiveAssets.length ? (
                  <div className="mt-3 space-y-2">
                    {lendingActiveAssets.map((asset) => (
                      <div key={asset.symbol} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{asset.symbol}</p>
                            <p className="mt-1 text-[11px] text-slate-500">
                              {asset.position?.useAsCollateral ? 'Used as collateral' : 'Not used as collateral'}
                            </p>
                          </div>
                          <div className="text-right text-[11px] text-slate-500">
                            <p>Wallet {formatPositionAmount(asset.wallet?.amount || 0)}</p>
                            <p>Available {formatUsdAmount(asset.wallet?.amountUsd)}</p>
                          </div>
                        </div>

                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Supplied</p>
                            <p className="mt-1 text-sm font-semibold text-slate-900">{formatPositionAmount(asset.position?.suppliedAmount || 0)}</p>
                            <p className="mt-1 text-[11px] text-slate-500">{formatUsdAmount(asset.position?.suppliedUsd)}</p>
                          </div>
                          <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Borrowed</p>
                            <p className="mt-1 text-sm font-semibold text-slate-900">{formatPositionAmount(asset.position?.borrowAmount || 0)}</p>
                            <p className="mt-1 text-[11px] text-slate-500">{formatUsdAmount(asset.position?.borrowUsd)}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                    No active lending position is visible yet. Open DeFi to review balances and available lending actions.
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Connection Snapshot</p>
                  <p className="mt-1 text-xs text-slate-500">Quick status of the lending surface currently wired into the dashboard.</p>
                </div>

                <div className="mt-4 space-y-2">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Build State</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{String(lendingOverview.execution?.buildState || 'scaffold_only').replace(/_/g, ' ')}</p>
                    <p className="mt-1 text-[11px] text-slate-500">Source {lendingOverview.execution?.source || 'arc_native_scaffold'}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Contract</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{lendingOverview.execution?.contractAddress ? formatAddress(lendingOverview.execution.contractAddress) : 'Not connected'}</p>
                    <p className="mt-1 text-[11px] text-slate-500">Updated {formatDateTime(lendingOverview.prices?.fetchedAt)}</p>
                  </div>
                </div>

                {lendingExecutionNotes.length > 0 && (
                  <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Notes</p>
                    <p className="mt-2 text-[11px] leading-5 text-slate-500">{lendingExecutionNotes[0]}</p>
                  </div>
                )}

                <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-3 text-[11px] leading-5 text-sky-800">
                  Use the DeFi tab for reserve watch, asset-level guards, and live lending actions. This dashboard card stays focused on the top-level account snapshot.
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Recent activity */}
      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-slate-400" />
            <h3 className="font-semibold text-slate-800">Recent Activity</h3>
          </div>
          <Button
            variant="outline"
            className="px-3 py-2 text-xs"
            onClick={() => loadTransactions()}
            loading={loadingTxs}
          >
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>
        {loadingTxs ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : txError ? (
          <Alert type="error">{txError}</Alert>
        ) : recentActivityItems.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">No transactions yet. Your agent activity will appear here.</div>
        ) : (
          <div className="max-h-[36rem] space-y-2 overflow-y-auto overscroll-contain pr-1">
            {recentActivityItems.map(tx => {
              const { title, routeLabel, amountLabel, phase, links, tagLabel, tagVariant } = getTxDisplay(tx, { allTxs: txs, agentStatus });
              const isReceive = tx.type === 'receive';
              const isSend    = tx.type === 'send' || tx.type === 'nano_payment';
              const isSwap    = tx.type === 'swap';
              const isDirectLpAdd = tx.type === 'direct_lp_add';
              const isDirectLpRemove = tx.type === 'direct_lp_remove';
              const isCurveLpAdd = tx.type === 'curve_lp_add';
              const isCurveLpRemove = tx.type === 'curve_lp_remove';
              const isTaskArb = tx.type === 'task_arb';
              const isRebalance = tx.type === 'rebalance';
              const isOracleSignal = tx.type === 'oracle_signal';
              const isOracleStrategy = tx.type === 'defi_loop_swap' || tx.type === 'defi_loop_dry';
              const isBridge  = tx.type === 'bridge' || tx.type === 'gas_topup';

              const TxIcon = isReceive ? ArrowDownLeft
                : isSend    ? ArrowUpRight
                : isSwap || isTaskArb || isRebalance ? Repeat2
                : isDirectLpAdd || isDirectLpRemove || isCurveLpAdd || isCurveLpRemove ? Zap
                : isOracleSignal || isOracleStrategy ? Activity
                : Zap;

              const iconColor = isReceive ? 'text-arc-green'
                : isSend    ? 'text-blue-500'
                : isSwap || isTaskArb || isRebalance ? 'text-purple-500'
                : isDirectLpAdd ? 'text-emerald-600'
                : isDirectLpRemove ? 'text-amber-600'
                : isCurveLpAdd ? 'text-emerald-600'
                : isCurveLpRemove ? 'text-amber-600'
                : isOracleSignal ? 'text-sky-500'
                : isOracleStrategy ? 'text-indigo-500'
                : 'text-slate-400';

              const displayTitle = isReceive ? 'Received'
                : isSend && tx.type === 'nano_payment' ? 'Nano payment'
                : isSend ? 'Sent'
                : isDirectLpAdd ? 'Direct Pair LP Add'
                : isDirectLpRemove ? 'Direct Pair LP Exit'
                : isCurveLpAdd ? 'Curve LP Add'
                : isCurveLpRemove ? 'Curve LP Exit'
                : isTaskArb ? 'Signal Trade'
                : isRebalance ? 'Rebalance'
                : title;

              const statusLabel = isOracleSignal ? 'snapshot' : tx.status;
              const statusVariant = isOracleSignal
                ? 'slate'
                : tx.status === 'confirmed'
                  ? 'green'
                  : tx.status === 'failed'
                    ? 'red'
                    : 'yellow';

              const meta = getTxMeta(tx);
              const counterpart = isReceive
                ? (tx.from_address || meta.from || null)
                : (tx.to_address   || meta.toAddress || null);

              return (
                <div key={tx.id} className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm">
                  <div className="flex items-center gap-3">
                    <TxIcon size={15} className={`shrink-0 ${iconColor}`} />
                    <span className="font-semibold text-slate-800 capitalize">{displayTitle}</span>
                    {amountLabel && (
                      <span className={`font-semibold ${isReceive ? 'text-arc-green' : isOracleSignal ? 'text-sky-700' : 'text-slate-700'}`}>
                        {isReceive ? '+' : isSend ? '-' : ''}{amountLabel}
                      </span>
                    )}
                    {tagLabel && (
                      <Badge variant={tagVariant}>
                        {tagLabel}
                      </Badge>
                    )}
                    <Badge variant={statusVariant} className="ml-auto">
                      {statusLabel}
                    </Badge>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[23px] text-xs text-slate-500">
                    {routeLabel && <span>{routeLabel}</span>}
                    {counterpart && (
                      <span className="font-mono">
                        {isReceive ? 'from ' : 'to '}
                        {counterpart.slice(0, 8)}…{counterpart.slice(-5)}
                      </span>
                    )}
                    {phase && <span className="min-w-0 break-words leading-5">{phase}</span>}
                    {links.map(link => (
                      <a key={link.key} href={link.url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-arc-green hover:underline font-mono">
                        <span>{link.label}</span>
                        <span>{link.hash.slice(0, 10)}…</span>
                        <ExternalLink size={10} />
                      </a>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {[
          { label: 'Bridge Assets', tab: 'bridge' },
          { label: 'Swap Tokens',   tab: 'swap'   },
          { label: 'Agent Settings',tab: 'agent'  },
        ].map(({ label, tab }) => (
          <Button key={tab} variant="outline" onClick={() => onNavigate(tab)} className="w-full">
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
}
