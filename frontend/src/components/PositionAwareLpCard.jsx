import React from 'react';

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
  if (Math.abs(numeric) >= 100) return `${numeric.toFixed(0)}%`;
  if (Math.abs(numeric) >= 10) return `${numeric.toFixed(1).replace(/\.0$/, '')}%`;
  if (Math.abs(numeric) >= 1) return `${numeric.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
  return `${numeric.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function formatStatusPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return formatPercentAmount(numeric);
}

function getPositionRiskStatus(position) {
  const protocol = String(position?.protocol || '').toLowerCase();
  const liquidityState = String(position?.liquidityState || '').toLowerCase();
  const priceImpact10kPct = Number(position?.depthMetrics?.priceImpact10kPct ?? position?.priceImpact?.swap10k);

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

function getStatusBadgeClasses(tone) {
  if (tone === 'blue') return 'border-sky-200 bg-sky-50 text-sky-700';
  if (tone === 'green') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (tone === 'amber') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (tone === 'red') return 'border-rose-200 bg-rose-50 text-rose-700';
  return 'border-slate-200 bg-slate-100 text-slate-700';
}

export default function PositionAwareLpCard({
  position,
  title = 'LP Position',
  subtitle,
  showHeader = true,
  showShareBadge = true,
  emptyLabel = 'No live LP position is currently detected for this agent on this pool.',
  className = '',
}) {
  if (!position) {
    return (
      <div className={`rounded-xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-500 ${className}`.trim()}>
        {emptyLabel}
      </div>
    );
  }

  const headerSubtitle = subtitle || `${position.lpToken?.symbol || 'LP position'} · ${position.chain || 'Arc Testnet'}`;
  const statusCards = getPositionStatusCards(position);
  const shareLabel = formatPercentAmount(position.sharePct);
  const yieldNote = position?.yieldMetrics?.note
    ? `${position.yieldMetrics.note}${position.yieldMetrics?.isCapped ? ' Safety cap applied to keep the estimate in a realistic range.' : ''}`
    : '';

  return (
    <div className={`space-y-3 rounded-xl border border-slate-200 bg-white p-4 ${className}`.trim()}>
      {showHeader && (
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
            <p className="mt-1 text-xs text-slate-500">{headerSubtitle}</p>
          </div>
          {showShareBadge && (
            <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              {shareLabel} share
            </span>
          )}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
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
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Est. Fee APR</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatPercentAmount(position.yieldMetrics?.aprPct)}</p>
          <p className="mt-1 text-[11px] text-slate-500">Trading fees only, not claimable rewards</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Est. Fee APY</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatPercentAmount(position.yieldMetrics?.apyPct)}</p>
          <p className="mt-1 text-[11px] text-slate-500">Compounded run-rate estimate</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Yield Run-Rate</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{formatUsdAmount(position.yieldMetrics?.dailyUsd)}</p>
          <p className="mt-1 text-[11px] text-slate-500">Weekly {formatUsdAmount(position.yieldMetrics?.weeklyUsd)}</p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {statusCards.map((card) => (
          <div key={`${position.poolAddress || position.poolKey}:${card.title}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
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
          {(position.underlying || []).map((asset) => (
            <div key={`${position.poolAddress || position.poolKey}:${asset.symbol}`} className="flex items-start justify-between gap-3">
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

      {yieldNote && (
        <p className="text-[11px] leading-5 text-slate-500">{yieldNote}</p>
      )}
    </div>
  );
}