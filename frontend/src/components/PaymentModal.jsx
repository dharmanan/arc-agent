import React, { useState, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useAgent } from '../providers/AgentProvider.jsx';
import { agents as agentsApi, transactions as txApi } from '../lib/api.js';
import { authenticatePasskey } from '../lib/passkey.js';
import { buildPaymentURI, generateQRDataURL } from '../lib/qrPayment.js';
import { startScan, stopScan, parsePaymentURI } from '../lib/qrScanner.js';
import { Button, Input } from './ui/index.jsx';
import { CHAINS } from '../lib/chains.js';
import { X, QrCode, Camera, ClipboardCheck, AlertTriangle, CheckCircle, Loader2, ExternalLink } from 'lucide-react';

function formatUsdcAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return amount ?? '?';
  return numeric.toFixed(4).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

const RECEIVE_CLOCK_SKEW_MS = 2 * 60 * 1000;

function normalizeAddress(address) {
  return String(address || '').trim().toLowerCase();
}

function parseTxCreatedAt(tx) {
  const createdAt = Date.parse(tx?.created_at || tx?.createdAt || '');
  return Number.isNaN(createdAt) ? null : createdAt;
}

function matchesRequestedAmount(tx, requestedAmount) {
  const tokenAmount = Number(tx?.meta?.tokenAmount);
  const txAmount = Number.isFinite(tokenAmount)
    ? tokenAmount
    : Number(tx?.amount_usdc ?? tx?.amountUsdc);
  if (!Number.isFinite(txAmount) || !Number.isFinite(requestedAmount)) return false;
  return Math.abs(txAmount - requestedAmount) < 0.0005;
}

// ── SendResult: shows amount, recipient, polls for confirmed tx hash ───────────
function SendResult({ result, agentName, onClose }) {
  const [txHash, setTxHash]     = useState(null);
  const [pollDone, setPollDone] = useState(false);
  const pollRef                 = useRef(null);

  useEffect(() => {
    if (!result?.txId) { setPollDone(true); return; }

    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const data = await txApi.getStatus(result.txId);
        if (data?.tx_hash || data?.txHash) {
          setTxHash(data.tx_hash || data.txHash);
          setPollDone(true);
          clearInterval(pollRef.current);
          return;
        }
        if (data?.status === 'failed') { setPollDone(true); clearInterval(pollRef.current); return; }
      } catch (_) {}
      if (attempts >= 12) { setPollDone(true); clearInterval(pollRef.current); } // give up after ~60s
    }, 5000);

    return () => clearInterval(pollRef.current);
  }, [result?.txId]);

  const explorerUrl = txHash
    ? `${CHAINS['Arc Testnet']?.explorerUrl || 'https://testnet.arcscan.app'}/tx/${txHash}`
    : null;

  return (
    <div className="p-6 text-center">
      <CheckCircle size={36} className="mx-auto mb-3 text-arc-green" />
      <h2 className="mb-1 text-lg font-bold text-slate-900">Payment Sent!</h2>
      {agentName && (
        <p className="mb-1 text-sm font-semibold text-slate-600">{agentName}</p>
      )}
      {result?.amountUsdc && (
        <p className="mb-1 text-xl font-bold text-arc-green">-{result.amountUsdc} USDC</p>
      )}
      {result?.toAddress && (
        <p className="mb-3 font-mono text-xs text-slate-500">
          to {result.toAddress.slice(0, 8)}…{result.toAddress.slice(-6)}
        </p>
      )}
      {!pollDone && (
        <p className="mb-3 flex items-center justify-center gap-1.5 text-xs text-slate-400">
          <Loader2 size={12} className="animate-spin" /> Waiting for on-chain confirmation…
        </p>
      )}
      {txHash && explorerUrl && (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-4 flex items-center justify-center gap-1.5 break-all rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 font-mono text-xs text-arc-green hover:underline"
        >
          <span>{txHash.slice(0, 14)}…{txHash.slice(-8)}</span>
          <ExternalLink size={10} />
        </a>
      )}
      {pollDone && !txHash && (
        <p className="mb-4 text-xs text-slate-400">Transaction submitted. Check Recent Activity for status.</p>
      )}
      <Button onClick={onClose} variant="outline" className="w-full">Close</Button>
    </div>
  );
}

// ── Modal wrapper ─────────────────────────────────────────────────────────────
function ModalOverlay({ onClose, children }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <X size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}

// ── RECEIVE FLOW ──────────────────────────────────────────────────────────────
function ReceiveFlow({ agent, onClose }) {
  const [step, setStep]             = useState(1); // 1 = amount input, 2 = QR display, 3 = received
  const [amount, setAmount]         = useState('');
  const [qrUrl, setQrUrl]           = useState('');
  const [uri, setUri]               = useState('');
  const [copied, setCopied]         = useState(false);
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [receivedTx, setReceivedTx] = useState(null);
  const [senderFallbackName, setSenderFallbackName] = useState('');
  const pollRef                     = useRef(null);
  const knownIdsRef                 = useRef(new Set());
  const listeningSinceRef           = useRef(0);
  const requestedAmountRef          = useRef(null);

  function isFreshReceive(tx, requestedAmount) {
    if (tx?.type !== 'receive' || tx?.status !== 'confirmed') return false;
    if (String(tx?.token || '').toUpperCase() !== 'USDC') return false;
    if (!matchesRequestedAmount(tx, requestedAmount)) return false;
    if (knownIdsRef.current.has(tx.id)) return false;

    const createdAt = parseTxCreatedAt(tx);
    if (createdAt == null) return false;

    return createdAt >= listeningSinceRef.current - RECEIVE_CLOCK_SKEW_MS;
  }

  // Start polling when QR is shown; stop on unmount
  useEffect(() => {
    if (step !== 2) return;

    const requestedAmount = requestedAmountRef.current;
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) return;

    listeningSinceRef.current = Date.now();
    knownIdsRef.current = new Set();

    // Snapshot existing tx ids so we only react to NEW ones
    txApi.list(agent.id).then(data => {
      if (!Array.isArray(data)) return;

      const freshReceive = data.find((tx) => isFreshReceive(tx, requestedAmount));
      if (freshReceive) {
        setReceivedTx(freshReceive);
        setStep(3);
        return;
      }

      data.forEach((tx) => {
        const createdAt = parseTxCreatedAt(tx);
        const isCurrentRequest = matchesRequestedAmount(tx, requestedAmount);
        const isAfterListening = createdAt != null && createdAt >= listeningSinceRef.current - RECEIVE_CLOCK_SKEW_MS;

        if (!isCurrentRequest || !isAfterListening) {
          knownIdsRef.current.add(tx.id);
        }
      });
    }).catch(() => {});

    pollRef.current = setInterval(async () => {
      try {
        const data = await txApi.list(agent.id);
        if (!Array.isArray(data)) return;
        const newReceive = data.find((tx) => isFreshReceive(tx, requestedAmount));
        if (newReceive) {
          clearInterval(pollRef.current);
          setReceivedTx(newReceive);
          setStep(3);
          return;
        }

        data.forEach(tx => knownIdsRef.current.add(tx.id));
      } catch (_) {}
    }, 5000);

    return () => clearInterval(pollRef.current);
  }, [step, agent.id]);

  useEffect(() => {
    let cancelled = false;

    const senderAgentName = String(receivedTx?.meta?.senderAgentName || '').trim();
    const fromAddress = normalizeAddress(receivedTx?.from_address);
    setSenderFallbackName('');

    if (step !== 3 || !receivedTx || senderAgentName || !fromAddress) {
      return () => {
        cancelled = true;
      };
    }

    agentsApi.list().then((data) => {
      if (cancelled || !Array.isArray(data)) return;

      const matchedAgent = data.find((candidate) => {
        const candidateAddress = normalizeAddress(candidate?.walletAddress || candidate?.wallet_address);
        return candidateAddress && candidateAddress === fromAddress;
      });

      if (!cancelled) {
        setSenderFallbackName(String(matchedAgent?.name || '').trim());
      }
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [receivedTx, step]);

  async function handleGenerate() {
    setError('');
    const val = parseFloat(amount);
    if (!val || val <= 0) { setError('Enter a valid amount'); return; }
    setLoading(true);
    try {
      requestedAmountRef.current = val;
      setReceivedTx(null);
      setSenderFallbackName('');
      const payUri = buildPaymentURI(agent.walletAddress, val);
      const dataUrl = await generateQRDataURL(payUri);
      setUri(payUri);
      setQrUrl(dataUrl);
      setStep(2);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(uri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // ── Step 3: Payment received confirmation
  if (step === 3 && receivedTx) {
    const rxAmount = formatUsdcAmount(receivedTx.amount_usdc ?? receivedTx.amountUsdc ?? '?');
    const fromAddr = receivedTx.from_address || '';
    const senderAgentName = String(receivedTx.meta?.senderAgentName || senderFallbackName || '').trim();
    return (
      <div className="p-6 text-center">
        <CheckCircle size={40} className="mx-auto mb-3 text-arc-green" />
        <h2 className="mb-1 text-lg font-bold text-slate-900">Payment Received!</h2>
        {senderAgentName && (
          <p className="mb-1 text-sm font-semibold text-slate-600">From {senderAgentName}</p>
        )}
        <p className="mb-1 text-2xl font-bold text-arc-green">+{rxAmount} USDC</p>
        {!senderAgentName && fromAddr && (
          <p className="mb-4 font-mono text-xs text-slate-500">
            from {fromAddr.slice(0, 8)}…{fromAddr.slice(-6)}
          </p>
        )}
        <p className="mb-5 text-sm text-slate-500">Your agent wallet has been credited on Arc Testnet.</p>
        <Button onClick={onClose} className="w-full">Close</Button>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h2 className="mb-1 text-lg font-bold text-slate-900">Receive USDC</h2>
      <p className="mb-5 text-sm text-slate-500">Generate a QR code that others can scan to pay you on Arc Testnet.</p>

      {step === 1 && (
        <div className="space-y-4">
          <Input
            label="Amount (USDC)"
            type="number"
            min="0"
            step="0.01"
            placeholder="e.g. 10.00"
            value={amount}
            onChange={e => setAmount(e.target.value)}
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button onClick={handleGenerate} loading={loading} className="w-full">
            <QrCode size={16} /> Generate QR
          </Button>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4 text-center">
          <div className="mx-auto mb-1 flex items-center gap-1.5 justify-center text-xs text-slate-400 animate-pulse">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-arc-green" />
            Listening for payment…
          </div>
          <img src={qrUrl} alt="Payment QR" className="mx-auto rounded-xl border border-slate-100" />
          <p className="text-xs text-slate-500 break-all">{uri}</p>
          <Button variant="outline" onClick={handleCopy} className="w-full">
            <ClipboardCheck size={14} /> {copied ? 'Copied!' : 'Copy URI'}
          </Button>
          <Button variant="ghost" onClick={() => setStep(1)} className="w-full text-sm">
            ← Change amount
          </Button>
        </div>
      )}
    </div>
  );
}

// ── SEND FLOW ─────────────────────────────────────────────────────────────────
function SendFlow({ agent, ownerAddress, onClose, isAuthenticated, clearAgent }) {
  const [step, setStep]               = useState(1); // 1=input, 2=confirm, 3=result
  const [inputMode, setInputMode]     = useState('scan'); // 'scan' | 'manual'
  const [scanning, setScanning]       = useState(false);
  const [scanError, setScanError]     = useState('');
  const [recipient, setRecipient]     = useState('');
  const [amount, setAmount]           = useState('');
  const [parsed, setParsed]           = useState(null); // { recipient, amountUsdc }
  const [limitInfo, setLimitInfo]     = useState('');
  const [loading, setLoading]         = useState(false);
  const [result, setResult]           = useState(null); // { txHash } | { error }
  const [formError, setFormError]     = useState('');
  const [sessionState, setSessionState] = useState(isAuthenticated ? 'checking' : 'missing');
  const [sessionError, setSessionError] = useState('');
  const videoRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function validateSession() {
      stopCamera();

      if (!isAuthenticated) {
        setSessionState('missing');
        setSessionError('Session expired. Reconnect with your passkey before sending funds.');
        return;
      }

      setSessionState('checking');
      setSessionError('');

      try {
        await agentsApi.list();
        if (!cancelled) {
          setSessionState('ready');
        }
      } catch (err) {
        if (cancelled) return;

        if (err?.status === 401) {
          clearAgent?.();
          setSessionState('missing');
          setSessionError('Session expired. Reconnect with your passkey before scanning a QR code.');
          return;
        }

        setSessionState('error');
        setSessionError(err?.message || 'Could not verify your session right now.');
      }
    }

    validateSession();

    return () => {
      cancelled = true;
    };
  }, [clearAgent, isAuthenticated]);

  // Start/stop camera on mount/unmount when scan mode
  useEffect(() => {
    if (sessionState === 'ready' && inputMode === 'scan' && step === 1) {
      startCamera();
    }
    return () => stopCamera();
  }, [inputMode, sessionState, step]);

  async function startCamera() {
    setScanning(true);
    setScanError('');
    // Delay to let React render the <video>
    setTimeout(() => {
      if (!videoRef.current) return;
      startScan(
        videoRef.current,
        (result) => {
          stopCamera();
          setParsed({ ...result, source: 'scan' });
          setStep(2);
        },
        (err) => {
          setScanError(err.message);
          setScanning(false);
        },
      );
    }, 200);
  }

  function stopCamera() {
    stopScan();
    setScanning(false);
  }

  function handleManualContinue() {
    setFormError('');
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      setFormError('Invalid address format');
      return;
    }
    const val = parseFloat(amount);
    if (!val || val <= 0) {
      setFormError('Enter a valid amount');
      return;
    }
    setParsed({ recipient, amountUsdc: val, source: 'manual' });
    setStep(2);
  }

  // Determine limit category for confirm screen
  useEffect(() => {
    if (!parsed || !agent) return;
    const maxTrade   = agent.settings?.maxTradeUsdc ?? agent.maxTradeUsdc ?? 500;
    const dailyLimit = agent.settings?.dailyLimitUsdc ?? agent.dailyLimitUsdc ?? 1000;
    if (parsed.amountUsdc > dailyLimit) {
      setLimitInfo(`⚠️ Exceeds daily limit (${dailyLimit} USDC)`);
    } else if (parsed.amountUsdc > maxTrade) {
      setLimitInfo(`Passkey required — above auto-approve limit (${maxTrade} USDC)`);
    } else {
      setLimitInfo(`Within auto-approve limit (≤ ${maxTrade} USDC)`);
    }
  }, [parsed, agent]);

  async function handleConfirm() {
    setLoading(true);
    setFormError('');
    try {
      const tx = await txApi.send({
        agentId:    agent.id,
        toAddress:  parsed.recipient,
        amountUsdc: parsed.amountUsdc,
        token:      'USDC',
        chain:      'Arc Testnet',
      });
      setResult({ txId: tx.txId || tx.id, toAddress: parsed.recipient, amountUsdc: parsed.amountUsdc });
      setStep(3);
    } catch (err) {
      if (err.status === 422 && err.message?.includes('requiresPasskey')) {
        setFormError('Passkey sign required. Please use the "Sign with Passkey" button.');
      } else if (err.status === 429) {
        setFormError('Daily limit reached. Try again tomorrow.');
      } else {
        setFormError(err.message || 'Transaction failed');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmWithPasskey() {
    setLoading(true);
    setFormError('');
    try {
      // Re-authenticate — only prompt the biometric, no new JWT needed
      await authenticatePasskey(ownerAddress);
      await handleConfirmSend();
    } catch (err) {
      setFormError('Passkey authentication failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmSend() {
    try {
      const tx = await txApi.send({
        agentId:    agent.id,
        toAddress:  parsed.recipient,
        amountUsdc: parsed.amountUsdc,
        token:      'USDC',
        chain:      'Arc Testnet',
      });
      setResult({ txId: tx.txId || tx.id, toAddress: parsed.recipient, amountUsdc: parsed.amountUsdc });
      setStep(3);
    } catch (err) {
      if (err.status === 429) {
        setFormError('Daily limit reached. Try again tomorrow.');
      } else {
        setFormError(err.message || 'Transaction failed');
      }
    }
  }

  const maxTrade   = agent?.settings?.maxTradeUsdc ?? agent?.maxTradeUsdc ?? 500;
  const dailyLimit = agent?.settings?.dailyLimitUsdc ?? agent?.dailyLimitUsdc ?? 1000;
  const needsPasskey  = parsed && parsed.amountUsdc > maxTrade;
  const dailyBlocked  = parsed && parsed.amountUsdc > dailyLimit;
  const qrAmountWarning = parsed?.source === 'scan' && parsed.amountUsdc > maxTrade * 10
    ? `This QR requests ${formatUsdcAmount(parsed.amountUsdc)} USDC, which is more than 10x your auto-approve limit (${formatUsdcAmount(maxTrade)} USDC). Double-check the amount and recipient before sending.`
    : '';

  // ── Step 1: Input
  if (step === 1) {
    if (sessionState !== 'ready') {
      return (
        <div className="p-6">
          <h2 className="mb-1 text-lg font-bold text-slate-900">Send USDC</h2>
          <p className="mb-4 text-sm text-slate-500">A valid agent session is required before the camera or send form can open.</p>

          <div className={`rounded-xl border px-4 py-3 text-sm ${sessionState === 'checking' ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-red-200 bg-red-50 text-red-600'}`}>
            {sessionState === 'checking' ? (
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> Verifying active session…
              </div>
            ) : (
              sessionError || 'Session is not available.'
            )}
          </div>

          <div className="mt-4 flex gap-2">
            <Button variant="outline" onClick={onClose} className="flex-1">Close</Button>
            {sessionState !== 'checking' && (
              <Button onClick={() => window.location.reload()} className="flex-1">Retry Session Check</Button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-900">Send USDC</h2>
        <p className="mb-4 text-sm text-slate-500">Scan a payment QR or enter details manually.</p>

        <div className="mb-4 flex gap-2">
          <button
            onClick={() => setInputMode('scan')}
            className={`flex-1 rounded-xl border py-2 text-sm font-semibold transition ${inputMode === 'scan' ? 'border-arc-green bg-arc-greenBg text-arc-green' : 'border-slate-200 text-slate-500 hover:border-arc-green/40'}`}
          >
            <Camera size={14} className="mr-1.5 inline" /> Scan QR
          </button>
          <button
            onClick={() => { setInputMode('manual'); stopCamera(); }}
            className={`flex-1 rounded-xl border py-2 text-sm font-semibold transition ${inputMode === 'manual' ? 'border-arc-green bg-arc-greenBg text-arc-green' : 'border-slate-200 text-slate-500 hover:border-arc-green/40'}`}
          >
            Manual Entry
          </button>
        </div>

        {inputMode === 'scan' && (
          <div className="overflow-hidden rounded-xl bg-black">
            <video
              ref={videoRef}
              className="w-full"
              style={{ aspectRatio: '1', objectFit: 'cover' }}
              autoPlay
              muted
              playsInline
            />
            {!scanning && !scanError && (
              <p className="py-2 text-center text-xs text-slate-400">Starting camera…</p>
            )}
            {scanError && (
              <p className="px-4 py-2 text-center text-xs text-red-400">{scanError}</p>
            )}
          </div>
        )}

        {inputMode === 'manual' && (
          <div className="space-y-3">
            <Input
              label="Recipient Address"
              placeholder="0x..."
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
            />
            <Input
              label="Amount (USDC)"
              type="number"
              min="0"
              step="0.01"
              placeholder="e.g. 5.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
            {formError && <p className="text-sm text-red-500">{formError}</p>}
            <Button onClick={handleManualContinue} className="w-full">Continue</Button>
          </div>
        )}
      </div>
    );
  }

  // ── Step 2: Confirm
  if (step === 2) {
    return (
      <div className="p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-900">Confirm Payment</h2>
        <p className="mb-4 text-sm text-slate-500">Review before sending — this cannot be undone.</p>

        <div className="mb-4 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">To</span>
            <span className="font-mono text-slate-800 break-all text-right max-w-[200px]">
              {parsed.recipient.slice(0, 10)}…{parsed.recipient.slice(-8)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Amount</span>
            <span className="font-bold text-slate-900">{parsed.amountUsdc} USDC</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Network</span>
            <span className="text-slate-800">Arc Testnet</span>
          </div>
        </div>

        {qrAmountWarning && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {qrAmountWarning}
          </div>
        )}

        {limitInfo && (
          <div className={`mb-4 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${dailyBlocked ? 'border-red-200 bg-red-50 text-red-600' : needsPasskey ? 'border-yellow-200 bg-yellow-50 text-yellow-700' : 'border-green-200 bg-green-50 text-green-700'}`}>
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {limitInfo}
          </div>
        )}

        {formError && <p className="mb-3 text-sm text-red-500">{formError}</p>}

        {dailyBlocked ? (
          <Button variant="outline" disabled className="w-full">Daily Limit Reached</Button>
        ) : needsPasskey ? (
          <Button onClick={handleConfirmWithPasskey} loading={loading} className="w-full">
            Sign with Passkey
          </Button>
        ) : (
          <Button onClick={handleConfirm} loading={loading} className="w-full">
            Confirm Send
          </Button>
        )}

        <Button variant="ghost" onClick={() => setStep(1)} className="mt-2 w-full text-sm" disabled={loading}>
          ← Back
        </Button>
      </div>
    );
  }

  // ── Step 3: Result — poll for tx hash until confirmed
  if (step === 3) {
    return <SendResult result={result} agentName={agent.name} onClose={onClose} />;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * PaymentModal
 * @param {{ mode: 'send'|'receive', onClose: () => void }} props
 */
export default function PaymentModal({ mode, onClose }) {
  const { agent, clearAgent, isAuthenticated } = useAgent();
  const { address: ownerAddr } = useAccount();

  if (!agent) {
    return (
      <ModalOverlay onClose={onClose}>
        <div className="p-6 text-center">
          <p className="text-sm text-slate-500">No agent found. Create an agent first.</p>
          <Button variant="outline" onClick={onClose} className="mt-4">Close</Button>
        </div>
      </ModalOverlay>
    );
  }

  return (
    <ModalOverlay onClose={onClose}>
      {mode === 'receive'
        ? <ReceiveFlow agent={agent} onClose={onClose} />
        : <SendFlow agent={agent} ownerAddress={ownerAddr} onClose={onClose} isAuthenticated={isAuthenticated} clearAgent={clearAgent} />
      }
    </ModalOverlay>
  );
}
