import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { agents as agentsApi, oracle as oracleApi, defi as defiApi } from '../lib/api.js';
import { Alert, Card, Spinner } from './ui/index.jsx';
import {
  Activity,
  ArrowRightLeft,
  BarChart3,
  Coins,
  Droplets,
  Layers3,
  MinusCircle,
  PlusCircle,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';

const DEFI_POOL_CONFIG = [
  {
    key: 'USDC-EURC',
    venue: 'curve',
    poolType: 'curve',
    title: 'Curve USDC / EURC',
    description: 'Stable liquidity pool on Arc Testnet.',
    adapterLabel: 'Curve stable pool',
  },
  {
    key: 'USDC-CIRBTC',
    venue: 'uniswap_v2_like',
    poolType: 'direct_pair',
    stableToken: 'USDC',
    title: 'cirBTC / USDC Direct Pair',
    description: 'Live constant-product LP on Arc Testnet. cirBTC swaps stay on the main Swap tab.',
    adapterLabel: 'Direct liquidity pool',
  },
  {
    key: 'EURC-CIRBTC',
    venue: 'uniswap_v2_like',
    poolType: 'direct_pair',
    stableToken: 'EURC',
    title: 'cirBTC / EURC Direct Pair',
    description: 'Live constant-product LP on Arc Testnet. cirBTC swaps stay on the main Swap tab.',
    adapterLabel: 'Direct liquidity pool',
  },
];

const CURVE_MANUAL_ACTIONS = [
  {
    id: 'swap',
    label: 'Swap',
    title: 'Swap',
    description: 'Trade between USDC and EURC inside the verified stable Curve pool.',
    ctaLabel: 'Swap',
    icon: ArrowRightLeft,
  },
  {
    id: 'add_single',
    label: 'Add Single',
    title: 'Add single-sided liquidity',
    description: 'Deposit only one stablecoin and mint LP from the Curve pool.',
    ctaLabel: 'Add single-sided liquidity',
    icon: PlusCircle,
  },
  {
    id: 'add_dual',
    label: 'Add Dual',
    title: 'Add dual-sided liquidity',
    description: 'Deposit both USDC and EURC directly into the Curve pool to mint LP.',
    ctaLabel: 'Add dual-sided liquidity',
    icon: PlusCircle,
  },
  {
    id: 'remove_single',
    label: 'Remove Single',
    title: 'Remove to one token',
    description: 'Burn Curve LP and withdraw a single chosen stablecoin.',
    ctaLabel: 'Remove single-sided liquidity',
    icon: MinusCircle,
  },
  {
    id: 'remove_dual',
    label: 'Remove Dual',
    title: 'Remove to both tokens',
    description: 'Burn Curve LP and withdraw both pool assets proportionally.',
    ctaLabel: 'Remove dual-sided liquidity',
    icon: MinusCircle,
  },
];

const DIRECT_PAIR_MANUAL_ACTIONS = [
  {
    id: 'add_single',
    label: 'Add Single',
    title: 'Add single-sided liquidity',
    description: 'Start from one token and split it into the LP position automatically.',
    ctaLabel: 'Add single-sided liquidity',
    icon: PlusCircle,
  },
  {
    id: 'add_dual',
    label: 'Add Dual',
    title: 'Add dual-sided liquidity',
    description: 'Provide both the stable token and cirBTC directly into the pair.',
    ctaLabel: 'Add dual-sided liquidity',
    icon: PlusCircle,
  },
  {
    id: 'remove_single',
    label: 'Exit Single',
    title: 'Exit to one token',
    description: 'Burn LP and consolidate the whole exit into one target token.',
    ctaLabel: 'Exit to one token',
    icon: MinusCircle,
  },
  {
    id: 'remove_dual',
    label: 'Exit Dual',
    title: 'Exit to both tokens',
    description: 'Burn LP and receive both underlying tokens back in the wallet.',
    ctaLabel: 'Exit to both tokens',
    icon: MinusCircle,
  },
];

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

function formatPercentAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric === 0) return '0%';
  if (Math.abs(numeric) < 0.01) return '<0.01%';
  return `${numeric.toFixed(2).replace(/\.0+$|(?<=\.\d*?)0+$/g, '')}%`;
}

function formatCompactAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: numeric >= 1000 ? 1 : 2,
  }).format(numeric);
}

function getPoolSourceLabel(source) {
  if (source === 'verified_default') return 'Verified default';
  if (source === 'env') return 'Environment mapped';
  if (source === 'arc_rpc') return 'Arc RPC';
  return source || 'Unknown source';
}

function formatStatusPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return `${numeric.toFixed(numeric >= 1 ? 2 : 3).replace(/\.0+$|(?<=\.\d*?)0+$/g, '')}%`;
}

function getRiskStatus(position) {
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
      ...getRiskStatus(position),
    },
  ];
}

function getStatusBadgeClasses(tone) {
  if (tone === 'green') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (tone === 'amber') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (tone === 'red') return 'border-rose-200 bg-rose-50 text-rose-700';
  return 'border-slate-200 bg-slate-100 text-slate-700';
}

function getPoolManualActions(poolConfig) {
  return poolConfig.poolType === 'curve'
    ? CURVE_MANUAL_ACTIONS
    : DIRECT_PAIR_MANUAL_ACTIONS;
}

function getDefaultManualParams(poolConfig, actionId) {
  if (poolConfig.poolType === 'curve') {
    switch (actionId) {
      case 'swap':
        return { fromToken: 'USDC', toToken: 'EURC', amountIn: '' };
      case 'add_single':
        return { tokenIn: 'USDC', amountIn: '' };
      case 'add_dual':
        return { amountUsdc: '', amountEurc: '' };
      case 'remove_single':
        return { tokenOut: 'USDC', lpAmount: '' };
      case 'remove_dual':
        return { lpAmount: '' };
      default:
        return {};
    }
  }

  const stableToken = poolConfig.stableToken || 'USDC';
  switch (actionId) {
    case 'swap':
      return { fromToken: stableToken, toToken: 'CIRBTC', amountIn: '' };
    case 'add_single':
      return { inputToken: stableToken, amountIn: '' };
    case 'add_dual':
      return { amountStable: '', amountCirbtc: '' };
    case 'remove_single':
      return { targetToken: stableToken, withdrawPct: '100' };
    case 'remove_dual':
      return { withdrawPct: '100' };
    default:
      return {};
  }
}

function getManualActionError(poolConfig, actionId, params) {
  if (poolConfig.poolType === 'curve') {
    switch (actionId) {
      case 'swap':
        if (!(Number(params.amountIn) > 0)) return 'Enter an amount for the Curve swap.';
        if (!params.fromToken || !params.toToken || params.fromToken === params.toToken) return 'Choose a valid Curve swap route.';
        return '';
      case 'add_single':
        if (!params.tokenIn) return 'Choose the token used for the liquidity add.';
        if (!(Number(params.amountIn) > 0)) return 'Enter an amount for the single-sided add.';
        return '';
      case 'add_dual':
        if (!(Number(params.amountUsdc) > 0) || !(Number(params.amountEurc) > 0)) return 'Enter both USDC and EURC amounts for the dual add.';
        return '';
      case 'remove_single':
        if (!params.tokenOut) return 'Choose the token that should be withdrawn.';
        if (!(Number(params.lpAmount) > 0)) return 'Enter a Curve LP amount to remove.';
        return '';
      case 'remove_dual':
        if (!(Number(params.lpAmount) > 0)) return 'Enter a Curve LP amount to remove.';
        return '';
      default:
        return '';
    }
  }

  const stableToken = poolConfig.stableToken || 'USDC';
  switch (actionId) {
    case 'swap':
      if (!(Number(params.amountIn) > 0)) return 'Enter an amount for the pair swap.';
      if (!params.fromToken || !params.toToken || params.fromToken === params.toToken) return 'Choose a valid direct-pair swap route.';
      return '';
    case 'add_single':
      if (!params.inputToken) return 'Choose the token used for the single-sided add.';
      if (!(Number(params.amountIn) > 0)) return 'Enter an amount for the single-sided add.';
      return '';
    case 'add_dual':
      if (!(Number(params.amountStable) > 0) || !(Number(params.amountCirbtc) > 0)) return `Enter both ${stableToken} and cirBTC amounts for the dual add.`;
      return '';
    case 'remove_single':
      if (!params.targetToken) return 'Choose the token you want to keep after the exit.';
      if (!(Number(params.withdrawPct) > 0) || Number(params.withdrawPct) > 100) return 'Enter an exit percentage between 0 and 100.';
      return '';
    case 'remove_dual':
      if (!(Number(params.withdrawPct) > 0) || Number(params.withdrawPct) > 100) return 'Enter an exit percentage between 0 and 100.';
      return '';
    default:
      return '';
  }
}

function buildManualActionRequest(poolConfig, actionId, params) {
  if (poolConfig.poolType === 'curve') {
    if (actionId === 'swap') {
      return {
        poolKey: poolConfig.key,
        venue: poolConfig.venue,
        action: 'swap',
        params: {
          fromToken: params.fromToken,
          toToken: params.toToken,
          amountIn: Number(params.amountIn),
        },
      };
    }

    if (actionId === 'add_single') {
      return {
        poolKey: poolConfig.key,
        venue: poolConfig.venue,
        action: 'add_single',
        params: {
          tokenIn: params.tokenIn,
          amountIn: Number(params.amountIn),
        },
      };
    }

    if (actionId === 'add_dual') {
      return {
        poolKey: poolConfig.key,
        venue: poolConfig.venue,
        action: 'add_dual',
        params: {
          amountUsdc: Number(params.amountUsdc),
          amountEurc: Number(params.amountEurc),
        },
      };
    }

    if (actionId === 'remove_single') {
      return {
        poolKey: poolConfig.key,
        venue: poolConfig.venue,
        action: 'remove_single',
        params: {
          tokenOut: params.tokenOut,
          lpAmount: Number(params.lpAmount),
        },
      };
    }

    return {
      poolKey: poolConfig.key,
      venue: poolConfig.venue,
      action: 'remove_dual',
      params: {
        lpAmount: Number(params.lpAmount),
      },
    };
  }

  if (actionId === 'swap') {
    return {
      poolKey: poolConfig.key,
      venue: poolConfig.venue,
      action: 'swap',
      params: {
        fromToken: params.fromToken,
        toToken: params.toToken,
        amountIn: Number(params.amountIn),
      },
    };
  }

  if (actionId === 'add_single') {
    return {
      poolKey: poolConfig.key,
      venue: poolConfig.venue,
      action: 'add_single',
      params: {
        inputToken: params.inputToken,
        amountIn: Number(params.amountIn),
      },
    };
  }

  if (actionId === 'add_dual') {
    return {
      poolKey: poolConfig.key,
      venue: poolConfig.venue,
      action: 'add_dual',
      params: {
        amountStable: Number(params.amountStable),
        amountCirbtc: Number(params.amountCirbtc),
      },
    };
  }

  if (actionId === 'remove_single') {
    return {
      poolKey: poolConfig.key,
      venue: poolConfig.venue,
      action: 'remove_single',
      params: {
        targetToken: params.targetToken,
        withdrawPct: Number(params.withdrawPct),
      },
    };
  }

  return {
    poolKey: poolConfig.key,
    venue: poolConfig.venue,
    action: 'remove_dual',
    params: {
      withdrawPct: Number(params.withdrawPct),
    },
  };
}

function ManualActionFields({ poolConfig, actionId, params, setParams }) {
  const stableToken = poolConfig.stableToken || 'USDC';

  if (actionId === 'swap') {
    const swapOptions = poolConfig.poolType === 'curve'
      ? ['USDC', 'EURC']
      : [stableToken, 'CIRBTC'];

    return (
      <div className="grid gap-2 sm:grid-cols-3">
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">From</span>
          <select
            value={params.fromToken}
            onChange={(event) => setParams(current => ({ ...current, fromToken: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          >
            {swapOptions.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">To</span>
          <select
            value={params.toToken}
            onChange={(event) => setParams(current => ({ ...current, toToken: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          >
            {swapOptions.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Amount</span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={params.amountIn}
            onChange={(event) => setParams(current => ({ ...current, amountIn: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          />
        </label>
      </div>
    );
  }

  if (poolConfig.poolType === 'curve' && actionId === 'add_single') {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Token In</span>
          <select
            value={params.tokenIn}
            onChange={(event) => setParams(current => ({ ...current, tokenIn: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          >
            <option value="USDC">USDC</option>
            <option value="EURC">EURC</option>
          </select>
        </label>
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Amount</span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={params.amountIn}
            onChange={(event) => setParams(current => ({ ...current, amountIn: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          />
        </label>
      </div>
    );
  }

  if (poolConfig.poolType === 'curve' && actionId === 'add_dual') {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">USDC Amount</span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={params.amountUsdc}
            onChange={(event) => setParams(current => ({ ...current, amountUsdc: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          />
        </label>
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">EURC Amount</span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={params.amountEurc}
            onChange={(event) => setParams(current => ({ ...current, amountEurc: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          />
        </label>
      </div>
    );
  }

  if (poolConfig.poolType === 'curve' && actionId === 'remove_single') {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Withdraw Token</span>
          <select
            value={params.tokenOut}
            onChange={(event) => setParams(current => ({ ...current, tokenOut: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          >
            <option value="USDC">USDC</option>
            <option value="EURC">EURC</option>
          </select>
        </label>
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">LP Amount</span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={params.lpAmount}
            onChange={(event) => setParams(current => ({ ...current, lpAmount: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          />
        </label>
      </div>
    );
  }

  if (poolConfig.poolType === 'curve' && actionId === 'remove_dual') {
    return (
      <label>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">LP Amount</span>
        <input
          type="number"
          min="0"
          step="0.0001"
          value={params.lpAmount}
          onChange={(event) => setParams(current => ({ ...current, lpAmount: event.target.value }))}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
        />
      </label>
    );
  }

  if (actionId === 'add_single') {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Input Token</span>
          <select
            value={params.inputToken}
            onChange={(event) => setParams(current => ({ ...current, inputToken: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          >
            <option value={stableToken}>{stableToken}</option>
            <option value="CIRBTC">CIRBTC</option>
          </select>
        </label>
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Amount</span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={params.amountIn}
            onChange={(event) => setParams(current => ({ ...current, amountIn: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          />
        </label>
      </div>
    );
  }

  if (actionId === 'add_dual') {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{stableToken} Amount</span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={params.amountStable}
            onChange={(event) => setParams(current => ({ ...current, amountStable: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          />
        </label>
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">cirBTC Amount</span>
          <input
            type="number"
            min="0"
            step="0.00000001"
            value={params.amountCirbtc}
            onChange={(event) => setParams(current => ({ ...current, amountCirbtc: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          />
        </label>
      </div>
    );
  }

  if (actionId === 'remove_single') {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Keep Token</span>
          <select
            value={params.targetToken}
            onChange={(event) => setParams(current => ({ ...current, targetToken: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          >
            <option value={stableToken}>{stableToken}</option>
            <option value="CIRBTC">CIRBTC</option>
          </select>
        </label>
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Exit %</span>
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={params.withdrawPct}
            onChange={(event) => setParams(current => ({ ...current, withdrawPct: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          />
        </label>
      </div>
    );
  }

  return (
    <label>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Exit %</span>
      <input
        type="number"
        min="0"
        max="100"
        step="1"
        value={params.withdrawPct}
        onChange={(event) => setParams(current => ({ ...current, withdrawPct: event.target.value }))}
        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
      />
    </label>
  );
}

function PoolManualControls({ poolConfig, agentId, onRunQueued }) {
  const actions = useMemo(() => getPoolManualActions(poolConfig), [poolConfig]);
  const [activeActionId, setActiveActionId] = useState(() => actions[0]?.id || '');
  const activeAction = actions.find(action => action.id === activeActionId) || actions[0] || null;
  const ActionIcon = activeAction?.icon || PlusCircle;
  const [params, setParams] = useState(() => getDefaultManualParams(poolConfig, activeAction?.id));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!actions.some(action => action.id === activeActionId)) {
      setActiveActionId(actions[0]?.id || '');
    }
  }, [actions, activeActionId]);

  useEffect(() => {
    setParams(getDefaultManualParams(poolConfig, activeAction?.id));
    setMessage('');
    setError('');
  }, [poolConfig, activeAction?.id]);

  async function handleSubmit() {
    if (!agentId || !activeAction) return;

    const paramError = getManualActionError(poolConfig, activeAction.id, params);
    if (paramError) {
      setError(paramError);
      return;
    }

    setBusy(true);
    setError('');
    setMessage('');

    try {
      const response = await defiApi.manualExecute(agentId, buildManualActionRequest(poolConfig, activeAction.id, params));
      const feeLabel = Number(response?.feeUsdc) > 0
        ? `${Number(response.feeUsdc).toFixed(2)} USDC fee applied.`
        : 'Fee applied on submit.';

      if (response?.run) {
        setMessage(`Queued. ${feeLabel}`);
        onRunQueued?.(response.run);
        return;
      }

      setMessage('Submitted.');
    } catch (runError) {
      setError(runError.message || 'Failed to run the manual pool action.');
    } finally {
      setBusy(false);
    }
  }

  if (!activeAction) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-500">
        No actions are available for this pool yet.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      {poolConfig.poolType === 'direct_pair' && (
        <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          Use the main Swap tab for cirBTC trades. This card is only for adding or removing LP on the direct pair.
        </div>
      )}

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => {
            const TabIcon = action.icon || PlusCircle;
            const isActive = action.id === activeAction.id;
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => setActiveActionId(action.id)}
                className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${
                  isActive
                    ? 'border-[#66D121]/40 bg-arc-greenBg text-arc-green shadow-sm'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-800'
                }`}
              >
                <TabIcon size={14} /> {action.label}
              </button>
            );
          })}
        </div>
        <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
          Arc fee on submit
        </span>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ActionIcon size={16} className="text-slate-400" />
              <p className="text-base font-semibold text-slate-900">{activeAction.title}</p>
            </div>
            <p className="mt-1 text-sm text-slate-500">{activeAction.description}</p>
          </div>
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">
            Manual action
          </span>
        </div>

        <div className="mt-4 space-y-2">
          <ManualActionFields poolConfig={poolConfig} actionId={activeAction.id} params={params} setParams={setParams} />
        </div>

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        {message && <p className="mt-3 text-xs text-green-600">{message}</p>}

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">
            {poolConfig.poolType === 'direct_pair'
              ? 'Every click here changes the LP position only. cirBTC trades stay on the main Swap tab.'
              : 'Every click here sends a direct pool transaction from your agent wallet.'}
          </p>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || !agentId}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
              busy || !agentId
                ? 'cursor-not-allowed bg-slate-200 text-slate-400'
                : 'bg-amber-500 text-white hover:bg-amber-600'
            }`}
          >
            {busy ? <Spinner size={13} /> : <ActionIcon size={15} />}
            {busy ? 'Submitting...' : activeAction.ctaLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function PoolGlobalMetrics({ snapshot }) {
  if (!snapshot?.state) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-500">
        Global pool metrics are unavailable right now.
      </div>
    );
  }

  const pool = snapshot.pool || {};
  const state = snapshot.state || {};

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Global Pool Snapshot</p>
          <p className="mt-1 text-xs text-slate-500">{pool.baseToken || 'TOKEN0'} / {pool.quoteToken || 'TOKEN1'} · {getPoolSourceLabel(pool.source)}</p>
        </div>
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
          {state.liquidityState || pool.liquidityState || 'unknown'}
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Implied Rate</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatPositionAmount(state.impliedRate)}</p>
          <p className="mt-1 text-[11px] text-slate-500">{pool.quoteToken || 'TOKEN1'} per {pool.baseToken || 'TOKEN0'}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Pool Fee</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatPercentAmount(state.fee)}</p>
          <p className="mt-1 text-[11px] text-slate-500">Active execution tier</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">10k Price Impact</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatPercentAmount(state.priceImpact?.swap10k)}</p>
          <p className="mt-1 text-[11px] text-slate-500">Depth proxy</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Reserves</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatCompactAmount((state.reserves?.token0 ?? 0) + (state.reserves?.token1 ?? 0))}</p>
          <p className="mt-1 text-[11px] text-slate-500">Combined visible liquidity</p>
        </div>
      </div>
    </div>
  );
}

function PoolPositionSnapshot({ position }) {
  if (!position) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-500">
        No live LP position is currently detected for this agent on this pool.
      </div>
    );
  }

  const statusCards = getPositionStatusCards(position);

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Your Current Position</p>
          <p className="mt-1 text-xs text-slate-500">{position.lpToken?.symbol || 'LP position'} · {position.chain || 'Arc Testnet'}</p>
        </div>
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
          {formatPercentAmount(position.sharePct)} share
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">LP Balance</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatLpAmount(position.lpToken?.balance)}</p>
          <p className="mt-1 text-[11px] text-slate-500">{position.lpToken?.symbol}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Position Value</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(position.valuation?.totalUsd)}</p>
          <p className="mt-1 text-[11px] text-slate-500">Approximate USD spot valuation</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Est. Fee APR / APY</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatPercentAmount(position.yieldMetrics?.aprPct)} / {formatPercentAmount(position.yieldMetrics?.apyPct)}</p>
          <p className="mt-1 text-[11px] text-slate-500">Trading fees only, not claimable rewards</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Yield Run-Rate</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(position.yieldMetrics?.dailyUsd)}</p>
          <p className="mt-1 text-[11px] text-slate-500">Weekly {formatUsdAmount(position.yieldMetrics?.weeklyUsd)}</p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {statusCards.map((card) => (
          <div key={`${position.poolKey}:${card.title}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
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

      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Underlying Exposure</p>
        <div className="mt-2 space-y-2">
          {(position.underlying || []).map(asset => (
            <div key={`${position.poolKey}:${asset.symbol}`} className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-800">{asset.symbol}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">{formatUsdAmount(asset.usdValue)} · {formatPercentAmount(asset.exposurePct)} exposure</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold text-slate-900">{formatPositionAmount(asset.amount)}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">Spot {formatUsdAmount(asset.usdPrice)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LendingPlaceholder() {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <ShieldCheck size={18} className="text-slate-400 shrink-0 mt-1" />
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Lending</h3>
            <p className="mt-1 text-sm text-slate-500">Manual lending is not live yet. This page will open with simple borrow and repay controls first.</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Status</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">Coming next</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">Lending is planned, but it is not available for live use yet.</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Assets first</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">USDC and EURC</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">The first lending version will focus on the two stable assets shown across the rest of DeFi.</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Planned actions</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">Supply, withdraw, borrow, repay</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">The goal is a simple manual lending flow before any automation is added.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}

export default function DeFiTab() {
  const { agent } = useAgent();
  const [activeSection, setActiveSection] = useState('liquidity');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [poolSnapshots, setPoolSnapshots] = useState({});
  const [positionSnapshot, setPositionSnapshot] = useState({ positions: [], warnings: [] });

  const load = useCallback(async () => {
    if (!agent?.id) return;

    setLoading(true);
    setError('');

    try {
      const [positionsRes, ...snapshotResults] = await Promise.all([
        agentsApi.positions(agent.id).catch(() => ({ positions: [], warnings: [] })),
        ...DEFI_POOL_CONFIG.map(pool => (
          oracleApi.poolState(pool.key, pool.venue)
            .then(data => ({ key: pool.key, data }))
            .catch(poolError => ({ key: pool.key, error: poolError.message || 'Pool state is unavailable right now.' }))
        )),
      ]);

      setPositionSnapshot({
        positions: positionsRes?.positions || [],
        warnings: positionsRes?.warnings || [],
      });
      setPoolSnapshots(Object.fromEntries(snapshotResults.map(result => [result.key, result])));
    } catch (loadError) {
      setError(loadError.message || 'Failed to load the DeFi surface.');
    } finally {
      setLoading(false);
    }
  }, [agent?.id]);

  useEffect(() => {
    load();
  }, [load]);
  const positionsByPool = useMemo(() => new Map((positionSnapshot.positions || []).map(position => [position.poolKey, position])), [positionSnapshot.positions]);

  if (!agent) {
    return (
      <Card>
        <p className="py-6 text-center text-sm text-slate-500">Connect your agent first.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3">
            <Droplets size={20} className="text-[#66D121] shrink-0 mt-1" />
            <div>
              <h2 className="text-xl font-bold text-slate-900">DeFi</h2>
              <p className="text-sm text-slate-500">Check pool health, add liquidity, remove liquidity, and review your current LP position from one place.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:opacity-60"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2">
              <Layers3 size={14} className="text-slate-400" />
              <p className="text-sm font-semibold text-slate-800">How to use it</p>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">Review the pool, choose an action, and submit from your agent wallet when you are ready.</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2">
              <Wallet size={14} className="text-slate-400" />
              <p className="text-sm font-semibold text-slate-800">cirBTC note</p>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">Use the main Swap tab for cirBTC trades. The cirBTC cards here are for LP only.</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck size={14} className="text-slate-400" />
              <p className="text-sm font-semibold text-slate-800">Fees</p>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">Each submitted action uses your agent wallet and applies an Arc execution fee.</p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setActiveSection('liquidity')}
            className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition ${activeSection === 'liquidity' ? 'border-[#66D121]/40 bg-arc-greenBg text-arc-green shadow-sm' : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'}`}
          >
            <Activity size={14} /> Liquidity
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('lending')}
            className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition ${activeSection === 'lending' ? 'border-[#66D121]/40 bg-arc-greenBg text-arc-green shadow-sm' : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'}`}
          >
            <Coins size={14} /> Lending
          </button>
        </div>
      </Card>

      {error && <Alert type="error">{error}</Alert>}

      {activeSection === 'lending' ? (
        <LendingPlaceholder />
      ) : loading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <div className="space-y-4">
          {positionSnapshot.warnings?.length > 0 && (
            <Alert type="warning">{positionSnapshot.warnings[0].message}</Alert>
          )}

          {DEFI_POOL_CONFIG.map(poolConfig => {
            const snapshot = poolSnapshots[poolConfig.key]?.data || null;
            const snapshotError = poolSnapshots[poolConfig.key]?.error || '';
            const position = positionsByPool.get(poolConfig.key) || null;

            return (
              <Card key={poolConfig.key}>
                <div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-semibold text-slate-900">{poolConfig.title}</h3>
                      <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">{poolConfig.adapterLabel}</span>
                    </div>
                    <p className="mt-1 text-sm text-slate-500">{poolConfig.description}</p>
                  </div>
                </div>

                {snapshotError && (
                  <Alert type="warning" className="mt-4">{snapshotError}</Alert>
                )}

                <div className="mt-4 space-y-4">
                  <PoolGlobalMetrics snapshot={snapshot} />
                  <PoolPositionSnapshot position={position} />
                </div>

                <div className="mt-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <BarChart3 size={14} className="text-slate-400" />
                    <p className="text-sm font-semibold text-slate-800">Pool Actions</p>
                  </div>
                  <PoolManualControls
                    poolConfig={poolConfig}
                    agentId={agent?.id}
                    onRunQueued={() => {
                      window.setTimeout(() => {
                        load();
                      }, 1500);
                    }}
                  />
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}