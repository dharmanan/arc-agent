import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Brain, RefreshCw, Coins, ShieldCheck, Radio, Wallet, Cable, CircleDollarSign,
} from 'lucide-react';
import { oracle as oracleApi } from '../lib/api.js';
import { useAgent } from '../providers/AgentProvider.jsx';
import {
  Card, Alert, AddressBox, Spinner, Button, SectionHeader,
} from './ui/index.jsx';

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatUsdcBalance(value) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toFixed(6)} USDC` : `${value} USDC`;
}

function parseUsdcAmount(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function humanizeGatewayRail(rail) {
  const normalized = String(rail || '').trim().toLowerCase();

  if (normalized === 'agentic_automation_economy') return 'Automation fees';
  if (normalized === 'agentic_task_economy') return 'Task fees';
  if (normalized === 'agentic_job_economy') return 'Job fees';
  if (normalized === 'circle_paid_info_unlock') return 'Paid unlocks';
  if (normalized === 'circle_gateway') return 'Gateway buyer payments';

  return String(rail || 'Unknown rail')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function humanizeGatewayReferenceType(referenceType) {
  const normalized = String(referenceType || '').trim().toLowerCase();

  if (normalized === 'automation') return 'automation';
  if (normalized === 'task') return 'task';
  if (normalized === 'job') return 'job';
  if (normalized === 'circle_paid_unlock') return 'paid unlock';

  return normalized || 'payment';
}

function getOracleWarnings(oracleOverview) {
  const warnings = [];

  if (!oracleOverview?.config) return warnings;

  if (!oracleOverview.config.payToConfigured) {
    warnings.push('Public payment address is missing. Buyers cannot complete paid verification yet.');
  }
  if (!oracleOverview.config.pools?.usdcEurcConfigured) {
    warnings.push('The Curve USDC/EURC pool is not connected. Pool state and arbitrage reads may fall back to sample data.');
  }
  if (!oracleOverview.config.pools?.wusdcUsdcConfigured) {
    warnings.push('WUSDC/USDC oracle reads are unavailable.');
  }
  if (!oracleOverview.config.pools?.eurcWusdcConfigured) {
    warnings.push('EURC/WUSDC oracle reads are unavailable.');
  }

  const seller = oracleOverview?.gateway?.seller;
  const facilitatorError = seller?.facilitator?.supportedCache?.lastError;
  if (seller?.authRequired && !seller?.authConfigured) {
    warnings.push(`Circle Gateway auth is incomplete for mode ${seller.authMode}.`);
  }
  if (facilitatorError?.message) {
    warnings.push(`Circle Gateway facilitator error: ${facilitatorError.message}`);
  }

  const settlementFailures = Number(oracleOverview?.observability?.signalCounts?.settlement_failure || 0);
  const serverErrors = Number(oracleOverview?.observability?.signalCounts?.server_error || 0);
  const alertDeliveryFailures = Number(oracleOverview?.observability?.alerting?.failedCount || 0);

  if (settlementFailures > 0) {
    warnings.push(`Settlement failures observed: ${settlementFailures}.`);
  }
  if (serverErrors > 0) {
    warnings.push(`Public server errors observed: ${serverErrors}.`);
  }
  if (alertDeliveryFailures > 0) {
    warnings.push(`Alert delivery failures observed: ${alertDeliveryFailures}.`);
  }

  return warnings;
}

const PAYMENT_FLOW_STEPS = [
  {
    title: 'Request data',
    description: 'A caller hits a public oracle route such as Stablecoin FX, Yield Rank or Arb Signal.',
  },
  {
    title: 'Receive 402 challenge',
    description: 'The oracle returns price, chain and destination details instead of serving the data for free.',
  },
  {
    title: 'Send payment proof',
    description: 'The caller pays in USDC and retries with payment proof so the oracle can verify the request.',
  },
  {
    title: 'Unlock the response',
    description: 'Once the payment is verified, the oracle serves the requested data and records the revenue event.',
  },
];

const ORACLE_EXPLANATION_CARDS = [
  {
    title: 'What this tab is for',
    description: 'Use this page to see whether the oracle can sell data to outside buyers right now.',
    Icon: Brain,
  },
  {
    title: 'Why it matters',
    description: 'If the oracle is healthy, agents can earn from stablecoin FX, pool state, yield ranking, and arbitrage signals.',
    Icon: CircleDollarSign,
  },
  {
    title: 'What to inspect here',
    description: 'Check payment readiness, endpoint availability, revenue, warnings, and the address that receives oracle payments.',
    Icon: ShieldCheck,
  },
];

const PUBLIC_BUYER_GUIDE_URL = '/oracle-public-buyer-guide.html';
const PUBLIC_BUYER_EXAMPLE_URL = '/downloads/oraclePublicBuyerExample.js';
const PUBLIC_BUYER_HELPER_URL = '/downloads/arcOracleBuyerHelper.js';
const MANUAL_GATEWAY_FUND_USDC = '1';
const EXTERNAL_DEX_LABELS = {
  curve: 'Curve',
  uniswapV2Like: 'Uniswap V2-like',
  arcFx: 'ArcFX',
  aaveLike: 'Aave-like',
};
const EXTERNAL_DEX_QUERY_VENUES = {
  curve: 'curve',
  uniswapV2Like: 'uniswap_v2_like',
  arcFx: 'arcfx',
  aaveLike: 'aave_like',
};
const CURVE_DEPENDENT_ENDPOINTS = new Set([
  'stablecoin-fx',
  'pool-state',
  'pool-compare',
  'arb-signal',
  'arb-scan-multi',
]);

const ORACLE_PRODUCT_GROUPS = [
  {
    key: 'execution_data',
    title: 'Execution Data',
    description: 'Use these before a real move on Arc. They expose live pool, peg, or reserve context that is closest to execution-time reality.',
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  {
    key: 'macro_research',
    title: 'Macro Research',
    description: 'Use these to understand broader market or capital-allocation context. They are helpful research inputs, not direct execution routes.',
    tone: 'border-blue-200 bg-blue-50 text-blue-800',
  },
  {
    key: 'signal_estimate',
    title: 'Signal Estimate',
    description: 'Use these as scanners. They point at a candidate setup, but the final trade still needs a live exit route and fresh execution checks.',
    tone: 'border-amber-200 bg-amber-50 text-amber-800',
  },
];

const ORACLE_PRODUCT_META = {
  'stablecoin-fx': {
    group: 'execution_data',
    label: 'Execution data',
    readiness: 'Live FX + pool read',
    bestFor: 'Checking whether the live Arc EURC lane is dislocated enough to deserve a closer look.',
    caveat: 'Treat it as a pricing input, not as a trade instruction by itself.',
  },
  'pool-state': {
    group: 'execution_data',
    label: 'Execution data',
    readiness: 'Live pool snapshot',
    bestFor: 'Reading reserves, implied rate, fees, and price impact before using a lane.',
    caveat: 'It is strongest on verified Curve lanes. Experimental venues still need manual judgment.',
  },
  'peg-monitor': {
    group: 'execution_data',
    label: 'Execution data',
    readiness: 'Live peg monitor',
    bestFor: 'Watching stablecoin peg health before routing stable capital.',
    caveat: 'It tells you whether the peg looks stressed, not whether a swap route is executable.',
  },
  'reserve-state': {
    group: 'execution_data',
    label: 'Execution data',
    readiness: 'Watchlist reserve read',
    bestFor: 'Checking reserve APY and utilization when the deployment can read that reserve live.',
    caveat: 'This deployment can fall back to yield hints when on-chain reserve data is unavailable.',
  },
  'pool-compare': {
    group: 'execution_data',
    label: 'Execution data',
    readiness: 'Live venue comparison',
    bestFor: 'Comparing multiple quoted lanes side by side before choosing where to inspect next.',
    caveat: 'It compares quotes and liquidity states. It does not settle or simulate the full trade lifecycle.',
  },
  'protocol-tvl': {
    group: 'macro_research',
    label: 'Macro research',
    readiness: 'Protocol watchlist',
    bestFor: 'Comparing broad protocol size and recent direction when deciding where to do more research.',
    caveat: 'This is a global watchlist view, not an Arc-native execution route.',
  },
  'yield-rank': {
    group: 'macro_research',
    label: 'Macro research',
    readiness: 'Cross-market research',
    bestFor: 'Scanning broad yield venues for research and idea generation.',
    caveat: 'It is not limited to Arc-native routes, so treat it as research rather than an action queue.',
  },
  'prediction-market-check': {
    group: 'macro_research',
    label: 'Macro research',
    readiness: 'Live regime overlay',
    bestFor: 'Adding a macro risk overlay before deciding how defensive or aggressive to be.',
    caveat: 'It is a market-regime lens, not a direct execution surface.',
  },
  'arb-signal': {
    group: 'signal_estimate',
    label: 'Signal estimate',
    readiness: 'Cost-aware scanner',
    bestFor: 'Spotting whether a stablecoin lane deserves a live execution review.',
    caveat: 'The signal is now cost-aware, but a real trade still depends on the current exit route clearing its floor.',
  },
  'arb-scan-multi': {
    group: 'signal_estimate',
    label: 'Signal estimate',
    readiness: 'Multi-lane scanner',
    bestFor: 'Ranking several lanes quickly to decide which one deserves closer execution review.',
    caveat: 'Use it to shortlist lanes, then confirm the final entry and exit path before sending capital.',
  },
};

function getOracleProductMeta(endpointKey) {
  return ORACLE_PRODUCT_META[endpointKey] || {
    group: 'macro_research',
    label: 'Research surface',
    readiness: 'General read',
    bestFor: 'Inspecting the current oracle output for this surface.',
    caveat: 'Confirm execution details separately before trading on it.',
  };
}

function getOracleEndpointBadges(endpointKey, { payToConfigured, curveConfigured }) {
  const paymentBadge = payToConfigured
    ? {
        label: 'Payment gated',
        tone: 'border-green-200 bg-green-50 text-green-700',
      }
    : {
        label: 'Payment blocked',
        tone: 'border-red-200 bg-red-50 text-red-700',
      };

  if (CURVE_DEPENDENT_ENDPOINTS.has(endpointKey)) {
    return [
      paymentBadge,
      curveConfigured
        ? {
            label: 'Live route',
            tone: 'border-blue-200 bg-blue-50 text-blue-700',
          }
        : {
            label: 'Fallback risk',
            tone: 'border-amber-200 bg-amber-50 text-amber-800',
          },
    ];
  }

  return [
    paymentBadge,
    {
      label: 'Live read',
      tone: 'border-blue-200 bg-blue-50 text-blue-700',
    },
  ];
}

function OracleTrustPanel({
  payToConfigured,
  publicChallengeCount,
  curveConfigured,
  gatewayFundingState,
  operatorNote,
}) {
  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-indigo-600" />
          <h3 className="text-lg font-semibold text-slate-900">Buyer Readiness</h3>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className={`rounded-xl border px-4 py-3 text-xs ${payToConfigured ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
            <p className="text-[11px] font-semibold uppercase tracking-wide">Payment Gate</p>
            <p className="mt-1 text-sm font-semibold">{payToConfigured ? '402 flow is configured' : '402 flow is blocked'}</p>
            <p className="mt-1 leading-5">
              {payToConfigured
                ? 'Public buyers should expect a 402 challenge first, then a paid retry with payment proof.'
                : 'ORACLE_PAY_ADDRESS is missing, so public buyers cannot complete paid verification yet.'}
            </p>
          </div>

          <div className={`rounded-xl border px-4 py-3 text-xs ${curveConfigured ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            <p className="text-[11px] font-semibold uppercase tracking-wide">Data Source</p>
            <p className="mt-1 text-sm font-semibold">{curveConfigured ? 'Verified live reads only' : 'Fallback risk'}</p>
            <p className="mt-1 leading-5">
              {curveConfigured
                ? 'Current canonical reads are coming from configured live sources.'
                : 'Some core pool reads may fall back until the main Curve pool is configured.'}
            </p>
          </div>

          <div className={`rounded-xl border px-4 py-3 text-xs ${gatewayFundingState.tone}`}>
            <p className="text-[11px] font-semibold uppercase tracking-wide">Buyer Funding</p>
            <p className="mt-1 text-sm font-semibold">{gatewayFundingState.title}</p>
            <p className="mt-1 leading-5">{gatewayFundingState.body}</p>
          </div>

          <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-500">Watch now</p>
            <p className="mt-1 text-sm font-semibold text-blue-900">Current focus</p>
            <p className="mt-1 leading-5">{operatorNote}</p>
            <p className="mt-2 text-[11px] text-blue-700">402 challenges seen: {publicChallengeCount.toLocaleString()}</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function OracleTab() {
  const { agent } = useAgent();
  const [oracleOverview, setOracleOverview] = useState(null);
  const [oracleError, setOracleError] = useState('');
  const [loading, setLoading] = useState(false);
  const [gatewayBalance, setGatewayBalance] = useState(null);
  const [gatewayBalanceError, setGatewayBalanceError] = useState('');
  const [gatewayBalanceLoading, setGatewayBalanceLoading] = useState(false);
  const [gatewayFundLoading, setGatewayFundLoading] = useState(false);
  const [gatewayFundError, setGatewayFundError] = useState('');
  const [gatewayFundResult, setGatewayFundResult] = useState(null);
  const gatewayAutoTopupEnabled = agent?.settings?.gatewayAutoTopupEnabled !== false;
  const gatewayAutoTopupMinUsdc = Math.max(Number(agent?.settings?.gatewayAutoTopupMinUsdc || 1), 1);
  const gatewayAutoTopupTargetUsdc = Math.max(Number(agent?.settings?.gatewayAutoTopupTargetUsdc || 3), gatewayAutoTopupMinUsdc);

  const load = useCallback(async () => {
    setLoading(true);
    setOracleError('');

    try {
      const data = await oracleApi.status();
      setOracleOverview(data);
    } catch (error) {
      setOracleOverview(null);
      setOracleError(error.message || 'Failed to load oracle status');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGatewayBalance = useCallback(async () => {
    if (!agent?.id) {
      setGatewayBalance(null);
      setGatewayBalanceError('');
      setGatewayFundError('');
      setGatewayFundResult(null);
      return;
    }

    setGatewayBalanceLoading(true);
    setGatewayBalanceError('');

    try {
      const data = await oracleApi.gatewayBalance(agent.id);
      setGatewayBalance(data);
    } catch (error) {
      setGatewayBalance(null);
      setGatewayBalanceError(error.message || 'Failed to load Gateway balance');
    } finally {
      setGatewayBalanceLoading(false);
    }
  }, [agent?.id]);

  const handleManualGatewayFund = useCallback(async () => {
    if (!agent?.id) return;

    setGatewayFundLoading(true);
    setGatewayFundError('');
    setGatewayFundResult(null);

    try {
      const data = await oracleApi.fundGateway(agent.id, { amountUsdc: MANUAL_GATEWAY_FUND_USDC });
      setGatewayBalance(data);
      setGatewayFundResult({
        amountUsdc: data.amountUsdc,
        approvalTxHash: data.deposit?.approvalTxHash || null,
        depositTxHash: data.deposit?.depositTxHash || null,
      });
    } catch (error) {
      setGatewayFundError(error.message || 'Failed to fund Gateway balance');
    } finally {
      setGatewayFundLoading(false);
    }
  }, [agent?.id]);

  const refreshAll = useCallback(() => {
    void load();
    void loadGatewayBalance();
  }, [load, loadGatewayBalance]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    void loadGatewayBalance();
  }, [loadGatewayBalance]);

  const warnings = useMemo(() => getOracleWarnings(oracleOverview), [oracleOverview]);
  const hasWarnings = warnings.length > 0;
  const gatewaySeller = oracleOverview?.gateway?.seller;
  const gatewayBuyer = oracleOverview?.gateway?.buyer;
  const gatewayTaskEconomy = oracleOverview?.gateway?.taskEconomy;
  const gatewayJobEconomy = oracleOverview?.gateway?.jobEconomy;
  const gatewayAudit = oracleOverview?.gateway?.audit;
  const facilitatorCache = gatewaySeller?.facilitator?.supportedCache;
  const externalDexEntries = Object.entries(oracleOverview?.marketCoverage?.externalDexes || {});
  const oracleObservability = oracleOverview?.observability;
  const oracleAlerting = oracleObservability?.alerting;
  const signalCounts = oracleObservability?.signalCounts || {};
  const fallbackCounts = oracleObservability?.fallbackCounts || {};
  const totalFallbacks = Object.values(fallbackCounts).reduce((total, value) => total + Number(value || 0), 0);
  const recentFallbackEntries = oracleObservability?.recentFallbacks || [];
  const recentFallbacks = recentFallbackEntries.slice(0, 3);
  const recentAlertDeliveries = (oracleAlerting?.recentDeliveries || []).slice(0, 3);
  const configuredAlertSinks = (oracleAlerting?.sinks || []).slice(0, 3);
  const gatewayAvailability = String(gatewayBalance?.availability || '').trim().toLowerCase();
  const gatewayBalanceTemporarilyUnavailable = gatewayAvailability === 'temporarily_unavailable'
    || (Boolean(gatewayBalance) && gatewayBalance.wallet == null && gatewayBalance.gateway == null);
  const walletAvailableForManualFund = parseUsdcAmount(gatewayBalance?.wallet?.availableUsdc);
  const gatewayUsageSummary = Array.isArray(gatewayBalance?.usage?.summary) ? gatewayBalance.usage.summary : [];
  const gatewayRecentUsage = Array.isArray(gatewayBalance?.usage?.recent) ? gatewayBalance.usage.recent : [];
  const canManualFundGateway = walletAvailableForManualFund != null
    && walletAvailableForManualFund >= Number(MANUAL_GATEWAY_FUND_USDC)
    && !gatewayBalanceTemporarilyUnavailable;
  const statusLabel = oracleError ? 'Needs attention' : hasWarnings ? 'Warnings' : 'Live';
  const statusClasses = oracleError
    ? 'border-red-200 bg-red-50 text-red-700'
    : hasWarnings
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : 'border-green-200 bg-green-50 text-green-700';
  const payToConfigured = Boolean(oracleOverview?.config?.payToConfigured);
  const publicChallengeCount = Number(signalCounts.payment_challenge || 0);
  const gatewayFundingState = !agent?.id
    ? {
        tone: 'border-slate-200 bg-slate-50 text-slate-600',
        title: 'No agent selected',
        body: 'Connect or reconnect an agent to inspect wallet USDC and Gateway available balance for buyer-side payments.',
      }
    : gatewayBalanceTemporarilyUnavailable
      ? {
          tone: 'border-amber-200 bg-amber-50 text-amber-800',
          title: 'Gateway balance temporarily unavailable',
          body: 'Arc RPC is cooling down, so wallet and Gateway balances cannot be confirmed right now. Retry shortly; do not treat this as a wallet funding failure.',
        }
    : gatewayBalance?.funded
      ? {
          tone: 'border-green-200 bg-green-50 text-green-700',
          title: 'Gateway balance is warm',
          body: 'This agent can pay public x402 routes without an extra deposit step right now.',
        }
      : canManualFundGateway
        ? {
            tone: 'border-amber-200 bg-amber-50 text-amber-800',
            title: 'Will fund on demand',
            body: gatewayAutoTopupEnabled
              ? `The wallet has enough USDC. Supported payments can already refill Gateway on demand. Auto-topup will seed Gateway to ${gatewayAutoTopupMinUsdc} USDC on the next incoming USDC, then later refill it back to ${gatewayAutoTopupTargetUsdc} USDC whenever the available balance falls below ${gatewayAutoTopupMinUsdc} USDC.`
              : 'The wallet has enough USDC, so the buyer helper can deposit into Gateway during the first paid request or you can pre-fund it manually below.',
          }
        : {
            tone: 'border-red-200 bg-red-50 text-red-700',
            title: 'Buyer wallet needs funds',
            body: gatewayAutoTopupEnabled
              ? `Auto-topup is on, but the selected agent still needs wallet USDC before it can warm Gateway back above ${gatewayAutoTopupMinUsdc} USDC.`
              : `The selected agent needs at least ${MANUAL_GATEWAY_FUND_USDC} USDC in the wallet before manual Gateway funding can run.`,
          };
  const operatorNote = gatewayBalanceTemporarilyUnavailable
    ? 'Balance reads are temporarily unavailable while Arc RPC cools down. Keep usage history visible and retry shortly.'
    : gatewayBalance?.funded
      ? 'Buyers can use the normal 402 -> pay -> retry flow. Keep an eye on fallback warnings and settlement failures.'
      : 'If this agent will buy oracle data, keep wallet USDC and ARC gas ready.';
  const curveConfigured = Boolean(oracleOverview?.config?.pools?.usdcEurcConfigured);
  const productMatrix = useMemo(() => ORACLE_PRODUCT_GROUPS.map((group) => {
    const endpoints = (oracleOverview?.publicEndpoints || []).filter(endpoint => getOracleProductMeta(endpoint.key).group === group.key);
    return {
      ...group,
      endpoints,
    };
  }), [oracleOverview?.publicEndpoints]);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Oracle"
        subtitle="Paid oracle status, buyer flow, and revenue readiness."
      />

      <Card className="space-y-5 border-blue-100 bg-[radial-gradient(circle_at_top_left,rgba(219,234,254,0.95),rgba(255,255,255,1),rgba(240,253,250,0.9))]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 flex-wrap">
              <Brain size={18} className="text-blue-600" />
              <h2 className="text-xl font-bold text-slate-900">Arc Oracle Service</h2>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusClasses}`}>
                {statusLabel}
              </span>
              <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                {oracleOverview?.network || 'arc-testnet'}
              </span>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              See what the oracle sells, how payment works, and whether this deployment is ready for paid buyer traffic.
            </p>
          </div>

          <Button size="sm" variant="ghost" onClick={refreshAll} disabled={loading || gatewayBalanceLoading} className="self-start px-4 py-2 text-sm">
            {loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
            Refresh
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {ORACLE_EXPLANATION_CARDS.map(({ title, description, Icon }) => (
            <div key={title} className="rounded-xl border border-slate-200 bg-white/80 px-4 py-4">
              <div className="flex items-center gap-2">
                <Icon size={15} className="text-slate-600" />
                <p className="text-sm font-semibold text-slate-800">{title}</p>
              </div>
              <p className="mt-2 text-xs text-slate-500">{description}</p>
            </div>
          ))}
        </div>
      </Card>

      {oracleError && <Alert type="warning">{oracleError}</Alert>}

      {!oracleError && hasWarnings && (
        <Alert type="warning">
          <div className="space-y-1">
            <p className="font-semibold">Oracle configuration warnings</p>
            {warnings.map(message => (
              <p key={message} className="text-xs">{message}</p>
            ))}
          </div>
        </Alert>
      )}

      {!oracleError && (
        <OracleTrustPanel
          payToConfigured={payToConfigured}
          publicChallengeCount={publicChallengeCount}
          curveConfigured={curveConfigured}
          gatewayFundingState={gatewayFundingState}
          operatorNote={operatorNote}
        />
      )}

      <Card className="space-y-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-2">
            <Cable size={16} className="text-teal-600" />
            <h3 className="text-lg font-semibold text-slate-900">Buyer Guide</h3>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 xl:min-w-[640px] xl:flex-1 xl:pl-6">
            <a
              href={PUBLIC_BUYER_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-arc-green px-4 py-3 text-sm font-semibold text-white transition hover:bg-arc-greenHover"
            >
              Open Buyer Guide
            </a>
            <a
              href={PUBLIC_BUYER_EXAMPLE_URL}
              download
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-[#66D121]/40 hover:bg-arc-greenBg hover:text-arc-green"
            >
              Download Example
            </a>
            <a
              href={PUBLIC_BUYER_HELPER_URL}
              download
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-[#66D121]/40 hover:bg-arc-greenBg hover:text-arc-green"
            >
              Download Helper
            </a>
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 space-y-2">
            <p>
              This guide explains the paid oracle flow for both people and apps.
              Open it in the browser for a quick walkthrough.
            </p>
            <p>
              Downloads are optional. Use them only if you want ready-to-run example files.
            </p>
          </div>

          <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
            <strong>Who this is for:</strong>
            {' '}
            the guide works for both human buyers and automated buyers. The same link is also returned in the live 402 response so apps can discover it automatically.
          </div>
        </div>
      </Card>

      <div className="space-y-4">
        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <Radio size={16} className="text-blue-600" />
            <h3 className="text-lg font-semibold text-slate-900">Live Service Status</h3>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Revenue</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{Number(oracleOverview?.revenue?.totalUsdc || 0).toFixed(3)} USDC</p>
              <p className="text-xs text-slate-500">Verified oracle payment records.</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Paid Requests</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{Number(oracleOverview?.revenue?.requestCount || 0).toLocaleString()}</p>
              <p className="text-xs text-slate-500">Successful public verifications.</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Public Endpoints</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{Number(oracleOverview?.publicEndpoints?.length || 0)}</p>
              <p className="text-xs text-slate-500">Routes currently sold to external callers.</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Cache</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{Number(oracleOverview?.cache?.keys || 0)} keys</p>
              <p className="text-xs text-slate-500">
                Hits {Number(oracleOverview?.cache?.hits || 0).toLocaleString()} · Misses {Number(oracleOverview?.cache?.misses || 0).toLocaleString()}
              </p>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-800">Endpoint Catalog</p>
              <span className="text-xs text-slate-400">Current public x402 products</span>
            </div>

            <div className="mb-4 grid gap-3 xl:grid-cols-3">
              {productMatrix.map((group) => (
                <div key={group.key} className={`rounded-xl border px-4 py-3 text-xs ${group.tone}`}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide">{group.title}</p>
                  <p className="mt-2 text-sm font-semibold">{group.endpoints.length} endpoint{group.endpoints.length === 1 ? '' : 's'}</p>
                  <p className="mt-1 leading-5">{group.description}</p>
                  <p className="mt-2 text-[11px] opacity-80">
                    {group.endpoints.length > 0
                      ? group.endpoints.map(endpoint => endpoint.title).join(' · ')
                      : 'No endpoints in this class on the current deployment.'}
                  </p>
                </div>
              ))}
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              {(oracleOverview?.publicEndpoints || []).map(endpoint => (
                <div key={endpoint.key} className="rounded-xl border border-slate-200 bg-white p-4">
                  {(() => {
                    const productMeta = getOracleProductMeta(endpoint.key);
                    return (
                      <>
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                            {productMeta.label}
                          </span>
                          <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500">
                            {productMeta.readiness}
                          </span>
                        </div>
                      </>
                    );
                  })()}
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {getOracleEndpointBadges(endpoint.key, {
                      payToConfigured,
                      curveConfigured,
                    }).map((badge) => (
                      <span
                        key={`${endpoint.key}-${badge.label}`}
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.tone}`}
                      >
                        {badge.label}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{endpoint.title}</p>
                      <p className="mt-1 text-xs text-slate-500">{endpoint.description}</p>
                    </div>
                    <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                      {endpoint.priceUsdc} USDC
                    </span>
                  </div>
                  <p className="mt-3 rounded-lg bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-slate-500">
                    {endpoint.path}
                  </p>

                  <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 space-y-1.5">
                    <p><strong className="text-slate-700">Best for:</strong> {getOracleProductMeta(endpoint.key).bestFor}</p>
                    <p><strong className="text-slate-700">Caveat:</strong> {getOracleProductMeta(endpoint.key).caveat}</p>
                  </div>

                  {Array.isArray(endpoint.supportedVenues) && endpoint.supportedVenues.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {endpoint.supportedVenues.map(venue => (
                        <span key={`${endpoint.key}-${venue}`} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          {venue}
                        </span>
                      ))}
                    </div>
                  )}

                  {Array.isArray(endpoint.supportedPairs) && endpoint.supportedPairs.length > 0 && (
                    <p className="mt-3 text-xs text-slate-500">
                      <strong className="text-slate-700">Pairs:</strong>
                      {' '}
                      {endpoint.supportedPairs.join(', ')}
                    </p>
                  )}

                  {Array.isArray(endpoint.supportedPools) && endpoint.supportedPools.length > 0 && (
                    <p className="mt-3 text-xs text-slate-500">
                      <strong className="text-slate-700">Pools:</strong>
                      {' '}
                      {endpoint.supportedPools.join(', ')}
                    </p>
                  )}

                  {Array.isArray(endpoint.exampleQueries) && endpoint.exampleQueries.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Example queries</p>
                      {endpoint.exampleQueries.map(query => (
                        <p key={`${endpoint.key}-${query}`} className="rounded-lg bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-slate-500 break-all">
                          {query}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <Wallet size={16} className="text-emerald-600" />
            <h3 className="text-lg font-semibold text-slate-900">Payment Readiness</h3>
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(280px,0.95fr)] xl:items-start">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-1.5 h-full">
              <p><strong className="text-slate-700">Last updated:</strong> {formatTimestamp(oracleOverview?.timestamp)}</p>
              <p><strong className="text-slate-700">Payment token:</strong> {oracleOverview?.payment?.token || 'USDC'}</p>
              <p><strong className="text-slate-700">Chain:</strong> {oracleOverview?.payment?.chain || 'arc-testnet'}</p>
              <p><strong className="text-slate-700">Chain ID:</strong> {oracleOverview?.payment?.chainId || '—'}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-1.5 h-full">
              <p><strong className="text-slate-700">Pay-to configured:</strong> {oracleOverview?.config?.payToConfigured ? 'Yes' : 'No'}</p>
              <p><strong className="text-slate-700">USDC/EURC pool:</strong> {oracleOverview?.config?.pools?.usdcEurcConfigured ? 'Configured' : 'Missing'}</p>
              <p><strong className="text-slate-700">EURC/WUSDC pool:</strong> {oracleOverview?.config?.pools?.eurcWusdcConfigured ? 'Configured' : 'Missing'}</p>
              <p><strong className="text-slate-700">WUSDC/USDC pool:</strong> {oracleOverview?.config?.pools?.wusdcUsdcConfigured ? 'Configured' : 'Missing'}</p>
              <p><strong className="text-slate-700">USDC/USYC pool:</strong> {oracleOverview?.config?.pools?.usdcUsycConfigured ? 'Configured' : 'Missing'}</p>
            </div>

            <div className="h-full">
              {oracleOverview?.payment?.address ? (
                <AddressBox address={oracleOverview.payment.address} label="Oracle Pay-To Address" compact />
              ) : (
                <Alert type="warning">Oracle pay-to address is not configured yet.</Alert>
              )}
            </div>
          </div>
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-indigo-600" />
            <h3 className="text-lg font-semibold text-slate-900">Data Quality & Observability</h3>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">402 Challenges</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{Number(signalCounts.payment_challenge || 0).toLocaleString()}</p>
              <p className="text-xs text-slate-500">Public payment challenges observed since boot.</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">429 Rate Limits</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{Number(signalCounts.rate_limited || 0).toLocaleString()}</p>
              <p className="text-xs text-slate-500">Gateway or route throttling signals.</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Settlement Failures</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{Number(signalCounts.settlement_failure || 0).toLocaleString()}</p>
              <p className="text-xs text-slate-500">Paid retries that failed to settle cleanly.</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Fallback Events</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{totalFallbacks.toLocaleString()}</p>
              <p className="text-xs text-slate-500">Degraded upstream reads recorded since boot.</p>
            </div>
          </div>

          <div className="grid gap-3 xl:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-1.5">
              <p><strong className="text-slate-700">Observability window:</strong> Since process start</p>
              <p><strong className="text-slate-700">Started at:</strong> {formatTimestamp(oracleObservability?.startedAt)}</p>
              <p><strong className="text-slate-700">5xx errors:</strong> {Number(signalCounts.server_error || 0).toLocaleString()}</p>
              <p><strong className="text-slate-700">Gateway unavailable:</strong> {Number(signalCounts.gateway_unavailable || 0).toLocaleString()}</p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-1.5">
              <p><strong className="text-slate-700">Alert backend:</strong> {oracleAlerting?.delivery || 'database'}</p>
              <p><strong className="text-slate-700">External sinks:</strong> {Number(oracleAlerting?.sinkCount || 0).toLocaleString()}</p>
              <p><strong className="text-slate-700">Sink timeout:</strong> {Number(oracleAlerting?.timeoutMs || 0).toLocaleString()} ms</p>
              <p><strong className="text-slate-700">Alerts stored:</strong> {Number(oracleAlerting?.storedCount || 0).toLocaleString()}</p>
              <p><strong className="text-slate-700">Webhook forwarded:</strong> {Number(oracleAlerting?.sentCount || 0).toLocaleString()}</p>
              <p><strong className="text-slate-700">Webhook skipped:</strong> {Number(oracleAlerting?.suppressedCount || 0).toLocaleString()}</p>
              <p><strong className="text-slate-700">Delivery failures:</strong> {Number(oracleAlerting?.failedCount || 0).toLocaleString()}</p>
              <p><strong className="text-slate-700">Last alert sent:</strong> {formatTimestamp(oracleAlerting?.lastSentAt)}</p>
              {oracleAlerting?.lastError?.message ? (
                <p><strong className="text-slate-700">Last sink error:</strong> {oracleAlerting.lastError.message}</p>
              ) : null}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-2">
              <p className="font-semibold text-slate-700">Recent fallback components</p>
              {recentFallbacks.length > 0 ? recentFallbacks.map((entry) => (
                <div key={`${entry.component}-${entry.timestamp}`} className="rounded-lg bg-slate-50 px-3 py-2">
                  <p className="font-semibold text-slate-700">{entry.component}</p>
                  <p className="mt-1 text-slate-500">{entry.meta?.reason || 'fallback_recorded'}</p>
                  <p className="mt-1 text-[11px] text-slate-400">{formatTimestamp(entry.timestamp)}</p>
                </div>
              )) : (
                <p className="text-slate-500">No fallback events recorded since this process started.</p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-2">
            <p className="font-semibold text-slate-700">Configured external sinks</p>
            {configuredAlertSinks.length > 0 ? configuredAlertSinks.map((sink) => (
              <div key={`${sink.name}-${sink.destination}`} className="rounded-lg bg-slate-50 px-3 py-2">
                <p className="font-semibold text-slate-700">{sink.name}</p>
                <p className="mt-1 text-slate-500">{sink.destination}</p>
                <p className="mt-1 text-[11px] text-slate-400">
                  headers: {(sink.headerKeys || []).join(', ') || 'content-type only'}
                </p>
              </div>
            )) : (
              <p className="text-slate-500">No external paging/webhook sinks are configured on this deployment.</p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-2">
            <p className="font-semibold text-slate-700">Recent alert deliveries</p>
            {recentAlertDeliveries.length > 0 ? recentAlertDeliveries.map((entry) => (
              <div key={`${entry.type}-${entry.timestamp}-${entry.status}`} className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-slate-700">{entry.type}</p>
                  <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    {entry.status}
                  </span>
                </div>
                <p className="mt-1 text-slate-500">count = {Number(entry.count || 0).toLocaleString()}</p>
                <p className="mt-1 text-slate-500">{entry.message || entry.error || 'alert_recorded'}</p>
                {Array.isArray(entry.sinkResults) && entry.sinkResults.length > 0 ? (
                  <p className="mt-1 text-[11px] text-slate-400">
                    sinks: {entry.sinkResults.map((result) => `${result.name}:${result.status}`).join(' · ')}
                  </p>
                ) : null}
                <p className="mt-1 text-[11px] text-slate-400">{formatTimestamp(entry.timestamp)}</p>
              </div>
            )) : (
              <p className="text-slate-500">No threshold-triggered alert deliveries recorded since this process started.</p>
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <Coins size={16} className="text-amber-600" />
            <h3 className="text-lg font-semibold text-slate-900">Experimental Pool Coverage</h3>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            Canonical stable oracle lanes stay on Curve. The experimental section below exposes filtered external venue pairs that can be queried through the same <span className="font-mono">/api/oracle/public/pool-state</span> product using a <span className="font-mono">venue</span> parameter.
          </div>

          <div className="space-y-3">
            {externalDexEntries.map(([key, venue]) => {
              const label = EXTERNAL_DEX_LABELS[key] || key;
              const queryVenue = EXTERNAL_DEX_QUERY_VENUES[key] || key;
              const whitelistedPools = venue?.whitelistedPools || [];
              const verifiedLivePools = venue?.verifiedLivePools || [];

              return (
                <div key={key} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{label}</p>
                      <p className="mt-1 text-xs text-slate-500">{venue?.note || 'No venue notes available.'}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${key === 'curve' ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-amber-200 bg-amber-50 text-amber-700'}`}>
                      {key === 'curve' ? 'Canonical' : 'Experimental'}
                    </span>
                  </div>

                  {verifiedLivePools.length > 0 && (
                    <p className="mt-3 text-xs text-slate-500">
                      <strong className="text-slate-700">Live pools:</strong>
                      {' '}
                      {verifiedLivePools.join(', ')}
                    </p>
                  )}

                  {whitelistedPools.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {whitelistedPools.map(pool => (
                        <div key={`${key}-${pool.key || pool.pair}`} className="rounded-lg bg-slate-50 px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-semibold text-slate-700">{pool.pair}</p>
                            {pool.key && (
                              <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                                {pool.key}
                              </span>
                            )}
                          </div>
                          {pool.key && (
                            <p className="mt-2 rounded-lg bg-white px-2.5 py-1.5 font-mono text-[11px] text-slate-500 break-all">
                              /api/oracle/public/pool-state?pool={pool.key}&venue={queryVenue}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {venue?.filteredOutReason && (
                    <p className="mt-3 text-xs text-slate-500">
                      <strong className="text-slate-700">Filter:</strong>
                      {' '}
                      {venue.filteredOutReason}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <Wallet size={16} className="text-sky-600" />
            <h3 className="text-lg font-semibold text-slate-900">Selected Agent Gateway Balance</h3>
          </div>

          {!agent?.id && (
            <Alert type="warning">Create or reconnect an agent to inspect its wallet balance and Gateway available balance.</Alert>
          )}

          {agent?.id && (
            <>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500 space-y-1.5">
                <p><strong className="text-slate-700">Agent:</strong> {agent.name || 'Unnamed agent'}</p>
                <p><strong className="text-slate-700">Agent ID:</strong> {agent.id}</p>
                <p><strong className="text-slate-700">Balance source:</strong> Agent EOA wallet plus Circle Gateway available balance.</p>
              </div>

              {(agent.walletAddress || gatewayBalance?.walletAddress) && (
                <AddressBox address={gatewayBalance?.walletAddress || agent.walletAddress} label="Selected Agent Wallet" compact />
              )}

              {gatewayBalanceError && <Alert type="warning">{gatewayBalanceError}</Alert>}
              {gatewayFundError && <Alert type="warning">{gatewayFundError}</Alert>}

              {gatewayBalanceLoading ? (
                <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
                  <Spinner size={12} />
                  Loading live Gateway balance...
                </div>
              ) : gatewayBalance && (
                <>
                  <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
                    <strong>How payment works:</strong>
                    {' '}
                    Third-party buyers following Circle's standard quickstart typically deposit USDC into Gateway before the first paid request. Arc-managed agents use our buyer helper instead, so if Gateway available balance is empty but the wallet holds USDC, the next supported payment can refill Gateway on demand and then complete the flow. Auto-topup is only a warm-balance convenience layer on top of that. The same Gateway balance is shared by task fees, automation fees, job fees, and other buyer-side Gateway payments, so it can naturally go down between checks.
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-slate-800">Automatic Gateway warm balance</p>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${gatewayAutoTopupEnabled ? 'border-green-200 bg-green-50 text-green-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                          {gatewayAutoTopupEnabled ? 'On' : 'Off'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500">
                        When this is on, the next incoming USDC can seed Gateway up to {gatewayAutoTopupMinUsdc} USDC for a first warm balance. After that, if Gateway available balance falls below {gatewayAutoTopupMinUsdc} USDC, the next automation cycle tops it back up to {gatewayAutoTopupTargetUsdc} USDC from the wallet. Manage this toggle from Tasks &gt; Automation.
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-slate-800">Optional operator Gateway pre-fund</p>
                        <p className="text-xs text-slate-500">
                          Adds {MANUAL_GATEWAY_FUND_USDC} USDC from the selected agent wallet into Circle Gateway. Normal buyer flows do not require this; it only keeps a warm balance ready ahead of time.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        onClick={handleManualGatewayFund}
                        loading={gatewayFundLoading}
                        disabled={!canManualFundGateway}
                        className="px-4 py-2"
                      >
                        Fund Gateway +{MANUAL_GATEWAY_FUND_USDC} USDC
                      </Button>
                    </div>
                    {!canManualFundGateway && (
                      <p className="mt-2 text-xs text-amber-700">
                        {gatewayBalanceTemporarilyUnavailable
                          ? 'Gateway balances are temporarily unavailable while Arc RPC cools down. Manual pre-fund is disabled until balance reads recover.'
                          : `The selected agent wallet needs at least ${MANUAL_GATEWAY_FUND_USDC} USDC available before a manual Gateway top-up can run.`}
                      </p>
                    )}
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-1.5">
                      <p><strong className="text-slate-700">Wallet available:</strong> {formatUsdcBalance(gatewayBalance.wallet?.availableUsdc)}</p>
                      <p><strong className="text-slate-700">Wallet total:</strong> {formatUsdcBalance(gatewayBalance.wallet?.totalUsdc)}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-1.5">
                      <p><strong className="text-slate-700">Gateway available:</strong> {formatUsdcBalance(gatewayBalance.gateway?.availableUsdc)}</p>
                      <p><strong className="text-slate-700">Gateway total:</strong> {formatUsdcBalance(gatewayBalance.gateway?.totalUsdc)}</p>
                      <p><strong className="text-slate-700">Withdrawable:</strong> {formatUsdcBalance(gatewayBalance.gateway?.withdrawableUsdc)}</p>
                    </div>
                  </div>

                  {gatewayBalance?.usage?.note && (
                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
                      <strong className="text-slate-800">Why this balance changes:</strong>
                      {' '}
                      {gatewayBalance.usage.note}
                    </div>
                  )}

                  {gatewayUsageSummary.length > 0 && (
                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 space-y-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">Where Gateway balance has been used</p>
                        <p className="text-xs text-slate-500">Confirmed spend grouped by rail for this selected agent.</p>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {gatewayUsageSummary.map((entry) => (
                          <div key={`${entry.rail}-${entry.referenceType}`} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 space-y-1">
                            <p className="font-semibold text-slate-800">{humanizeGatewayRail(entry.rail)}</p>
                            <p>{formatUsdcBalance(entry.totalUsdc)} across {entry.count} {humanizeGatewayReferenceType(entry.referenceType)} payment{entry.count === 1 ? '' : 's'}.</p>
                            <p className="text-slate-500">Last used: {formatTimestamp(entry.lastAt)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {gatewayRecentUsage.length > 0 && (
                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 space-y-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">Recent Gateway-backed payments</p>
                        <p className="text-xs text-slate-500">These are the latest confirmed payments that could reduce the warm Gateway balance before the next on-demand refill.</p>
                      </div>
                      <div className="space-y-2">
                        {gatewayRecentUsage.slice(0, 5).map((entry, index) => (
                          <div key={`${entry.txHash || entry.referenceId || entry.createdAt || index}`} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-800">{humanizeGatewayRail(entry.rail)}</span>
                              <span>{formatUsdcBalance(entry.amountUsdc)}</span>
                            </div>
                            <p className="mt-1">{humanizeGatewayReferenceType(entry.referenceType)} payment at {formatTimestamp(entry.createdAt)}</p>
                            {entry.referenceId && <p className="mt-1 break-all text-slate-500">Reference: {entry.referenceId}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {gatewayFundResult && (
                    <Alert type="success">
                      <div className="space-y-1">
                        <p>Manual Gateway funding completed for {gatewayFundResult.amountUsdc} USDC.</p>
                        {gatewayFundResult.depositTxHash && (
                          <p className="break-all font-mono text-[11px]">Deposit tx: {gatewayFundResult.depositTxHash}</p>
                        )}
                      </div>
                    </Alert>
                  )}

                  <div className={`rounded-xl border px-4 py-3 text-xs ${gatewayBalanceTemporarilyUnavailable ? 'border-amber-200 bg-amber-50 text-amber-800' : gatewayBalance.funded ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                    <strong>{gatewayBalanceTemporarilyUnavailable ? 'Gateway balance temporarily unavailable.' : gatewayBalance.funded ? 'Gateway funded.' : 'Gateway not funded yet.'}</strong>
                    {' '}
                    {gatewayBalanceTemporarilyUnavailable
                      ? 'Arc RPC is cooling down, so this view cannot confirm wallet or Gateway amounts right now. Retry shortly before making funding decisions.'
                      : gatewayBalance.funded
                        ? 'This agent currently has a warm Gateway balance, but that balance can still be spent by public x402 payments, task fees, automation fees, and other buyer-side Gateway flows.'
                        : 'The wallet holds USDC, but Circle Gateway available balance is currently empty and the buyer helper can refill it on demand when the next supported payment runs.'}
                  </div>
                </>
              )}
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <Coins size={16} className="text-amber-600" />
            <h3 className="text-lg font-semibold text-slate-900">Gateway Control Plane</h3>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-1.5">
              <p><strong className="text-slate-700">Seller mode:</strong> {gatewaySeller?.mode || 'gateway-seller'}</p>
              <p><strong className="text-slate-700">Auth mode:</strong> {gatewaySeller?.authMode || 'none'}</p>
              <p><strong className="text-slate-700">Auth configured:</strong> {gatewaySeller?.authConfigured ? 'Yes' : 'No'}</p>
              <p><strong className="text-slate-700">Supported cache:</strong> {facilitatorCache?.ready ? 'Ready' : 'Empty'}</p>
              <p><strong className="text-slate-700">Cached networks:</strong> {Number(facilitatorCache?.networkCount || 0)}</p>
              <p><strong className="text-slate-700">Cache updated:</strong> {formatTimestamp(facilitatorCache?.loadedAt)}</p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 space-y-1.5">
              <p><strong className="text-slate-700">Buyer max fee:</strong> {gatewayBuyer?.defaultMaxFeeUsdc || '—'} USDC</p>
              <p><strong className="text-slate-700">Buyer chains:</strong> {Number(gatewayBuyer?.chainCount || 0)}</p>
              <p><strong className="text-slate-700">Task fee rail:</strong> {gatewayTaskEconomy?.configured ? 'Configured' : 'Missing'} · {gatewayTaskEconomy?.dryRun ? 'Dry run' : 'Live'}</p>
              <p><strong className="text-slate-700">Jobs fee rail:</strong> {gatewayJobEconomy?.configured ? 'Configured' : 'Missing'} · {gatewayJobEconomy?.dryRun ? 'Dry run' : 'Live'}</p>
              <p><strong className="text-slate-700">Audit events:</strong> {Number(gatewayAudit?.totalEvents || 0)}</p>
              <p><strong className="text-slate-700">Last agentic payment:</strong> {formatTimestamp(gatewayAudit?.lastEventAt)}</p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500 space-y-1.5">
              <p><strong className="text-slate-700">Confirmed events:</strong> {Number(gatewayAudit?.confirmedCount || 0)}</p>
              <p><strong className="text-slate-700">Skipped events:</strong> {Number(gatewayAudit?.skippedCount || 0)}</p>
              <p><strong className="text-slate-700">Failed events:</strong> {Number(gatewayAudit?.failedCount || 0)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500 space-y-1.5">
              <p><strong className="text-slate-700">Nano events:</strong> {Number(gatewayAudit?.nanoEvents || 0)}</p>
              <p><strong className="text-slate-700">Task fee events:</strong> {Number(gatewayAudit?.taskEvents || 0)}</p>
              <p><strong className="text-slate-700">Job create / payout:</strong> {Number(gatewayAudit?.jobCreateEvents || 0)} / {Number(gatewayAudit?.jobPayoutEvents || 0)}</p>
            </div>
          </div>

          {facilitatorCache?.lastError?.message && (
            <Alert type="warning">
              <div className="space-y-1">
                <p className="font-semibold">Gateway facilitator error</p>
                <p className="text-xs">{facilitatorCache.lastError.message}</p>
              </div>
            </Alert>
          )}
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <Cable size={16} className="text-violet-600" />
            <h3 className="text-lg font-semibold text-slate-900">How Oracle Access Works</h3>
          </div>

          <div className="space-y-3">
            {PAYMENT_FLOW_STEPS.map((step, index) => (
              <div key={step.title} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
                    {index + 1}
                  </span>
                  <p className="text-sm font-semibold text-slate-800">{step.title}</p>
                </div>
                <p className="mt-2 text-xs text-slate-500">{step.description}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}