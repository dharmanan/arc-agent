import React, { useState, useEffect, useCallback } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { tasks as tasksApi, agents as agentsApi } from '../lib/api.js';
import { fetchUsdcBalance, fetchEurcBalance } from '../lib/agentBalances.js';
import {
  Card, Button, Alert, Spinner, AddressBox,
} from './ui/index.jsx';
import {
  Zap, Lock, CheckCircle, RefreshCw, Coins,
  Play, ChevronDown, ChevronUp, AlertTriangle, Clock, Brain,
  ShieldCheck, ExternalLink,
} from 'lucide-react';
import { CHAINS } from '../lib/chains.js';
import ReputationProofModal from './ReputationProofModal.jsx';

const AUTOMATION_SNAPSHOT_TOLERANCE_MS = 60 * 1000;
const CARRY_STALE_STATUSES = new Set(['fetch_error', 'decision_error']);

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
    description: 'Keeps pricing and opportunity checks up to date.',
    detail: 'This feeds later decisions. It does not trade by itself.',
  },
  {
    key: 'defiLoopEnabled',
    statusKey: 'defiLoop',
    title: 'Stable DeFi Loop',
    description: 'Lets the agent use the stable USDC/EURC route within your limits.',
    detail: 'This is the stable auto-trading switch.',
  },
  {
    key: 'lendingAutomationEnabled',
    statusKey: 'lendingAutomation',
    title: 'Lending Guard',
    description: 'Protects the live lending account before the rest of the DeFi loop takes new risk.',
    detail: 'Can auto-repay, top up collateral, or reduce LP positions to free stable funds.',
  },
  {
    key: 'carryAutomationEnabled',
    statusKey: 'carryAutomation',
    title: 'Auto Carry',
    description: 'Exclusive stable carry mode that can borrow one stable and deploy it into the stable LP when net carry stays positive.',
    detail: 'While enabled, this lane owns the stable LP carry path and pauses Stable DeFi Loop plus cirBTC LP growth actions.',
  },
  {
    key: 'cirbtcLpEnabled',
    statusKey: 'cirbtcLp',
    title: 'cirBTC LP Automation',
    description: 'Lets the agent manage the cirBTC LP position on its own.',
    detail: 'Adds or removes cirBTC LP automatically.',
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
const FREE_TASK_SURFACE_TASK_IDS = [
  'DAILY_POOL_HEALTH',
  'DAILY_ACTIVITY_RECAP',
  'DAILY_FOREX_MATRIX',
  'DAILY_USDC_PEG_CHECK',
  'DAILY_ARB_SCAN',
];
const FREE_TASK_SURFACE_TASK_ID_SET = new Set(FREE_TASK_SURFACE_TASK_IDS);
const FREE_TASK_SIMULATION_IDS = new Set(['DAILY_ARB_SCAN']);
const EXECUTION_TASK_IDS = new Set([
  'EXEC_CURVE_SWAP',
  'EXEC_CURVE_LIQUIDITY_ADD',
  'EXEC_CURVE_LIQUIDITY_REMOVE',
  'EXEC_CIRBTC_USDC_ZAP_IN',
  'EXEC_CIRBTC_EURC_ZAP_IN',
  'EXEC_CIRBTC_USDC_LP_REMOVE',
  'EXEC_CIRBTC_EURC_LP_REMOVE',
  'EXEC_LENDING_SUPPLY',
  'EXEC_LENDING_WITHDRAW',
  'EXEC_LENDING_BORROW',
  'EXEC_LENDING_REPAY',
  'EXEC_LENDING_COLLATERAL_TOP_UP',
  'EXEC_LENDING_SAFE_EXIT',
  'EXEC_LENDING_LIQUIDATE',
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
const LENDING_ASSET_OPTIONS = ['USDC', 'EURC'];
const REPUTATION_EVENT_LABELS = {
  TRANSACTION_COMPLETED: 'Completed Job',
  ARB_EXECUTED: 'Arbitrage Execution',
  DEFI_LOOP_COMPLETED: 'DeFi Loop',
  ORACLE_QUERY_COMPLETED: 'Oracle Query',
  DAILY_TASK_COMPLETED: 'Daily Task',
  PAID_TASK_COMPLETED: 'Paid Task',
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
    eventType: 'PAID_TASK_COMPLETED',
    label: 'Paid Task',
    delta: 2,
    description: 'Awarded for completing a paid task; weighted higher to reflect USDC cost.',
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
    key: 'bridge_setup',
    title: 'Bridge Setup',
    description: 'Start here on a new wallet. Fund at least 0.06 ETH on Sepolia first, then spread gas to the three supported Sepolia L2 testnets before running other bridge actions.',
    taskIds: ['EXEC_SEPOLIA_GAS_FANOUT'],
  },
  {
    key: 'auto_carry',
    title: 'Auto Carry Products',
    description: 'No-input carry products that only trigger or stop the autonomous stable carry lane. The live lending and LP state is read automatically before each run.',
    taskIds: ['EXEC_AUTO_CARRY_START', 'EXEC_AUTO_CARRY_STOP'],
  },
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
  {
    key: 'lending_lane',
    title: 'Lending Actions',
    description: 'Manual Arc-native lending actions with the same visible guardrails shown in the DeFi lending surface.',
    taskIds: ['EXEC_LENDING_SUPPLY', 'EXEC_LENDING_WITHDRAW', 'EXEC_LENDING_BORROW', 'EXEC_LENDING_REPAY', 'EXEC_LENDING_COLLATERAL_TOP_UP', 'EXEC_LENDING_SAFE_EXIT', 'EXEC_LENDING_DELEVERAGE', 'EXEC_LENDING_LIQUIDATE'],
  },
];
const PAID_TASK_GROUP_TASK_IDS = new Set(PAID_TASK_GROUPS.flatMap(group => group.taskIds));
const AUTO_CARRY_TASK_IDS = new Set(['EXEC_AUTO_CARRY_START', 'EXEC_AUTO_CARRY_STOP']);
const TASK_ID_WORD_OVERRIDES = {
  arb: 'Arbitrage',
  cirbtc: 'cirBTC',
  cctp: 'CCTP',
  defi: 'DeFi',
  eurc: 'EURC',
  lp: 'LP',
  tvl: 'TVL',
  usd: 'USD',
  usdc: 'USDC',
};

function getTaskOperationalAlert(task) {
  switch (task?.id) {
    case 'EXEC_AUTO_CARRY_START':
      return {
        badge: 'Autonomous',
        title: 'Triggers the same carry lane the background loop uses',
        body: 'This product does not ask for an amount. It reads the live carry lane, removes a blocking manual stable LP when needed, then hands the route back to Auto Carry.',
      };

    case 'EXEC_AUTO_CARRY_STOP':
      return {
        badge: 'Exit lane',
        title: 'Turns Auto Carry off before any unwind step runs',
        body: 'This product first switches the carry lane off, then unwinds the visible autonomous carry leg only when the current LP and debt state makes that possible.',
      };

    case 'EXEC_SEPOLIA_GAS_FANOUT':
      return {
        badge: 'Start here',
        title: 'Fund bridge gas before other cross-chain actions',
        body: 'A new wallet should hold at least 0.06 ETH on Sepolia before this run. This task then sends 0.01 ETH each to Base Sepolia, Optimism Sepolia and Arbitrum Sepolia so later bridge and destination-side actions do not fail for missing gas.',
      };

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

    case 'EXEC_LENDING_SUPPLY':
    case 'EXEC_LENDING_WITHDRAW':
    case 'EXEC_LENDING_BORROW':
    case 'EXEC_LENDING_REPAY':
      return {
        badge: 'Lending lane',
        title: 'Runs on the Arc-native lending adapter',
        body: 'This task uses the Arc-native lending lane and re-checks the same visible risk guard before any on-chain write is sent.',
      };

    case 'EXEC_LENDING_COLLATERAL_TOP_UP':
      return {
        badge: 'Buffer repair',
        title: 'Adds visible wallet collateral only when needed',
        body: 'This task builds a deterministic supply plan from the visible lending risk surface and only runs when the current buffer needs a collateral top-up.',
      };

    case 'EXEC_LENDING_SAFE_EXIT':
      return {
        badge: 'Safe close',
        title: 'Closes lending only when the full exit is currently possible',
        body: 'This task first checks whether the wallet can fully repay visible debt, then withdraws the remaining supplied assets in a deterministic order.',
      };

    case 'EXEC_LENDING_DELEVERAGE':
      return {
        badge: 'Recovery',
        title: 'Emergency-only lending path',
        body: 'This task only runs when the lending account is already in the critical recovery band and wallet funds can cover the planned repay steps.',
      };

    case 'EXEC_LENDING_LIQUIDATE':
      return {
        badge: 'Liquidation',
        title: 'Targets another unhealthy lending account',
        body: 'This task requires another borrower below the liquidation threshold plus a matching debt and collateral pair before any liquidation tx can be sent.',
      };

    default:
      return null;
  }
}

function getAutoCarryTaskToneClasses(tone) {
  switch (tone) {
    case 'amber':
      return {
        card: 'border-amber-200 bg-amber-50',
        eyebrow: 'text-amber-700',
        body: 'text-amber-900',
        note: 'text-amber-800',
        badge: 'border-amber-200 bg-white text-amber-700',
      };
    case 'rose':
      return {
        card: 'border-rose-200 bg-rose-50',
        eyebrow: 'text-rose-700',
        body: 'text-rose-900',
        note: 'text-rose-800',
        badge: 'border-rose-200 bg-white text-rose-700',
      };
    default:
      return {
        card: 'border-sky-200 bg-sky-50',
        eyebrow: 'text-sky-700',
        body: 'text-sky-900',
        note: 'text-sky-800',
        badge: 'border-sky-200 bg-white text-sky-700',
      };
  }
}

const AUTO_CARRY_PRACTICAL_SUPPLY_FLOOR_USDC = 100;

function getAutoCarryBlockedReasonLabel(blockedBy, assetSymbol = 'USDC') {
  switch (String(blockedBy || '').trim().toLowerCase()) {
    case 'borrow_capacity_too_small':
      return 'Fresh starts still need more supplied collateral and visible borrow room.';
    case 'manual_stable_lp_conflict':
      return 'A manual stable LP is still blocking the autonomous lane.';
    case 'stable_pool_unavailable':
      return 'The stable LP lane is not ready for a live deploy yet.';
    case 'negative_net_carry':
      return 'The live LP yield is still not clearing borrow cost.';
    case 'health_factor_buffer_too_thin':
      return 'The projected health buffer is still too thin for a fresh leg.';
    case 'wallet_balance_too_small':
      return `The wallet still needs idle ${assetSymbol} ready for the deploy or repay step.`;
    case 'execution_not_ready':
      return 'The lending lane is not ready for live execution yet.';
    default:
      return humanizeAutomationAction(blockedBy, 'The live carry checks are still waiting on another condition.');
  }
}

function getAutoCarryExplainer(taskId, assetSymbol) {
  if (taskId === 'EXEC_AUTO_CARRY_STOP') {
    return `Auto Carry unwinds the same lending plus stable LP lane in reverse: turn the lane off, pull liquidity back, then repay visible ${assetSymbol} debt when the live state allows it.`;
  }

  return `Auto Carry uses supplied collateral to borrow ${assetSymbol}, then moves that borrowed balance into the stable LP only when the live spread stays positive and the safety checks still pass.`;
}

function getAutoCarryRequirementLines({ taskId, carryState, blockedBy, assetSymbol }) {
  const waitReason = blockedBy ? `Current live hold reason: ${getAutoCarryBlockedReasonLabel(blockedBy, assetSymbol)}` : null;

  if (taskId === 'EXEC_AUTO_CARRY_STOP') {
    if (carryState === 'manual_lp_conflict') {
      return [
        'No amount entry is needed. This card only turns Auto Carry off from the current manual LP state.',
        'The manual stable LP stays untouched until a separate manual exit or conversion is requested.',
      ];
    }

    if (carryState === 'debt_idle') {
      return [
        'No amount entry is needed. The card reads the live debt and wallet balance on its own.',
        `The lane repays visible idle ${assetSymbol} debt only if enough matching wallet balance is already sitting idle.`,
        'If the wallet is still short, Auto Carry still turns off and leaves the remaining repay choice for later.',
      ];
    }

    if (carryState === 'active' || carryState === 'unwind') {
      return [
        'No amount entry is needed. The card reads the live LP and debt state before it sends anything.',
        'If carry is live, the stable LP must be removable and the visible debt must be unwindable from the same live flow.',
        'If the unwind cannot finish safely, the card surfaces the failure instead of hiding it.',
      ];
    }

    return [
      'No amount entry is needed.',
      'When there is no live carry leg, this only keeps the lane turned off.',
    ];
  }

  if (carryState === 'manual_lp_conflict') {
    return [
      'A manual USDC/EURC LP is still open, so this product has to convert that position before Auto Carry can own the lane.',
      `With the current setup, about ${AUTO_CARRY_PRACTICAL_SUPPLY_FLOOR_USDC} USDC already supplied in lending is the practical threshold for a fresh carry start.`,
      'The spread must stay positive after borrow cost and the projected health buffer must still clear the safety floor.',
      ...(waitReason ? [waitReason] : []),
    ];
  }

  if (carryState === 'debt_idle') {
    return [
      'The borrow leg is already open, so this trigger mainly needs the LP handoff to finish.',
      `The borrowed ${assetSymbol} has to stay visible in the wallet until the follow-up deploy runs.`,
      'If the spread or safety checks fail on the next review, Auto Carry holds instead of forcing the LP add.',
      ...(waitReason ? [waitReason] : []),
    ];
  }

  if (carryState === 'active') {
    return [
      'The lane already has both debt and LP exposure live.',
      'This refresh mostly rechecks spread, LP coverage, and the health buffer before it decides to keep holding or unwind.',
      'It does not ask you for a manual size while Auto Carry already owns the lane.',
      ...(waitReason ? [waitReason] : []),
    ];
  }

  return [
    'Auto Carry reads live lending and stable LP conditions before it does anything.',
    `With the current setup, about ${AUTO_CARRY_PRACTICAL_SUPPLY_FLOOR_USDC} USDC already supplied in lending is the practical threshold for a fresh carry start.`,
    'The spread must stay positive after borrow cost, the stable LP lane must be live, and the projected health buffer must clear the safety floor.',
    ...(waitReason ? [waitReason] : []),
  ];
}

function getAutoCarryPhaseLines({ taskId, carryState, assetSymbol }) {
  if (taskId === 'EXEC_AUTO_CARRY_STOP') {
    if (carryState === 'manual_lp_conflict') {
      return [
        'Turn Auto Carry off.',
        'Leave the manual stable LP untouched.',
        'Keep the lane closed until you reopen or convert it later.',
      ];
    }

    if (carryState === 'debt_idle') {
      return [
        'Turn Auto Carry off first.',
        `Read the visible ${assetSymbol} debt and the idle ${assetSymbol} balance already sitting in the wallet.`,
        'Repay immediately only if enough idle balance is already available.',
        'Leave the lane off after that repay decision.',
      ];
    }

    if (carryState === 'active' || carryState === 'unwind') {
      return [
        'Turn Auto Carry off first.',
        'Remove the active stable LP leg.',
        `Use the recovered ${assetSymbol} flow to repay visible debt.`,
        'Leave the lane off after the unwind finishes.',
      ];
    }

    return [
      'Turn Auto Carry off.',
      'Make no LP or lending move because nothing is live to unwind.',
      'Leave the lane closed until you trigger Start again.',
    ];
  }

  if (carryState === 'manual_lp_conflict') {
    return [
      'Convert the blocking manual stable LP back into wallet tokens.',
      'Turn Auto Carry on and run the first live review right away.',
      `If the checks pass, borrow ${assetSymbol} first.`,
      'Queue a follow-up carry review about 30 seconds later.',
      `On the follow-up pass, move the borrowed ${assetSymbol} into the stable LP.`,
      'After that, keep monitoring and only hold or unwind when the next live checks require it.',
    ];
  }

  if (carryState === 'debt_idle') {
    return [
      'Keep the lane on and refresh the live review immediately.',
      `Read the borrowed ${assetSymbol} already sitting idle in the wallet.`,
      `Deploy that idle ${assetSymbol} into the stable LP on the follow-up pass if the checks still pass.`,
      'Return to monitoring once the LP and debt are aligned again.',
    ];
  }

  if (carryState === 'active') {
    return [
      'Refresh the live carry snapshot.',
      'Recheck borrow cost, LP yield, LP coverage, and the health buffer.',
      'Keep holding the active lane if those checks still pass.',
      'Switch to hold or unwind instead if the spread weakens or the position becomes unsafe.',
    ];
  }

  return [
    'Turn Auto Carry on and queue the first live carry review immediately.',
    'Read supplied collateral, visible borrow room, LP yield, and borrow cost.',
    `If the checks pass, borrow ${assetSymbol} first.`,
    'Queue a follow-up carry review about 30 seconds later.',
    `On that follow-up pass, deploy the borrowed ${assetSymbol} into the stable LP.`,
    'After the handoff, keep monitoring and only hold or unwind when the next checks say so.',
  ];
}

function getAutoCarryProductDetails(taskId, carryContext) {
  const decision = carryContext?.lastDecision || {};
  const carryState = String(decision.carryState || 'inactive');
  const liveManagedAssetSymbol = decision.actionAssetSymbol || decision.selectedAssetSymbol || null;
  const selectedAssetSymbol = taskId === 'EXEC_AUTO_CARRY_START'
    && !['active', 'debt_idle', 'unwind'].includes(carryState)
      ? decision.preferredOpenAssetSymbol || 'USDC'
      : liveManagedAssetSymbol || decision.preferredOpenAssetSymbol || 'USDC';
  const lpBalance = Number(decision.lpBalance || 0);
  const positionValueUsd = Number(decision.positionValueUsd || 0);
  const netCarryApyPct = Number(decision.netCarryApyPct || 0);
  const projectedOpenHealthFactor = Number(decision.projectedOpenHealthFactor || 0);
  const availableBorrowUsd = Number(decision.availableBorrowUsd || 0);
  const blockedBy = decision.blockedBy || null;
  const explainer = getAutoCarryExplainer(taskId, selectedAssetSymbol);
  const requirements = getAutoCarryRequirementLines({
    taskId,
    carryState,
    blockedBy,
    assetSymbol: selectedAssetSymbol,
  });
  const phases = getAutoCarryPhaseLines({
    taskId,
    carryState,
    assetSymbol: selectedAssetSymbol,
  });

  if (taskId === 'EXEC_AUTO_CARRY_START') {
    if (carryState === 'manual_lp_conflict') {
      return {
        tone: 'amber',
        title: 'Manual LP will be converted first',
        body: 'This product removes the blocking manual stable LP into both wallet tokens, then enables Auto Carry and queues the same autonomous carry review. No amount entry is required.',
        note: lpBalance > 0 || positionValueUsd > 0
          ? `Current manual LP: ${formatTaskMetricAmount(lpBalance)} LP about ${formatUsdAmount(positionValueUsd)}.`
          : 'The live LP size is waiting for the next carry refresh.',
        carryState,
        selectedAssetSymbol,
        lpBalance,
        positionValueUsd,
        netCarryApyPct,
        projectedOpenHealthFactor,
        availableBorrowUsd,
        blockedBy,
        explainer,
        requirements,
        phases,
      };
    }

    if (carryState === 'debt_idle') {
      return {
        tone: 'sky',
        title: 'Borrow is already open and waiting for the next LP step',
        body: 'This product re-queues the autonomous carry review immediately so the idle borrowed balance can continue into the stable LP lane without waiting for the long scheduler interval.',
        note: 'No manual amount entry is needed because the current carry lane is read live before the trigger is queued.',
        carryState,
        selectedAssetSymbol,
        lpBalance,
        positionValueUsd,
        netCarryApyPct,
        projectedOpenHealthFactor,
        availableBorrowUsd,
        blockedBy,
        explainer,
        requirements,
        phases,
      };
    }

    if (carryState === 'active') {
      return {
        tone: 'sky',
        title: 'Carry is already live',
        body: 'Running this product again does not ask for a size. It only refreshes the same autonomous carry lane and keeps Auto Carry in control of the stable route.',
        note: 'Use the stop product below if the goal is to unwind and switch the lane off.',
        carryState,
        selectedAssetSymbol,
        lpBalance,
        positionValueUsd,
        netCarryApyPct,
        projectedOpenHealthFactor,
        availableBorrowUsd,
        blockedBy,
        explainer,
        requirements,
        phases,
      };
    }

    return {
      tone: 'sky',
      title: 'Queues the autonomous carry lane with no amount input',
      body: 'This product enables Auto Carry and queues the same live carry review that the background loop uses. If the spread is not ready yet, the lane stays on and keeps waiting automatically.',
      note: blockedBy
        ? `Current wait reason: ${getAutoCarryBlockedReasonLabel(blockedBy, selectedAssetSymbol)}`
        : 'The carry lane chooses the borrow size on its own from the live lending and LP surface.',
      carryState,
      selectedAssetSymbol,
      lpBalance,
      positionValueUsd,
      netCarryApyPct,
      projectedOpenHealthFactor,
      availableBorrowUsd,
      blockedBy,
      explainer,
      requirements,
      phases,
    };
  }

  if (carryState === 'manual_lp_conflict') {
    return {
      tone: 'rose',
      title: 'Turns Auto Carry off without taking over the manual LP',
      body: 'Because the current stable LP is manual, this stop product only turns Auto Carry off. The manual LP stays untouched until a separate manual exit is requested.',
      note: lpBalance > 0 || positionValueUsd > 0
        ? `Current manual LP: ${formatTaskMetricAmount(lpBalance)} LP about ${formatUsdAmount(positionValueUsd)}.`
        : 'No autonomous LP unwind is planned from this state.',
      carryState,
      selectedAssetSymbol,
      lpBalance,
      positionValueUsd,
      netCarryApyPct,
      projectedOpenHealthFactor,
      availableBorrowUsd,
      blockedBy,
      explainer,
      requirements,
      phases,
    };
  }

  if (carryState === 'debt_idle') {
    return {
      tone: 'rose',
      title: 'Repays idle carry debt before the lane stays off',
      body: 'This product first turns Auto Carry off, then uses any visible idle wallet balance in the carry asset to repay the current debt leg when that repay is immediately possible.',
      note: 'If the wallet does not hold enough of the debt asset yet, the lane still turns off and waits for a later manual or automated repay decision.',
      carryState,
      selectedAssetSymbol,
      lpBalance,
      positionValueUsd,
      netCarryApyPct,
      projectedOpenHealthFactor,
      availableBorrowUsd,
      blockedBy,
      explainer,
      requirements,
      phases,
    };
  }

  if (carryState === 'active' || carryState === 'unwind') {
    return {
      tone: 'rose',
      title: 'Unwinds the live autonomous carry leg',
      body: 'This product turns Auto Carry off first, then removes the current stable LP and repays visible debt from the same carry asset when the live position can be unwound immediately.',
      note: 'No manual notional is required because the current LP and debt are read from the live carry state.',
      carryState,
      selectedAssetSymbol,
      lpBalance,
      positionValueUsd,
      netCarryApyPct,
      projectedOpenHealthFactor,
      availableBorrowUsd,
      blockedBy,
      explainer,
      requirements,
      phases,
    };
  }

  return {
    tone: 'rose',
    title: 'Keeps the carry lane closed',
    body: 'This product simply turns Auto Carry off when there is no active autonomous carry leg to unwind right now.',
    note: 'Use the start product when the goal is to hand the stable route back to autonomous carry management.',
    carryState,
    selectedAssetSymbol,
    lpBalance,
    positionValueUsd,
    netCarryApyPct,
    projectedOpenHealthFactor,
    availableBorrowUsd,
    blockedBy,
    explainer,
    requirements,
    phases,
  };
}

function getAutoCarryTaskButtonCopy(taskId, hasResult) {
  if (taskId === 'EXEC_AUTO_CARRY_START') {
    return hasResult ? 'Pay & Trigger Again' : 'Pay & Trigger';
  }

  if (taskId === 'EXEC_AUTO_CARRY_STOP') {
    return hasResult ? 'Pay & Stop Again' : 'Pay & Stop';
  }

  return hasResult ? 'Pay & Run Again' : 'Pay & Run';
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

function formatCirclePaidUsd(value, maximumFractionDigits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';

  return numeric.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: numeric >= 1000 ? 0 : Math.min(maximumFractionDigits, 2),
    maximumFractionDigits,
  });
}

function formatCirclePaidNumber(value, maximumFractionDigits = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';

  const absoluteValue = Math.abs(numeric);
  const resolvedDigits = absoluteValue >= 100
    ? 2
    : absoluteValue >= 1
      ? Math.min(maximumFractionDigits, 4)
      : maximumFractionDigits;

  return numeric.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: resolvedDigits,
  });
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

function isCirclePaidWalletSnapshotPayload(payload) {
  return Boolean(
    payload?.walletAddress
      && (Array.isArray(payload?.balances) || Array.isArray(payload?.positions) || payload?.dailySummary),
  );
}

function formatCirclePaidWalletPosture(posture) {
  switch (String(posture || '').toLowerCase()) {
    case 'lp_exposure_present':
      return 'LP exposure live';
    case 'stable_lp_present':
      return 'Stable LP live';
    case 'balanced_stable_idle':
      return 'Idle stables ready';
    case 'stable_concentration':
      return 'Stable mix skewed';
    case 'single_asset_stable':
      return 'Single stable heavy';
    case 'informational':
      return 'Wallet snapshot';
    default:
      return 'Wallet snapshot';
  }
}

function getCirclePaidWalletPostureClasses(posture) {
  switch (String(posture || '').toLowerCase()) {
    case 'lp_exposure_present':
    case 'stable_lp_present':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'balanced_stable_idle':
      return 'border-green-200 bg-green-50 text-green-700';
    case 'stable_concentration':
      return 'border-red-200 bg-red-50 text-red-700';
    case 'single_asset_stable':
      return 'border-sky-200 bg-sky-50 text-sky-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600';
  }
}

function getCirclePaidSnapshotMeta(preview, isEventOddsCompare = false) {
  const meta = [];

  if (isCirclePaidWalletSnapshotPayload(preview)) {
    if (Number.isFinite(Number(preview?.metrics?.totalWalletUsd))) {
      meta.push(`Wallet ${formatCirclePaidUsdCompact(preview.metrics.totalWalletUsd)}`);
    }

    if (Number.isFinite(Number(preview?.metrics?.positionCount))) {
      const positionCount = Number(preview.metrics.positionCount);
      meta.push(`${positionCount} position${positionCount === 1 ? '' : 's'}`);
    }

    if (Number(preview?.dailySummary?.counts?.swaps) > 0) {
      meta.push(`Yesterday ${preview.dailySummary.counts.swaps} swaps`);
    }

    if (Number(preview?.dailySummary?.counts?.lpAdds) > 0 || Number(preview?.dailySummary?.counts?.lpRemoves) > 0) {
      meta.push(`LP ${preview?.dailySummary?.counts?.lpAdds || 0} add / ${preview?.dailySummary?.counts?.lpRemoves || 0} remove`);
    }

    if (preview?.dailySummary?.status && preview.dailySummary.status !== 'available') {
      meta.push('Wallet-only recap');
    }

    return meta;
  }

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
  const { agent: activeAgent } = useAgent();
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
  const isWalletSnapshot = item.id === 'ARC_WALLET_ASSET_SNAPSHOT';
  const isEventOddsCompare = item.id === 'ARC_EVENT_ODDS_COMPARE';
  const isActionFirst = item.arcTestnetActionable;
  const hasLiveRuntime = item.status === 'live';
  const sourceServices = Array.isArray(item.sourceServices) ? item.sourceServices : [];
  const statusLabel = formatCirclePaidStatus(item.status);
  const preview = previewResponse?.preview || null;
  const liveResult = unlockedResponse?.liveResult || null;
  const previewComparison = isWalletSnapshot ? null : preview?.comparison || null;
  const liveComparison = isWalletSnapshot ? null : liveResult?.comparison || null;
  const connectedWalletAddress = activeAgent?.walletAddress || activeAgent?.wallet_address || preview?.walletAddress || liveResult?.walletAddress || '';

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

  function renderWalletSnapshotMetrics(metrics = {}) {
    const metricItems = [
      {
        label: 'Liquid balance',
        value: formatCirclePaidUsd(metrics?.liquidUsd),
        note: 'Wallet tokens',
      },
      {
        label: 'Position value',
        value: formatCirclePaidUsd(metrics?.positionUsd),
        note: 'LP and direct-pair exposure',
      },
      {
        label: 'Total wallet',
        value: formatCirclePaidUsd(metrics?.totalWalletUsd),
        note: 'Liquid plus positions',
      },
      {
        label: 'Open positions',
        value: Number.isFinite(Number(metrics?.positionCount)) ? String(Number(metrics.positionCount)) : '—',
        note: Number(metrics?.warningCount) > 0
          ? `${Number(metrics.warningCount)} warning${Number(metrics.warningCount) === 1 ? '' : 's'}`
          : 'Live reads clean',
      },
    ];

    return (
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {metricItems.map(metric => (
          <div key={`${item.id}:${metric.label}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{metric.label}</p>
            <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{metric.value}</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">{metric.note}</p>
          </div>
        ))}
      </div>
    );
  }

  function renderWalletSnapshotBalances(balances = []) {
    const visibleBalances = Array.isArray(balances) ? balances.filter(Boolean) : [];
    if (!visibleBalances.length) return null;

    return (
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Token mix</p>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          {visibleBalances.map((balance, index) => (
            <div key={`${item.id}:balance:${balance.symbol || index}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold text-slate-900">{balance.symbol || 'Asset'}</p>
                {Number.isFinite(Number(balance.exposurePct)) && (
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    {formatCirclePaidPercent(balance.exposurePct)}
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm font-semibold tabular-nums text-slate-900">
                {formatCirclePaidNumber(balance.amount, balance.symbol === 'cirBTC' ? 8 : 6)}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">{formatCirclePaidUsd(balance.usdValue)}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderWalletSnapshotPositions(positions = []) {
    const visiblePositions = Array.isArray(positions) ? positions.filter(Boolean) : [];

    return (
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Open positions</p>
        {visiblePositions.length === 0 ? (
          <p className="mt-2 text-xs leading-5 text-slate-500">No LP or direct-pair position is open right now.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {visiblePositions.map((position, index) => (
              <div key={`${item.id}:position:${position.poolKey || position.protocol || index}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-xs font-semibold text-slate-900">{position.poolKey || 'Tracked position'}</p>
                      {position.protocol && (
                        <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
                          {String(position.protocol).replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    {Array.isArray(position.underlying) && position.underlying.length > 0 && (
                      <p className="mt-1 text-[11px] leading-5 text-slate-500">
                        {position.underlying.slice(0, 3).map(asset => `${asset.symbol} ${formatCirclePaidNumber(asset.amount, asset.symbol === 'cirBTC' ? 8 : 6)}`).join(' · ')}
                      </p>
                    )}
                  </div>
                  <div className="sm:text-right">
                    <p className="text-xs font-semibold text-slate-900">{formatCirclePaidUsd(position.totalUsd)}</p>
                    {Number.isFinite(Number(position.sharePct)) && (
                      <p className="mt-1 text-[11px] text-slate-500">Share {formatCirclePaidPercent(position.sharePct)}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderWalletSnapshotYesterdayPanel(dailySummary, { showRecent = false } = {}) {
    if (!dailySummary) return null;

    const statItems = [
      { label: 'Swaps', value: Number(dailySummary?.counts?.swaps || 0) },
      { label: 'LP adds', value: Number(dailySummary?.counts?.lpAdds || 0) },
      { label: 'LP removes', value: Number(dailySummary?.counts?.lpRemoves || 0) },
      { label: 'Rebalances', value: Number(dailySummary?.counts?.rebalances || 0) },
      { label: 'Borrows', value: Number(dailySummary?.counts?.lendingBorrows || 0) },
      { label: 'Arb signals', value: Number(dailySummary?.counts?.arbSignalsFound || 0) },
    ].filter(entry => entry.value > 0);
    const recentItems = showRecent && Array.isArray(dailySummary.recent)
      ? dailySummary.recent.slice(0, 3)
      : [];
    const isIndexedSummary = dailySummary.status === 'available';

    return (
      <div className="rounded-xl border border-sky-200 bg-gradient-to-br from-sky-50 to-cyan-50 px-3 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">Yesterday (UTC)</p>
            <p className="mt-1 text-sm font-semibold leading-6 text-slate-900">{dailySummary.summary || 'No yesterday recap is available yet.'}</p>
            {!isIndexedSummary && (
              <p className="mt-1 text-xs leading-5 text-slate-600">
                This panel fills in only when the connected wallet already exists as an indexed Arc agent.
              </p>
            )}
          </div>
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            isIndexedSummary
              ? 'border-sky-200 bg-white text-sky-700'
              : 'border-slate-200 bg-white text-slate-600'
          }`}>
            {isIndexedSummary ? 'Indexed history' : 'Wallet only'}
          </span>
        </div>

        {statItems.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            {statItems.map(entry => (
              <div key={`${item.id}:yesterday:${entry.label}`} className="rounded-lg border border-white bg-white/80 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{entry.label}</p>
                <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{entry.value}</p>
              </div>
            ))}
          </div>
        )}

        {recentItems.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">Latest tracked moves</p>
            {recentItems.map((activity, index) => (
              <div key={`${item.id}:recent:${activity.type || index}:${activity.createdAt || index}`} className="rounded-lg border border-white bg-white/80 px-3 py-2.5">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-slate-900">{activity.label || activity.type || 'Tracked activity'}</p>
                    <p className="mt-1 text-[11px] leading-5 text-slate-500">
                      {[activity.token, Number(activity.amountUsd) > 0 ? formatCirclePaidUsd(activity.amountUsd) : null, formatTimestamp(activity.createdAt)].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium capitalize text-slate-600">
                    {String(activity.status || 'tracked').replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  async function handlePreviewRun() {
    if (!agentId || !hasLiveRuntime) return;

    setPreviewBusy(true);
    setRunError('');

    try {
      const previewParams = isWalletSnapshot
        ? {}
        : isEventOddsCompare
          ? { primaryTopic: topic, secondaryTopic: comparisonTopic, limit: 4 }
          : { topic };

      const response = await tasksApi.circlePaidPreview(agentId, item.id, previewParams);
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
  const suggestedTaskLabel = unlockedResponse?.recommendedTask?.title || liveResult?.recommendedTaskId || '';

  const todayCopy = hasLiveRuntime
    ? isEventOddsCompare
      ? 'Start with a free preview. Pay only if you want the full comparison saved to your account.'
      : isWalletSnapshot
        ? 'Start with a free preview. This card reads the connected Arc wallet now and opens a clearer Yesterday panel whenever indexed history exists.'
        : 'Start with a free preview. Pay only if you want the full result saved to your account.'
    : 'This card is still a preview. Opening it does not charge anything and does not start any on-chain step yet.';

  const paymentCopy = hasLiveRuntime
    ? isEventOddsCompare
      ? 'Free preview is live. Payment unlocks the full comparison and saves it. Any later Arc action is still separate.'
      : isWalletSnapshot
        ? 'Free preview is live. Payment unlocks the full wallet readout and saves it. Any later Arc action is still separate.'
        : 'Free preview is live. Payment unlocks the full result and saves it. Any later Arc action is still separate.'
    : 'This card is still in preview. Prices shown here are planning estimates until it goes live.';

  const currentSourceLabel = hasLiveRuntime ? 'Data source' : 'Planned source';
  const teaserCopy = hasLiveRuntime
    ? isWalletSnapshot
      ? 'Open the card to preview the connected wallet first. Paying later only saves the full result and Yesterday recap.'
      : 'Open the card to start a free preview. Paying later only unlocks the full result and saved copy.'
    : 'Open the card to see what is planned and what it may cost later.';

  const renderUnlockBox = (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Unlock full result + save snapshot</p>
          <p className="mt-1 leading-5">
            Pay <strong>{formatCirclePaidFeeUsdc(previewTotalFeeUsdc)} USDC</strong> to reveal the {isWalletSnapshot ? 'full wallet readout and Yesterday panel' : isEventOddsCompare ? 'full side-by-side comparison' : 'full matched markets'} and save this result as a reusable snapshot.
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
  );

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
          <p className="mt-1 text-[11px] text-slate-400">{teaserCopy}</p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(current => !current)}
          className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? 'Close' : isWalletSnapshot ? 'Open wallet preview' : hasLiveRuntime ? 'Open live preview' : 'View details'}
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
              {isWalletSnapshot ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Connected agent wallet</p>
                  <p className="mt-2 break-all rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-700">
                    {connectedWalletAddress || 'Agent wallet is not available yet.'}
                  </p>
                  <p className="mt-2 text-[11px] leading-5 text-slate-500">
                    Free preview reads the connected Arc wallet, current LP exposure, and the Yesterday panel when indexed history already exists.
                  </p>
                </div>
              ) : (
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
              )}

              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="button"
                  onClick={handlePreviewRun}
                  disabled={isAnyBusy || !agentId || (!isWalletSnapshot && !topic.trim()) || (isEventOddsCompare && (!comparisonTopic.trim() || hasInvalidComparisonTopics))}
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
                {isWalletSnapshot
                  ? 'Free preview reads the live Arc wallet and surfaces a balances + positions readout. Unlock is a separate paid step for the full saved wallet snapshot.'
                  : isEventOddsCompare
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
              {isWalletSnapshot ? (
                <>
                  <div className="space-y-2">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Free preview</p>
                      <p className="mt-1 text-sm font-semibold leading-6 text-slate-900">{preview.summary}</p>
                      {previewResponse?.note && (
                        <p className="mt-1 text-xs leading-5 text-slate-500">{previewResponse.note}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getCirclePaidWalletPostureClasses(preview.posture)}`}>
                        {formatCirclePaidWalletPosture(preview.posture)}
                      </span>
                    </div>
                  </div>

                  {renderWalletSnapshotMetrics(preview.metrics)}
                  {renderWalletSnapshotBalances(preview.balances)}
                  {renderWalletSnapshotPositions(preview.positions)}
                  {renderWalletSnapshotYesterdayPanel(preview.dailySummary)}
                  {!liveResult && renderUnlockBox}
                </>
              ) : (
                <>
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
                  {!liveResult && renderUnlockBox}
                </>
              )}
            </div>
          )}

          {hasLiveRuntime && liveResult && (
            <div className="space-y-3 rounded-xl border border-green-200 bg-white p-3">
              {isWalletSnapshot ? (
                <>
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
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getCirclePaidWalletPostureClasses(liveResult.posture)}`}>
                        {formatCirclePaidWalletPosture(liveResult.posture)}
                      </span>
                      {suggestedTaskLabel && (
                        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                          Next {suggestedTaskLabel}
                        </span>
                      )}
                      {unlockedResponse?.economy?.status && !isViewingSavedSnapshot && (
                        <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                          Payment {String(unlockedResponse.economy.status).toLowerCase()}
                        </span>
                      )}
                    </div>
                  </div>

                  {renderWalletSnapshotMetrics(liveResult.metrics)}
                  {renderWalletSnapshotBalances(liveResult.balances)}
                  {renderWalletSnapshotPositions(liveResult.positions)}
                  {renderWalletSnapshotYesterdayPanel(liveResult.dailySummary, { showRecent: true })}
                </>
              ) : (
                <>
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
                </>
              )}

              {(unlockedResponse?.savedSnapshot?.unlockedAt || unlockedResponse?.savedSnapshot?.createdAt) && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Saved snapshot: <strong>{formatTimestamp(unlockedResponse?.savedSnapshot?.unlockedAt || unlockedResponse?.savedSnapshot?.createdAt)}</strong>
                </div>
              )}

              {!isWalletSnapshot && !isEventOddsCompare && Array.isArray(liveResult.highlights) && liveResult.highlights.length > 0 && (
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
                  savedSnapshots.map(snapshot => {
                    const snapshotIsWallet = isCirclePaidWalletSnapshotPayload(snapshot.preview);

                    return (
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
                              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${snapshotIsWallet ? getCirclePaidWalletPostureClasses(snapshot.preview?.posture) : getCirclePaidRegimeClasses(snapshot.preview?.regime)}`}>
                                {snapshotIsWallet ? formatCirclePaidWalletPosture(snapshot.preview?.posture) : String(snapshot.preview?.regime || 'UNKNOWN').toLowerCase()}
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
                    );
                  })
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

function getTaskRunErrorMessage(message, taskId = null) {
  const normalized = String(message || '').trim();
  const lower = normalized.toLowerCase();

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
    case 'manual_lending_asset_invalid':
      return 'Choose USDC or EURC for this lending action.';
    case 'lending_amount_required':
      return 'Enter a positive amount for this lending action.';
    case 'lending_contract_not_configured':
      return 'The Arc lending contract address is not configured yet on this deployment.';
    case 'lending_contract_scaffold_only':
      return 'The Arc lending contract is still in scaffold mode, so live writes stay blocked.';
    case 'lending_globally_paused':
      return 'The Arc-native lending lane is globally paused right now.';
    case 'lending_reserve_not_supported':
      return 'This lending reserve is not part of the current v1 scope.';
    case 'lending_reserve_paused':
      return 'This lending reserve is paused right now.';
    case 'lending_reserve_borrow_disabled':
      return 'Borrowing is disabled for this lending reserve right now.';
    case 'lending_wallet_balance_empty':
      return 'The agent wallet does not hold enough of that asset for this lending action.';
    case 'lending_wallet_balance_too_low':
      return 'The requested amount is above the visible wallet balance for this asset.';
    case 'lending_supply_position_required':
      return 'This action needs an existing supplied position first.';
    case 'lending_borrow_position_required':
      return 'This action needs an existing debt position first.';
    case 'lending_supply_cap_reached':
      return 'The reserve supply cap is already full.';
    case 'lending_borrow_cap_reached':
      return 'The reserve borrow cap is already full.';
    case 'lending_borrow_capacity_unavailable':
      return 'Borrow capacity is not available for this account right now.';
    case 'lending_borrow_capacity_exceeded':
      return 'The requested borrow amount is above the visible borrow capacity.';
    case 'lending_withdraw_amount_exceeds_supply':
      return 'The requested withdraw amount is above the visible supplied balance.';
    case 'lending_repay_amount_exceeds_debt':
      return 'The requested repay amount is above the visible debt balance.';
    case 'lending_collateral_topup_not_required':
      return 'Collateral top-up is not required for this account right now.';
    case 'lending_collateral_topup_wallet_funds_required':
      return 'Collateral top-up needs wallet funds in a supported collateral asset before any supply step can run.';
    case 'lending_deleverage_not_required':
      return 'Emergency deleverage is not required for this account right now.';
    case 'lending_deleverage_wallet_funds_required':
      return 'Emergency deleverage needs wallet funds in the same debt asset before any repay step can be sent.';
    case 'lending_safe_exit_not_required':
      return 'There is no active lending position that needs a safe exit right now.';
    case 'lending_safe_exit_wallet_funds_required':
      return 'Safe exit needs enough wallet funds to fully repay visible debt before collateral can be withdrawn.';
    case 'lending_liquidation_borrower_required':
      return 'Enter the borrower wallet address for liquidation.';
    case 'lending_liquidation_collateral_asset_invalid':
      return 'Choose USDC or EURC as the collateral asset for liquidation.';
    case 'lending_liquidation_amount_required':
      return 'Enter a positive repay amount for liquidation.';
    case 'lending_liquidation_self_target_invalid':
      return 'Liquidation must target another wallet, not the current agent wallet.';
    case 'lending_liquidation_target_healthy':
      return 'That borrower is not below the liquidation threshold right now.';
    case 'lending_liquidation_target_debt_missing':
      return 'The borrower does not currently hold the selected debt asset.';
    case 'lending_liquidation_target_collateral_missing':
      return 'The borrower does not currently hold the selected collateral asset.';
    case 'lending_liquidation_amount_too_high':
      return 'The requested liquidation amount is above the visible repayable debt.';
    case 'lending_liquidation_health_unknown':
      return 'Liquidation status cannot be determined until a valid borrower health factor is available.';
    case 'carry_context_unavailable':
      return 'The live carry snapshot could not be loaded right now. Retry after the lending and LP surface refreshes.';
    case 'carry_manual_lp_balance_unavailable':
      return 'The current manual stable LP balance is not visible yet. Refresh the carry surface, then retry this Auto Carry start product.';
    case 'carry_handoff_queue_failed':
      return 'Auto Carry mode was enabled, but the immediate carry review could not be queued. Refresh once, then retry this card if the lane is still idle.';
    case 'lending_surface_unavailable':
      return 'The live lending surface could not be read right now, so Auto Carry could not continue. Refresh the lending data and retry in a moment.';
    case 'swap_not_configured':
      return 'No direct execution rail is configured for this task on this deployment.';
    case 'direct_pair_not_configured':
      return 'This direct cirBTC pair is not configured on the current deployment yet.';
    case 'direct_pair_seed_required':
      return 'The direct cirBTC pair exists but still needs initial seed liquidity before this task can run.';
    case 'native_lending_execution_error':
    case 'native_lending_collateral_topup_error':
    case 'native_lending_deleverage_error':
    case 'native_lending_liquidation_error':
    case 'native_lending_safe_exit_error':
      return 'The lending worker started but the live on-chain step did not complete successfully.';
    case 'execution_error':
      return AUTO_CARRY_TASK_IDS.has(taskId)
        ? 'Auto Carry reached the live chain step, but the wallet was still busy finishing another on-chain action. Wait a short moment, then try this card again.'
        : 'The live on-chain step did not finish successfully. Wait a short moment, then try again.';
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
    case 'bridge_params_required':
      return 'Choose the source chain, destination chain and bridge amount before starting this bridge.';
    case 'stale_task_run_closed':
      return taskId === 'EXEC_SEPOLIA_GAS_FANOUT'
        ? 'The previous gas fanout run stopped before the final bridge status was saved. Check Sepolia and destination gas balances, then retry if needed.'
        : 'The previous task run stopped before the final status was saved. Review balances and retry if needed.';
    case 'bridge_native_topup_error':
      return 'The native gas bridge did not complete successfully.';
    default:
      if (/insufficient funds/i.test(normalized)) {
        if (taskId === 'EXEC_SEPOLIA_GAS_FANOUT') {
          return 'This wallet does not have enough Sepolia ETH to fan out gas to the destination testnets. Fund Sepolia first, then retry this setup task.';
        }

        if (taskId === 'EXEC_CCTP_BRIDGE') {
          return 'This bridge could not continue because the wallet does not have enough balance to cover the next on-chain step.';
        }

        return 'This task could not continue because the wallet did not have enough balance for the required on-chain step.';
      }

      if (/another transaction is already executing/i.test(lower)) {
        return AUTO_CARRY_TASK_IDS.has(taskId)
          ? 'Auto Carry is still waiting for the previous on-chain step to settle. Give it a short moment, then run this card again.'
          : 'The wallet is still finishing a previous on-chain step. Give it a short moment, then retry.';
      }

      if (lower === 'worker_interrupted') {
        return 'The previous worker stopped before this task finished. Review the latest stage and retry if needed.';
      }

      if (/missing revert data|call_exception/i.test(lower)) {
        return 'The live on-chain check did not return a usable response. Retry after the lending and LP surface refresh.';
      }

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
    case 'EXEC_LENDING_SUPPLY':
    case 'EXEC_LENDING_WITHDRAW':
    case 'EXEC_LENDING_BORROW':
    case 'EXEC_LENDING_REPAY':
      return { asset: 'USDC', amount: '' };
    case 'EXEC_LENDING_COLLATERAL_TOP_UP':
    case 'EXEC_LENDING_SAFE_EXIT':
    case 'EXEC_LENDING_DELEVERAGE':
      return {};
    case 'EXEC_LENDING_LIQUIDATE':
      return { borrower: '', debtAsset: 'USDC', collateralAsset: 'EURC', amount: '' };
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
    case 'EXEC_LENDING_SUPPLY':
    case 'EXEC_LENDING_WITHDRAW':
    case 'EXEC_LENDING_BORROW':
    case 'EXEC_LENDING_REPAY':
      if (!params.asset) return 'Choose USDC or EURC for this lending action.';
      if (!(Number(params.amount) > 0)) return 'Enter a positive amount for this lending action.';
      return '';
    case 'EXEC_LENDING_COLLATERAL_TOP_UP':
    case 'EXEC_LENDING_SAFE_EXIT':
    case 'EXEC_LENDING_DELEVERAGE':
      return '';
    case 'EXEC_LENDING_LIQUIDATE':
      if (!params.borrower) return 'Enter the borrower wallet address for liquidation.';
      if (!params.debtAsset) return 'Choose the debt asset used for liquidation.';
      if (!params.collateralAsset) return 'Choose the collateral asset expected from liquidation.';
      if (!(Number(params.amount) > 0)) return 'Enter a positive repay amount for liquidation.';
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
    case 'EXEC_LENDING_SUPPLY':
    case 'EXEC_LENDING_WITHDRAW':
    case 'EXEC_LENDING_BORROW':
    case 'EXEC_LENDING_REPAY':
      return {
        asset: params.asset,
        amount: Number(params.amount),
      };
    case 'EXEC_LENDING_COLLATERAL_TOP_UP':
    case 'EXEC_LENDING_SAFE_EXIT':
    case 'EXEC_LENDING_DELEVERAGE':
      return undefined;
    case 'EXEC_LENDING_LIQUIDATE':
      return {
        borrower: params.borrower,
        debtAsset: params.debtAsset,
        collateralAsset: params.collateralAsset,
        amount: Number(params.amount),
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

function formatTaskIdLabel(taskId, fallback = 'Task') {
  const normalized = String(taskId || '').trim();
  if (!normalized) return fallback;

  const words = normalized
    .replace(/^(EXEC|DAILY)_/, '')
    .split('_')
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (TASK_ID_WORD_OVERRIDES[lower]) return TASK_ID_WORD_OVERRIDES[lower];
      return part.charAt(0) + part.slice(1).toLowerCase();
    });

  return words.length > 0 ? words.join(' ') : fallback;
}

function formatAutomationMetric(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return numeric.toFixed(digits).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

function formatUsdAmount(value) {
  const numeric = Number(value);
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

function formatUsdUnitPrice(value) {
  const numeric = Number(value);
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

function humanizeAutomationAction(value, fallback = 'No action') {
  if (!value) return fallback;
  return String(value)
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function humanizeAutomationStatus(status) {
  const labels = {
    idle: 'Idle',
    running: 'Running',
    success: 'Healthy',
    db_only: 'Local Only',
    no_signal: 'No Signal',
    gate_blocked: 'Gate Hold',
    policy_hold: 'Waiting',
    executed: 'Executed',
    dry_run: 'Dry Run',
    no_opportunity: 'No Opportunity',
    cap_reached: 'Daily Cap Reached',
    insufficient_balance: 'Needs Funds',
    permission_blocked: 'Permission Needed',
    fetch_error: 'Fetch Error',
    decision_error: 'Decision Error',
    execution_error: 'Execution Error',
    execution_blocked: 'Execution Blocked',
    dry_run_failed: 'Dry Run Failed',
    disabled: 'Disabled',
    missing_agent: 'Missing Agent',
    no_private_key: 'Missing Key',
    pool_unconfigured: 'Pool Missing',
    position_guard_unavailable: 'Position Check',
    balance_check_failed: 'Balance Check',
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
  if (['policy_hold', 'insufficient_balance', 'permission_blocked', 'gate_blocked', 'cap_reached', 'disabled', 'pool_unconfigured', 'no_private_key'].includes(status)) {
    return 'border-amber-200 bg-amber-50 text-amber-700';
  }
  return 'border-red-200 bg-red-50 text-red-700';
}

function getCirbtcAutomationFreshness(defiLoopState, cirbtcState) {
  const latestDefiLoopAtMs = Date.parse(defiLoopState?.lastRunAt || '');
  const latestCirbtcSnapshotAt = cirbtcState?.lastDecision?.recordedAt || cirbtcState?.lastRunAt || null;
  const latestCirbtcRunAtMs = Date.parse(latestCirbtcSnapshotAt || '');

  if (!Number.isFinite(latestDefiLoopAtMs)) {
    return null;
  }

  if (
    Number.isFinite(latestCirbtcRunAtMs)
    && (latestDefiLoopAtMs - latestCirbtcRunAtMs) <= AUTOMATION_SNAPSHOT_TOLERANCE_MS
  ) {
    return null;
  }

  return {
    detail: latestCirbtcSnapshotAt
      ? `A later auto cycle finished at ${formatTimestamp(defiLoopState?.lastRunAt)}. The next cirBTC LP review has not run yet.`
      : `A later auto cycle finished at ${formatTimestamp(defiLoopState?.lastRunAt)}. The first cirBTC LP review is still pending.`,
  };
}

function getCirbtcAutomationRuntimeSummary(state, freshness) {
  const bypassNote = state?.bypassDailyCap
    ? ' Daily limit is relaxed for this test agent, so this counter is only a guide.'
    : '';

  const baseSummary = state?.lastDecision?.summary
    || (state?.lastStatus === 'dry_run'
      ? `Practice mode is active. ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} LP checks ran, and no new live LP change was required from this card.${bypassNote}`
      : `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} cirBTC LP checks ran and ${Number(state?.autoTxToday || 0)} live LP actions were sent.${bypassNote}`);

  return freshness?.detail
    ? `${baseSummary} ${freshness.detail}`
    : baseSummary;
}

function getCarryLiveSummary(carry, enabled = true) {
  if (!carry || typeof carry !== 'object') return '';

  if (!enabled) {
    return 'Auto Carry is off. Use Start when you want the stable carry lane to review the live lending and LP state again.';
  }

  if (carry.carryState === 'manual_lp_conflict') {
    return 'Auto Carry is waiting because this stable LP was added manually. Convert it once, then Auto Carry can reopen and manage the next carry position on its own.';
  }

  if (carry.carryState === 'active') {
    return 'Auto Carry already owns the visible stable LP carry leg and is waiting for the next open, deploy, or unwind check.';
  }

  if (carry.carryState === 'debt_idle') {
    return 'The borrow leg is already open and the borrowed stable balance is sitting in the wallet. Auto Carry will use the next carry check to deploy that balance into the stable LP, or trim it if the spread or health buffer no longer passes.';
  }

  if (carry.carryState === 'unwind') {
    return 'Auto Carry is in unwind mode because the current spread or health buffer no longer supports the open carry leg.';
  }

  if (carry.carryState === 'inactive') {
    return 'Auto Carry is on and watching the live spread, but it has not opened a fresh borrowed carry leg yet.';
  }

  return '';
}

function getCarryStateLabel(carryState) {
  switch (String(carryState || '').trim().toLowerCase()) {
    case 'manual_lp_conflict':
      return 'Manual LP needs conversion';
    case 'active':
      return 'Carry is live';
    case 'debt_idle':
      return 'Borrow open, deploy next';
    case 'unwind':
      return 'Closing carry';
    case 'inactive':
      return 'Ready for a new carry';
    case 'unavailable':
      return 'Carry data unavailable';
    default:
      return 'Waiting';
  }
}

function deriveCarryAutomationDisplayState(state, liveSurface, enabled) {
  const carry = liveSurface?.carry;
  if (!carry || typeof carry !== 'object') return state;
  const carryEnabled = Boolean(state?.enabled ?? enabled);

  const staleStatus = CARRY_STALE_STATUSES.has(String(state?.lastStatus || '').trim().toLowerCase())
    || state?.lastDecision?.reason === 'lending_surface_unavailable'
    || !state?.lastDecision?.carryState;

  const liveNetCarryApyPct = Number(carry?.selectedAsset?.netCarryApyPct ?? carry?.netCarryApyPct);
  const nextLastDecision = {
    ...(state?.lastDecision || {}),
    policyId: carry.policyId || state?.lastDecision?.policyId || null,
    carryState: carry.carryState || state?.lastDecision?.carryState || 'inactive',
    selectedStableToken: carry.selectedAssetSymbol || state?.lastDecision?.selectedStableToken || null,
    actionAssetSymbol: carry.selectedAssetSymbol || state?.lastDecision?.actionAssetSymbol || null,
    lpBalance: carry?.lpBalance || state?.lastDecision?.lpBalance || null,
    netCarryApyPct: Number.isFinite(liveNetCarryApyPct)
      ? liveNetCarryApyPct
      : state?.lastDecision?.netCarryApyPct,
    projectedOpenHealthFactor: Number.isFinite(Number(carry?.projectedOpenHealthFactor))
      ? Number(carry.projectedOpenHealthFactor)
      : state?.lastDecision?.projectedOpenHealthFactor,
    estimatedNetUsdPerYear: Number.isFinite(Number(carry?.estimatedNetUsdPerYear))
      ? Number(carry.estimatedNetUsdPerYear)
      : state?.lastDecision?.estimatedNetUsdPerYear,
    positionValueUsd: Number.isFinite(Number(carry?.positionValueUsd))
      ? Number(carry.positionValueUsd)
      : state?.lastDecision?.positionValueUsd,
    availableBorrowUsd: Number.isFinite(Number(carry?.availableBorrowUsd))
      ? Number(carry.availableBorrowUsd)
      : state?.lastDecision?.availableBorrowUsd,
    exclusiveMode: carry.exclusiveMode === true,
    blockedBy: carry?.checks?.stableLpConflict?.passed === false
      ? carry.checks.stableLpConflict.blockedBy
      : state?.lastDecision?.blockedBy || null,
  };

  if (!carryEnabled) {
    nextLastDecision.action = 'auto_carry_stop';
    nextLastDecision.carryAutomationEnabled = false;
    nextLastDecision.carryState = 'inactive';
    nextLastDecision.blockedBy = null;
    nextLastDecision.summary = getCarryLiveSummary(carry, false);

    return {
      ...(state || {}),
      enabled: false,
      lastStatus: 'disabled',
      lastDecision: nextLastDecision,
    };
  }

  if (!nextLastDecision.summary || staleStatus) {
    nextLastDecision.summary = getCarryLiveSummary(carry, carryEnabled) || nextLastDecision.summary || '';
  }

  return {
    ...(state || {}),
    enabled: carryEnabled,
    lastStatus: staleStatus
      ? (enabled ? 'policy_hold' : 'disabled')
      : (state?.lastStatus || (enabled ? 'idle' : 'disabled')),
    lastDecision: nextLastDecision,
  };
}

function deriveReputationAutomationDisplayState(state, reputationOverview, enabled) {
  const baseState = {
    ...(state || {}),
    enabled: Boolean(enabled),
  };

  if (!enabled) {
    return {
      ...baseState,
      lastStatus: 'disabled',
    };
  }

  const onchain = reputationOverview?.onchain;
  if (!onchain || typeof onchain !== 'object') {
    return baseState;
  }

  if (onchain.status === 'live') {
    return {
      ...baseState,
      lastStatus: 'success',
      displaySummary: 'Reputation writes are mirrored on-chain and the current score is readable from the registry.',
    };
  }

  if (onchain.status === 'read_error') {
    return {
      ...baseState,
      lastStatus: 'chain_error',
      displaySummary: 'Registry is configured, but the current on-chain score could not be read.',
    };
  }

  if (onchain.configured === false) {
    return {
      ...baseState,
      lastStatus: 'db_only',
      displaySummary: 'Saving reputation activity locally. On-chain posting is off right now.',
    };
  }

  return baseState;
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

function getCirbtcPairStatusClasses(status) {
  if (['executed', 'ready', 'eligible'].includes(status)) return 'border-green-200 bg-green-50 text-green-700';
  if (['cooldown', 'needs_funds', 'impact_guard'].includes(status)) return 'border-amber-200 bg-amber-50 text-amber-700';
  if (['pool_inactive', 'exit_ready', 'blocked'].includes(status)) return 'border-red-200 bg-red-50 text-red-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function getAutomationSummary(feature, state, agent) {
  const bypassNote = state?.bypassDailyCap
    ? ' Daily limit is relaxed for this test agent, so this counter is only a guide.'
    : '';
  const maxTradeUsdc = Number(agent?.settings?.maxTradeUsdc || 0);
  const usdcReserve = Number(agent?.settings?.defiWalletReserveUsdc || 0);
  const explicitEurcCap = Number(agent?.settings?.oracleMaxEurcInventory || 0);
  const explicitEurcReserve = agent?.settings?.oracleMinEurcReserve;
  const eurcCap = explicitEurcCap > 0 ? explicitEurcCap : maxTradeUsdc;
  const eurcReserve = explicitEurcReserve != null ? Number(explicitEurcReserve || 0) : usdcReserve;
  const oracleCooldownNote = state?.entryCooldown?.active
    ? ` Fresh USDC -> EURC entries are paused until ${formatTimestamp(state.entryCooldown.until)} after the last EURC -> USDC inventory exit.`
    : '';

  switch (feature.statusKey) {
    case 'marketAnalysis':
      return state?.lastStatus === 'success'
        ? 'Latest market check completed. This step only refreshes context.'
        : 'Runs background market checks. No funds move here.';
    case 'oracle':
      return `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 48)} price refreshes completed. This keeps pricing and opportunity data fresh for later decisions. Later stable/oracle execution can use up to ${maxTradeUsdc.toFixed(2)} USDC per cycle, stop fresh EURC buys above ${eurcCap.toFixed(2)} EURC, and keep ${eurcReserve.toFixed(2)} EURC protected before selling the excess back into USDC on the live swap route whenever the exit quote is strong enough.${oracleCooldownNote}${bypassNote}`;
    case 'defiLoop':
      if (state?.lastStatus === 'dry_run') {
        return `Practice mode is active. ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} checks ran, and no new live trade was required from this card.${bypassNote}`;
      }
      return `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} stable checks ran and ${Number(state?.autoTxToday || 0)} live trades were sent. This card only controls the stable USDC/EURC route.${bypassNote}`;
    case 'lendingAutomation': {
      const healthFactor = Number(state?.lastDecision?.healthFactor);
      const utilizationCap = Number(state?.lastDecision?.utilizationCapPct);
      const triggerSummary = Number.isFinite(healthFactor) || Number.isFinite(utilizationCap)
        ? ` Latest visible thresholds: HF ${formatAutomationMetric(healthFactor, 4)} and utilization cap ${formatAutomationMetric(utilizationCap, 2)}%.`
        : '';
      if (state?.lastStatus === 'dry_run') {
        return `Practice mode is active. ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} lending protection checks ran, and no live protection step was sent from this card.${triggerSummary}${bypassNote}`;
      }
      return `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} lending protection checks ran and ${Number(state?.autoTxToday || 0)} live protection steps were sent. This card can auto-repay, top up collateral, or force LP reduction before the stable lane takes fresh risk.${triggerSummary}${bypassNote}`;
    }
    case 'carryAutomation': {
      const netCarryApyPct = Number(state?.lastDecision?.netCarryApyPct);
      const projectedHealthFactor = Number(state?.lastDecision?.projectedOpenHealthFactor);
      const spreadSummary = Number.isFinite(netCarryApyPct)
        ? ` Latest visible estimated net yield: ${formatAutomationMetric(netCarryApyPct, 2)}%.`
        : '';
      const healthSummary = Number.isFinite(projectedHealthFactor)
        ? ` Projected safety buffer after a new carry leg: ${formatAutomationMetric(projectedHealthFactor, 4)}.`
        : '';
      const carryHoldSummary = state?.lastDecision?.summary
        && ['manual_lp_conflict', 'active', 'debt_idle', 'unwind', 'inactive'].includes(state?.lastDecision?.carryState)
        ? `${state.lastDecision.summary}${spreadSummary}${healthSummary}${bypassNote}`
        : '';
      if (carryHoldSummary) {
        return carryHoldSummary;
      }
      if (state?.lastStatus === 'dry_run') {
        return `Practice mode is active. ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} carry checks ran, and no live carry step was sent from this card. Auto Carry keeps the stable LP lane exclusive while it is enabled.${spreadSummary}${healthSummary}${bypassNote}`;
      }
      return `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} carry checks ran and ${Number(state?.autoTxToday || 0)} live carry steps were sent. Auto Carry can open, deploy, or unwind the stable carry leg while keeping the stable LP lane exclusive.${spreadSummary}${healthSummary}${bypassNote}`;
    }
    case 'cirbtcLp':
      if (state?.lastStatus === 'dry_run') {
        return `Practice mode is active. ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} LP checks ran, and no new live LP change was required from this card.${bypassNote}`;
      }
      return `Today ${Number(state?.todayCount || 0)}/${Number(state?.dailyCap || 10)} cirBTC LP checks ran and ${Number(state?.autoTxToday || 0)} live LP actions were sent. This card only tracks LP adds and removals.${bypassNote}`;
    case 'reputation':
      if (state?.displaySummary) {
        return state.displaySummary;
      }
      return state?.lastStatus === 'db_only'
        ? 'Saving reputation activity locally. On-chain posting is off right now.'
        : 'Updates when tasks, oracle events, or transactions create new reputation activity.';
    default:
      return 'Triggered when smart-mode analysis jobs are queued for this agent.';
  }
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
        : humanizeAutomationAction(blockedBy, 'Oracle quote check'),
      reasonDetail: blockedBy === 'same_chain_exit_unprofitable'
        ? 'A fresh Curve buy stays blocked until the matching live Arc EURC -> USDC quote clears the required round-trip floor.'
        : 'Fresh Curve entries only run when the same-cycle live Arc exit quote still clears the required floor after minimum profit.',
      title: 'Oracle Guard Check',
      detail: 'Fresh Curve entries only run when the same-cycle live Arc exit quote still clears the required floor after minimum profit.',
      quoteAmountLabel: `${formatAutomationMetric(expectedEurcOut, 4)} EURC`,
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
        : 'Oracle quote check',
      reasonDetail: blockedBy
        ? (costFloorActive
          ? 'Protected EURC inventory stays on hold until the live Arc EURC -> USDC quote clears the tracked cost-basis floor.'
          : 'Protected EURC inventory stays on hold until the live Arc EURC -> USDC quote clears the required floor.')
        : (costFloorActive
          ? 'Excess EURC inventory only exits when the live Arc quote is above tracked cost basis plus the minimum profit buffer.'
          : 'Excess EURC inventory only exits when the live Arc quote is above the current required floor.'),
      title: costFloorActive ? 'Oracle Cost Floor Check' : 'Oracle Exit Check',
      detail: costFloorActive
        ? 'Excess EURC inventory only exits when the live Arc quote is above tracked cost basis plus the minimum profit buffer.'
        : 'Excess EURC inventory only exits when the live Arc quote is above the current required floor.',
      quoteAmountLabel: `${formatAutomationMetric(exitQuote.inputEurc, 4)} EURC`,
      entryPriceUsdc: Number(exitQuote.averageEntryPriceUsdc),
      entryPriceTracked: Number(exitQuote.averageEntryPriceUsdc) > 0,
      currentExitQuoteUsdc: Number(exitQuote.expectedUsdcOut),
      requiredFloorUsdc: Number(exitQuote.minimumExpectedUsdcOut),
      exitRail: getExecutionRailLabel(exitQuote.exitExecutionRail),
    };
  }

  return null;
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

function getArbDisplayAmountUsdc(payload) {
  const candidates = [
    payload?.requestedAmountIn,
    payload?.amountIn,
    payload?.signal?.opportunity?.amountUsdc,
    payload?.signalModelAmountUsdc,
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }

  return 0;
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
      const destinationTxHash = target.destinationTxHash || null;
      const sourceTxHash = target.sourceTxHash || target.topUpTxHash || null;

      pushTaskExecutionLink(links, {
        label: `${target.toChain} destination tx`,
        chainName: target.toChain,
        hash: destinationTxHash,
      });

      pushTaskExecutionLink(links, {
        label: `${target.toChain} source tx`,
        chainName: target.fromChain || payload.fromChain || 'Sepolia',
        hash: sourceTxHash,
      });
    });
  }

  pushTaskExecutionLink(links, {
    label: 'Fee settlement tx',
    chainName: payload.economy?.destinationChain || 'Arc Testnet',
    hash: payload.economy?.gatewayMintTxHash,
  });

  if (payload.executionRail === 'arc_native_lending') {
    pushTaskExecutionLink(links, {
      label: payload.action === 'liquidate' ? 'Liquidation tx' : payload.action === 'deleverage' ? 'Recovery tx' : 'Lending tx',
      chainName: 'Arc Testnet',
      hash: payload.txHash,
    });

    if (Array.isArray(payload.stepsExecuted)) {
      payload.stepsExecuted.forEach((step, index) => {
        pushTaskExecutionLink(links, {
          label: `Recovery step ${index + 1}`,
          chainName: 'Arc Testnet',
          hash: step?.txHash,
        });
      });
    }
  }

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

function isAutoCarryQueueFailurePayload(task, payload) {
  return task?.id === 'EXEC_AUTO_CARRY_START'
    && payload?.executionRail === 'carry_automation_trigger'
    && Boolean(payload?.triggerQueueError);
}

function isAutoCarryWaitingPayload(task, payload) {
  if (!AUTO_CARRY_TASK_IDS.has(task?.id)) return false;

  const action = String(payload?.action || '').trim().toLowerCase();
  const finalAutomationStatus = String(payload?.finalAutomationStatus || '').trim().toLowerCase();

  return finalAutomationStatus === 'policy_hold'
    || action === 'hold'
    || (task?.id === 'EXEC_AUTO_CARRY_START'
      && payload?.executionRail === 'carry_automation_trigger'
      && payload?.carryAutomationEnabled === true
      && payload?.triggerQueued === true
      && !payload?.triggerQueueError
      && !payload?.txHash);
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
    case 'EXEC_LENDING_SUPPLY':
      return 'Supply completed';
    case 'EXEC_LENDING_WITHDRAW':
      return 'Withdraw completed';
    case 'EXEC_LENDING_BORROW':
      return 'Borrow completed';
    case 'EXEC_LENDING_REPAY':
      return 'Repay completed';
    case 'EXEC_LENDING_COLLATERAL_TOP_UP':
      return 'Collateral top-up completed';
    case 'EXEC_LENDING_SAFE_EXIT':
      return 'Safe exit completed';
    case 'EXEC_LENDING_DELEVERAGE':
      return 'Recovery completed';
    case 'EXEC_LENDING_LIQUIDATE':
      return 'Liquidation completed';
    case 'EXEC_AUTO_CARRY_START':
      if (isAutoCarryQueueFailurePayload(task, payload)) return 'Needs retry';
      if (isAutoCarryWaitingPayload(task, payload)) return 'Waiting';
      return 'Auto Carry updated';
    case 'EXEC_AUTO_CARRY_STOP':
      if (isAutoCarryWaitingPayload(task, payload)) return 'Waiting';
      return 'Auto Carry updated';
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

  if (isAutoCarryQueueFailurePayload(task, payload)) {
    return {
      label: 'Needs retry',
      buttonLabel: 'Retry',
      panelClasses: 'bg-rose-50/80',
      iconClasses: 'text-rose-600',
      titleClasses: 'text-rose-800',
      detailClasses: 'text-rose-700',
      summary: payload?.summary || getTaskRunErrorMessage('carry_handoff_queue_failed', task?.id),
    };
  }

  if (isAutoCarryWaitingPayload(task, payload)) {
    return {
      label: 'Waiting',
      buttonLabel: 'Waiting',
      panelClasses: 'bg-sky-50/80',
      iconClasses: 'text-sky-600',
      titleClasses: 'text-sky-800',
      detailClasses: 'text-sky-700',
      summary: payload?.summary || 'Auto Carry is enabled, but the live carry lane is waiting for the next review.',
    };
  }

  if (payload?.ok === false) {
    const failureSummary = getTaskRunErrorMessage(
      payload?.errorSummary || payload?.error || payload?.summary || payload?.reason || 'task_execution_failed',
      task?.id,
    );

    return {
      label: 'Failed',
      buttonLabel: 'Failed',
      panelClasses: 'bg-rose-50/80',
      iconClasses: 'text-rose-600',
      titleClasses: 'text-rose-800',
      detailClasses: 'text-rose-700',
      summary: failureSummary,
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

function getTaskResultHistoryLabel(resultMeta) {
  if (resultMeta?.buttonLabel === 'Simulated') return 'Last simulated';
  if (resultMeta?.buttonLabel === 'Skipped') return 'Last skipped';
  if (resultMeta?.buttonLabel === 'Retry') return 'Last failed';
  if (resultMeta?.buttonLabel === 'Waiting') return 'Last waiting';
  return 'Last completed';
}

function isTaskRunActive(run) {
  return ACTIVE_TASK_RUN_STATUSES.has(String(run?.status || '').toLowerCase());
}

function buildTaskRunResult(task, run, agent = null) {
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
      summary: getTaskPayloadSummary(task, payload, agent) || meta.summary,
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

function getTaskPayloadSummary(task, payload, agent = null) {
  if (!payload || typeof payload !== 'object') return '';

  if (payload.ok === false) {
    return getTaskRunErrorMessage(
      payload.errorSummary || payload.error || payload.summary || payload.reason || 'task_execution_failed',
      task?.id,
    );
  }

  const getLegacyArbSkipSummary = () => {
    const rawSummary = String(payload.summary || '').trim();
    if (task?.id !== 'EXEC_ARB') return null;
    if (!/Stable LP manager/i.test(rawSummary)) return null;

    const blockedBy = String(payload?.stablePolicy?.verdict?.blockedBy || '').trim();
    if (blockedBy === 'addSizePositive') {
      return 'No on-chain trade was sent. This task only executes the USDC -> EURC Curve entry leg, and the deployable stable balance available to this task stayed below the minimum actionable entry size.';
    }

    return 'No on-chain trade was sent. This task only executes the USDC -> EURC Curve entry leg, and the current oracle safety policy did not approve opening a fresh entry at the requested size.';
  };

  const getInventoryCapSummary = () => {
    if (task?.id !== 'EXEC_ARB') return null;
    const blockedBy = String(payload?.oracleStrategyPolicy?.verdict?.blockedBy || '').trim();
    if (blockedBy !== 'inventoryCap') return null;

    const currentEurcBalance = Number(
      payload?.oracleInventory?.currentEurcBalance
      ?? payload?.oracleStrategyPolicy?.metrics?.availableEurcBalance,
    );
    const agentInventoryCap = Number(agent?.settings?.oracleMaxEurcInventory || 0);
    const fallbackAgentCap = Number(agent?.settings?.maxTradeUsdc || agent?.maxTradeUsdc || 0);
    const payloadInventoryCap = Number(
      payload?.oracleInventory?.eurcCap
      ?? payload?.oracleStrategyPolicy?.metrics?.maxEurcInventoryEurc,
    );
    const eurcInventoryCap = agentInventoryCap > 0
      ? agentInventoryCap
      : (fallbackAgentCap > 0 ? fallbackAgentCap : payloadInventoryCap);

    if (!(Number.isFinite(currentEurcBalance) && Number.isFinite(eurcInventoryCap) && eurcInventoryCap > 0)) {
      return null;
    }

    return `No on-chain trade was sent. This task only opens a fresh USDC -> EURC Curve entry, and the agent already holds ${formatTaskMetricAmount(currentEurcBalance)} EURC against a ${formatTaskMetricAmount(eurcInventoryCap)} EURC inventory cap. A new entry stays paused until some EURC rotates back into USDC.`;
  };

  if (task?.id === 'DAILY_ARB_SCAN') {
    const arbOpportunity = payload.signal?.opportunity;
    const referenceAmountUsdc = getArbDisplayAmountUsdc(payload);

    if (arbOpportunity?.found && referenceAmountUsdc > 0) {
      const referenceAmountLabel = formatTaskMetricAmount(referenceAmountUsdc);
      const referenceProfitLabel = formatTaskMetricAmount(
        arbOpportunity.expectedProfitUsdc ?? arbOpportunity.netProfitUsdc ?? 0,
      );

      return `Reference only: if you swapped about ${referenceAmountLabel} USDC on the Curve leg, the current spread suggests roughly ${referenceProfitLabel} USDC before bridge, exit and live fees.`;
    }

    if (payload.summary) return payload.summary;

    return 'Simulation did not find a profitable arbitrage setup in the latest scan.';
  }

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

    const inventoryCapSummary = getInventoryCapSummary();
    if (inventoryCapSummary) return inventoryCapSummary;

    const legacyArbSkipSummary = getLegacyArbSkipSummary();
    if (legacyArbSkipSummary) return legacyArbSkipSummary;

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
    const arbDisplayAmountUsdc = getArbDisplayAmountUsdc(payload);
    const hasRequestedAmount = Number(payload.requestedAmountIn || payload.amountIn) > 0;
    const hasExecutionTx = Boolean(
      payload.swapTxHash
      || payload.txHash
      || payload.bridgeTxHash
      || payload.swap?.txHash
      || payload.swap?.hash,
    );

    facts.push(`Signal: ${arbOpportunity.confidence || 'LOW'} confidence · spread ${formatTaskPercent(arbOpportunity.spreadPct || 0)}%`);
    if (arbDisplayAmountUsdc > 0) {
      facts.push(`${hasRequestedAmount ? 'Requested size' : 'Reference swap size'}: ${formatTaskMetricAmount(arbDisplayAmountUsdc)} ${fromToken}`);
    }
    if (hasExecutionTx) {
      facts.push(`Executed route: ${fromToken} -> ${toToken} via Curve stable pool`);
      if (payload.amountOut || payload.swap?.amountOut) {
        facts.push(`Received: ${formatTaskMetricAmount(payload.amountOut || payload.swap?.amountOut)} ${toToken}`);
      }
    } else if (payload.direction) {
      facts.push(`Current signal direction: ${payload.direction === 'buy_eurc' ? 'USDC -> EURC' : 'EURC -> USDC'}`);
    }
    const currentEurcInventory = Number(payload?.oracleInventory?.currentEurcBalance);
    const eurcInventoryCap = Number(payload?.oracleInventory?.eurcCap);
    if (Number.isFinite(currentEurcInventory) && Number.isFinite(eurcInventoryCap) && eurcInventoryCap > 0) {
      facts.push(`Current EURC inventory: ${formatTaskMetricAmount(currentEurcInventory)} / ${formatTaskMetricAmount(eurcInventoryCap)} cap`);
      if (payload?.oracleStrategyPolicy?.verdict?.blockedBy === 'inventoryCap') {
        const capSource = String(payload?.oracleInventory?.capSource || '').trim();
        if (capSource === 'agent_setting') {
          facts.push('Inventory rule source: your agent Oracle EURC inventory setting.');
        } else if (capSource === 'environment_setting') {
          facts.push('Inventory rule source: the shared Oracle environment cap.');
        } else if (capSource === 'trade_size_fallback') {
          facts.push('Inventory rule source: fallback to the Oracle trade-size cap.');
        }
      }
    }
    if (arbOpportunity.found === false) {
      facts.push('Signal outcome: the full-route oracle model is not profitable right now.');
    } else if (!hasExecutionTx && !hasRequestedAmount && arbDisplayAmountUsdc > 0) {
      facts.push(`Reference scenario: swapping about ${formatTaskMetricAmount(arbDisplayAmountUsdc)} ${fromToken} would imply roughly ${formatTaskMetricAmount(arbOpportunity.expectedProfitUsdc || arbOpportunity.netProfitUsdc || 0)} USDC before bridge, exit and live fees.`);
    }
    facts.push('Execution scope: this task only covers the Curve swap leg; bridge and exit legs are not executed here.');
  }

  if (payload.fromChain && payload.toChain && Number(payload.amountUsdc) > 0) {
    facts.push(`Bridge route: ${payload.fromChain} -> ${payload.toChain} · ${formatTaskMetricAmount(payload.amountUsdc)} USDC`);
  }

  if (payload.fromChain === 'Sepolia' && Array.isArray(payload.targets) && payload.targets.length > 0) {
    facts.push(`Fanout route: ${payload.targets.map(target => `${target.toChain} ${target.amountEth} ETH`).join(' · ')}`);
  }

  if (payload.executionRail === 'arc_native_lending') {
    if (payload.action === 'liquidate') {
      facts.push(`Liquidation target: ${payload.borrower || 'borrower required'}`);
      facts.push(`Debt -> collateral: ${payload.debtAsset || 'debt'} -> ${payload.collateralAsset || 'collateral'}`);
      facts.push(`Repay amount: ${formatTaskMetricAmount(payload.amount || 0)} ${payload.debtAsset || 'asset'}`);
      if (payload.borrowerHealthFactor != null) {
        facts.push(`Borrower health factor: ${formatTaskMetricAmount(payload.borrowerHealthFactor)}`);
      }
    } else if (payload.action === 'collateral_top_up') {
      if (payload.currentHealthFactor != null) {
        facts.push(`Current health factor: ${formatTaskMetricAmount(payload.currentHealthFactor)}`);
      }
      if (payload.targetHealthFactor != null) {
        facts.push(`Target health factor: ${formatTaskMetricAmount(payload.targetHealthFactor)}`);
      }
      if (payload.projectedHealthFactor != null) {
        facts.push(`Projected health factor: ${formatTaskMetricAmount(payload.projectedHealthFactor)}`);
      }
      if (payload.collateralUsdPlanned != null) {
        facts.push(`Collateral planned: ${formatTaskMetricAmount(payload.collateralUsdPlanned)} USD equivalent`);
      }
      if (Array.isArray(payload.stepsExecuted) && payload.stepsExecuted.length > 0) {
        facts.push(`Top-up steps executed: ${payload.stepsExecuted.length}`);
      } else if (Array.isArray(payload.plannedSteps) && payload.plannedSteps.length > 0) {
        facts.push(`Top-up steps planned: ${payload.plannedSteps.length}`);
      }
    } else if (payload.action === 'safe_exit') {
      if (payload.currentHealthFactor != null) {
        facts.push(`Current health factor: ${formatTaskMetricAmount(payload.currentHealthFactor)}`);
      }
      if (payload.repayUsdPlanned != null) {
        facts.push(`Repay planned: ${formatTaskMetricAmount(payload.repayUsdPlanned)} USD equivalent`);
      }
      if (payload.withdrawUsdPlanned != null) {
        facts.push(`Withdraw planned: ${formatTaskMetricAmount(payload.withdrawUsdPlanned)} USD equivalent`);
      }
      if (Array.isArray(payload.stepsExecuted) && payload.stepsExecuted.length > 0) {
        facts.push(`Safe-exit steps executed: ${payload.stepsExecuted.length}`);
      } else if (Array.isArray(payload.plannedSteps) && payload.plannedSteps.length > 0) {
        facts.push(`Safe-exit steps planned: ${payload.plannedSteps.length}`);
      }
    } else if (payload.action === 'deleverage') {
      if (payload.currentHealthFactor != null) {
        facts.push(`Current health factor: ${formatTaskMetricAmount(payload.currentHealthFactor)}`);
      }
      if (payload.targetHealthFactor != null) {
        facts.push(`Target health factor: ${formatTaskMetricAmount(payload.targetHealthFactor)}`);
      }
      if (payload.repayUsdPlanned != null) {
        facts.push(`Repay planned: ${formatTaskMetricAmount(payload.repayUsdPlanned)} USD equivalent`);
      }
      if (Array.isArray(payload.stepsExecuted) && payload.stepsExecuted.length > 0) {
        facts.push(`Recovery steps executed: ${payload.stepsExecuted.length}`);
      } else if (Array.isArray(payload.plannedSteps) && payload.plannedSteps.length > 0) {
        facts.push(`Recovery steps planned: ${payload.plannedSteps.length}`);
      }
    } else {
      facts.push(`Lending action: ${String(payload.action || 'action').toUpperCase()} ${payload.asset || 'asset'}`);
      facts.push(`Requested amount: ${formatTaskMetricAmount(payload.amount || 0)} ${payload.asset || 'asset'}`);
      if (payload.healthFactor != null) {
        facts.push(`Health factor after guard: ${formatTaskMetricAmount(payload.healthFactor)}`);
      }
      if (payload.availableBorrowUsd != null) {
        facts.push(`Visible borrow capacity: ${formatTaskMetricAmount(payload.availableBorrowUsd)} USD`);
      }
    }
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
    facts.push('Arc fee destination: shared Arc pool');
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

function ReputationHeroCard({ reputationOverview, trackingBusy, onToggleTracking, agentId }) {
  const [proofOpen, setProofOpen] = useState(false);
  const setupItems = getReputationSetupItems(reputationOverview);
  const onchain = reputationOverview?.onchain || {};
  const modeLabel = reputationOverview?.mode === 'hybrid' ? 'Local + On-Chain' : 'Local Only';
  const trackingEnabled = Boolean(reputationOverview?.reputationEnabled);
  const registryExplorerUrl = onchain.contractAddress
    ? getTaskExplorerAddressUrl('Arc Testnet', onchain.contractAddress)
    : null;

  return (
    <>
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
          {onchain.status === 'live' && agentId && (
            <button
              type="button"
              onClick={() => setProofOpen(true)}
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-800 transition"
            >
              <ShieldCheck size={11} />
              View on-chain proof
            </button>
          )}
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

    {proofOpen && agentId && (
      <ReputationProofModal agentId={agentId} onClose={() => setProofOpen(false)} />
    )}
  </>);
}

// ── Task Card with persistent run status ──────────────────────────────────────
function TaskCard({ task, agent, agentId, tasksEnabled, latestRun, latestResult, onRunQueued, highlighted, recommendationReason, carryContext = null, sharedActiveRun = null }) {
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState('');
  const [expanded, setExpanded] = useState(false);
  const [params, setParams]     = useState(() => getInitialTaskParams(task.id));

  const isPaid      = task.tier === 2;
  const isBlocked   = !tasksEnabled;
  const needsParams = isExecutionTask(task.id);
  const isAutoCarryTask = AUTO_CARRY_TASK_IDS.has(task.id);
  const ownActiveRun = isTaskRunActive(latestRun) ? latestRun : null;
  const blockingPeerRun = isAutoCarryTask
    && sharedActiveRun
    && isTaskRunActive(sharedActiveRun)
    && sharedActiveRun.id !== latestRun?.id
      ? sharedActiveRun
      : null;
  const activeRun   = ownActiveRun;
  const failedRun   = latestRun?.status === 'failed' ? latestRun : null;
  const result      = activeRun
    ? null
    : buildTaskRunResult(task, latestRun, agent) || latestResult || null;
  const resultFacts = result ? getTaskExecutionFactLines(result.payload) : [];
  const resultLinks = result ? getTaskExecutionLinks(result.payload) : [];
  const resultMeta  = result ? getTaskResultStatusMeta(task, result.payload || {}) : null;
  const resultHistoryLabel = result ? getTaskResultHistoryLabel(resultMeta) : '';
  const summaryText = result ? getTaskPayloadSummary(task, result.payload || {}, agent) : '';
  const arbReferenceAmountUsdc = task.id === 'DAILY_ARB_SCAN'
    ? getArbDisplayAmountUsdc(result?.payload || {})
    : 0;
  const taskDescription = task.id === 'EXEC_ARB'
    ? 'Manual signal entry on the Curve leg only. This task does not bridge out or sell back into USDC.'
    : task.description;
  const operationalAlert = getTaskOperationalAlert(task);
  const autoCarryDetails = AUTO_CARRY_TASK_IDS.has(task.id)
    ? getAutoCarryProductDetails(task.id, carryContext)
    : null;
  const autoCarryTone = autoCarryDetails ? getAutoCarryTaskToneClasses(autoCarryDetails.tone) : null;
  const paidButtonLabel = getAutoCarryTaskButtonCopy(task.id, Boolean(result));
  const errorMessage = err || '';
  const failedRunMessage = !activeRun && failedRun
    ? getTaskRunErrorMessage(
      failedRun.result_payload?.errorSummary
        || failedRun.result_payload?.error
        || failedRun.stage_detail
        || failedRun.result_payload?.summary
        || failedRun.result_payload?.reason
        || failedRun.error
        || failedRun.stage_key
        || failedRun.stage_label,
      task.id,
    )
    : '';
  const peerLockTaskLabel = blockingPeerRun?.task_id === 'EXEC_AUTO_CARRY_START'
    ? 'Auto Carry Start'
    : blockingPeerRun?.task_id === 'EXEC_AUTO_CARRY_STOP'
      ? 'Auto Carry Stop'
      : 'another Auto Carry product';

  useEffect(() => {
    setParams(getInitialTaskParams(task.id));
  }, [task.id]);

  useEffect(() => {
    setErr('');
  }, [agentId, task.id, latestRun?.id, latestRun?.status]);

  useEffect(() => {
    if (isAutoCarryTask && (activeRun || blockingPeerRun || failedRun)) {
      setExpanded(true);
    }
  }, [isAutoCarryTask, activeRun, blockingPeerRun, failedRun]);

  async function handleRun() {
    if (!agentId || isBlocked || activeRun || blockingPeerRun) return;
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
      setErr(getTaskRunErrorMessage(e.message, task.id));
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
              {FREE_TASK_SIMULATION_IDS.has(task.id) && (
                <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                  Simulation
                </span>
              )}
              {result && !activeRun && (
                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  {resultHistoryLabel}
                </span>
              )}
              {failedRun && !activeRun && !result && (
                <span className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                  Last failed
                </span>
              )}
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
                <p className="text-xs text-slate-500 mt-0.5 truncate">{taskDescription}</p>
                {operationalAlert && (
                  <p className="text-[11px] text-amber-700 mt-1 truncate">{operationalAlert.title}</p>
                )}
                {result && !activeRun && (
                  <p className="text-[11px] text-emerald-700 mt-1 truncate">
                    {resultHistoryLabel} {formatTimestamp(result.created_at)}
                  </p>
                )}
                {failedRun && !activeRun && !result && (
                  <p className="text-[11px] text-rose-700 mt-1 truncate">
                    Last failed {formatTimestamp(failedRun.updated_at || failedRun.created_at)}
                  </p>
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
          disabled={busy || !agentId || Boolean(activeRun) || Boolean(blockingPeerRun) || isBlocked}
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
              : blockingPeerRun
                ? <><Lock size={11} /> Locked</>
              : needsParams && !expanded
                ? 'Configure'
              : result
                ? isPaid
                  ? <><Coins size={11} /> {paidButtonLabel}</>
                  : <><Play size={11} /> Run Again</>
                : isPaid
                  ? <><Coins size={11} /> {paidButtonLabel}</>
                  : <><Play size={11} /> Run</>}
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-3 border-t border-slate-100 pt-2.5 space-y-2">
          <p className="text-xs text-slate-500">{taskDescription}</p>
          {task.id === 'EXEC_ARB' && (
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
              <p className="font-semibold text-sky-900">This is not a full arbitrage round trip</p>
              <p className="mt-1">The paid task only executes the Curve entry leg when EURC looks cheap on Arc. It does not bridge out, it does not force an immediate sell-back into USDC, and it does not claim realized arbitrage profit by itself. Full round-trip behavior belongs to the autonomous oracle lane when the live exit route is strong enough.</p>
            </div>
          )}
          {FREE_TASK_SIMULATION_IDS.has(task.id) && (
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
              <p>
                This card estimates an edge only{arbReferenceAmountUsdc > 0 ? ` using a reference ${formatTaskMetricAmount(arbReferenceAmountUsdc)} USDC Curve-leg swap.` : '.'}
              </p>
              <p className="mt-1">Live bridge fees, exit pricing and timing can change the outcome before any real execution.</p>
            </div>
          )}
          {operationalAlert && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <p className="font-semibold text-amber-900">{operationalAlert.title}</p>
              <p className="mt-1">{operationalAlert.body}</p>
            </div>
          )}
          {autoCarryDetails && autoCarryTone && (
            <div className={`rounded-lg border px-3 py-3 ${autoCarryTone.card}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className={`text-[11px] font-semibold uppercase tracking-wide ${autoCarryTone.eyebrow}`}>{autoCarryDetails.title}</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">Current lane: {getCarryStateLabel(autoCarryDetails.carryState)}</p>
                  <p className="mt-2 text-xs leading-5 text-slate-700">{autoCarryDetails.explainer}</p>
                  <p className={`mt-1 text-xs leading-5 ${autoCarryTone.body}`}>{autoCarryDetails.body}</p>
                  {autoCarryDetails.note && (
                    <p className={`mt-2 text-xs leading-5 ${autoCarryTone.note}`}>{autoCarryDetails.note}</p>
                  )}
                </div>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${autoCarryTone.badge}`}>
                  {autoCarryDetails.selectedAssetSymbol}
                </span>
              </div>

              <div className="mt-3 grid gap-2 md:grid-cols-2">
                <div className="rounded-lg border border-white/70 bg-white px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">When it will act</p>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-slate-600">
                    {autoCarryDetails.requirements.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-lg border border-white/70 bg-white px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">How the flow works</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-5 text-slate-600">
                    {autoCarryDetails.phases.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ol>
                </div>
              </div>

              <div className={`mt-3 grid gap-2 ${Number.isFinite(autoCarryDetails.availableBorrowUsd) && autoCarryDetails.availableBorrowUsd > 0 ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
                {Number.isFinite(autoCarryDetails.availableBorrowUsd) && autoCarryDetails.availableBorrowUsd > 0 && (
                  <div className="rounded-lg border border-white/70 bg-white px-3 py-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Visible Borrow</p>
                    <p className="mt-1 text-sm font-medium text-slate-700">{formatUsdAmount(autoCarryDetails.availableBorrowUsd)}</p>
                  </div>
                )}
                <div className="rounded-lg border border-white/70 bg-white px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Visible LP</p>
                  <p className="mt-1 text-sm font-medium text-slate-700">{formatTaskMetricAmount(autoCarryDetails.lpBalance)}</p>
                </div>
                <div className="rounded-lg border border-white/70 bg-white px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">LP Value</p>
                  <p className="mt-1 text-sm font-medium text-slate-700">{formatUsdAmount(autoCarryDetails.positionValueUsd)}</p>
                </div>
                <div className="rounded-lg border border-white/70 bg-white px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Projected Safety</p>
                  <p className="mt-1 text-sm font-medium text-slate-700">{formatAutomationMetric(autoCarryDetails.projectedOpenHealthFactor, 4)}</p>
                </div>
              </div>

              {Number.isFinite(autoCarryDetails.netCarryApyPct) && autoCarryDetails.netCarryApyPct !== 0 && (
                <p className="mt-2 text-xs text-slate-600">Latest estimated net carry: {formatAutomationMetric(autoCarryDetails.netCarryApyPct, 2)}% yearly.</p>
              )}
            </div>
          )}
          {failedRunMessage && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              <p className="font-semibold text-rose-900">Last failed run</p>
              <p className="mt-1">{failedRunMessage}</p>
              <p className="mt-1 text-[11px] text-rose-700/80">
                {formatTimestamp(failedRun.updated_at || failedRun.created_at)}
              </p>
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

              {['EXEC_LENDING_SUPPLY', 'EXEC_LENDING_WITHDRAW', 'EXEC_LENDING_BORROW', 'EXEC_LENDING_REPAY'].includes(task.id) && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Asset</span>
                    <select
                      value={params.asset}
                      onChange={e => setParams(current => ({ ...current, asset: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                    >
                      {LENDING_ASSET_OPTIONS.map(token => (
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
                      value={params.amount}
                      onChange={e => setParams(current => ({ ...current, amount: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                      placeholder="1.00"
                    />
                  </label>
                </div>
              )}

              {task.id === 'EXEC_LENDING_LIQUIDATE' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block sm:col-span-2">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Borrower Wallet</span>
                    <input
                      type="text"
                      value={params.borrower}
                      onChange={e => setParams(current => ({ ...current, borrower: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                      placeholder="0x..."
                    />
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Debt Asset</span>
                    <select
                      value={params.debtAsset}
                      onChange={e => setParams(current => ({ ...current, debtAsset: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                    >
                      {LENDING_ASSET_OPTIONS.map(token => (
                        <option key={token} value={token}>{token}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Collateral Asset</span>
                    <select
                      value={params.collateralAsset}
                      onChange={e => setParams(current => ({ ...current, collateralAsset: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-[#66D121]"
                    >
                      {LENDING_ASSET_OPTIONS.map(token => (
                        <option key={token} value={token}>{token}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="block text-[11px] font-medium text-slate-500 mb-1">Repay Amount</span>
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
          {task.id === 'EXEC_LENDING_COLLATERAL_TOP_UP' && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-500">
              This task has no manual amount field. It uses the visible lending surface to build a deterministic collateral supply plan and only runs when the current health buffer needs support.
            </div>
          )}
          {task.id === 'EXEC_LENDING_SAFE_EXIT' && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-500">
              This task has no manual amount field. It only runs when the current wallet can fully repay visible debt before withdrawing the remaining supplied assets.
            </div>
          )}
          {task.id === 'EXEC_LENDING_DELEVERAGE' && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-500">
              This recovery task has no manual amount field. It uses the visible lending surface to build a deterministic repay plan and only runs when the guard says the account needs emergency deleverage.
            </div>
          )}
          {task.id === 'EXEC_SEPOLIA_GAS_FANOUT' && (
            <div className="space-y-1">
              <p className="text-[11px] text-amber-700">
                Start by funding at least 0.06 ETH on Sepolia for this agent wallet. This run then spreads 0.01 ETH each to Base Sepolia, Optimism Sepolia and Arbitrum Sepolia so later bridge actions have destination gas ready.
              </p>
              <p className="text-[11px] text-slate-500">
                This run waits for each destination ETH balance update before the card unlocks. If you leave this screen and return later, the latest backend stage is restored and the button remains disabled until all three destinations finish.
              </p>
              <p className="text-[11px] text-slate-500">
                Arbitrum Sepolia is usually the slowest leg and can take up to 10 minutes to reflect the bridged gas.
              </p>
            </div>
          )}
          {isPaid && (
            <p className="text-xs text-amber-700/80 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
              A small Arc fee is charged for each paid run. The task confirmation and fee confirmation appear below after the run completes.
            </p>
          )}
        </div>
      )}

      {blockingPeerRun && (
        <div className="px-4 pb-3 border-t border-slate-100 pt-2.5 bg-amber-50/70">
          <div className="flex items-start gap-2">
            <Lock size={13} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-amber-800">Locked by {peerLockTaskLabel}</p>
              <p className="text-xs mt-0.5 text-amber-700">Another Auto Carry product is already running. This card stays locked until that run finishes or fails.</p>
              <p className="text-[11px] text-slate-500 mt-1">
                Started {formatTimestamp(blockingPeerRun.created_at)} · Last update {formatTimestamp(blockingPeerRun.updated_at || blockingPeerRun.created_at)}
              </p>
            </div>
          </div>
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
                {resultHistoryLabel} {formatTimestamp(result.created_at)}
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
function ResultRow({ result, agent = null }) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(result.created_at).toLocaleTimeString();
  const factLines = getTaskExecutionFactLines(result.payload);
  const executionLinks = getTaskExecutionLinks(result.payload);
  const summaryText = getTaskPayloadSummary({ id: result.task_id, title: result.title }, result.payload || {}, agent);
  const hasRenderableContent = Boolean(summaryText) || factLines.length > 0 || executionLinks.length > 0;

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-slate-50 transition-colors"
      >
        <CheckCircle size={12} className="text-green-500 shrink-0" />
        <span className="flex-1 text-xs text-slate-700">{result.title || formatTaskIdLabel(result.task_id)}</span>
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
  const [carryLiveSurface, setCarryLiveSurface] = useState(null);
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
      fetchUsdcBalance(agent.walletAddress, 5042002),
      fetchEurcBalance(agent.walletAddress, 5042002),
    ]).then(([usdcBalance, eurcBalance]) => {
      if (!cancelled) {
        setAutomationWalletSnapshot({ usdcBalance, eurcBalance });
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
  const gatewayAutoTopupEnabled = agent?.settings?.gatewayAutoTopupEnabled !== false;
  const gatewayAutoTopupMinUsdc = Math.max(Number(agent?.settings?.gatewayAutoTopupMinUsdc || 1), 1);
  const gatewayAutoTopupTargetUsdc = Math.max(Number(agent?.settings?.gatewayAutoTopupTargetUsdc || 3), gatewayAutoTopupMinUsdc);
  const gatewayAutoTopupBusy = automationSavingKey === 'gatewayAutoTopup' || fullAutonomyBusy;

  function buildFullAutonomyPayload(nextValue) {
    return Object.fromEntries(FULL_AUTONOMY_FEATURE_KEYS.map(key => [key, nextValue]));
  }

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [catRes, circlePaidRes, poolRes, statusRes, carryRes, reputationRes, resultsRes, runsRes] = await Promise.all([
        tasksApi.catalog(),
        tasksApi.circlePaidCatalog().catch(() => ({ items: [], lanes: [], economy: null })),
        tasksApi.poolBalance(),
        agent?.id
          ? agentsApi.status(agent.id).then(data => ({ data })).catch(err => ({ error: err.message }))
          : Promise.resolve(null),
        agent?.id
          ? agentsApi.lending(agent.id).then(data => ({ data })).catch(err => ({ error: err.message }))
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
      if (carryRes?.data) {
        setCarryLiveSurface(carryRes.data);
      } else {
        setCarryLiveSurface(null);
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

  useEffect(() => {
    const latestAutoCarryResult = results.find(result => AUTO_CARRY_TASK_IDS.has(result.task_id));
    const nextEnabled = latestAutoCarryResult?.payload?.carryAutomationEnabled;

    if (typeof nextEnabled !== 'boolean') return;

    setAgent((current) => (current
      ? {
          ...current,
          features: {
            ...(current.features || {}),
            carryAutomationEnabled: nextEnabled,
          },
        }
      : current));
  }, [results, setAgent]);

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

  async function handleGatewayAutoTopupToggle(nextValue) {
    if (!agent?.id) return;

    setAutomationSavingKey('gatewayAutoTopup');
    setAutomationMsg('');

    try {
      await agentsApi.update(agent.id, {
        gatewayAutoTopupEnabled: nextValue,
        gatewayAutoTopupMinUsdc,
        gatewayAutoTopupTargetUsdc,
      });

      setAgent(current => ({
        ...current,
        settings: {
          ...(current?.settings || {}),
          gatewayAutoTopupEnabled: nextValue,
          gatewayAutoTopupMinUsdc,
          gatewayAutoTopupTargetUsdc,
        },
      }));

      setAutomationMsg(nextValue
        ? 'Gateway warm auto-topup enabled.'
        : 'Gateway warm auto-topup disabled.');
      setTimeout(() => setAutomationMsg(''), 3000);
    } catch (e) {
      setAutomationMsg(`Error: ${e.message}`);
    } finally {
      setAutomationSavingKey('');
    }
  }

  const allFreeTasks = catalog.filter(t => t.tier === 1);
  const freeTasks  = FREE_TASK_SURFACE_TASK_IDS
    .map(taskId => allFreeTasks.find(task => task.id === taskId))
    .filter(Boolean);
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
  const activeCarryProductRun = taskRuns.find(run => AUTO_CARRY_TASK_IDS.has(run.task_id) && isTaskRunActive(run)) || null;

  const visibleTaskIds = new Set([
    ...freeTasks.map(task => task.id),
    ...paidTasks.map(task => task.id),
  ]);
  const visibleResults = results.filter(result => visibleTaskIds.has(result.task_id));

  const shownTasks = activeGroup === 'free'
    ? freeTasks
    : activeGroup === 'paid'
      ? paidTasks
      : [];
  const paidCarryAutomationState = deriveCarryAutomationDisplayState(
    agentStatus?.automation?.carryAutomation || null,
    carryLiveSurface,
    agent?.features?.carryAutomationEnabled ?? false,
  );
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
              <p className="text-sm font-semibold text-slate-800">Background Controls</p>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                allAutomationEnabled
                  ? 'border-green-200 bg-green-50 text-green-700'
                  : 'border-slate-200 bg-slate-50 text-slate-500'
              }`}>
                {allAutomationEnabled ? 'All automation features on' : `${automationEnabledCount}/${AUTOMATION_FEATURES.length} enabled`}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Turn the background checks and controls on or off in one action.
            </p>
            <p className="text-xs text-slate-400 mt-1">
              The main Tasks switch stays separate. This control only manages the background controls below.
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
            {allAutomationEnabled ? 'Disable Automation' : 'Enable Automation'}
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
          <p>Oracle Data Feed keeps pricing and opportunity inputs fresh.</p>
          <p>Stable DeFi Loop can move funds automatically on the stable USDC/EURC route.</p>
          <p>Lending Guard can auto-repay, top up collateral, or force LP reduction before the stable lane takes fresh risk.</p>
          <p>cirBTC LP Automation only manages the LP position.</p>
          <p>Direct cirBTC swaps are still shallow, so keep size small.</p>
          <p>Maximum autonomous trade size is capped by your agent setting: <strong>{Number(agent?.settings?.maxTradeUsdc || 0).toFixed(2)} USDC</strong>. The loop uses the smaller of the strategy size and this cap.</p>
          <p>Stable/oracle automation keeps <strong>{Number(agent?.settings?.defiWalletReserveUsdc || 0).toFixed(2)} USDC</strong> protected in the wallet, stops new EURC buys above <strong>{Number(agent?.settings?.oracleMaxEurcInventory || agent?.settings?.maxTradeUsdc || 0).toFixed(2)} EURC</strong>, and keeps at least <strong>{Number((agent?.settings?.oracleMinEurcReserve ?? agent?.settings?.defiWalletReserveUsdc) || 0).toFixed(2)} EURC</strong> before selling any excess back into USDC.</p>
          <p>If the same-cycle round trip quote is profitable enough, the bot can buy EURC on Curve and sell it back into USDC in the same run. Otherwise it keeps the EURC and later exits only the excess above the protected EURC reserve when the live EURC → USDC swap quote is strong enough.</p>
          <p>Automation needs funds in the agent wallet. Current wallet snapshot: <strong>{automationWalletSnapshot?.usdcBalance ?? '—'} USDC</strong>, <strong>{automationWalletSnapshot?.eurcBalance ?? '—'} EURC</strong>.</p>
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl p-4 bg-white">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-slate-800">Keep Gateway ready</p>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                gatewayAutoTopupEnabled
                  ? 'border-green-200 bg-green-50 text-green-700'
                  : 'border-slate-200 bg-slate-50 text-slate-500'
              }`}>
                {gatewayAutoTopupEnabled ? 'On' : 'Off'}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Keeps a small Gateway payment balance ready so automatic work does not have to stop and refill at the last second.
            </p>
            <p className="text-xs text-slate-400 mt-1">
              The next incoming USDC can seed Gateway up to <strong>{gatewayAutoTopupMinUsdc} USDC</strong>. After that, if Gateway available balance falls below <strong>{gatewayAutoTopupMinUsdc} USDC</strong>, the next automation cycle refills it to <strong>{gatewayAutoTopupTargetUsdc} USDC</strong> from the wallet.
            </p>

            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Why it is here</p>
                <p className="mt-1 text-sm text-slate-600">
                  This belongs in Automation because it supports every automatic run, but it does not pick trades or change strategy. It simply keeps a small payment balance ready.
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Why leave it on</p>
                <p className="mt-1 text-sm text-slate-600">
                  Leave this on if you want the agent to feel hands-off. Supported payments can still refill Gateway on demand when this is off, but keeping it on avoids that extra catch-up step for the next automatic run.
                </p>
              </div>
            </div>
          </div>

          <Button
            onClick={() => handleGatewayAutoTopupToggle(!gatewayAutoTopupEnabled)}
            disabled={gatewayAutoTopupBusy}
            variant={gatewayAutoTopupEnabled ? 'outline' : 'primary'}
            className="shrink-0"
          >
            {gatewayAutoTopupBusy ? <Spinner size={11} /> : null}
            {gatewayAutoTopupEnabled ? 'Turn off auto-topup' : 'Keep Gateway ready automatically'}
          </Button>
        </div>
      </div>

      {AUTOMATION_FEATURES.map(feature => {
        const enabled = agent?.features?.[feature.key] ?? false;
        const isSaving = automationSavingKey === feature.key || fullAutonomyBusy;
        const rawAutomationState = agentStatus?.automation?.[feature.statusKey] || null;
        const automationState = feature.statusKey === 'carryAutomation'
          ? deriveCarryAutomationDisplayState(rawAutomationState, carryLiveSurface, enabled)
          : feature.statusKey === 'reputation'
            ? deriveReputationAutomationDisplayState(rawAutomationState, reputationOverview, enabled)
          : rawAutomationState;
        const liveCarry = feature.statusKey === 'carryAutomation' ? carryLiveSurface?.carry || null : null;
        const carryLpBalance = feature.statusKey === 'carryAutomation'
          ? Number(automationState?.lastDecision?.lpBalance ?? liveCarry?.lpBalance ?? 0)
          : 0;
        const carryPositionValueUsd = feature.statusKey === 'carryAutomation'
          ? Number(automationState?.lastDecision?.positionValueUsd ?? liveCarry?.positionValueUsd ?? 0)
          : 0;
        const cirbtcFreshness = feature.statusKey === 'cirbtcLp'
          ? getCirbtcAutomationFreshness(agentStatus?.automation?.defiLoop || null, automationState)
          : null;
        const lastStatus = automationState?.lastStatus || (enabled ? 'idle' : 'disabled');
        const displayLastRunAt = automationState?.lastDecision?.recordedAt || automationState?.lastRunAt || null;
        const automationSummary = feature.statusKey === 'cirbtcLp'
          ? getCirbtcAutomationRuntimeSummary(automationState, cirbtcFreshness)
          : getAutomationSummary(feature, automationState, agent);
        const cirbtcPairSummaries = feature.statusKey === 'cirbtcLp'
          ? (Array.isArray(automationState?.lastDecision?.pairSummaries) && automationState.lastDecision.pairSummaries.length > 0
            ? automationState.lastDecision.pairSummaries
            : (automationState?.lastDecision?.poolKey
              ? [{
                  poolKey: automationState.lastDecision.poolKey,
                  status: automationState.lastDecision.execute ? 'executed' : (automationState.lastDecision.blockedBy ? 'blocked' : 'waiting'),
                  summary: automationState.lastDecision.summary || 'The latest cirBTC review did not save pair-level details yet.',
                }]
              : []))
          : [];
        const stableOracleGuardContext = feature.statusKey === 'defiLoop'
          ? getStableOracleGuardContext(automationState?.lastDecision)
          : null;
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
                  {automationState?.bypassDailyCap && ['oracle', 'defiLoop', 'lendingAutomation', 'carryAutomation', 'cirbtcLp'].includes(feature.statusKey) && (
                    <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                      Daily limit relaxed
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
                    <p className="mt-1 text-sm font-medium text-slate-700">{formatTimestamp(displayLastRunAt)}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 md:col-span-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Runtime Notes</p>
                    <p className="mt-1 text-sm text-slate-600">{automationSummary}</p>
                  </div>
                </div>

                {feature.statusKey === 'oracle' && automationState?.entryCooldown?.active && (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Oracle Entry Cooldown</p>
                    <p className="mt-1">
                      Fresh USDC -&gt; EURC entries are paused until <strong>{formatTimestamp(automationState.entryCooldown.until)}</strong> after the latest EURC -&gt; USDC inventory exit.
                    </p>
                  </div>
                )}

                {feature.statusKey === 'defiLoop' && stableOracleGuardContext && (
                  <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">{stableOracleGuardContext.title}</p>
                        <p className="mt-1 text-sm font-semibold text-slate-900">{stableOracleGuardContext.reasonLabel}</p>
                        <p className="mt-1 text-xs leading-5 text-sky-800">
                          {automationState?.lastDecision?.summary || stableOracleGuardContext.reasonDetail}
                        </p>
                      </div>
                      <p className="text-[11px] leading-5 text-sky-700">
                        {stableOracleGuardContext.quoteAmountLabel || 'Quote size unavailable'} via {stableOracleGuardContext.exitRail || 'swap route'}
                      </p>
                    </div>

                    <div className="mt-3 grid gap-2 md:grid-cols-3">
                      <div className="rounded-lg border border-sky-200 bg-white px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Entry Price</p>
                        <p className="mt-1 text-sm font-medium text-slate-700">
                          {stableOracleGuardContext.entryPriceTracked
                            ? `${formatUsdUnitPrice(stableOracleGuardContext.entryPriceUsdc)} / EURC`
                            : 'Not tracked yet'}
                        </p>
                        {!stableOracleGuardContext.entryPriceTracked && (
                          <p className="mt-1 text-xs text-slate-500">Manual or older EURC inventory is using the standard floor right now.</p>
                        )}
                      </div>
                      <div className="rounded-lg border border-sky-200 bg-white px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Current Exit Quote</p>
                        <p className="mt-1 text-sm font-medium text-slate-700">{formatUsdAmount(stableOracleGuardContext.currentExitQuoteUsdc)}</p>
                      </div>
                      <div className="rounded-lg border border-sky-200 bg-white px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Required Floor</p>
                        <p className="mt-1 text-sm font-medium text-slate-700">{formatUsdAmount(stableOracleGuardContext.requiredFloorUsdc)}</p>
                      </div>
                    </div>
                  </div>
                )}

                {feature.statusKey === 'lendingAutomation' && automationState?.lastDecision && (
                  <div className="mt-3 grid gap-2 md:grid-cols-3">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Health Factor</p>
                      <p className="mt-1 text-sm font-medium text-slate-700">{formatAutomationMetric(automationState.lastDecision.healthFactor, 4)}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Utilization Cap</p>
                      <p className="mt-1 text-sm font-medium text-slate-700">{formatAutomationMetric(automationState.lastDecision.utilizationCapPct, 2)}%</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Next Protected Asset</p>
                      <p className="mt-1 text-sm font-medium text-slate-700">{automationState.lastDecision.actionAssetSymbol || automationState.lastDecision.targetDebtAsset || '—'}</p>
                    </div>
                  </div>
                )}

                {feature.statusKey === 'lendingAutomation' && Array.isArray(automationState?.lastDecision?.breachedAssets) && automationState.lastDecision.breachedAssets.length > 0 && (
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {automationState.lastDecision.breachedAssets.map((asset) => (
                      <div key={asset.symbol} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-slate-800">{asset.symbol}</p>
                          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                            {formatAutomationMetric(asset.reserveUtilizationPct, 2)}%
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">Visible reserve utilization is above the current cap, so lending protection is prioritizing this asset.</p>
                      </div>
                    ))}
                  </div>
                )}

                {feature.statusKey === 'carryAutomation' && automationState?.lastDecision && (
                  <div className="mt-3 space-y-3">
                    <div className="grid gap-2 md:grid-cols-4">
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Carry Mode</p>
                        <p className="mt-1 text-sm font-medium text-slate-700">{getCarryStateLabel(automationState.lastDecision.carryState)}</p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Estimated Net Yield</p>
                        <p className="mt-1 text-sm font-medium text-slate-700">{formatAutomationMetric(automationState.lastDecision.netCarryApyPct, 2)}%</p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Projected Safety Buffer</p>
                        <p className="mt-1 text-sm font-medium text-slate-700">{formatAutomationMetric(automationState.lastDecision.projectedOpenHealthFactor, 4)}</p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Estimated Yearly Carry</p>
                        <p className="mt-1 text-sm font-medium text-slate-700">{formatUsdAmount(automationState.lastDecision.estimatedNetUsdPerYear)}</p>
                      </div>
                    </div>

                    <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-3">
                      <p className="text-xs font-semibold text-sky-800">Auto Carry mode</p>
                      <p className="mt-1 text-xs leading-5 text-sky-900">
                        While Auto Carry is enabled, it becomes the only manager of this stable LP route so other growth actions do not compete for the same balance.
                      </p>
                    </div>

                    {automationState.lastDecision.carryState === 'manual_lp_conflict' && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
                        <p className="text-xs font-semibold text-amber-800">Manual LP is blocking Auto Carry</p>
                        <p className="mt-1 text-xs leading-5 text-amber-900">
                          This lane is intentionally waiting because the current stable LP was opened outside Auto Carry. Use Paid &gt; Auto Carry Products &gt; Auto Carry Start to convert that LP into wallet balances first, then hand the route back to the autonomous carry lane without entering an amount.
                        </p>
                        {(carryLpBalance > 0 || carryPositionValueUsd > 0) && (
                          <p className="mt-2 text-xs leading-5 text-amber-800">
                            Current manual LP: {formatTaskMetricAmount(carryLpBalance)} LP about {formatUsdAmount(carryPositionValueUsd)}.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {feature.statusKey === 'cirbtcLp' && cirbtcPairSummaries.length > 0 && (
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {cirbtcPairSummaries.map((pairSummary) => (
                      <div key={pairSummary.poolKey} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-slate-800">{pairSummary.poolKey}</p>
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getCirbtcPairStatusClasses(pairSummary.status)}`}>
                            {getCirbtcPairStatusLabel(pairSummary.status)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">{pairSummary.summary}</p>
                      </div>
                    ))}
                  </div>
                )}

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
                agent={agent}
                agentId={agent?.id}
                tasksEnabled={tasksEnabled}
                carryContext={paidCarryAutomationState}
                sharedActiveRun={activeCarryProductRun}
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
                agent={agent}
                agentId={agent?.id}
                tasksEnabled={tasksEnabled}
                carryContext={paidCarryAutomationState}
                sharedActiveRun={activeCarryProductRun}
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
          agent={agent}
          agentId={agent?.id}
          tasksEnabled={tasksEnabled}
          carryContext={paidCarryAutomationState}
          sharedActiveRun={activeCarryProductRun}
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
        agentId={agent?.id}
      />

      <Card>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3">
            <Zap size={20} className="text-[#66D121] shrink-0 mt-1" />
            <div>
              <h2 className="text-xl font-bold text-slate-900">Agent Tasks</h2>
              <p className="text-sm text-slate-500">Run free checks, paid actions, Circle Paid cards and automation controls from one screen.</p>
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
                <strong>Tasks are disabled.</strong> Enable them to run free and paid actions with your agent.
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
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-500 flex items-center gap-2">
            <Clock size={12} className="shrink-0" />
            Free runs: up to 5 total per day for this agent. This focused set keeps the live Arc checks, wallet recap and simulation cards in one place. Oracle details and payment help live in the Oracle tab.
          </div>

          <div className="rounded-xl border border-green-200 bg-green-50/70 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Zap size={14} className="text-green-600" />
                  <p className="text-sm font-semibold text-slate-800">Funding Setup</p>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  For a new wallet, get Sepolia ETH first so bridge gas can be fanned out later. Use the Sepolia faucet for gas, then Circle&apos;s faucet when you need test USDC for paid runs on Arc.
                </p>
                <div className="mt-3 space-y-1 text-[11px] text-slate-600">
                  <p>1. Fund at least 0.06 ETH on Sepolia from a faucet or another wallet.</p>
                  <p>2. Open Paid -&gt; Bridge Setup and run Sepolia Gas Fanout before cross-chain bridge tasks.</p>
                  <p>3. Use the Circle faucet below when you need test USDC in this same agent wallet.</p>
                </div>
                <div className="mt-3 inline-flex flex-wrap items-center gap-2">
                  <a
                    href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center rounded-lg border border-green-200 bg-white px-3 py-1.5 text-xs font-semibold text-green-700 hover:border-green-300 hover:text-green-800"
                  >
                    Open Sepolia ETH Faucet
                  </a>
                  <a
                    href="https://faucet.circle.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center rounded-lg border border-green-200 bg-white px-3 py-1.5 text-xs font-semibold text-green-700 hover:border-green-300 hover:text-green-800"
                  >
                    Open Circle Faucet
                  </a>
                </div>
              </div>

              {(agent?.walletAddress || agent?.wallet_address) && (
                <div className="w-full lg:max-w-sm">
                  <AddressBox
                    address={agent.walletAddress || agent.wallet_address}
                    label="Agent wallet for faucet and top-ups"
                    compact
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {activeGroup === 'automation' && (
        <div className="rounded-xl border border-blue-100 bg-blue-50/70 px-3.5 py-2.5 text-xs text-blue-700 flex items-center gap-2">
          <Brain size={12} className="shrink-0" />
          Automation controls only change automatic behavior. Use Free or Paid when you want to start a task yourself.
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
          Use Paid when you already know what you want this agent to do on-chain.
        </div>
      )}

      {error && <Alert type="error">{error}</Alert>}

      {taskSection}

      {/* Recent results */}
      {visibleResults.length > 0 && (
        <Card>
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Recent Executions</h3>
          <div className="space-y-1.5">
            {visibleResults.slice(0, 10).map(r => (
              <ResultRow key={r.id} result={r} agent={agent} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

