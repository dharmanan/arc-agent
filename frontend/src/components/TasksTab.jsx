import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { tasks as tasksApi, agents as agentsApi } from '../lib/api.js';
import { fetchAgentBalance, fetchUsdcBalance, fetchEurcBalance } from '../lib/agentBalances.js';
import {
  Card, Button, Alert, Spinner, AddressBox,
} from './ui/index.jsx';
import {
  Zap, Lock, CheckCircle, RefreshCw, Coins,
  Play, ChevronDown, ChevronUp, AlertTriangle, Clock, Brain,
  ShieldCheck,
} from 'lucide-react';

const AUTOMATION_FEATURES = [
  {
    key: 'marketAnalysisEnabled',
    statusKey: 'marketAnalysis',
    title: 'Market Analysis',
    description: 'Periodic strategy scans for smart-mode agents before any autonomous execution happens.',
    detail: 'This updates decision context only. It does not move funds or spend gas by itself; cost is limited to your LLM provider if you use a paid model.',
  },
  {
    key: 'oracleEnabled',
    statusKey: 'oracle',
    title: 'Oracle Data Feed',
    description: 'Background oracle pulls for forex, TVL and stablecoin opportunity updates.',
    detail: 'This is a data collection layer. It records signals and permissions state but does not submit a trade on its own.',
  },
  {
    key: 'defiLoopEnabled',
    statusKey: 'defiLoop',
    title: 'DeFi Loop Execution',
    description: 'Background DeFi strategy execution within your configured limits.',
    detail: 'This is the automation that can actually submit swaps. Real runs consume gas and token balance; dry runs only record what would have happened.',
  },
  {
    key: 'reputationEnabled',
    statusKey: 'reputation',
    title: 'Reputation Tracking',
    description: 'Track and publish agent reputation-related activity in the background.',
    detail: 'Writes local reputation events and optionally relays them on-chain when configured.',
  },
];
const FULL_AUTONOMY_FEATURE_KEYS = AUTOMATION_FEATURES.map(feature => feature.key);
const EXECUTION_TASK_IDS = new Set([
  'EXEC_CURVE_SWAP',
  'EXEC_CURVE_LIQUIDITY_ADD',
  'EXEC_CURVE_LIQUIDITY_REMOVE',
  'EXEC_CIRBTC_USDC_ZAP_IN',
  'EXEC_CIRBTC_EURC_ZAP_IN',
  'EXEC_CIRBTC_USDC_LP_REMOVE',
  'EXEC_CIRBTC_EURC_LP_REMOVE',
  'EXEC_CCTP_BRIDGE',
  'EXEC_YIELD_MOVE',
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
    case 'yield_amount_required':
      return 'Enter an amount for the yield move.';
    case 'yield_action_required':
      return 'Choose whether the agent should supply or withdraw.';
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
    case 'EXEC_YIELD_MOVE':
      return { action: 'supply', amount: '' };
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
    case 'EXEC_YIELD_MOVE':
      if (!params.action) return 'Choose whether the agent should supply or withdraw.';
      if (!(Number(params.amount) > 0)) return 'Enter an amount for the yield move.';
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
    case 'EXEC_YIELD_MOVE':
      return {
        action: params.action,
        amount: Number(params.amount),
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
        ? 'Latest analysis completed. This stage only refreshes strategy context; later automation decides whether any on-chain action is worth taking.'
        : 'Scheduled USDC strategy scans for smart-mode agents. No gas is spent here; only your selected LLM provider may incur usage cost.';
    case 'oracle':
      return `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 48)} oracle cycles completed. This layer only records EURC/USDC stablecoin signals plus execution-gate context; it does not submit a transaction by itself.${bypassNote}`;
    case 'defiLoop':
      if (state?.lastStatus === 'dry_run') {
        return `Simulation mode is active for this agent. ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} loops ran and ${Number(state?.autoTxToday || 0)} real auto tx were submitted.${bypassNote}`;
      }
      return `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} loop runs · ${Number(state?.autoTxToday || 0)} auto tx executed. This loop now has one execution gate only: if an LLM key exists it returns EXECUTE/HOLD JSON, otherwise the rule engine does. Only approved Arc Testnet USDC -> EURC Curve swaps are submitted today.${bypassNote}`;
    case 'reputation':
      return state?.lastStatus === 'db_only'
        ? 'Writing local reputation events only. On-chain relay is currently not configured.'
        : 'Updates when task, oracle or transaction events create reputation records.';
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
    label: 'Task completed',
    buttonLabel: 'Done',
    panelClasses: 'bg-green-50/60',
    iconClasses: 'text-green-600',
    titleClasses: 'text-green-800',
    detailClasses: 'text-slate-600',
    summary: payload?.summary || `${task.title} completed.`,
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

function getTaskExecutionFactLines(payload) {
  const facts = [];
  if (!payload || typeof payload !== 'object') return facts;

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

  if (payload.lpAmount) {
    facts.push(`LP minted: ${formatTaskMetricAmount(payload.lpAmount)}`);
  }

  if (payload.token0Amount && payload.token0Symbol) {
    facts.push(`Returned: ${formatTaskMetricAmount(payload.token0Amount)} ${payload.token0Symbol}`);
  }

  if (payload.token1Amount && payload.token1Symbol) {
    facts.push(`Returned: ${formatTaskMetricAmount(payload.token1Amount)} ${payload.token1Symbol}`);
  }

  if (payload.swapTxHash) {
    facts.push(`Swap tx: ${payload.swapTxHash}`);
  }

  if (payload.mintTxHash) {
    facts.push(`Mint tx: ${payload.mintTxHash}`);
  }

  if (payload.burnTxHash) {
    facts.push(`Burn tx: ${payload.burnTxHash}`);
  }

  return facts;
}

function buildInlineTaskResult(task, response) {
  const payload = response?.result || {};
  const meta = getTaskResultStatusMeta(task, payload);

  return {
    id: `inline-${task.id}-${Date.now()}`,
    task_id: task.id,
    title: task.title,
    description: task.description,
    created_at: new Date().toISOString(),
    payload: {
      ...payload,
      summary: payload?.summary || meta.summary,
    },
  };
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
          <p className="text-xs text-slate-500">On-chain reputation becomes portable only after identity registration.</p>
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

// ── Task Card with result polling ─────────────────────────────────────────────
function TaskCard({ task, agentId, tasksEnabled, onRefresh }) {
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState('');
  const [runState, setRunState] = useState(null); // null | 'queued' | 'done'
  const [result, setResult]     = useState(null);
  const pollRef                 = useRef(null);
  const startedAtRef            = useRef(null);
  const [params, setParams]     = useState(() => getInitialTaskParams(task.id));
  const resultFacts = result ? getTaskExecutionFactLines(result.payload) : [];

  const isPaid    = task.tier === 2;
  const isBlocked = !tasksEnabled;
  const needsParams = isExecutionTask(task.id);

  useEffect(() => {
    setParams(getInitialTaskParams(task.id));
  }, [task.id]);

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

    setBusy(true); setErr(''); setResult(null); setRunState('queued');
    startedAtRef.current = new Date().toISOString();
    try {
      const response = await tasksApi.runTask(agentId, task.id, needsParams ? buildTaskParams(task.id, params) : undefined);
      if (response?.inline) {
        setResult(buildInlineTaskResult(task, response));
        setRunState('done');
        onRefresh?.();
        return;
      }
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
      setErr(getTaskRunErrorMessage(e.message));
      setRunState(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => () => stopPoll(), []);

  const [expanded, setExpanded] = useState(false);
  const resultMeta = result ? getTaskResultStatusMeta(task, result.payload || {}) : null;

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
              )}

              {task.id === 'EXEC_YIELD_MOVE' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Action</span>
                    <select
                      value={params.action}
                      onChange={e => setParams(current => ({ ...current, action: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                    >
                      <option value="supply">Supply</option>
                      <option value="withdraw">Withdraw</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Amount (USDC)</span>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={params.amount}
                      onChange={e => setParams(current => ({ ...current, amount: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                      placeholder="1.00"
                    />
                  </label>
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
                This execution task requires explicit configuration before it can run.
              </p>
            </div>
          )}
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
              {result.payload?.summary && (
                <p className={`text-xs mt-0.5 ${resultMeta?.detailClasses || 'text-slate-600'}`}>{result.payload.summary}</p>
              )}
              {resultFacts.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {resultFacts.map(line => (
                    <p key={line} className="text-[11px] text-slate-500">{line}</p>
                  ))}
                </div>
              )}
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
  const factLines = getTaskExecutionFactLines(result.payload);
  const expandedText = [result.payload?.summary, ...factLines].filter(Boolean).join('\n');

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
          {expandedText
            ? expandedText
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
      const [catRes, poolRes, statusRes, reputationRes] = await Promise.all([
        tasksApi.catalog(),
        tasksApi.poolBalance(),
        agent?.id
          ? agentsApi.status(agent.id).then(data => ({ data })).catch(err => ({ error: err.message }))
          : Promise.resolve(null),
        agent?.id
          ? agentsApi.reputation(agent.id, 8).then(data => ({ data })).catch(err => ({ error: err.message }))
          : Promise.resolve(null),
      ]);
      setCatalog(catRes.tasks || []);
      setPoolBal(poolRes);
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
  const shownTasks = activeGroup === 'free'
    ? freeTasks
    : activeGroup === 'paid'
      ? paidTasks
      : [];
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
          <p className="text-sm font-semibold text-slate-800">Current Autonomy Policy</p>
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
            {agent?.isSmartMode ? 'Smart Mode on' : 'Smart Mode off'}
          </span>
        </div>
        <div className="mt-2 space-y-1.5 text-xs text-slate-600">
          <p>Market Analysis uses the selected LLM only to refresh context. It does not sign or submit on-chain transactions.</p>
          <p>Oracle Data Feed currently watches the Arc Testnet EURC/USDC stablecoin strategy and records opportunities plus one execution-gate verdict.</p>
          <p>DeFi Loop Execution is the only background feature that can currently move funds. It asks exactly one gate before every autonomous trade: LLM JSON if a key exists, otherwise the built-in rule engine.</p>
          <p>Today the only autonomous on-chain trade is Arc Testnet USDC to EURC on the verified Curve pool. cirBTC LP bootstrap is still manual paid execution, not autonomous.</p>
          <p>Maximum autonomous trade size is capped by your agent setting: <strong>{Number(agent?.settings?.maxTradeUsdc || 0).toFixed(2)} USDC</strong>. The loop uses the smaller of the strategy size and this cap.</p>
          <p>Automation needs funds in the agent wallet. Current Arc wallet snapshot: <strong>{automationWalletSnapshot?.nativeBalance ?? '—'} ARC</strong>, <strong>{automationWalletSnapshot?.usdcBalance ?? '—'} USDC</strong>, <strong>{automationWalletSnapshot?.eurcBalance ?? '—'} EURC</strong>.</p>
          <p>Runtime still starts here in Tasks → Automation. Today, DeFi Protocol Scanner gates Market Analysis, Arbitrage gates oracle-strategy eligibility plus DeFi Loop Execution, and the remaining strategy checkboxes are saved preferences only.</p>
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
                    <strong>Reputation registry is not configured.</strong> `REPUTATION_REGISTRY_ADDRESS` is empty, so this feature records local DB events only.
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
  ) : loading && !catalog.length ? (
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
              <p className="text-sm text-slate-500">Run free informational jobs, paid executions and background automation from one screen.</p>
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

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
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
          Full catalog — this agent can run up to 5 free task runs total per day. Oracle product status and payment flow now live under the dedicated Oracle tab.
        </div>
      )}
      {activeGroup === 'paid' && (
        <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-3.5 py-2.5 text-xs text-amber-700 flex items-center gap-2">
          <Coins size={12} className="shrink-0" />
          Paid tasks execute real on-chain transactions via your agent wallet. CCTP Bridge is <strong>free</strong>. Other paid tasks incur a 0.10 USDC platform fee per run.
        </div>
      )}
      {activeGroup === 'automation' && (
        <div className="rounded-xl border border-blue-100 bg-blue-50/70 px-3.5 py-2.5 text-xs text-blue-700 flex items-center gap-2">
          <Brain size={12} className="shrink-0" />
          Automation settings save instantly here. Use these switches for background agent behavior; use the Free and Paid tabs for manual task runs.
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

