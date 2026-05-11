import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useAgent } from '../providers/AgentProvider.jsx';
import { transactions as txApi } from '../lib/api.js';
import { fetchUsdcBalance, fetchEurcBalance } from '../lib/agentBalances.js';
import { ARC_TESTNET_ID } from '../lib/chains.js';
import { Card, Button, Input, Alert, Badge, SectionHeader } from './ui/index.jsx';
import { ArrowUpDown, Bot, Zap, ExternalLink, ChevronLeft, RefreshCw } from 'lucide-react';

const ARC_EXPLORER = 'https://testnet.arcscan.app';

/**
 * SwapTab — USDC ↔ EURC on Arc Testnet, fully agentic
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
  const [quote,     setQuote]     = useState(null);  // { amountOut, isDexQuote }
  const [quoting,   setQuoting]   = useState(false);
  const [result,    setResult]    = useState(null);  // completed tx
  const [status,    setStatus]    = useState(null);  // executing status string
  const [error,     setError]     = useState('');
  const [loading,   setLoading]   = useState(false);
  const [balances,  setBalances]  = useState({ usdc: null, eurc: null });
  const [loadingBalances, setLoadingBalances] = useState(false);
  const quoteTimer = useRef(null);

  const maxTrade    = agent?.settings?.maxTradeUsdc  ?? 200;
  const parsedAmount = parseFloat(amountIn);
  const hasAmount    = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const isNano       = hasAmount && parsedAmount < 0.01;
  const isAgentic    = hasAmount && parsedAmount <= maxTrade;
  const exceedsMax   = hasAmount && parsedAmount > maxTrade;
  const swapDisabledByDex = hasAmount && !quoting && !!quote && !quote.isDexQuote;

  // ── Fetch quote on amount / direction change ──────────────────────────────
  const fetchQuote = useCallback(async (amount, from, to) => {
    if (!agent || !amount || parseFloat(amount) <= 0) { setQuote(null); return; }
    setQuoting(true);
    try {
      const q = await txApi.swapQuote({ fromToken: from, toToken: to, amountIn: parseFloat(amount) });
      setQuote(q);
    } catch {
      setQuote({ amountOut: parseFloat(amount), isDexQuote: false }); // 1:1 fallback
    } finally {
      setQuoting(false);
    }
  }, [agent]);

  useEffect(() => {
    clearTimeout(quoteTimer.current);
    if (amountIn && parseFloat(amountIn) > 0) {
      quoteTimer.current = setTimeout(() => fetchQuote(amountIn, fromToken, toToken), 600);
    } else {
      setQuote(null);
    }
    return () => clearTimeout(quoteTimer.current);
  }, [amountIn, fromToken, toToken, fetchQuote]);

  useEffect(() => {
    if (!agent?.walletAddress) return;
    setLoadingBalances(true);
    Promise.all([
      fetchUsdcBalance(agent.walletAddress, ARC_TESTNET_ID),
      fetchEurcBalance(agent.walletAddress, ARC_TESTNET_ID),
    ])
      .then(([usdc, eurc]) => setBalances({ usdc, eurc }))
      .finally(() => setLoadingBalances(false));
  }, [agent?.walletAddress]);

  // ── Flip direction ────────────────────────────────────────────────────────
  function flipTokens() {
    setFromToken(t => t === 'USDC' ? 'EURC' : 'USDC');
    setToToken(t   => t === 'USDC' ? 'EURC' : 'USDC');
    setAmountIn('');
    setQuote(null);
  }

  // ── Execute swap (agent auto-signs) ──────────────────────────────────────
  async function handleSwap() {
    if (!hasAmount) { setError('Enter a valid amount.'); return; }
    if (quoting || !quote) { setError('Waiting for a live swap quote from Arc Testnet…'); return; }
    if (!quote.isDexQuote) { setError('Swap is unavailable on this deployment until ARC_DEX_ROUTER is configured.'); return; }
    if (exceedsMax) { setError(`Amount exceeds agent auto-approve limit (${maxTrade} USDC). Lower the amount or raise the limit in Agent Settings.`); return; }

    setError('');
    setLoading(true);
    setStatus('Agent is executing swap autonomously…');

    try {
      const res = await txApi.swap({
        agentId:   agent.id,
        fromToken,
        toToken,
        amountIn:  parsedAmount,
      });

      // Poll for confirmation
      setStatus('Waiting for on-chain confirmation…');
      const final = await txApi.poll(res.txId, tx => {
        if (tx.status === 'executing') setStatus('Agent signing transaction…');
        if (tx.status === 'pending')   setStatus('Broadcast — waiting for block…');
      }, 90_000);

      setResult(final);
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
        <SectionHeader title="Swap" subtitle="USDC ↔ EURC on Arc Testnet." />
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
    return (
      <div className="max-w-lg mx-auto space-y-6">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-arc-green transition">
              <ChevronLeft size={16}/> Back
            </button>
          )}
          <SectionHeader title="Swap" subtitle="USDC ↔ EURC on Arc Testnet — agentic." />
        </div>
        <Card>
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <Badge variant={isConfirmed ? 'green' : result.status === 'failed' ? 'red' : 'yellow'}>
              {result.status}
            </Badge>
            <Bot size={32} className="text-arc-green" />
            <h3 className="text-lg font-bold text-slate-900">
              {isConfirmed ? 'Swap Executed by Agent!' : result.status === 'failed' ? 'Swap Failed' : 'Processing…'}
            </h3>
            {amountOut && (
              <p className="text-sm text-slate-600">
                {amountIn} {fromToken} → <span className="font-semibold text-arc-green">{amountOut} {toToken}</span>
              </p>
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
          subtitle="USDC ↔ EURC on Arc Testnet — agent executes autonomously within your limits."
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
              {loadingBalances && <span className="text-xs text-slate-400">Refreshing…</span>}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-center">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">USDC</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{balances.usdc ?? '—'}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-center">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">EURC</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{balances.eurc ?? '—'}</p>
              </div>
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
              <span className="flex-1 text-sm font-semibold text-slate-800">{fromToken}</span>
              <Input
                type="number"
                placeholder="0.00"
                min="0"
                step="0.01"
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
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">To (estimated)</label>
            <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
              <span className="flex-1 text-sm font-semibold text-slate-800">{toToken}</span>
              <span className="text-right text-base font-bold text-slate-400">
                {quoting ? <RefreshCw size={14} className="animate-spin inline"/> : (quote ? parseFloat(quote.amountOut).toFixed(4) : '—')}
              </span>
            </div>
            {swapDisabledByDex && (
              <Alert type="warning">
                Live Arc DEX routing is not configured on this deployment. The 1:1 number is a placeholder, and execution is disabled until `ARC_DEX_ROUTER` is set.
              </Alert>
            )}
          </div>

          {/* Agentic info panel */}
          <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 space-y-1.5 text-xs text-slate-500">
            <div className="flex items-center gap-2">
              <Bot size={13} className="text-arc-green shrink-0"/>
              <span>
                {isNano
                  ? <><strong className="text-slate-700">Nano payment</strong> — agent executes automatically ({'<'}$0.01)</>
                  : isAgentic
                  ? <><strong className="text-slate-700">Agentic</strong> — agent auto-executes (within {maxTrade} USDC limit)</>
                  : exceedsMax
                  ? <span className="text-red-600">Exceeds auto-approve limit ({maxTrade} USDC) — raise limit in Agent Settings</span>
                  : 'Enter an amount to see execution mode'}
              </span>
            </div>
            {isAgentic && !exceedsMax && (
              <div className="flex items-center gap-2">
                <Zap size={13} className="text-amber-500 shrink-0"/>
                <span>No MetaMask pop-up needed — agent wallet signs autonomously</span>
              </div>
            )}
            <p>Agent: <span className="font-mono text-slate-700">{agent.walletAddress?.slice(0, 12)}…{agent.walletAddress?.slice(-4)}</span></p>
          </div>

          {error  && <Alert type="error">{error}</Alert>}
          {status && <Alert type="info"><Bot size={13} className="inline mr-1.5"/>{status}</Alert>}

          <Button
            onClick={handleSwap}
            loading={loading}
            disabled={exceedsMax || !hasAmount || quoting || !quote?.isDexQuote}
            className="w-full"
          >
            {swapDisabledByDex
              ? 'Swap unavailable on this deployment'
              : isNano
              ? '⚡ Nano Swap'
              : <><Bot size={15}/> Agent Swap {amountIn || '0'} {fromToken} → {toToken}</>}
          </Button>
        </div>
      </Card>
    </div>
  );
}
