import React, { useState } from 'react';
import { useAccount } from 'wagmi';
import { useAgent } from '../providers/AgentProvider.jsx';
import { transactions as txApi } from '../lib/api.js';
import { Card, Button, Input, Select, Alert, SectionHeader } from './ui/index.jsx';
import { Send, Shield, ExternalLink, ChevronLeft } from 'lucide-react';
import { CHAINS } from '../lib/chains.js';

export default function SecurityTab({ onBack }) {
  const { address: ownerAddress } = useAccount();
  const { agent, isAuthenticated } = useAgent();

  const [chain,    setChain]    = useState('Sepolia');
  const [toAddr,   setToAddr]   = useState('');
  const [amount,   setAmount]   = useState('');
  const [token,    setToken]    = useState('ETH');
  const [status,   setStatus]   = useState(null);
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  if (!ownerAddress) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Shield size={32} className="mb-4 text-slate-300" />
        <h2 className="text-lg font-bold text-slate-900">Wallet Not Connected</h2>
        <p className="mt-1 text-sm text-slate-500">Connect your wallet first.</p>
      </div>
    );
  }

  if (!agent || !isAuthenticated) {
    return (
      <div className="space-y-4">
        <SectionHeader title="Send" subtitle="Send funds from your agent wallet." />
        <Card className="border-yellow-200 bg-yellow-50">
          <p className="text-sm font-medium text-yellow-800">
            You need an active agent wallet. Go to the Agent tab to create or reconnect one.
          </p>
        </Card>
      </div>
    );
  }

  async function handleSend() {
    if (!toAddr.match(/^0x[0-9a-fA-F]{40}$/)) {
      setError('Please enter a valid EVM address (0x…).');
      return;
    }
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      setError('Please enter a valid amount.');
      return;
    }
    setError('');
    setLoading(true);
    setStatus('pending');
    try {
      const result = await txApi.send({
        agentId:      agent.id,
        chain,
        toAddress:    toAddr,
        amount:       parseFloat(amount),
        token,
        ownerAddress,
      });
      if (result.txId) {
        const final = await txApi.poll(result.txId, tx => setStatus(tx));
        setStatus(final);
      } else {
        setStatus(result);
      }
    } catch (e) {
      setError(e.message);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  function reset() { setStatus(null); setError(''); setAmount(''); setToAddr(''); }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-arc-green transition">
            <ChevronLeft size={16} /> Back
          </button>
        )}
        <SectionHeader title="Send Funds" subtitle="Transfer tokens from your agent wallet to any address." />
      </div>

      {status && status !== 'pending' && typeof status === 'object' ? (
        <Card>
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <h3 className="text-lg font-bold text-slate-900">
              {status.status === 'confirmed' ? 'Transaction Sent!' : status.status === 'failed' ? 'Transaction Failed' : 'Processing…'}
            </h3>
            {status.txHash && (
              <a
                href={`${CHAINS[chain]?.explorerUrl}/tx/${status.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-arc-green hover:underline"
              >
                View on Explorer <ExternalLink size={13} />
              </a>
            )}
            <Button variant="outline" onClick={reset}>Send Another</Button>
          </div>
        </Card>
      ) : (
        <Card className="max-w-lg">
          <div className="space-y-4">
            <Select label="Network" value={chain} onChange={e => setChain(e.target.value)}>
              {Object.keys(CHAINS).filter(n => n !== 'Solana').map(n => <option key={n}>{n}</option>)}
            </Select>

            <Input
              label="Recipient Address"
              placeholder="0x..."
              value={toAddr}
              onChange={e => setToAddr(e.target.value)}
            />

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Amount"
                type="number"
                placeholder="0.001"
                min="0"
                step="0.001"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
              <Select label="Token" value={token} onChange={e => setToken(e.target.value)}>
                <option>ETH</option>
                <option>ARC</option>
                <option>USDC</option>
              </Select>
            </div>

            {error && <Alert type="error">{error}</Alert>}
            {status === 'pending' && <Alert type="info">Transaction submitted — waiting for confirmation…</Alert>}

            <Button onClick={handleSend} loading={loading} className="w-full">
              <Send size={16} /> Send {amount || '0'} {token}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
