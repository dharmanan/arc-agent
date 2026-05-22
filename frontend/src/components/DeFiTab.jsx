import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgent } from '../providers/AgentProvider.jsx';
import { agents as agentsApi, oracle as oracleApi, defi as defiApi, tasks as tasksApi } from '../lib/api.js';
import { CHAINS } from '../lib/chains.js';
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

const LENDING_WATCH_ASSETS = ['USDC', 'EURC'];
const LENDING_MANUAL_ACTIONS = [
  {
    id: 'supply',
    label: 'Supply',
    title: 'Supply collateral',
    description: 'Supply USDC or EURC into the Arc-native lending lane from the agent wallet.',
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
];

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
    return { tone: 'green', label: 'On-chain live' };
  }
  if (reserve?.isFallback) {
    return { tone: 'amber', label: 'Fallback watch' };
  }
  return { tone: 'slate', label: 'Waiting' };
}

function formatLendingFallbackReason(reason) {
  if (reason === 'aave_pool_not_configured') {
    return 'No live external reserve is configured yet, so this asset stays in watchlist mode while the first lending lane is being built.';
  }
  if (reason === 'reserve_not_available') {
    return 'A reserve target exists, but it did not return live on-chain state. The lending build should not trust it as an execution source yet.';
  }
  if (reason === 'onchain_fetch_failed') {
    return 'On-chain reserve reads failed, so this card is showing fallback watch data while the lending lane remains under construction.';
  }
  if (!reason) {
    return 'This asset is currently part of the lending watchlist while the first Arc lending lane is being designed.';
  }
  return String(reason).replace(/_/g, ' ');
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
      detail: 'The Arc-native lending lane is globally paused.',
    };
  }

  if (execution.ready) {
    return {
      tone: 'green',
      label: 'Live write path',
      detail: `Manual lending writes can use ${execution.source || 'the configured lending adapter'} from this screen.`,
    };
  }

  if (execution.contractAddress && execution.buildState === 'scaffold_only') {
    return {
      tone: 'amber',
      label: 'Scaffold contract',
      detail: 'The contract address exists, but the contract still reports scaffold-only build state, so writes stay guarded.',
    };
  }

  return {
    tone: 'amber',
    label: 'Build in progress',
    detail: 'The Arc-native lending route is wired, but a live lending contract is not configured yet.',
  };
}

function getLendingPriceCard(surface) {
  const priceAssets = Array.isArray(surface?.prices?.assets) ? surface.prices.assets : [];
  const fallbackAssets = priceAssets.filter(asset => asset?.isFallback);

  if (priceAssets.length === 0) {
    return {
      tone: 'slate',
      label: 'Waiting',
      detail: 'Dedicated lending price inputs have not loaded yet.',
    };
  }

  if (fallbackAssets.length > 0) {
    return {
      tone: 'amber',
      label: 'Fallback active',
      detail: `${fallbackAssets.map(asset => asset.symbol).join(', ')} is using a fallback price input right now.`,
    };
  }

  return {
    tone: 'green',
    label: 'Dedicated source',
    detail: 'The lending risk layer is using a dedicated stable-price snapshot for this lane.',
  };
}

function getLendingActionGuard(surface, assetSymbol, actionId) {
  return surface?.actionGuards?.[assetSymbol]?.[actionId] || {
    execute: false,
    detail: 'Guard state is unavailable right now.',
  };
}

function getDefaultLendingManualParams(surface) {
  const assetOptions = Array.isArray(surface?.assets) && surface.assets.length > 0
    ? surface.assets.map(asset => asset.symbol)
    : LENDING_WATCH_ASSETS;

  return {
    asset: assetOptions[0] || 'USDC',
    amount: '',
  };
}

function getLendingManualActionError(params) {
  if (!params.asset) return 'Choose the asset used for this lending action.';
  if (!(Number(params.amount) > 0)) return 'Enter a positive amount for this lending action.';
  return '';
}

function LendingManualFields({ assetOptions, params, setParams }) {
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
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Amount</span>
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

function LendingManualControls({ agentId, lendingSurface, onRunQueued }) {
  const actions = LENDING_MANUAL_ACTIONS;
  const assetOptions = useMemo(() => {
    const assets = Array.isArray(lendingSurface?.assets) ? lendingSurface.assets.map(asset => asset.symbol) : [];
    return assets.length > 0 ? assets : LENDING_WATCH_ASSETS;
  }, [lendingSurface]);
  const [activeActionId, setActiveActionId] = useState(actions[0]?.id || 'supply');
  const activeAction = actions.find(action => action.id === activeActionId) || actions[0] || null;
  const ActionIcon = activeAction?.icon || PlusCircle;
  const [params, setParams] = useState(() => getDefaultLendingManualParams(lendingSurface));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setParams((current) => {
      const nextAsset = assetOptions.includes(current.asset) ? current.asset : (assetOptions[0] || 'USDC');
      return { ...current, asset: nextAsset };
    });
  }, [assetOptions]);

  useEffect(() => {
    setParams(getDefaultLendingManualParams(lendingSurface));
    setMessage('');
    setError('');
  }, [lendingSurface?.execution?.contractAddress, lendingSurface?.execution?.buildState]);

  const activeGuard = getLendingActionGuard(lendingSurface, params.asset, activeAction?.id);

  async function handleSubmit() {
    if (!agentId || !activeAction) return;

    const paramError = getLendingManualActionError(params);
    if (paramError) {
      setError(paramError);
      return;
    }

    setBusy(true);
    setError('');
    setMessage('');

    try {
      const response = await defiApi.manualExecute(agentId, {
        lane: 'lending',
        action: activeAction.id,
        asset: params.asset,
        params: {
          asset: params.asset,
          amount: Number(params.amount),
        },
      });
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
      setError(runError?.data?.detail || runError.message || 'Failed to run the manual lending action.');
    } finally {
      setBusy(false);
    }
  }

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
          <LendingManualFields assetOptions={assetOptions} params={params} setParams={setParams} />
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
      </div>
    </div>
  );
}

function LendingAssetSnapshot({ lendingSurface }) {
  const assets = Array.isArray(lendingSurface?.assets) ? lendingSurface.assets : [];

  if (assets.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-500">
        No native lending asset snapshot is available yet.
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
                Price {formatUsdAmount(asset.price.priceUsd)} · {asset.price.isFallback ? 'Fallback price' : 'Dedicated price source'}
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
            {LENDING_MANUAL_ACTIONS.map((action) => {
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
    return run.error || run.stage_detail || `${fallbackLabel} failed.`;
  }

  return run.result_payload?.summary
    || run.stage_detail
    || `${fallbackLabel} ${String(run.status || 'queued').replace(/_/g, ' ')}.`;
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
    setMessage('');
    setError('');
  }, [poolConfig, activeAction?.id]);

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
            setError(updatedRun.error || updatedRun.stage_detail || 'The manual pool action failed.');
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
      setError(runError.message || 'Failed to run the manual pool action.');
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
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Current Redeemable Underlying</p>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">This is the live token mix your current LP share can withdraw right now, not the last amounts you originally deposited.</p>
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
  const liquidation = lendingSurface?.liquidation || {
    liquidatable: false,
    status: 'idle',
    detail: 'No debt is active, so liquidation is not relevant for this account.',
    healthFactor: risk.healthFactor,
  };
  const recoveryTone = recovery.execute
    ? recovery.status === 'partial' ? 'amber' : 'green'
    : recovery.status === 'needs_funding' ? 'amber' : 'slate';
  const recoveryLabel = recovery.execute
    ? recovery.status === 'partial' ? 'Partially funded' : 'Ready'
    : recovery.status === 'needs_funding' ? 'Needs funding' : recovery.status === 'not_required' ? 'Not required' : 'No debt';
  const recoveryDetail = `${recovery.detail} Need ${formatUsdAmount(recovery.repayUsdNeeded)} · Planned ${formatUsdAmount(recovery.repayUsdPlanned)}${Number(recovery.repayUsdShortfall || 0) > 0 ? ` · Shortfall ${formatUsdAmount(recovery.repayUsdShortfall)}` : ''}.`;
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
      title: 'Recovery',
      tone: recoveryTone,
      label: recoveryLabel,
      detail: recoveryDetail,
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
            <p className="mt-1 text-sm text-slate-500">This lane now shows the Arc-native lending adapter state, visible account risk, and guarded manual actions for the first stable lending scope.</p>
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
                <p className="text-sm font-semibold text-slate-800">Execution source</p>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Source {lendingSurface?.execution?.source || 'arc_native_scaffold'} · Build state {lendingSurface?.execution?.buildState || 'scaffold_only'} · Contract {formatAddressShort(lendingSurface?.execution?.contractAddress)}
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
            <p className="text-sm font-semibold text-slate-800">Manual lending controls</p>
          </div>
          <p className="text-xs text-slate-500">
            The same supply, withdraw, borrow, repay, recovery and liquidation actions now also appear in Tasks &gt; Paid when you prefer the task-based lane.
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
              <p className="mt-1 text-sm text-slate-500">Wallet balances, supplied amounts, borrowed amounts, and per-asset manual guard status for the v1 stable lending scope.</p>
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
            <BarChart3 size={18} className="text-slate-400 shrink-0 mt-1" />
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Reserve Watchlist</h3>
              <p className="mt-1 text-sm text-slate-500">Watch the first stable assets for supply APY, borrow APY, utilization, and fallback state before live execution opens.</p>
            </div>
          </div>
          <p className="text-xs text-slate-400">Updated {formatTimestamp(lendingSnapshot?.fetchedAt)}</p>
        </div>

        {hasFallbackData && (
          <Alert type="warning">Reserve data is still acting as a market watchlist. Lending execution stays disabled while the first Arc lending lane, reserve model, and risk guard are being implemented.</Alert>
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
                      <p className="mt-1 text-xs text-slate-500">{String(reserve.market || 'aave_v3').replace(/_/g, ' ')}</p>
                    </div>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusBadgeClasses(sourceStatus.tone)}`}>
                      {sourceStatus.label}
                    </span>
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