import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { agents as agentsApi, oracle as oracleApi, defi as defiApi, tasks as tasksApi } from '../lib/api.js';
import { CHAINS } from '../lib/chains.js';
import { Alert, Card, Spinner } from './ui/index.jsx';
import PositionAwareLpCard from './PositionAwareLpCard.jsx';
import {
  Activity,
  ArrowRightLeft,
  BarChart3,
  Coins,
  Droplets,
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

const LENDING_WATCH_ASSETS = ['USDC', 'EURC'];
const DEFI_SECTION_EXPLANATIONS = {
  liquidity: {
    title: 'Liquidity',
    detail: 'Review live pool data, then add, reduce, or exit LP positions from your agent wallet.',
  },
  lending: {
    title: 'Lending',
    detail: 'Supply, withdraw, borrow, repay, deleverage, or liquidate from the stable lending market.',
  },
};

const LENDING_MANUAL_ACTIONS = [
  {
    id: 'supply',
    label: 'Supply',
    title: 'Supply collateral',
    description: 'Move USDC or EURC from the agent wallet into the lending market as collateral.',
    ctaLabel: 'Supply',
    icon: PlusCircle,
  },
  {
    id: 'withdraw',
    label: 'Withdraw',
    title: 'Withdraw supplied asset',
    description: 'Withdraw an already supplied stable asset back into the agent wallet.',
    ctaLabel: 'Withdraw',
    icon: MinusCircle,
  },
  {
    id: 'borrow',
    label: 'Borrow',
    title: 'Borrow stable asset',
    description: 'Borrow against the current supplied collateral, if the visible risk buffer allows it.',
    ctaLabel: 'Borrow',
    icon: Coins,
  },
  {
    id: 'repay',
    label: 'Repay',
    title: 'Repay debt',
    description: 'Repay an existing stable debt position from the agent wallet.',
    ctaLabel: 'Repay',
    icon: RefreshCw,
  },
  {
    id: 'collateral_top_up',
    label: 'Top-Up',
    title: 'Repair the collateral buffer',
    description: 'Use wallet funds to strengthen the position when the collateral buffer gets too thin.',
    ctaLabel: 'Run top-up',
    icon: PlusCircle,
  },
  {
    id: 'safe_exit',
    label: 'Safe Exit',
    title: 'Close the lending position safely',
    description: 'Pay back what is owed first, then pull the remaining supplied assets back to the wallet.',
    ctaLabel: 'Run safe exit',
    icon: MinusCircle,
  },
  {
    id: 'deleverage',
    label: 'Deleverage',
    title: 'Run emergency deleverage',
    description: 'Use the visible wallet balance to reduce debt quickly when the position needs help.',
    ctaLabel: 'Run deleverage',
    icon: ShieldCheck,
  },
  {
    id: 'liquidate',
    label: 'Liquidate',
    title: 'Liquidate another account',
    description: 'Repay a target borrower debt position and seize the configured collateral when the target is below threshold.',
    ctaLabel: 'Liquidate',
    icon: Activity,
  },
];

const LENDING_ASSET_ACTION_IDS = new Set(['supply', 'withdraw', 'borrow', 'repay']);

function createEmptyLendingSnapshot() {
  return {
    assets: [...LENDING_WATCH_ASSETS],
    reserves: [],
    summary: null,
    isFallback: true,
    fetchedAt: null,
  };
}

function createEmptyLendingSurface() {
  return {
    execution: {
      source: 'arc_native_scaffold',
      contractAddress: null,
      buildState: 'scaffold_only',
      globalPaused: false,
      ready: false,
      live: false,
      notes: [],
      actions: LENDING_MANUAL_ACTIONS.map(action => action.id),
    },
    prices: {
      fetchedAt: null,
      assets: [],
    },
    account: {
      liquidity: null,
      positions: [],
    },
    assets: [],
    risk: {
      totalSuppliedUsd: 0,
      totalBorrowUsd: 0,
      collateralSuppliedUsd: 0,
      collateralCapacityUsd: 0,
      liquidationCapacityUsd: 0,
      availableBorrowUsd: 0,
      ltvPct: 0,
      healthFactor: null,
      band: 'idle',
      label: 'No debt',
      detail: 'No active lending debt is visible yet.',
    },
    yield: {
      grossSupplyUsdPerYear: 0,
      grossBorrowCostUsdPerYear: 0,
      netLendingUsdPerYear: 0,
    },
    carry: {
      lane: 'carry_stable_lp',
      policyId: 'carry_stable_lp_v1',
      carryState: 'inactive',
      exclusiveMode: true,
      selectedAssetSymbol: null,
      lpYield: {
        aprPct: 0,
        apyPct: 0,
      },
      estimatedNetUsdPerYear: 0,
      checks: {},
    },
    automation: {
      carryEnabled: false,
    },
    actionGuards: {},
  };
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

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatLendingRate(value, { hideZero = false } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  if (hideZero && numeric <= 0) return '—';
  return formatPercentAmount(numeric);
}

function getLendingSourceStatus(reserve) {
  if (reserve?.source === 'aave_onchain' && reserve?.isFallback !== true) {
    return {
      tone: 'green',
      label: 'Live reserve',
      caption: 'On-chain feed',
    };
  }
  if (reserve?.isFallback) {
    return {
      tone: 'blue',
      label: 'Watch only',
      caption: 'Monitor mode',
    };
  }
  return {
    tone: 'slate',
    label: 'Pending live',
    caption: 'Waiting for feed',
  };
}

function formatLendingFallbackReason(reason) {
  if (reason === 'aave_pool_not_configured') {
    return 'No live reserve feed is attached yet, so this card stays in monitor mode for now.';
  }
  if (reason === 'reserve_not_available') {
    return 'A target reserve exists, but it is not returning stable live state yet, so this card stays read-only.';
  }
  if (reason === 'onchain_fetch_failed') {
    return 'The last live reserve read failed, so this card fell back to monitor-only data.';
  }
  if (!reason) {
    return 'This asset is currently in monitor mode while the reserve model is still being wired.';
  }
  return String(reason).replace(/_/g, ' ');
}

function formatLendingMarketLabel(value) {
  const normalized = String(value || 'aave_v3').replace(/_/g, ' ').trim();
  if (!normalized) return 'Aave V3';
  return normalized.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function getLendingWatchBadgeClasses(tone) {
  if (tone === 'blue') return 'border-sky-200 bg-white text-sky-700 shadow-sm shadow-sky-100';
  if (tone === 'green') return 'border-emerald-200 bg-white text-emerald-700 shadow-sm shadow-emerald-100';
  if (tone === 'amber') return 'border-amber-200 bg-white text-amber-700 shadow-sm shadow-amber-100';
  if (tone === 'red') return 'border-rose-200 bg-white text-rose-700 shadow-sm shadow-rose-100';
  return 'border-slate-200 bg-white text-slate-700 shadow-sm shadow-slate-100';
}

function formatAddressShort(value) {
  if (!value || typeof value !== 'string') return 'Not configured';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatHealthFactor(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  if (numeric > 999) return '>999';
  return numeric.toFixed(numeric >= 10 ? 2 : 3).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

function getLendingRiskTone(band) {
  if (band === 'healthy') return 'green';
  if (band === 'warning') return 'amber';
  if (band === 'critical') return 'red';
  return 'slate';
}

function getLendingExecutionCard(surface) {
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
      detail: 'You can use this page to send lending actions from the connected wallet.',
    };
  }

  if (execution.contractAddress && execution.buildState === 'scaffold_only') {
    return {
      tone: 'amber',
      label: 'Limited',
      detail: 'A contract is connected, but this screen is still in a limited setup state.',
    };
  }

  return {
    tone: 'amber',
    label: 'Coming soon',
    detail: 'This lending screen is wired, but a live contract is not connected yet.',
  };
}

function getLendingPriceCard(surface) {
  const priceAssets = Array.isArray(surface?.prices?.assets) ? surface.prices.assets : [];
  const fallbackAssets = priceAssets.filter(asset => asset?.isFallback);

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
      detail: `${fallbackAssets.map(asset => asset.symbol).join(', ')} is currently using backup price data.`,
    };
  }

  return {
    tone: 'green',
    label: 'Live prices',
    detail: 'This page is using the current stable price feed.',
  };
}

function getLendingExecutionGuard(surface, detailWhenReady) {
  if (surface?.execution?.globalPaused) {
    return {
      execute: false,
      detail: 'Lending actions are paused right now.',
    };
  }

  if (!surface?.execution?.contractAddress) {
    return {
      execute: false,
      detail: 'A lending contract is not connected yet.',
    };
  }

  if (surface?.execution?.buildState === 'scaffold_only') {
    return {
      execute: false,
      detail: 'This action is still limited while the connected contract setup finishes.',
    };
  }

  return {
    execute: true,
    detail: detailWhenReady,
  };
}

function getLendingActionGuard(surface, assetSymbol, actionId) {
  if (actionId === 'collateral_top_up') {
    const topUp = surface?.collateralTopUp;
    return {
      execute: topUp?.execute === true,
      detail: topUp?.detail || 'Collateral top-up state is unavailable right now.',
    };
  }

  if (actionId === 'safe_exit') {
    const safeExit = surface?.safeExit;
    return {
      execute: safeExit?.execute === true,
      detail: safeExit?.detail || 'Safe-exit state is unavailable right now.',
    };
  }

  if (actionId === 'deleverage') {
    const recovery = surface?.recovery;
    return {
      execute: recovery?.execute === true,
      detail: recovery?.detail || 'Emergency deleverage state is unavailable right now.',
    };
  }

  if (actionId === 'liquidate') {
    return getLendingExecutionGuard(
      surface,
      'Liquidation needs a borrower address, debt asset, collateral asset, and repay amount. The worker re-checks the target health before any on-chain call.',
    );
  }

  return surface?.actionGuards?.[assetSymbol]?.[actionId] || {
    execute: false,
    detail: 'Guard state is unavailable right now.',
  };
}

function getDefaultLendingManualParams(surface, actionId = 'supply') {
  const assetOptions = Array.isArray(surface?.assets) && surface.assets.length > 0
    ? surface.assets.map(asset => asset.symbol)
    : LENDING_WATCH_ASSETS;

  const primaryAsset = assetOptions[0] || 'USDC';
  const secondaryAsset = assetOptions.find(asset => asset !== primaryAsset) || primaryAsset;

  if (actionId === 'collateral_top_up' || actionId === 'safe_exit' || actionId === 'deleverage') {
    return {
      asset: primaryAsset,
      amount: '',
      borrower: '',
      collateralAsset: secondaryAsset,
    };
  }

  if (actionId === 'liquidate') {
    return {
      asset: primaryAsset,
      amount: '',
      borrower: '',
      collateralAsset: secondaryAsset,
    };
  }

  return {
    asset: primaryAsset,
    amount: '',
    borrower: '',
    collateralAsset: secondaryAsset,
  };
}

function getLendingManualActionError(actionId, params) {
  if (actionId === 'collateral_top_up' || actionId === 'safe_exit') return '';
  if (actionId === 'deleverage') return '';

  if (actionId === 'liquidate') {
    if (!params.borrower) return 'Enter the borrower wallet address to liquidate.';
    if (!params.asset) return 'Choose the debt asset used for this liquidation.';
    if (!params.collateralAsset) return 'Choose the collateral asset to seize.';
    if (!(Number(params.amount) > 0)) return 'Enter a positive repay amount for this liquidation.';
    return '';
  }

  if (!params.asset) return 'Choose the asset used for this lending action.';
  if (!(Number(params.amount) > 0)) return 'Enter a positive amount for this lending action.';
  return '';
}

function LendingManualFields({ actionId, assetOptions, params, setParams, selectedAsset }) {
  const visibleRepayAmount = Number(selectedAsset?.position?.borrowAmount || 0);

  if (actionId === 'collateral_top_up') {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        This action uses the visible top-up plan automatically. You do not need to enter an extra amount.
      </div>
    );
  }

  if (actionId === 'safe_exit') {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        This action repays visible debt first, then withdraws the remaining supplied assets. No extra amount input is needed.
      </div>
    );
  }

  if (actionId === 'deleverage') {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        This action uses the visible recovery plan automatically. You do not need to enter an extra amount.
      </div>
    );
  }

  if (actionId === 'liquidate') {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Borrower</span>
          <input
            type="text"
            value={params.borrower}
            onChange={(event) => setParams(current => ({ ...current, borrower: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
            placeholder="0x..."
          />
        </label>
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Debt Asset</span>
          <select
            value={params.asset}
            onChange={(event) => setParams(current => ({ ...current, asset: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          >
            {assetOptions.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Collateral Asset</span>
          <select
            value={params.collateralAsset}
            onChange={(event) => setParams(current => ({ ...current, collateralAsset: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          >
            {assetOptions.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className="sm:col-span-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Repay Amount</span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={params.amount}
            onChange={(event) => setParams(current => ({ ...current, amount: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
          />
        </label>
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Asset</span>
        <select
          value={params.asset}
          onChange={(event) => setParams(current => ({ ...current, asset: event.target.value }))}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
        >
          {assetOptions.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Amount</span>
          {actionId === 'repay' && (
            <button
              type="button"
              onClick={() => setParams(current => ({
                ...current,
                amount: visibleRepayAmount > 0 ? String(visibleRepayAmount) : '',
              }))}
              disabled={visibleRepayAmount <= 0}
              className={`text-[11px] font-semibold transition ${
                visibleRepayAmount > 0
                  ? 'text-arc-green hover:text-[#4ea412]'
                  : 'cursor-not-allowed text-slate-300'
              }`}
            >
              All repay
            </button>
          )}
        </div>
        <input
          type="number"
          min="0"
          step="0.0001"
          value={params.amount}
          onChange={(event) => setParams(current => ({ ...current, amount: event.target.value }))}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#66D121]/40"
        />
        {actionId === 'repay' && (
          <p className="mt-1 text-[11px] text-slate-500">
            {visibleRepayAmount > 0
              ? `Visible debt: ${formatPositionAmount(visibleRepayAmount)} ${params.asset}. Click All repay to fill the full amount automatically.`
              : `No visible ${params.asset} debt is available to auto-fill right now.`}
          </p>
        )}
      </label>
    </div>
  );
}

function LendingManualControls({ agentId, lendingSurface, onRunQueued }) {
  const actions = LENDING_MANUAL_ACTIONS;
  const assetOptions = useMemo(() => {
    const assets = Array.isArray(lendingSurface?.assets) ? lendingSurface.assets.map(asset => asset.symbol) : [];
    return assets.length > 0 ? assets : LENDING_WATCH_ASSETS;
  }, [lendingSurface]);
  const [activeActionId, setActiveActionId] = useState(actions[0]?.id || 'supply');
  const activeAction = actions.find(action => action.id === activeActionId) || actions[0] || null;
  const ActionIcon = activeAction?.icon || PlusCircle;
  const [params, setParams] = useState(() => getDefaultLendingManualParams(lendingSurface, activeAction?.id));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [trackedRun, setTrackedRun] = useState(null);
  const selectedAsset = useMemo(() => {
    const assets = Array.isArray(lendingSurface?.assets) ? lendingSurface.assets : [];
    return assets.find((asset) => asset.symbol === params.asset) || null;
  }, [lendingSurface, params.asset]);

  useEffect(() => {
    setParams((current) => {
      const nextAsset = assetOptions.includes(current.asset) ? current.asset : (assetOptions[0] || 'USDC');
      const nextCollateral = assetOptions.includes(current.collateralAsset)
        ? current.collateralAsset
        : (assetOptions.find(asset => asset !== nextAsset) || nextAsset);
      return { ...current, asset: nextAsset, collateralAsset: nextCollateral };
    });
  }, [assetOptions]);

  useEffect(() => {
    setParams(getDefaultLendingManualParams(lendingSurface, activeAction?.id));
    setMessage('');
    setError('');
  }, [lendingSurface?.execution?.contractAddress, lendingSurface?.execution?.buildState, activeAction?.id]);

  useEffect(() => {
    if (!agentId || !trackedRun?.id || !isPoolManualRunActive(trackedRun)) {
      return undefined;
    }

    let active = true;

    async function syncTrackedRun() {
      try {
        const data = await tasksApi.runs(agentId, 'recent', 20);
        if (!active) return;

        const updatedRun = Array.isArray(data?.runs)
          ? data.runs.find(item => item.id === trackedRun.id)
          : null;

        if (!updatedRun) return;

        setTrackedRun(updatedRun);

        if (!isPoolManualRunActive(updatedRun)) {
          onRunQueued?.(updatedRun);
          if (updatedRun.status === 'completed') {
            setMessage(updatedRun.result_payload?.summary || 'Manual lending action completed.');
            setError('');
          } else if (updatedRun.status === 'failed') {
            setError(updatedRun.error || updatedRun.stage_detail || 'The manual lending action failed.');
          }
        }
      } catch (pollError) {
        if (!active) return;
        setError(current => current || pollError.message || 'Failed to refresh the manual lending action status.');
      }
    }

    syncTrackedRun();
    const intervalId = window.setInterval(syncTrackedRun, 2500);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [agentId, onRunQueued, trackedRun]);

  const activeGuard = getLendingActionGuard(lendingSurface, params.asset, activeAction?.id);

  async function handleSubmit() {
    if (!agentId || !activeAction) return;

    const paramError = getLendingManualActionError(activeAction.id, params);
    if (paramError) {
      setError(paramError);
      return;
    }

    setBusy(true);
    setError('');
    setMessage('');

    try {
      let request;

      if (activeAction.id === 'collateral_top_up' || activeAction.id === 'safe_exit' || activeAction.id === 'deleverage') {
        request = {
          lane: 'lending',
          action: activeAction.id,
          params: {
            action: activeAction.id,
          },
        };
      } else if (activeAction.id === 'liquidate') {
        request = {
          lane: 'lending',
          action: 'liquidate',
          asset: params.asset,
          params: {
            borrower: params.borrower,
            debtAsset: params.asset,
            collateralAsset: params.collateralAsset,
            amount: Number(params.amount),
          },
        };
      } else {
        request = {
          lane: 'lending',
          action: activeAction.id,
          asset: params.asset,
          params: {
            asset: params.asset,
            amount: Number(params.amount),
          },
        };
      }

      const response = await defiApi.manualExecute(agentId, request);
      const feeLabel = Number(response?.feeUsdc) > 0
        ? `${Number(response.feeUsdc).toFixed(2)} USDC fee applied.`
        : 'Fee applied on submit.';

      if (response?.run) {
        setTrackedRun(response.run);
        setMessage(`Queued. ${feeLabel}`);
        onRunQueued?.(response.run);
        return;
      }

      setMessage('Submitted.');
    } catch (runError) {
      if (runError?.data?.run) {
        setTrackedRun(runError.data.run);
      }
      setError(runError?.data?.detail || runError.message || 'Failed to run the manual lending action.');
    } finally {
      setBusy(false);
    }
  }

  const trackedRunStatus = trackedRun ? getPoolManualRunStatusMeta(trackedRun) : null;
  const trackedRunSummary = trackedRun ? getPoolManualRunSummary(trackedRun, activeAction?.title || 'Manual lending action') : '';
  const trackedRunLinks = trackedRun ? getPoolManualRunLinks(trackedRun) : [];

  if (!activeAction) {
    return null;
  }

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
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
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getStatusBadgeClasses(activeGuard.execute ? 'green' : 'amber')}`}>
            {activeGuard.execute ? 'Guard passed' : 'Guard blocked'}
          </span>
        </div>

        <div className="mt-4 space-y-2">
          <LendingManualFields
            actionId={activeAction.id}
            assetOptions={assetOptions}
            params={params}
            setParams={setParams}
            selectedAsset={selectedAsset}
          />
        </div>

        <p className="mt-3 text-xs leading-5 text-slate-500">{activeGuard.detail}</p>

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        {message && <p className="mt-3 text-xs text-green-600">{message}</p>}

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">
            Every click here queues a hidden lending task. The worker re-checks the same guard before any on-chain call.
          </p>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || !agentId || activeGuard.execute !== true}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
              busy || !agentId || activeGuard.execute !== true
                ? 'cursor-not-allowed bg-slate-200 text-slate-400'
                : 'bg-amber-500 text-white hover:bg-amber-600'
            }`}
          >
            {busy ? <Spinner size={13} /> : <ActionIcon size={15} />}
            {busy ? 'Submitting...' : activeAction.ctaLabel}
          </button>
        </div>

        {trackedRun && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">Latest manual action</p>
                <p className="mt-1 text-xs text-slate-500">
                  Started {formatTimestamp(trackedRun.created_at)} · Last update {formatTimestamp(trackedRun.updated_at || trackedRun.completed_at || trackedRun.created_at)}
                </p>
              </div>
              {trackedRunStatus && (
                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getStatusBadgeClasses(trackedRunStatus.tone)}`}>
                  {trackedRunStatus.label}
                </span>
              )}
            </div>

            <p className="mt-3 text-sm leading-6 text-slate-700">{trackedRunSummary}</p>

            {trackedRunLinks.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {trackedRunLinks.map(link => (
                  <a
                    key={`${link.label}-${link.txHash}`}
                    href={link.url || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                  >
                    <span>{link.label}</span>
                    <span>{formatAddressShort(link.txHash)}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CarryMigrationControls({ agentId, carry, carryAutomationEnabled, onRunQueued }) {
  const lpBalance = Number(carry?.lpBalance || 0);
  const positionValueUsd = Number(carry?.positionValueUsd || 0);
  const shouldShow = carryAutomationEnabled && carry?.carryState === 'manual_lp_conflict' && lpBalance > 0;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [trackedRun, setTrackedRun] = useState(null);

  useEffect(() => {
    setMessage('');
    setError('');
  }, [carry?.carryState, carry?.lpBalance]);

  useEffect(() => {
    if (!agentId || !trackedRun?.id || !isPoolManualRunActive(trackedRun)) {
      return undefined;
    }

    let active = true;

    async function syncTrackedRun() {
      try {
        const data = await tasksApi.runs(agentId, 'recent', 20);
        if (!active) return;

        const updatedRun = Array.isArray(data?.runs)
          ? data.runs.find(item => item.id === trackedRun.id)
          : null;

        if (!updatedRun) return;

        setTrackedRun(updatedRun);

        if (!isPoolManualRunActive(updatedRun)) {
          if (updatedRun.status === 'completed') {
            try {
              await agentsApi.update(agentId, { carryAutomationEnabled: true });
              setMessage('Existing stable LP was removed. Auto Carry re-check was queued and can reopen the position on its own if the spread still passes.');
            } catch (kickoffError) {
              setMessage(updatedRun.result_payload?.summary || 'Existing stable LP was removed.');
              setError(kickoffError.message || 'Auto Carry re-check could not be queued automatically. Use Refresh once to reload the latest carry state.');
            }
            onRunQueued?.(updatedRun);
          } else if (updatedRun.status === 'failed') {
            setError(updatedRun.error || updatedRun.stage_detail || 'The carry conversion could not remove the current stable LP.');
          }
        }
      } catch (pollError) {
        if (!active) return;
        setError(current => current || pollError.message || 'Failed to refresh the carry conversion status.');
      }
    }

    syncTrackedRun();
    const intervalId = window.setInterval(syncTrackedRun, 2500);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [agentId, onRunQueued, trackedRun]);

  async function handleConvert() {
    if (!shouldShow || !agentId) return;

    const curvePool = DEFI_POOL_CONFIG.find(pool => pool.key === 'USDC-EURC');
    if (!curvePool) {
      setError('The verified stable Curve pool is not available for carry conversion.');
      return;
    }

    setBusy(true);
    setError('');
    setMessage('');

    try {
      const response = await defiApi.manualExecute(
        agentId,
        buildManualActionRequest(curvePool, 'remove_dual', { lpAmount: lpBalance }),
      );
      const feeLabel = Number(response?.feeUsdc) > 0
        ? `${Number(response.feeUsdc).toFixed(2)} USDC fee applied.`
        : 'Fee applied on submit.';

      if (response?.run) {
        setTrackedRun(response.run);
        setMessage(`Queued. Existing stable LP will exit into both wallet tokens first. ${feeLabel}`);
        onRunQueued?.(response.run);
        return;
      }

      setMessage('Submitted. Auto Carry will need a refresh to pick up the new wallet balances.');
    } catch (runError) {
      if (runError?.data?.run) {
        setTrackedRun(runError.data.run);
      }
      setError(runError?.data?.detail || runError.message || 'Failed to start the carry conversion.');
    } finally {
      setBusy(false);
    }
  }

  const trackedRunStatus = trackedRun ? getPoolManualRunStatusMeta(trackedRun) : null;
  const trackedRunSummary = trackedRun ? getPoolManualRunSummary(trackedRun, 'Carry conversion') : '';
  const trackedRunLinks = trackedRun ? getPoolManualRunLinks(trackedRun) : [];

  if (!shouldShow) {
    return null;
  }

  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Carry Conversion</p>
          <p className="mt-2 text-sm leading-6 text-amber-900">
            This stable LP was opened outside Auto Carry, so the lane is intentionally waiting. Convert it once and Auto Carry can reopen and own the next stable LP leg by itself.
          </p>
          <p className="mt-2 text-xs leading-5 text-amber-800">
            Current manual LP: {formatLpAmount(lpBalance)} LP about {formatUsdAmount(positionValueUsd)}. The conversion removes that LP into both wallet tokens first, then queues a fresh Auto Carry re-check. It does not guarantee a new borrow if the spread or health buffer has changed by then.
          </p>
        </div>
        <button
          type="button"
          onClick={handleConvert}
          disabled={busy || !agentId}
          className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
            busy || !agentId
              ? 'cursor-not-allowed bg-slate-200 text-slate-400'
              : 'bg-amber-500 text-white hover:bg-amber-600'
          }`}
        >
          {busy ? <Spinner size={13} /> : <RefreshCw size={15} />}
          {busy ? 'Converting...' : 'Convert To Auto Carry'}
        </button>
      </div>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      {message && <p className="mt-3 text-xs text-green-700">{message}</p>}

      {trackedRun && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-white px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Latest carry conversion</p>
              <p className="mt-1 text-xs text-slate-500">
                Started {formatTimestamp(trackedRun.created_at)} · Last update {formatTimestamp(trackedRun.updated_at || trackedRun.completed_at || trackedRun.created_at)}
              </p>
            </div>
            {trackedRunStatus && (
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getStatusBadgeClasses(trackedRunStatus.tone)}`}>
                {trackedRunStatus.label}
              </span>
            )}
          </div>

          <p className="mt-3 text-sm leading-6 text-slate-700">{trackedRunSummary}</p>
          {trackedRunLinks.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {trackedRunLinks.map(link => (
                <a
                  key={`${link.label}-${link.url}`}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300 hover:text-slate-900"
                >
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LendingAssetSnapshot({ lendingSurface }) {
  const assets = Array.isArray(lendingSurface?.assets) ? lendingSurface.assets : [];

  if (assets.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-500">
        Lending balances are not available yet.
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {assets.map((asset) => (
        <div key={asset.symbol} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-lg font-semibold text-slate-900">{asset.symbol}</p>
              <p className="mt-1 text-xs text-slate-500">
                Price {formatUsdAmount(asset.price.priceUsd)} · {asset.price.isFallback ? 'Backup price' : 'Live price source'}
              </p>
            </div>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(asset.reserve.paused ? 'red' : asset.reserve.supported ? 'green' : 'amber')}`}>
              {asset.reserve.paused ? 'Paused' : asset.reserve.supported ? 'Configured' : 'Not configured'}
            </span>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Wallet</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{formatPositionAmount(asset.wallet.amount)}</p>
              <p className="mt-1 text-[11px] text-slate-500">{formatUsdAmount(asset.wallet.amountUsd)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Supplied</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{formatPositionAmount(asset.position.suppliedAmount)}</p>
              <p className="mt-1 text-[11px] text-slate-500">{formatUsdAmount(asset.position.suppliedUsd)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Borrowed</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{formatPositionAmount(asset.position.borrowAmount)}</p>
              <p className="mt-1 text-[11px] text-slate-500">{formatUsdAmount(asset.position.borrowUsd)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Collateral</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{asset.position.useAsCollateral ? 'Enabled' : 'Off'}</p>
              <p className="mt-1 text-[11px] text-slate-500">CF {formatPercentAmount(asset.reserve.collateralFactorBps / 100)} · LT {formatPercentAmount(asset.reserve.liquidationThresholdBps / 100)}</p>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {LENDING_MANUAL_ACTIONS.filter(action => LENDING_ASSET_ACTION_IDS.has(action.id)).map((action) => {
              const guard = getLendingActionGuard(lendingSurface, asset.symbol, action.id);
              return (
                <div key={`${asset.symbol}:${action.id}`} className="rounded-lg border border-slate-200 bg-white px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{action.label}</p>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(guard.execute ? 'green' : 'amber')}`}>
                      {guard.execute ? 'Ready' : 'Blocked'}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-slate-500">{guard.detail}</p>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
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
  if (tone === 'blue') return 'border-sky-200 bg-sky-50 text-sky-700';
  if (tone === 'green') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (tone === 'amber') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (tone === 'red') return 'border-rose-200 bg-rose-50 text-rose-700';
  return 'border-slate-200 bg-slate-100 text-slate-700';
}

function getArcExplorerTxUrl(txHash) {
  if (!txHash || typeof txHash !== 'string') return null;
  const explorerBase = CHAINS['Arc Testnet']?.explorerUrl;
  return explorerBase ? `${explorerBase}/tx/${txHash}` : null;
}

function isPoolManualRunActive(run) {
  return ['queued', 'running'].includes(String(run?.status || ''));
}

function getPoolManualRunStatusMeta(run) {
  const status = String(run?.status || 'queued');
  if (status === 'completed') {
    return { tone: 'green', label: run?.stage_label || 'Completed' };
  }
  if (status === 'failed') {
    return { tone: 'red', label: run?.stage_label || 'Failed' };
  }
  if (status === 'running') {
    return { tone: 'blue', label: run?.stage_label || 'Running' };
  }
  if (status === 'queued') {
    return { tone: 'amber', label: run?.stage_label || 'Queued' };
  }
  return {
    tone: 'slate',
    label: run?.stage_label || status.replace(/_/g, ' '),
  };
}

function getPoolManualRunSummary(run, fallbackLabel = 'Manual action') {
  if (!run) return '';

  if (run.status === 'failed') {
    return normalizeManualFailureText(run.stage_detail || run.error, `${fallbackLabel} failed.`);
  }

  return run.result_payload?.summary
    || run.stage_detail
    || `${fallbackLabel} ${String(run.status || 'queued').replace(/_/g, ' ')}.`;
}

function formatManualQuoteAmount(value, token = 'USDC') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';

  const decimals = String(token || '').toUpperCase() === 'CIRBTC' ? 6 : 4;
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function normalizeManualFailureText(value, fallback = 'Manual action failed.') {
  const text = String(value || '').trim();
  if (!text) return fallback;

  if (/ERC20:\s*transfer amount exceeds balance/i.test(text)) {
    return 'Agent wallet balance was too low for this trade.';
  }

  if (/insufficient funds/i.test(text)) {
    return 'Agent wallet did not have enough native gas token for this transaction.';
  }

  if (/transaction execution reverted/i.test(text) || /CALL_EXCEPTION/i.test(text)) {
    return 'The on-chain Curve swap reverted, but the RPC node did not return a decoded contract reason.';
  }

  if (text.length > 240) {
    return `${text.slice(0, 237)}...`;
  }

  return text;
}

function getPoolManualRunLinks(run) {
  const payload = run?.result_payload || {};
  const economy = payload?.economy || {};
  const candidates = [
    { label: 'Execution tx', txHash: payload.txHash || payload.hash || payload.mintTxHash || payload.burnTxHash || payload.swapTxHash || null },
    { label: 'Swap tx', txHash: payload.swapTxHash || null },
    { label: 'Mint tx', txHash: payload.mintTxHash || null },
    { label: 'Burn tx', txHash: payload.burnTxHash || null },
    { label: 'Fee settlement tx', txHash: economy.gatewayMintTxHash || null },
  ];
  const seen = new Set();

  return candidates
    .filter(({ txHash }) => {
      if (!txHash || seen.has(txHash)) return false;
      seen.add(txHash);
      return true;
    })
    .map(item => ({
      ...item,
      url: getArcExplorerTxUrl(item.txHash),
    }));
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
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [trackedRun, setTrackedRun] = useState(null);

  useEffect(() => {
    if (!actions.some(action => action.id === activeActionId)) {
      setActiveActionId(actions[0]?.id || '');
    }
  }, [actions, activeActionId]);

  useEffect(() => {
    setParams(getDefaultManualParams(poolConfig, activeAction?.id));
    setQuote(null);
    setMessage('');
    setError('');
  }, [poolConfig, activeAction?.id]);

  useEffect(() => {
    if (!agentId || poolConfig.poolType !== 'curve' || activeAction?.id !== 'swap') {
      setQuote(null);
      setQuoting(false);
      return undefined;
    }

    const paramError = getManualActionError(poolConfig, activeAction.id, params);
    if (paramError) {
      setQuote(null);
      setQuoting(false);
      return undefined;
    }

    let active = true;
    const timeoutId = window.setTimeout(async () => {
      setQuoting(true);
      try {
        const response = await defiApi.manualQuote(agentId, buildManualActionRequest(poolConfig, activeAction.id, params));
        if (!active) return;
        setQuote(response);
      } catch (quoteError) {
        if (!active) return;
        setQuote({
          amountOut: null,
          quoteError: quoteError.message || 'Live Curve preview is unavailable right now.',
        });
      } finally {
        if (active) setQuoting(false);
      }
    }, 350);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    activeAction?.id,
    agentId,
    params.amountIn,
    params.fromToken,
    params.toToken,
    poolConfig,
  ]);

  useEffect(() => {
    if (!agentId || !trackedRun?.id || !isPoolManualRunActive(trackedRun)) {
      return undefined;
    }

    let active = true;

    async function syncTrackedRun() {
      try {
        const data = await tasksApi.runs(agentId, 'recent', 20);
        if (!active) return;

        const updatedRun = Array.isArray(data?.runs)
          ? data.runs.find(item => item.id === trackedRun.id)
          : null;

        if (!updatedRun) return;

        setTrackedRun(updatedRun);

        if (!isPoolManualRunActive(updatedRun)) {
          onRunQueued?.(updatedRun);
          if (updatedRun.status === 'completed') {
            setMessage(updatedRun.result_payload?.summary || 'Manual action completed.');
            setError('');
          } else if (updatedRun.status === 'failed') {
            setError(normalizeManualFailureText(updatedRun.stage_detail || updatedRun.error, 'The manual pool action failed.'));
          }
        }
      } catch (pollError) {
        if (!active) return;
        setError(current => current || pollError.message || 'Failed to refresh the manual action status.');
      }
    }

    syncTrackedRun();
    const intervalId = window.setInterval(syncTrackedRun, 2500);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [agentId, onRunQueued, trackedRun]);

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
        setTrackedRun(response.run);
        setMessage(`Queued. ${feeLabel}`);
        onRunQueued?.(response.run);
        return;
      }

      setMessage('Submitted.');
    } catch (runError) {
      if (runError?.data?.run) {
        setTrackedRun(runError.data.run);
      }
      setError(normalizeManualFailureText(runError.message, 'Failed to run the manual pool action.'));
    } finally {
      setBusy(false);
    }
  }

  const trackedRunStatus = trackedRun ? getPoolManualRunStatusMeta(trackedRun) : null;
  const trackedRunSummary = trackedRun ? getPoolManualRunSummary(trackedRun, activeAction?.title || 'Manual action') : '';
  const trackedRunLinks = trackedRun ? getPoolManualRunLinks(trackedRun) : [];

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

        {poolConfig.poolType === 'curve' && activeAction.id === 'swap' && (
          <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Estimated output</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {quoting
                    ? 'Checking Curve pool...'
                    : quote?.amountOut
                      ? `${formatManualQuoteAmount(quote.amountOut, params.toToken)} ${params.toToken}`
                      : '—'}
                </p>
              </div>
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                Curve preview
              </span>
            </div>
            <p className="mt-2 break-words text-xs text-slate-500">
              {quote?.quoteError
                ? quote.quoteError
                : 'This is a read-only preview from the selected Curve stable pool before you submit the manual swap.'}
            </p>
          </div>
        )}

        {error && <p className="mt-3 break-all text-xs text-red-500">{error}</p>}
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

        {trackedRun && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">Latest manual action</p>
                <p className="mt-1 text-xs text-slate-500">
                  Started {formatTimestamp(trackedRun.created_at)} · Last update {formatTimestamp(trackedRun.updated_at || trackedRun.completed_at || trackedRun.created_at)}
                </p>
              </div>
              {trackedRunStatus && (
                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getStatusBadgeClasses(trackedRunStatus.tone)}`}>
                  {trackedRunStatus.label}
                </span>
              )}
            </div>

            <p className="mt-3 whitespace-pre-wrap break-all text-sm leading-6 text-slate-700">{trackedRunSummary}</p>

            {trackedRunLinks.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {trackedRunLinks.map(link => (
                  <a
                    key={`${link.label}-${link.txHash}`}
                    href={link.url || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                  >
                    <span>{link.label}</span>
                    <span>{formatAddressShort(link.txHash)}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
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
  return (
    <PositionAwareLpCard
      position={position}
      title="Your Current Position"
      emptyLabel="No live LP position is currently detected for this agent on this pool."
    />
  );
}

function LendingSection({ loading, lendingSnapshot, lendingError, lendingSurface, lendingSurfaceError, agentId, onRunQueued }) {
  const reserves = Array.isArray(lendingSnapshot?.reserves) ? lendingSnapshot.reserves : [];
  const hasLiveMarket = reserves.some(reserve => reserve?.source === 'aave_onchain' && reserve?.isFallback !== true);
  const hasFallbackData = reserves.some(reserve => reserve?.isFallback);
  const summary = lendingSnapshot?.summary || null;
  const executionCard = getLendingExecutionCard(lendingSurface);
  const priceCard = getLendingPriceCard(lendingSurface);
  const risk = lendingSurface?.risk || createEmptyLendingSurface().risk;
  const recovery = lendingSurface?.recovery || {
    execute: false,
    status: 'idle',
    detail: 'There is no lending debt to deleverage.',
    repayUsdNeeded: 0,
    repayUsdPlanned: 0,
    repayUsdShortfall: 0,
  };
  const collateralTopUp = lendingSurface?.collateralTopUp || {
    execute: false,
    status: 'idle',
    detail: 'There is no active lending debt, so collateral top-up is not needed.',
    collateralUsdNeeded: 0,
    collateralUsdPlanned: 0,
    collateralUsdShortfall: 0,
  };
  const safeExit = lendingSurface?.safeExit || {
    execute: false,
    status: 'idle',
    detail: 'There is no active supplied or borrowed lending position to close.',
    repayUsdNeeded: 0,
    repayUsdPlanned: 0,
    repayUsdShortfall: 0,
    withdrawUsdPlanned: 0,
  };
  const liquidation = lendingSurface?.liquidation || {
    liquidatable: false,
    status: 'idle',
    detail: 'No debt is active, so liquidation is not relevant for this account.',
    healthFactor: risk.healthFactor,
  };
  const lendingYield = lendingSurface?.yield || createEmptyLendingSurface().yield;
  const carry = lendingSurface?.carry || createEmptyLendingSurface().carry;
  const carrySelectedAsset = carry?.selectedAssetSymbol || carry?.selectedAsset?.symbol || null;
  const carryAutomationEnabled = lendingSurface?.automation?.carryEnabled === true;
  const carryNetApyPct = Number(carry?.selectedAsset?.netCarryApyPct ?? carry?.netCarryApyPct);
  const carryBorrowApyPct = Number(carry?.selectedAsset?.borrowApyPct ?? carry?.borrowApyPct);
  const carryLpApyPct = Number(carry?.lpYield?.apyPct);
  const carryProjectedDeltaUsd = Number(carry?.estimatedNetUsdPerYear);
  const carryTone = carry?.carryState === 'active'
    ? 'green'
    : carry?.carryState === 'unwind' || carry?.carryState === 'manual_lp_conflict' || carry?.carryState === 'unavailable'
      ? 'amber'
      : Number.isFinite(carryNetApyPct) && carryNetApyPct > 0
        ? 'green'
        : 'slate';
  const carryLabel = carry?.carryState === 'active'
    ? 'Active'
    : carry?.carryState === 'debt_idle'
      ? 'Borrow opened'
      : carry?.carryState === 'unwind'
        ? 'Unwind'
        : carry?.carryState === 'manual_lp_conflict'
          ? 'Manual LP detected'
          : carry?.carryState === 'unavailable'
            ? 'Unavailable'
            : carryAutomationEnabled
              ? 'Watching'
              : 'Off';
  const carryDetail = carry?.error
    ? `Carry snapshot is temporarily unavailable: ${carry.error}`
    : carry?.carryState === 'debt_idle'
      ? `${carryAutomationEnabled ? 'Auto Carry is enabled.' : 'Auto Carry is off.'} The borrow leg is already open, and the borrowed ${carrySelectedAsset || 'stable balance'} is now sitting in the wallet. If the spread and health buffer still pass, the next automatic carry cycle will deploy that borrowed balance into the stable LP. LP fee APY ${formatPercentAmount(carryLpApyPct)} · borrow APY ${formatPercentAmount(carryBorrowApyPct)} · estimated net yield ${formatPercentAmount(carryNetApyPct)} · estimated yearly carry ${formatUsdAmount(carryProjectedDeltaUsd)}.`
    : `${carryAutomationEnabled ? 'Auto Carry is enabled.' : 'Auto Carry is off.'} ${carry?.exclusiveMode ? 'When it is on, it controls this stable LP carry route.' : ''} ${carrySelectedAsset ? `Watching ${carrySelectedAsset} on the borrow side.` : ''} LP fee APY ${formatPercentAmount(carryLpApyPct)} · borrow APY ${formatPercentAmount(carryBorrowApyPct)} · estimated net yield ${formatPercentAmount(carryNetApyPct)} · estimated yearly carry ${formatUsdAmount(carryProjectedDeltaUsd)}.`;
  const recoveryTone = recovery.execute
    ? recovery.status === 'partial' ? 'amber' : 'green'
    : recovery.status === 'needs_funding' ? 'amber' : 'slate';
  const recoveryLabel = recovery.execute
    ? recovery.status === 'partial' ? 'Partially funded' : 'Ready'
    : recovery.status === 'needs_funding' ? 'Needs funding' : recovery.status === 'not_required' ? 'Not required' : 'No debt';
  const recoveryDetail = `${recovery.detail} Need ${formatUsdAmount(recovery.repayUsdNeeded)} · Planned ${formatUsdAmount(recovery.repayUsdPlanned)}${Number(recovery.repayUsdShortfall || 0) > 0 ? ` · Shortfall ${formatUsdAmount(recovery.repayUsdShortfall)}` : ''}.`;
  const collateralTopUpTone = collateralTopUp.execute
    ? collateralTopUp.status === 'partial' ? 'amber' : 'green'
    : collateralTopUp.status === 'needs_funding' ? 'amber' : 'slate';
  const collateralTopUpLabel = collateralTopUp.execute
    ? collateralTopUp.status === 'partial' ? 'Partially funded' : 'Ready'
    : collateralTopUp.status === 'needs_funding' ? 'Needs funding' : collateralTopUp.status === 'not_required' ? 'Not required' : 'No debt';
  const collateralTopUpDetail = `${collateralTopUp.detail} Need ${formatUsdAmount(collateralTopUp.collateralUsdNeeded)} · Planned ${formatUsdAmount(collateralTopUp.collateralUsdPlanned)}${Number(collateralTopUp.collateralUsdShortfall || 0) > 0 ? ` · Shortfall ${formatUsdAmount(collateralTopUp.collateralUsdShortfall)}` : ''}.`;
  const safeExitTone = safeExit.execute
    ? 'green'
    : safeExit.status === 'needs_funding' ? 'amber' : 'slate';
  const safeExitLabel = safeExit.execute
    ? 'Ready'
    : safeExit.status === 'needs_funding' ? 'Needs funding' : safeExit.status === 'not_required' ? 'Not required' : 'No position';
  const safeExitDetail = `${safeExit.detail} Repay ${formatUsdAmount(safeExit.repayUsdPlanned)}${Number(safeExit.withdrawUsdPlanned || 0) > 0 ? ` · Withdraw ${formatUsdAmount(safeExit.withdrawUsdPlanned)}` : ''}${Number(safeExit.repayUsdShortfall || 0) > 0 ? ` · Shortfall ${formatUsdAmount(safeExit.repayUsdShortfall)}` : ''}.`;
  const liquidationTone = liquidation.liquidatable
    ? 'red'
    : liquidation.status === 'critical' || liquidation.status === 'unknown'
      ? 'amber'
      : liquidation.status === 'safe'
        ? 'green'
        : 'slate';
  const liquidationLabel = liquidation.liquidatable
    ? 'Liquidatable'
    : liquidation.status === 'critical'
      ? 'Critical band'
      : liquidation.status === 'unknown'
        ? 'Unknown'
        : liquidation.status === 'safe'
          ? 'Safe'
          : 'No debt';
  const liquidationDetail = `${liquidation.detail} Health factor ${formatHealthFactor(liquidation.healthFactor)}.`;
  const reserveCards = reserves.length > 0
    ? reserves
    : LENDING_WATCH_ASSETS.map(asset => ({
        asset,
        market: 'aave_v3',
        source: null,
        isFallback: true,
        fallbackReason: 'aave_pool_not_configured',
      }));

  const statusCards = [
    {
      title: 'Execution Status',
      tone: executionCard.tone,
      label: executionCard.label,
      detail: executionCard.detail,
    },
    {
      title: 'Account Risk',
      tone: getLendingRiskTone(risk.band),
      label: risk.label,
      detail: `${risk.detail} Health factor ${formatHealthFactor(risk.healthFactor)} · LTV ${formatPercentAmount(risk.ltvPct)} · Available borrow ${formatUsdAmount(risk.availableBorrowUsd)}.`,
    },
    {
      title: 'Price Guard',
      tone: priceCard.tone,
      label: priceCard.label,
      detail: priceCard.detail,
    },
    {
      title: 'Carry Mode',
      tone: carryTone,
      label: carryLabel,
      detail: carryDetail,
    },
    {
      title: 'Recovery',
      tone: recoveryTone,
      label: recoveryLabel,
      detail: recoveryDetail,
    },
    {
      title: 'Collateral Top-Up',
      tone: collateralTopUpTone,
      label: collateralTopUpLabel,
      detail: collateralTopUpDetail,
    },
    {
      title: 'Safe Exit',
      tone: safeExitTone,
      label: safeExitLabel,
      detail: safeExitDetail,
    },
    {
      title: 'Liquidation Risk',
      tone: liquidationTone,
      label: liquidationLabel,
      detail: liquidationDetail,
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <ShieldCheck size={18} className="text-slate-400 shrink-0 mt-1" />
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Lending</h3>
            <p className="mt-1 text-sm text-slate-500">Review your lending position, see the current risk picture, and run the available lending actions from one place.</p>
          </div>
        </div>

        {lendingError && <Alert type="error">{lendingError}</Alert>}
        {lendingSurfaceError && <Alert type="error">{lendingSurfaceError}</Alert>}

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {statusCards.map(card => (
            <div key={card.title} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{card.title}</p>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(card.tone)}`}>
                  {card.label}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">{card.detail}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Wallet size={14} className="text-slate-400" />
                <p className="text-sm font-semibold text-slate-800">Connected contract</p>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                This screen is linked to contract {formatAddressShort(lendingSurface?.execution?.contractAddress)}. Actions from this page follow the current connection status shown above.
              </p>
            </div>
            <p className="text-xs text-slate-400">Updated {formatTimestamp(lendingSurface?.prices?.fetchedAt || lendingSnapshot?.fetchedAt)}</p>
          </div>

          {Array.isArray(lendingSurface?.execution?.notes) && lendingSurface.execution.notes.length > 0 && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-3 text-xs text-slate-500">
              {lendingSurface.execution.notes[0]}
            </div>
          )}
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            <Wallet size={14} className="text-slate-400" />
            <p className="text-sm font-semibold text-slate-800">Lending actions</p>
          </div>
          <p className="text-xs text-slate-500">
            You can also find these same actions in Tasks &gt; Paid if you prefer to run them from the task list.
          </p>
          <LendingManualControls agentId={agentId} lendingSurface={lendingSurface} onRunQueued={onRunQueued} />
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <Activity size={18} className="text-slate-400 shrink-0 mt-1" />
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Account and Guard Snapshot</h3>
              <p className="mt-1 text-sm text-slate-500">See wallet balances, supplied amounts, borrowed amounts, and whether each action is available right now.</p>
            </div>
          </div>
          <p className="text-xs text-slate-400">Supplied {formatUsdAmount(risk.totalSuppliedUsd)} · Borrowed {formatUsdAmount(risk.totalBorrowUsd)}</p>
        </div>

        <div className="mt-4 space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Total Supplied</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(risk.totalSuppliedUsd)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Total Borrowed</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(risk.totalBorrowUsd)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Available Borrow</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(risk.availableBorrowUsd)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Health Factor</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{formatHealthFactor(risk.healthFactor)}</p>
            </div>
          </div>

          <LendingAssetSnapshot lendingSurface={lendingSurface} />
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <Coins size={18} className="text-slate-400 shrink-0 mt-1" />
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Carry Readiness</h3>
              <p className="mt-1 text-sm text-slate-500">Read-only carry view from the live lending surface plus the stable LP fee estimate. This shows where yield comes from and what it costs.</p>
            </div>
          </div>
          <p className="text-xs text-slate-400">Watched borrow side {carrySelectedAsset || '—'}</p>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Base Lending Yield</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(lendingYield.grossSupplyUsdPerYear)}</p>
            <p className="mt-1 text-xs text-slate-500">Yearly estimate from current supplied balances.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Borrow Cost</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(lendingYield.grossBorrowCostUsdPerYear)}</p>
            <p className="mt-1 text-xs text-slate-500">Yearly estimate from current borrow APY on visible debt.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Stable LP Fee APY</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{formatPercentAmount(carryLpApyPct)}</p>
            <p className="mt-1 text-xs text-slate-500">Fee-only LP estimate from live pool depth and fee tier.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Estimated Net Yield</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{formatPercentAmount(carryNetApyPct)}</p>
            <p className="mt-1 text-xs text-slate-500">Stable LP fee APY minus the selected borrow APY.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Estimated Yearly Carry</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(carryProjectedDeltaUsd)}</p>
            <p className="mt-1 text-xs text-slate-500">Estimated yearly net carry on the currently tracked carry size.</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">How To Read This</p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Lending can earn on its own. Carry only adds a borrowed LP leg when the extra LP fee estimate still stays above the visible borrow cost on the watched stable asset.
            </p>
          </div>
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">Auto Carry Mode</p>
            <p className="mt-2 text-sm leading-6 text-sky-800">
              {carryAutomationEnabled
                ? 'Auto Carry is enabled. It becomes the only manager of this stable LP carry route while it is active.'
                : 'Auto Carry is currently off. This panel still shows whether the live spread is strong enough to support an active carry decision.'}
            </p>
          </div>
        </div>

        <CarryMigrationControls
          agentId={agentId}
          carry={carry}
          carryAutomationEnabled={carryAutomationEnabled}
          onRunQueued={onRunQueued}
        />
      </Card>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <BarChart3 size={18} className="text-slate-400 shrink-0 mt-1" />
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Reserve Readiness Watch</h3>
              <p className="mt-1 text-sm text-slate-500">Read-only reserve monitor for the first stable assets. It tracks APY, utilization, and whether each reserve feed is live enough for later risk models.</p>
            </div>
          </div>
          <p className="text-xs text-slate-400">Updated {formatTimestamp(lendingSnapshot?.fetchedAt)}</p>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">What This Does Now</p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              This panel does not move funds. It watches reserve APY, borrow APY, utilization, and whether each feed is live or using backup data while you use the lending actions above.
            </p>
          </div>
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">What It Can Unlock Later</p>
            <p className="mt-2 text-sm leading-6 text-sky-800">
              As the reserve model matures, these cards can feed utilization-aware guardrails, market depth checks, and safer lending size limits. Today they are informative, not an execution switch. Auto Carry uses the connected lending surface and stable LP fee model above instead of this watch panel.
            </p>
          </div>
        </div>

        {hasFallbackData && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm leading-6 text-amber-800">
            Some reserve feeds are still monitor-only, so this section is not deciding or limiting the lending actions above yet.
          </div>
        )}

        {loading && reserves.length === 0 ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : (
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {reserveCards.map(reserve => {
              const sourceStatus = getLendingSourceStatus(reserve);
              return (
                <div key={reserve.asset} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-lg font-semibold text-slate-900">{reserve.asset}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatLendingMarketLabel(reserve.market)}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold ${getLendingWatchBadgeClasses(sourceStatus.tone)}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${sourceStatus.tone === 'green' ? 'bg-emerald-500' : sourceStatus.tone === 'blue' ? 'bg-sky-500' : 'bg-slate-400'}`} />
                        {sourceStatus.label}
                      </span>
                      <p className="text-[11px] font-medium text-slate-400">{sourceStatus.caption}</p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Supply APY</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{formatLendingRate(reserve.supplyApy)}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Borrow APY</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{formatLendingRate(reserve.borrowApy, { hideZero: true })}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Utilization</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{formatLendingRate(reserve.utilization, { hideZero: true })}</p>
                    </div>
                  </div>

                  <p className="mt-3 text-xs leading-5 text-slate-500">
                    {reserve.isFallback
                      ? formatLendingFallbackReason(reserve.fallbackReason)
                      : 'Live on-chain reserve data is available for this asset.'}
                  </p>
                </div>
              );
            })}
          </div>
        )}
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
  const [lendingSnapshot, setLendingSnapshot] = useState(() => createEmptyLendingSnapshot());
  const [lendingSurface, setLendingSurface] = useState(() => createEmptyLendingSurface());
  const [lendingError, setLendingError] = useState('');
  const [lendingSurfaceError, setLendingSurfaceError] = useState('');

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!agent?.id) return;

    if (!silent) {
      setLoading(true);
    }
    setError('');

    try {
      const [positionsRes, lendingRes, lendingSurfaceRes, ...snapshotResults] = await Promise.all([
        agentsApi.positions(agent.id).catch(() => ({ positions: [], warnings: [] })),
        oracleApi.reserveState(LENDING_WATCH_ASSETS)
          .then(data => ({ data }))
          .catch(loadError => ({ error: loadError.message || 'Reserve watch data is unavailable right now.' })),
        agentsApi.lending(agent.id)
          .then(data => ({ data }))
          .catch(loadError => ({ error: loadError.message || 'Native lending surface is unavailable right now.' })),
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
      setLendingSnapshot(lendingRes?.data || createEmptyLendingSnapshot());
      setLendingError(lendingRes?.error || '');
      setLendingSurface(lendingSurfaceRes?.data || createEmptyLendingSurface());
      setLendingSurfaceError(lendingSurfaceRes?.error || '');
      setPoolSnapshots(Object.fromEntries(snapshotResults.map(result => [result.key, result])));
    } catch (loadError) {
      setError(loadError.message || 'Failed to load the DeFi surface.');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [agent?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshSurfaceAfterRun = useCallback(() => {
    window.setTimeout(() => {
      load({ silent: true });
    }, 1500);
  }, [load]);

  const positionsByPool = useMemo(() => new Map((positionSnapshot.positions || []).map(position => [position.poolKey, position])), [positionSnapshot.positions]);
  const activeSectionExplanation = DEFI_SECTION_EXPLANATIONS[activeSection] || DEFI_SECTION_EXPLANATIONS.liquidity;

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
              <p className="text-sm text-slate-500">Review live pool data, manage LP positions, and switch to Lending for stable supply and borrow actions.</p>
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

        <div className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-sm font-semibold text-slate-900">{activeSectionExplanation.title}</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">{activeSectionExplanation.detail}</p>
        </div>
      </Card>

      {error && <Alert type="error">{error}</Alert>}

      {activeSection === 'lending' ? (
        <LendingSection
          loading={loading}
          lendingSnapshot={lendingSnapshot}
          lendingError={lendingError}
          lendingSurface={lendingSurface}
          lendingSurfaceError={lendingSurfaceError}
          agentId={agent?.id}
            onRunQueued={refreshSurfaceAfterRun}
        />
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
                    onRunQueued={refreshSurfaceAfterRun}
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