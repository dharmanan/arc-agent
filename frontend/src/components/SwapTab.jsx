import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useAgent } from '../providers/AgentProvider.jsx';
import { transactions as txApi } from '../lib/api.js';
import { fetchUsdcBalance, fetchEurcBalance, fetchCirbtcBalance } from '../lib/agentBalances.js';
import { ARC_TESTNET_ID } from '../lib/chains.js';
import { Card, Button, Input, Alert, Badge, SectionHeader } from './ui/index.jsx';
import { ArrowUpDown, Bot, Zap, ExternalLink, ChevronLeft, RefreshCw } from 'lucide-react';

const ARC_EXPLORER = 'https://testnet.arcscan.app';
const SWAP_TOKENS = ['USDC', 'EURC', 'cirBTC'];
const STABLE_SWAP_TOKENS = new Set(['USDC', 'EURC']);
const SWAP_FALLBACK_CONFIRMATION_CODE = 'SWAP_FALLBACK_CONFIRMATION_REQUIRED';

function formatQuotedAmount(value, token) {
  const numeric = parseFloat(value ?? '');
  if (!Number.isFinite(numeric)) return '—';
  return numeric.toFixed(token === 'cirBTC' ? 6 : 4);
}

/**
 * SwapTab — USDC / EURC / cirBTC on Arc Testnet, fully agentic
 *
 * All swaps are executed by the agent's own private key (no MetaMask pop-up
 * for amounts within maxTradeUsdc). This follows Circle's agentic payment
 * model: https://developers.circle.com/gateway/nanopayments#agentic-payments
 */
export default function SwapTab({ onBack }) {
  const { address: ownerAddress } = useAccount();
  const { agent, isAuthenticated } = useAgent();

  const [fromToken, setFromToken] = useState('USDC');
  const [toToken,   setToToken]   = useState('EURC');
  const [amountIn,  setAmountIn]  = useState('');
  const [quote,     setQuote]     = useState(null);  // { amountOut, isDexQuote, quoteError, routeStrategy, routeReason }
  const [quoting,   setQuoting]   = useState(false);
  const [result,    setResult]    = useState(null);  // completed tx
  const [status,    setStatus]    = useState(null);  // executing status string
  const [error,     setError]     = useState('');
  const [loading,   setLoading]   = useState(false);
  const [balances,  setBalances]  = useState({ usdc: null, eurc: null, cirbtc: null });
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [slippageOverride, setSlippageOverride] = useState('');
  const [fallbackOffer, setFallbackOffer] = useState(null);
  const quoteTimer = useRef(null);

  const maxTrade    = agent?.settings?.maxTradeUsdc  ?? 200;
  const defaultSlippagePct = Number(agent?.settings?.slippagePercent ?? 0.5);
  const normalizedDefaultSlippagePct = Number.isFinite(defaultSlippagePct) && defaultSlippagePct > 0 ? defaultSlippagePct : 0.5;
  const parsedSlippageOverride = parseFloat(slippageOverride);
  const hasSlippageOverride = slippageOverride.trim() !== '' && Number.isFinite(parsedSlippageOverride);
  const slippageError = slippageOverride.trim() !== ''
    && (!Number.isFinite(parsedSlippageOverride) || parsedSlippageOverride < 0.1 || parsedSlippageOverride > 50)
    ? 'Enter a value between 0.1 and 50.'
    : '';
  const effectiveSlippagePct = hasSlippageOverride ? parsedSlippageOverride : normalizedDefaultSlippagePct;
  const activeRouteMode = fallbackOffer ? 'fallback_only' : 'auto';
  const parsedAmount = parseFloat(amountIn);
  const quotedAmountOut = parseFloat(quote?.amountOut ?? '');
  const backupQuote = fallbackOffer?.fallbackQuote || quote?.fallbackQuote || null;
  const hasAmount    = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const usdEquivalentIn = !hasAmount
    ? null
    : fromToken === 'cirBTC'
      ? (quote?.isDexQuote && Number.isFinite(quotedAmountOut) ? quotedAmountOut : null)
      : parsedAmount;
  const isNano       = usdEquivalentIn !== null && usdEquivalentIn < 0.01;
  const isAgentic    = usdEquivalentIn !== null && usdEquivalentIn <= maxTrade;
  const exceedsMax   = usdEquivalentIn !== null && usdEquivalentIn > maxTrade;
  const cirbtcPair = fromToken === 'cirBTC' || toToken === 'cirBTC';
  const cirbtcNeedsSwapKit = cirbtcPair && quote?.routeStrategy === 'swap_kit_required';
  const limitAwaitingQuote = hasAmount && fromToken === 'cirBTC' && usdEquivalentIn === null && !cirbtcNeedsSwapKit;
  const swapDisabledByDex = hasAmount && !quoting && !!quote && !quote.isDexQuote;
  const routeReason = quote?.routeReason || null;
  const userRouteReason = cirbtcNeedsSwapKit
    ? 'cirBTC is not ready on this deployment right now.'
    : routeReason;
  const quoteWarning = swapDisabledByDex
    ? (quote?.quoteError || userRouteReason || 'This swap is unavailable right now.')
    : null;
  const suggestLowerAmount = Boolean(quoteWarning && /try a smaller amount|stay at or below/i.test(quoteWarning));

  // ── Fetch quote on amount / direction change ──────────────────────────────
  const fetchQuote = useCallback(async (amount, from, to, routeMode = 'auto') => {
    if (!agent || !amount || parseFloat(amount) <= 0) { setQuote(null); return; }
    setQuoting(true);
    try {
      const q = await txApi.swapQuote({ fromToken: from, toToken: to, amountIn: parseFloat(amount), routeMode });
      setQuote(q);
    } catch {
      const stablePair = STABLE_SWAP_TOKENS.has(from) && STABLE_SWAP_TOKENS.has(to);
      setQuote({
        amountOut: stablePair ? parseFloat(amount) : null,
        isDexQuote: false,
        quoteError: stablePair
          ? 'Live pricing is unavailable right now. Stable quotes may show a placeholder.'
          : 'Live pricing is unavailable right now.',
        fallbackQuote: null,
      });
    } finally {
      setQuoting(false);
    }
  }, [agent]);

  const refreshBalances = useCallback(async () => {
    if (!agent?.walletAddress) return;
    setLoadingBalances(true);
    try {
      const [usdc, eurc, cirbtc] = await Promise.all([
        fetchUsdcBalance(agent.walletAddress, ARC_TESTNET_ID),
        fetchEurcBalance(agent.walletAddress, ARC_TESTNET_ID),
        fetchCirbtcBalance(agent.walletAddress, ARC_TESTNET_ID),
      ]);
      setBalances({ usdc, eurc, cirbtc });
    } finally {
      setLoadingBalances(false);
    }
  }, [agent?.walletAddress]);

  const refreshSwapData = useCallback(async () => {
    setManualRefreshing(true);
    setError('');
    try {
      await Promise.all([
        refreshBalances(),
        hasAmount ? fetchQuote(amountIn, fromToken, toToken, activeRouteMode) : Promise.resolve(),
      ]);
    } finally {
      setManualRefreshing(false);
    }
  }, [activeRouteMode, amountIn, fetchQuote, fromToken, hasAmount, refreshBalances, toToken]);

  useEffect(() => {
    clearTimeout(quoteTimer.current);
    if (amountIn && parseFloat(amountIn) > 0) {
      quoteTimer.current = setTimeout(() => fetchQuote(amountIn, fromToken, toToken, activeRouteMode), 600);
    } else {
      setQuote(null);
    }
    return () => clearTimeout(quoteTimer.current);
  }, [activeRouteMode, amountIn, fromToken, toToken, fetchQuote]);

  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  function clearSwapFlowState() {
    setFallbackOffer(null);
    setError('');
    setStatus(null);
  }

  // ── Flip direction ────────────────────────────────────────────────────────
  function flipTokens() {
    clearSwapFlowState();
    setFromToken(toToken);
    setToToken(fromToken);
    setQuote(null);
  }

  function handleFromTokenChange(nextToken) {
    clearSwapFlowState();
    if (nextToken === toToken) setToToken(fromToken);
    setFromToken(nextToken);
    setQuote(null);
  }

  function handleToTokenChange(nextToken) {
    clearSwapFlowState();
    if (nextToken === fromToken) setFromToken(toToken);
    setToToken(nextToken);
    setQuote(null);
  }

  function handleAmountChange(event) {
    clearSwapFlowState();
    setAmountIn(event.target.value);
    setQuote(null);
  }

  function handleSlippageChange(event) {
    clearSwapFlowState();
    setSlippageOverride(event.target.value);
  }

  // ── Execute swap (agent auto-signs) ──────────────────────────────────────
  async function handleSwap() {
    if (!hasAmount) { setError('Enter a valid amount.'); return; }
    if (quoting || !quote) { setError('Waiting for live pricing...'); return; }
    if (!quote.isDexQuote) { setError(quote?.quoteError || userRouteReason || 'This swap is unavailable right now.'); return; }
    if (limitAwaitingQuote) { setError('Waiting for live cirBTC pricing before checking your limit.'); return; }
    if (exceedsMax) { setError(`This amount is above your auto limit (${maxTrade} USDC). Lower it or raise the limit in Agent Settings.`); return; }
    if (slippageError) { setError(slippageError); return; }

    setError('');
    setLoading(true);
    setStatus(fallbackOffer ? 'Confirming the backup route on-chain...' : 'Your agent is executing the swap...');

    try {
      const res = await txApi.swap({
        agentId:   agent.id,
        fromToken,
        toToken,
        amountIn:  parsedAmount,
        routeMode: activeRouteMode,
        ...(hasSlippageOverride ? { slippage: parsedSlippageOverride } : {}),
      });

      // Poll for confirmation
      setStatus('Waiting for on-chain confirmation...');
      const final = await txApi.poll(res.txId, tx => {
        if (tx.status === 'executing') setStatus('Preparing the transaction...');
        if (tx.status === 'pending')   setStatus('Sent to the network. Waiting for a block...');
      }, 90_000);

      if (
        final.status === 'failed'
        && final.meta?.errorCode === SWAP_FALLBACK_CONFIRMATION_CODE
        && final.meta?.fallbackQuote?.amountOut
      ) {
        setFallbackOffer({
          primaryAmountOut: final.meta?.primaryAmountOut || quote?.amountOut || null,
          primaryError: final.meta?.primaryError || final.meta?.error || null,
          fallbackQuote: final.meta.fallbackQuote,
        });
        setQuote({
          amountOut: final.meta.fallbackQuote.amountOut,
          isDexQuote: true,
          quoteError: null,
          routeStrategy: final.meta.fallbackQuote.routeStrategy,
          routeReason: final.meta.fallbackQuote.routeReason,
          fallbackAvailable: false,
          executionRail: final.meta.fallbackQuote.executionRail,
          poolAddress: final.meta.fallbackQuote.poolAddress,
          poolSource: final.meta.fallbackQuote.poolSource,
          fallbackQuote: null,
        });
        setStatus(null);
        return;
      }

      setResult(final);
      setFallbackOffer(null);
      setStatus(null);
    } catch (e) {
      setError(e.message);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setResult(null);
    setFallbackOffer(null);
    setStatus(null);
    setError('');
    setAmountIn('');
    setQuote(null);
  }

  // ── Guard: no wallet ──────────────────────────────────────────────────────
  if (!ownerAddress) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ArrowUpDown size={32} className="mb-4 text-slate-300" />
        <h2 className="text-lg font-bold text-slate-900">Wallet Not Connected</h2>
        <p className="mt-1 text-sm text-slate-500">Connect your wallet to use Swap.</p>
      </div>
    );
  }

  if (!agent || !isAuthenticated) {
    return (
      <div className="max-w-lg mx-auto space-y-4">
        <SectionHeader title="Swap" subtitle="USDC / EURC / cirBTC on Arc Testnet." />
        <Card className="border-yellow-200 bg-yellow-50">
          <p className="text-sm font-medium text-yellow-800">
            You need an active agent wallet to use Swap. Go to the Agent tab to create or reconnect one.
          </p>
        </Card>
      </div>
    );
  }

  // ── Success screen ────────────────────────────────────────────────────────
  if (result) {
    const amountOut  = result.meta?.amountOut;
    const isConfirmed = result.status === 'confirmed';
    const usedBackupRoute = ['curve_fallback', 'uniswap_v2_fallback'].includes(result.meta?.executionRail);
    return (
      <div className="max-w-lg mx-auto space-y-6">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-arc-green transition">
              <ChevronLeft size={16}/> Back
            </button>
          )}
          <SectionHeader title="Swap" subtitle="USDC / EURC / cirBTC on Arc Testnet." />
        </div>
        <Card>
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <Badge variant={isConfirmed ? 'green' : result.status === 'failed' ? 'red' : 'yellow'}>
              {result.status}
            </Badge>
            <Bot size={32} className="text-arc-green" />
            <h3 className="text-lg font-bold text-slate-900">
              {isConfirmed ? 'Swap complete' : result.status === 'failed' ? 'Swap failed' : 'Processing...'}
            </h3>
            {amountOut && (
              <p className="text-sm text-slate-600">
                {amountIn} {fromToken} → <span className="font-semibold text-arc-green">{amountOut} {toToken}</span>
              </p>
            )}
            {isConfirmed && usedBackupRoute && (
              <p className="max-w-md text-sm text-slate-500">
                The live app route was unavailable at execution time, so this swap used the direct Arc backup pool after the updated quote was approved.
              </p>
            )}
            {!isConfirmed && result.meta?.error && (
              <p className="max-w-md text-sm text-red-600">{result.meta.error}</p>
            )}
            {result.tx_hash && (
              <a href={`${ARC_EXPLORER}/tx/${result.tx_hash}`} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-arc-green hover:underline">
                View on ArcScan <ExternalLink size={13}/>
              </a>
            )}
            <Button variant="outline" onClick={reset}>New Swap</Button>
          </div>
        </Card>
      </div>
    );
  }

  // ── Main form ─────────────────────────────────────────────────────────────
  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-arc-green transition">
            <ChevronLeft size={16}/> Back
          </button>
        )}
        <SectionHeader
          title="Swap"
          subtitle="USDC / EURC / cirBTC on Arc Testnet. Your agent handles the swap within your limit."
        />
      </div>

      <Card>
        <div className="space-y-5">

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">Agent balances on Arc Testnet</p>
                <p className="mt-1 text-xs text-slate-500">Swap uses the agent wallet directly on Arc Testnet.</p>
              </div>
              <div className="flex items-center gap-2">
                {loadingBalances && <span className="text-xs text-slate-400">Refreshing…</span>}
                <Button
                  variant="outline"
                  onClick={refreshSwapData}
                  loading={manualRefreshing}
                  className="px-3 py-2 text-xs"
                >
                  <RefreshCw size={13}/> Refresh
                </Button>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {SWAP_TOKENS.map((token) => (
                <div key={token} className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-center">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">{token}</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{balances[token.toLowerCase()] ?? '—'}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Network badge */}
          <div className="flex items-center gap-2 rounded-xl bg-arc-greenBg/60 px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-arc-green"/>
            <span className="text-xs font-medium text-arc-green">Arc Testnet</span>
          </div>

          {/* From token */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">From</label>
            <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <select
                value={fromToken}
                onChange={e => handleFromTokenChange(e.target.value)}
                className="flex-1 bg-transparent text-sm font-semibold text-slate-800 outline-none"
              >
                {SWAP_TOKENS.map(token => <option key={token} value={token}>{token}</option>)}
              </select>
              <Input
                type="number"
                placeholder="0.00"
                min="0"
                step={fromToken === 'cirBTC' ? '0.00000001' : '0.01'}
                value={amountIn}
                onChange={e => setAmountIn(e.target.value)}
                className="w-36 border-0 bg-transparent text-right text-base font-bold text-slate-900 focus:ring-0 p-0"
              />
            </div>
          </div>

          {/* Flip button */}
          <div className="flex justify-center">
            <button
              onClick={flipTokens}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-500 hover:border-arc-green/40 hover:text-arc-green transition"
            >
              <ArrowUpDown size={13}/> Flip
            </button>
          </div>

          {/* To token */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">{fallbackOffer ? 'To (backup estimate)' : 'To (estimated)'}</label>
            <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
              <select
                value={toToken}
                onChange={e => handleToTokenChange(e.target.value)}
                className="flex-1 bg-transparent text-sm font-semibold text-slate-800 outline-none"
              >
                {SWAP_TOKENS.map(token => <option key={token} value={token}>{token}</option>)}
              </select>
              <span className="text-right text-base font-bold text-slate-400">
                {quoting ? <RefreshCw size={14} className="animate-spin inline"/> : formatQuotedAmount(quote?.amountOut, toToken)}
              </span>
            </div>
            {quoteWarning && (
              <Alert type="warning">
                {quoteWarning}
              </Alert>
            )}
            {!fallbackOffer && quote?.executionRail === 'swap_kit' && backupQuote?.amountOut && (
              <Alert type="info">
                Primary route estimate: {formatQuotedAmount(quote?.amountOut, toToken)} {toToken}. If the live app route becomes unavailable, the direct Arc backup pool is currently quoting about {formatQuotedAmount(backupQuote.amountOut, toToken)} {toToken}.
              </Alert>
            )}
            {fallbackOffer && fallbackOffer.fallbackQuote?.amountOut && (
              <Alert type="warning">
                The live app route moved before broadcast. The primary quote was {formatQuotedAmount(fallbackOffer.primaryAmountOut, toToken)} {toToken}; the updated backup quote is {formatQuotedAmount(fallbackOffer.fallbackQuote.amountOut, toToken)} {toToken} on the direct Arc pool. Review it, then confirm if you want to continue.
              </Alert>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
            <Input
              label="Slippage (%)"
              type="number"
              min="0.1"
              max="50"
              step="0.1"
              value={slippageOverride}
              onChange={handleSlippageChange}
              placeholder={String(normalizedDefaultSlippagePct)}
              error={slippageError}
            />
            <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">
              <p className="font-medium text-slate-700">
                {hasSlippageOverride
                  ? `This swap will use ${effectiveSlippagePct}% instead of the agent default.`
                  : `This swap will use the agent default (${normalizedDefaultSlippagePct}%).`}
              </p>
              <p className="mt-1">
                Leave this blank to use Agent Settings. A value here overrides only this swap and does not change the saved agent default.
              </p>
            </div>
          </div>

          {/* Swap info panel */}
          <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 space-y-1.5 text-xs text-slate-500">
            <div className="flex items-center gap-2">
              <Bot size={13} className="text-arc-green shrink-0"/>
              <span>
                {isNano
                  ? <><strong className="text-slate-700">Tiny payment</strong> - your agent can send this automatically ({'<'}$0.01)</>
                  : cirbtcNeedsSwapKit
                  ? 'cirBTC is not available here until a live market is ready.'
                  : limitAwaitingQuote
                  ? 'Waiting for live cirBTC pricing before checking your limit.'
                  : isAgentic
                  ? <><strong className="text-slate-700">Auto-ready</strong> - this size is inside your {maxTrade} USDC limit.</>
                  : exceedsMax
                  ? <span className="text-red-600">This is above your {maxTrade} USDC auto limit. Lower the size or raise the limit in Agent Settings.</span>
                  : 'Enter an amount to preview the swap.'}
              </span>
            </div>
            {isAgentic && !exceedsMax && !limitAwaitingQuote && (
              <div className="flex items-center gap-2">
                <Zap size={13} className="text-amber-500 shrink-0"/>
                <span>No wallet pop-up is needed while the amount stays inside your limit.</span>
              </div>
            )}
            <p>
              Route: <span className="text-slate-700">{fallbackOffer ? 'Direct Arc backup pool' : quote?.executionRail === 'swap_kit' ? 'Circle Kit primary route' : backupQuote?.executionRail === 'curve_fallback' || quote?.executionRail === 'curve_fallback' ? 'Direct Arc stable backup pool' : quote?.executionRail === 'uniswap_v2_fallback' ? 'Direct Arc backup pool' : 'Waiting for live route'}</span>
            </p>
            <p>
              Slippage: <span className="text-slate-700">{hasSlippageOverride ? `${effectiveSlippagePct}% for this swap only` : `Agent default ${normalizedDefaultSlippagePct}%`}</span>
            </p>
            <p>Agent: <span className="font-mono text-slate-700">{agent.walletAddress?.slice(0, 12)}…{agent.walletAddress?.slice(-4)}</span></p>
          </div>

          {error  && <Alert type="error">{error}</Alert>}
          {status && <Alert type="info"><Bot size={13} className="inline mr-1.5"/>{status}</Alert>}

          <Button
            onClick={handleSwap}
            loading={loading}
            disabled={Boolean(slippageError) || exceedsMax || limitAwaitingQuote || !hasAmount || quoting || !quote?.isDexQuote}
            className="w-full"
          >
            {swapDisabledByDex
              ? (cirbtcNeedsSwapKit ? 'Market not ready' : suggestLowerAmount ? 'Try a smaller size' : 'Swap unavailable right now')
              : fallbackOffer
              ? <><Bot size={15}/> Confirm Backup Swap {amountIn || '0'} {fromToken} → {formatQuotedAmount(quote?.amountOut, toToken)} {toToken}</>
              : isNano
              ? '⚡ Nano Swap'
              : <><Bot size={15}/> Agent Swap {amountIn || '0'} {fromToken} → {toToken}</>}
          </Button>
        </div>
      </Card>
    </div>
  );
}
