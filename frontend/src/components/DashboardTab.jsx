import React, { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { useAgent } from '../providers/AgentProvider';
import { agents, transactions } from '../lib/api.js';
import { authenticatePasskey } from '../lib/passkey.js';
import { fetchAgentPortfolio } from '../lib/agentBalances.js';
import { Card, Badge, Button, AddressBox, Alert, Spinner } from './ui/index.jsx';
import { Wallet, Activity, ArrowRight, Zap, LogIn, ExternalLink, RefreshCw } from 'lucide-react';
import { CHAINS } from '../lib/chains.js';

function getTxMeta(tx) {
  return tx?.meta && typeof tx.meta === 'object' ? tx.meta : {};
}

function isRealHash(hash) {
  return /^0x[0-9a-fA-F]{64}$/.test(hash || '');
}

function getExplorerTxUrl(chainName, txHash) {
  const explorerBase = CHAINS[chainName]?.explorerUrl;
  if (!explorerBase || !isRealHash(txHash)) return null;
  return `${explorerBase}/tx/${txHash}`;
}

function getTxDisplay(tx) {
  const meta = getTxMeta(tx);
  const fromChain = tx.from_chain || tx.fromChain || meta.fromChain || '';
  const toChain = tx.to_chain || tx.toChain || meta.toChain || '';
  const bridgeKind = meta.bridgeType || meta.kind || null;
  const isNativeBridge = bridgeKind === 'native'
    || tx.type === 'gas_topup'
    || ['native_gas_topup', 'native_eth_bridge'].includes(meta.kind);
  const token = tx.token || (isNativeBridge ? 'ETH' : 'USDC');
  const isBridge = tx.type === 'bridge' || isNativeBridge;

  const sourceTxHash = meta.sourceTxHash || meta.burnTxHash || meta.topUpTxHash || (isBridge ? tx.tx_hash || tx.txHash : null);
  const destinationTxHash = meta.destinationTxHash || meta.mintTxHash || null;
  const amountValue = token === 'ETH'
    ? meta.amountEth
    : (tx.amount_usdc ?? tx.amountUsdc ?? 0);

  const amountLabel = token === 'ETH'
    ? (amountValue ? `${parseFloat(amountValue).toFixed(4)} ETH` : null)
    : (Number(amountValue) > 0 ? `${parseFloat(amountValue).toFixed(2)} ${token}` : null);

  const routeLabel = fromChain && toChain && fromChain !== toChain
    ? `${fromChain} → ${toChain}`
    : fromChain || toChain || null;
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
  ].filter(Boolean);

  return { title, routeLabel, amountLabel, phase, links };
}

export default function DashboardTab({ onNavigate }) {
  const { address: ownerAddress } = useAccount();
  const { agent, setAgent, setJwt, isAuthenticated } = useAgent();
  const [portfolio, setPortfolio]         = useState([]);
  const [loadingPortfolio, setLoadingPortfolio] = useState(false);
  const [portfolioError, setPortfolioError] = useState('');
  const [txs, setTxs]             = useState([]);
  const [loadingTxs, setLoadingTxs] = useState(false);
  const [txError, setTxError]     = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const agentWalletAddress = agent?.walletAddress || agent?.wallet_address;

  const arcPortfolio = portfolio.find(entry => entry.chainName === 'Arc Testnet');
  const sepoliaPortfolio = portfolio.find(entry => entry.chainName === 'Sepolia');

  function getGasLabel(entry) {
    const symbol = entry?.nativeSymbol || 'ETH';
    return `${symbol} gas`;
  }

  function shouldShowNativeBalance(entry) {
    return entry?.chainName !== 'Arc Testnet';
  }

  async function handleReconnect() {
    if (!ownerAddress) return;
    setConnectError('');
    setConnecting(true);
    try {
      const { authenticatePasskey: auth } = await import('../lib/passkey.js');
      const result = await auth(ownerAddress);
      setJwt(result.token);
      const list = await agents.list();
      if (list.length > 0) setAgent(list[0]);
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

  useEffect(() => {
    loadPortfolio(agentWalletAddress);
  }, [agentWalletAddress, loadPortfolio]);

  useEffect(() => {
    if (!agentWalletAddress) return;

    const intervalId = setInterval(() => {
      loadPortfolio(agentWalletAddress);
    }, 30_000);

    return () => clearInterval(intervalId);
  }, [agentWalletAddress, loadPortfolio]);

  useEffect(() => {
    if (agent?.id && isAuthenticated) {
      setLoadingTxs(true);
      setTxError('');
      transactions.list(agent.id)
        .then(data => setTxs(Array.isArray(data) ? data.slice(0, 5) : []))
        .catch(e => setTxError(e.message))
        .finally(() => setLoadingTxs(false));
    }
  }, [agent?.id, isAuthenticated]);

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
              { step: 2, title: 'Create Agent', desc: 'Go to the Agent tab, name your agent and choose permissions.' },
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
            <span className="font-mono text-sm text-slate-700">{ownerAddress?.slice(0, 8)}…{ownerAddress?.slice(-6)}</span>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
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
          </div>
        </div>
        <div className="mt-4">
          <AddressBox address={agent.walletAddress} label="Agent Wallet Address" />
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

      {/* Owner wallet */}
      <Card>
        <div className="flex items-center gap-3">
          <Wallet size={18} className="text-slate-400" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Owner Wallet (MetaMask)</p>
            <p className="font-mono text-sm text-slate-700">{ownerAddress}</p>
          </div>
        </div>
      </Card>

      {/* Recent activity */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <Activity size={16} className="text-slate-400" />
          <h3 className="font-semibold text-slate-800">Recent Activity</h3>
        </div>
        {loadingTxs ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : txError ? (
          <Alert type="error">{txError}</Alert>
        ) : txs.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">No transactions yet. Your agent activity will appear here.</div>
        ) : (
          <div className="space-y-2">
            {txs.map(tx => {
              const { title, routeLabel, amountLabel, phase, links } = getTxDisplay(tx);
              return (
                <div key={tx.id} className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm">
                  <div className="flex items-center gap-3">
                    <Zap size={14} className="shrink-0 text-arc-green" />
                    <span className="font-semibold text-slate-800 capitalize">{title}</span>
                    <Badge variant={tx.status === 'confirmed' ? 'green' : tx.status === 'failed' ? 'red' : 'yellow'} className="ml-auto">
                      {tx.status}
                    </Badge>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[22px] text-xs text-slate-500">
                    {routeLabel && <span>{routeLabel}</span>}
                    {amountLabel && <span className="font-medium text-slate-700">{amountLabel}</span>}
                    {phase && <span>{phase}</span>}
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
