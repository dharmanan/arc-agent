import React, { useState, useEffect, useRef } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { useAgent } from '../providers/AgentProvider.jsx';
import { agents as agentApi } from '../lib/api.js';
import { AGENT_PERMISSIONS } from '../lib/chains.js';
import { fetchUsdcBalance } from '../lib/agentBalances.js';
import { registerPasskey, authenticatePasskey, isPasskeySupported } from '../lib/passkey.js';
import {
  Card, Button, Input, Badge, Alert, AddressBox, Spinner, SectionHeader, Select
} from './ui/index.jsx';
import { Bot, Plus, Trash2, Key, AlertTriangle, LogOut, Brain, Shield, Zap, CheckCircle, XCircle, RefreshCw, FlaskConical } from 'lucide-react';

function getProviderLabel(model) {
  if (!model) return 'Unknown';
  if (model.startsWith('claude')) return 'Anthropic';
  if (model.startsWith('gemini')) return 'Google';
  if (model.startsWith('gpt-')) return 'OpenAI';
  if (model.startsWith('llama-')) return 'Groq';
  return 'Unknown';
}

function parseNonNegativeUsdc(value) {
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function parseOptionalPositiveUsdc(value) {
  if (value == null || value === '') return null;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseOptionalNonNegativeUsdc(value) {
  if (value == null || value === '') return null;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export default function AgentTab() {
  const { address: ownerAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { agent, setAgent, setJwt, clearAgent, disconnectSession } = useAgent();

  const [step, setStep]         = useState('idle');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [name, setName]         = useState('');
  const [deviceName, setDevice] = useState('My Device');
  const [newKey, setNewKey]     = useState('');
  const [perms, setPerms]       = useState({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savingPerms, setSavingPerms]     = useState(false);
  const [permMsg, setPermMsg]             = useState('');

  // ERC-8004 identity retry
  const [retryingIdentity, setRetryingIdentity] = useState(false);
  const [identityMsg, setIdentityMsg]           = useState('');

  // Settings state
  const [settings, setSettings]   = useState({});
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmModel, setLlmModel]   = useState('llama-3.3-70b-versatile');
  const [smartMode, setSmartMode] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestMsg, setLlmTestMsg] = useState('');
  const [features, setFeatures]   = useState({
    dailyTasksEnabled:     false,
    marketAnalysisEnabled: false,
    oracleEnabled:         false,
    defiLoopEnabled:       false,
    lendingAutomationEnabled: false,
    carryAutomationEnabled: false,
    cirbtcLpEnabled:       false,
    reputationEnabled:     false,
  });
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg]       = useState('');

  const [agentUsdc, setAgentUsdc] = useState(null);

  const pendingAgent = useRef(null);

  useEffect(() => {
    if (agent?.permissions) setPerms(agent.permissions);
    if (agent?.settings) {
      setSettings(agent.settings);
    }
    if (agent?.isSmartMode !== undefined) setSmartMode(agent.isSmartMode);
    if (agent?.llmModel) setLlmModel(agent.llmModel);
    if (agent?.features) setFeatures(f => ({ ...f, ...agent.features }));
  }, [agent]);

  // Fetch agent USDC balance for low-balance warning
  useEffect(() => {
    if (!agent?.walletAddress) { setAgentUsdc(null); return; }
    fetchUsdcBalance(agent.walletAddress, 5042002)
      .then(v => setAgentUsdc(v))
      .catch(() => setAgentUsdc(null));
  }, [agent?.walletAddress]);

  if (!ownerAddress) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Bot size={32} className="mb-4 text-slate-300" />
        <h2 className="text-lg font-bold text-slate-900">Wallet Not Connected</h2>
        <p className="mt-1 text-sm text-slate-500">Connect your wallet to manage your agent.</p>
      </div>
    );
  }

  async function handleRetryIdentity() {
    if (!agent?.id) return;
    setRetryingIdentity(true);
    setIdentityMsg('');
    try {
      const result = await agentApi.retryIdentity(agent.id);
      if (result.success) {
        setAgent(a => ({ ...a, identity: { ...a.identity, status: 'registered', tokenId: result.tokenId, txHash: result.txHash, error: null } }));
        setIdentityMsg('Identity registered successfully.');
      } else {
        setAgent(a => ({ ...a, identity: { ...a.identity, status: 'failed', error: result.error } }));
        setIdentityMsg('Registration failed: ' + result.error);
      }
    } catch (e) {
      setIdentityMsg('Error: ' + e.message);
    } finally {
      setRetryingIdentity(false);
      setTimeout(() => setIdentityMsg(''), 6000);
    }
  }

  async function handleCreate() {
    if (!name.trim()) { setError('Please enter an agent name.'); return; }
    setError('');
    setLoading(true);
    try {
      let authResult;
      try {
        authResult = await registerPasskey(ownerAddress, deviceName, signMessageAsync);
      } catch (regErr) {
        // Passkey already exists on this device — fall back to authentication
        if (regErr?.code === 'PASSKEY_ALREADY_REGISTERED') {
          authResult = await authenticatePasskey(ownerAddress);
        } else {
          throw regErr;
        }
      }
      setJwt(authResult.token);
      const created = await agentApi.create({ name: name.trim() });
      pendingAgent.current = created.agent || created;
      setNewKey(created.privateKey || '');
      setStep('confirm');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleKeySaved() {
    if (pendingAgent.current) {
      setAgent(pendingAgent.current);
      pendingAgent.current = null;
    }
    setNewKey('');
    setStep('idle');
  }

  async function loadFirstAgentWithDetails() {
    const list = await agentApi.list();
    if (!list.length) return null;

    try {
      return await agentApi.get(list[0].id);
    } catch {
      return list[0];
    }
  }

  async function handleLogin() {
    setError('');
    setLoading(true);
    try {
      const authResult = await authenticatePasskey(ownerAddress);
      setJwt(authResult.token);
      const fullAgent = await loadFirstAgentWithDetails();
      if (fullAgent) setAgent(fullAgent);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!agent?.id) return;
    setLoading(true);
    try {
      await agentApi.delete(agent.id);
      clearAgent();
      setConfirmDelete(false);
      setStep('idle');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveSettings() {
    if (!agent?.id) return;
    setSavingSettings(true);
    setSettingsMsg('');
    try {
      const payload = {
        dailyLimitUsdc:  parseFloat(settings.dailyLimitUsdc) || 1000,
        maxGasGwei:      parseInt(settings.maxGasGwei)       || 50,
        slippagePercent: parseFloat(settings.slippagePercent) || 0.5,
        maxTradeUsdc:    parseFloat(settings.maxTradeUsdc)    || 200,
        defiWalletReserveUsdc: parseNonNegativeUsdc(settings.defiWalletReserveUsdc),
        oracleMaxEurcInventory: parseOptionalPositiveUsdc(settings.oracleMaxEurcInventory),
        oracleMinEurcReserve: parseOptionalNonNegativeUsdc(settings.oracleMinEurcReserve),
        autoLockMinutes: parseInt(settings.autoLockMinutes)   || 5,
        contractGuard:   settings.contractGuard !== false,
      };
      if (llmApiKey.trim()) payload.llmApiKey = llmApiKey.trim();
      if (smartMode || llmApiKey.trim()) payload.llmModel = llmModel;
      payload.isSmartMode           = smartMode;
      payload.dailyTasksEnabled     = features.dailyTasksEnabled;
      payload.marketAnalysisEnabled = features.marketAnalysisEnabled;
      payload.oracleEnabled         = features.oracleEnabled;
      payload.defiLoopEnabled       = features.defiLoopEnabled;
      payload.lendingAutomationEnabled = features.lendingAutomationEnabled;
      payload.carryAutomationEnabled = features.carryAutomationEnabled;
      payload.cirbtcLpEnabled       = features.cirbtcLpEnabled;
      payload.reputationEnabled     = features.reputationEnabled;
      const updated = await agentApi.update(agent.id, payload);
      setAgent({ ...agent, ...updated });
      setLlmApiKey('');
      setSettingsMsg('Settings saved.');
      setTimeout(() => setSettingsMsg(''), 3000);
    } catch (e) {
      setSettingsMsg('Error: ' + e.message);
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleTestLlm() {
    if (!agent?.id) return;
    setTestingLlm(true);
    setLlmTestMsg('');
    try {
      const result = await agentApi.testLlm(agent.id, {
        llmModel,
        ...(llmApiKey.trim() ? { llmApiKey: llmApiKey.trim() } : {}),
      });

      const sourceLabel = result.usingStoredKey ? 'stored key' : 'typed key (not saved yet)';
      setLlmTestMsg(
        `Live ${result.provider} check passed using ${sourceLabel}. ` +
        `Model: ${result.model}. Challenge: ${result.challenge}. ` +
        `Latency: ${result.latencyMs} ms. Response: ${result.responseText || 'CONNECTED'}`
      );
    } catch (e) {
      setLlmTestMsg(`Error: ${e.message}`);
    } finally {
      setTestingLlm(false);
    }
  }

  async function handleSavePerms() {
    if (!agent?.id) return;
    setSavingPerms(true);
    setPermMsg('');
    try {
      await agentApi.update(agent.id, {
        defiWalletReserveUsdc: parseNonNegativeUsdc(settings.defiWalletReserveUsdc),
      });
      const updated = await agentApi.updatePermissions(agent.id, perms);
      setAgent(a => ({ ...(a || {}), ...(updated || {}), permissions: updated?.permissions || perms }));
      setPermMsg('Permissions saved.');
      setTimeout(() => setPermMsg(''), 3000);
    } catch (e) {
      setPermMsg('Error: ' + e.message);
    } finally {
      setSavingPerms(false);
    }
  }

  if (step === 'confirm') {
    return (
      <div className="space-y-6">
        <SectionHeader
          title="Save Your Agent Private Key"
          subtitle="This key is shown once. Store it securely."
        />
        <Card className="max-w-lg border-yellow-200 bg-yellow-50">
          <div className="mb-3 flex items-center gap-2">
            <AlertTriangle size={18} className="text-yellow-600" />
            <span className="font-semibold text-yellow-800">One-time disclosure</span>
          </div>
          <p className="mb-4 text-sm text-yellow-700">
            Copy this private key and store it in a password manager or secure vault.
            It will <strong>never</strong> be shown again.
          </p>
          <div className="mb-2 rounded-xl border border-yellow-200 bg-white p-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Private Key</p>
            <p className="break-all font-mono text-sm text-slate-800 select-all">
              {newKey || '(key unavailable)'}
            </p>
          </div>
          <p className="mb-4 text-xs text-yellow-600">
            Tip: Click the key above to select all, then Ctrl+C to copy.
          </p>
          <Button onClick={handleKeySaved} className="w-full">
            I Have Saved the Key — Continue
          </Button>
        </Card>
      </div>
    );
  }

  if (!agent && step === 'idle') {
    return (
      <div className="space-y-6">
        <SectionHeader title="Agent Wallet" subtitle="Create or connect to an autonomous agent wallet." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-arc-greenBg">
              <Plus size={20} className="text-arc-green" />
            </div>
            <h3 className="mb-1 font-bold text-slate-900">Create New Agent</h3>
            <p className="mb-4 text-sm text-slate-500">
              Register a passkey and deploy a new agent wallet. Private key shown only once.
            </p>
            <Button onClick={() => { setStep('create'); setError(''); }}>Create Agent</Button>
          </Card>
          <Card>
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100">
              <Key size={20} className="text-slate-500" />
            </div>
            <h3 className="mb-1 font-bold text-slate-900">Reconnect Existing Agent</h3>
            <p className="mb-4 text-sm text-slate-500">
              Already have an agent? Authenticate with your passkey to restore the session.
            </p>
            <Button variant="outline" onClick={handleLogin} loading={loading}>
              Authenticate with Passkey
            </Button>
          </Card>
        </div>
        {error && <Alert type="error">{error}</Alert>}
      </div>
    );
  }

  if (!agent && step === 'create') {
    return (
      <div className="space-y-6">
        <SectionHeader
          title="Create Agent Wallet"
          subtitle="A passkey will be registered to authorize agent transactions."
        />
        <Card className="max-w-lg">
          <div className="space-y-4">
            <Input
              label="Agent Name"
              placeholder="e.g. DeFi Scout"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <Input
              label="Device Name (for passkey)"
              placeholder="e.g. My MacBook"
              value={deviceName}
              onChange={e => setDevice(e.target.value)}
            />
            {!isPasskeySupported() && (
              <Alert type="warning">
                Your browser does not support Passkeys. Use Safari (iOS) or Chrome (Android) — not MetaMask&apos;s built-in browser.
              </Alert>
            )}
            {isPasskeySupported() && /MetaMask/i.test(navigator.userAgent) && (
              <Alert type="warning">
                MetaMask&apos;s built-in browser may block Passkeys. Open this page in Safari or Chrome instead.
              </Alert>
            )}
            {error && <Alert type="error">{error}</Alert>}
            <div className="flex gap-3">
              <Button onClick={handleCreate} loading={loading}>
                Register Passkey &amp; Create
              </Button>
              <Button variant="outline" onClick={() => setStep('idle')} disabled={loading}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="Agent Settings" subtitle={'Managing: ' + (agent?.name || '')} />

      {/* Identity card */}
      <Card>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Badge variant="green">Active</Badge>
          <span className="font-semibold text-slate-800">{agent?.name}</span>
          {agent?.isSmartMode && (
            <Badge variant="blue" className="flex items-center gap-1"><Brain size={11} /> Smart Mode</Badge>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={disconnectSession}
              className="flex items-center gap-2 text-slate-500 hover:text-red-600 hover:border-red-300"
            >
              <LogOut size={14} />
              Disconnect Session
            </Button>
          </div>
        </div>
        <AddressBox address={agent?.walletAddress} label="Agent Wallet Address" />
        <p className="mt-2 text-xs text-slate-400">
          Send ARC or ETH to this address to fund your agent operations.
        </p>

        {agentUsdc !== null && parseFloat(agentUsdc) < 0.01 && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-600" />
            <div>
              <p className="text-sm font-semibold text-amber-800">Agent wallet has no USDC</p>
              <p className="text-xs text-amber-700 mt-0.5">
                Send USDC to your agent wallet to enable paid tasks and autonomous operations.{' '}
                <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" className="underline font-medium">
                  Get testnet USDC →
                </a>
              </p>
            </div>
          </div>
        )}

        {/* ERC-8004 Identity status */}
        <div className="mt-4">
          {agent?.identity?.status === 'registered' && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2">
              <CheckCircle size={14} className="shrink-0 text-green-600" />
              <span className="text-sm font-medium text-green-800">Arc Identity Registered</span>
              {agent.identity.tokenId && (
                <span className="text-xs text-green-700">· Token #{agent.identity.tokenId}</span>
              )}
              {agent.identity.arcScanUrl && (
                <a
                  href={agent.identity.arcScanUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-xs text-green-700 underline hover:text-green-900"
                >
                  View on ArcScan →
                </a>
              )}
            </div>
          )}

          {agent?.identity?.status === 'pending' && (
            <div className="flex items-center gap-2 rounded-xl border border-yellow-200 bg-yellow-50 px-3 py-2">
              <Spinner size={14} className="text-yellow-600" />
              <span className="text-sm text-yellow-800">Registering identity on-chain…</span>
            </div>
          )}

          {agent?.identity?.status === 'failed' && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <XCircle size={14} className="shrink-0 text-red-500" />
                <span className="text-sm font-medium text-red-800">Identity registration failed</span>
                <Button
                  variant="outline"
                  onClick={handleRetryIdentity}
                  loading={retryingIdentity}
                  className="ml-auto flex items-center gap-1 text-xs border-red-300 text-red-700 hover:bg-red-100"
                >
                  <RefreshCw size={12} /> Retry
                </Button>
              </div>
              {agent.identity.error && (
                <p className="mt-1 text-xs text-red-600 break-all">{agent.identity.error}</p>
              )}
            </div>
          )}

          {(!agent?.identity?.status || agent?.identity?.status === 'skipped') && (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <span className="h-2 w-2 rounded-full bg-slate-300 shrink-0" />
              <span className="text-sm text-slate-500">On-chain identity not configured (testnet)</span>
            </div>
          )}

          {identityMsg && (
            <p className={`mt-1 text-xs font-medium ${identityMsg.startsWith('Error') || identityMsg.includes('failed') ? 'text-red-500' : 'text-green-600'}`}>
              {identityMsg}
            </p>
          )}
        </div>

      </Card>

      {/* Security & Limits */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <Shield size={16} className="text-arc-green" />
          <h3 className="font-bold text-slate-900">Security &amp; Limits</h3>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Daily Limit (USDC)"
            type="number"
            min="1"
            placeholder="1000"
            value={settings.dailyLimitUsdc ?? ''}
            onChange={e => setSettings(s => ({ ...s, dailyLimitUsdc: e.target.value }))}
          />
          <Input
            label="Max trade size (USDC) — also the auto-approve ceiling"
            type="number"
            min="1"
            placeholder="200"
            value={settings.maxTradeUsdc ?? ''}
            onChange={e => setSettings(s => ({ ...s, maxTradeUsdc: e.target.value }))}
          />
          <Input
            label="Wallet EURC cap"
            type="number"
            min="1"
            step="0.01"
            placeholder="Leave blank to follow the trade cap"
            value={settings.oracleMaxEurcInventory ?? ''}
            onChange={e => setSettings(s => ({ ...s, oracleMaxEurcInventory: e.target.value }))}
          />
          <Input
            label="Max Gas (gwei)"
            type="number"
            min="1"
            placeholder="50"
            value={settings.maxGasGwei ?? ''}
            onChange={e => setSettings(s => ({ ...s, maxGasGwei: e.target.value }))}
          />
          <Input
            label="Slippage (%)"
            type="number"
            min="0.1"
            max="50"
            step="0.1"
            placeholder="0.5"
            value={settings.slippagePercent ?? ''}
            onChange={e => setSettings(s => ({ ...s, slippagePercent: e.target.value }))}
          />
          <Input
            label="Keep at least (EURC)"
            type="number"
            min="0"
            step="0.01"
            placeholder="Leave blank to mirror the USDC reserve"
            value={settings.oracleMinEurcReserve ?? ''}
            onChange={e => setSettings(s => ({ ...s, oracleMinEurcReserve: e.target.value }))}
          />
          <Input
            label="Auto-lock after (minutes)"
            type="number"
            min="1"
            max="60"
            placeholder="5"
            value={settings.autoLockMinutes ?? ''}
            onChange={e => setSettings(s => ({ ...s, autoLockMinutes: e.target.value }))}
          />
          <div className="flex items-center gap-3 rounded-xl border border-slate-100 p-3">
            <input
              type="checkbox"
              id="contractGuard"
              className="h-4 w-4 rounded accent-arc-green"
              checked={settings.contractGuard !== false}
              onChange={e => setSettings(s => ({ ...s, contractGuard: e.target.checked }))}
            />
            <label htmlFor="contractGuard" className="cursor-pointer">
              <p className="text-sm font-semibold text-slate-800">Contract Guard</p>
              <p className="text-xs text-slate-500">Block interactions with unverified contracts</p>
            </label>
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600 space-y-2">
          <p>
            <span className="font-semibold text-slate-800">How the stable oracle lane uses these settings:</span>{' '}
            each buy or sell cycle is capped by <strong>{Number(settings.maxTradeUsdc || 0).toFixed(2)} USDC</strong>.
          </p>
          <p>
            The wallet keeps your USDC reserve first, then buys EURC only until the wallet reaches the EURC cap. Leave the EURC cap blank if you want it to follow the trade cap.
          </p>
          <p>
            If EURC has already built up, the bot keeps the protected EURC reserve and sells only the excess back into USDC on the live swap route whenever the exit quote is strong enough. Leave the EURC reserve blank to mirror the USDC reserve.
          </p>
          <p>
            When the same-run round trip is profitable enough, the bot can also buy EURC on Curve and sell it back into USDC in the same cycle instead of keeping the EURC inventory.
          </p>
        </div>
        <p className="mt-3 text-xs text-slate-400 flex items-center gap-1">
          <Zap size={11} /> Transactions below the auto-approve limit are signed automatically by the agent without prompting.
        </p>
      </Card>

      {/* Smart Agent Mode */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <Brain size={16} className="text-arc-green" />
          <h3 className="font-bold text-slate-900">Smart Agent Mode</h3>
          <label className="ml-auto flex cursor-pointer items-center gap-2">
            <span className="text-sm text-slate-500">{smartMode ? 'On' : 'Off'}</span>
            <div
              onClick={() => setSmartMode(v => !v)}
              className={`relative h-6 w-11 rounded-full transition-colors ${smartMode ? 'bg-arc-green' : 'bg-slate-200'}`}
            >
              <div className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${smartMode ? 'translate-x-5' : ''}`} />
            </div>
          </label>
        </div>

        {!smartMode ? (
          <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-medium text-slate-800 mb-1 flex items-center gap-2">
              Basic Mode (default)
              <Badge variant="green" className="text-xs">Built-in rules</Badge>
            </p>
            <p>Agent follows built-in limits and only trades when you trigger actions manually.</p>
            <p className="mt-2 text-xs text-slate-500">No LLM key is needed for Free Daily Tasks.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-arc-green/20 bg-arc-greenBg p-3 text-xs text-slate-600">
              Smart Mode can use an LLM to scan for opportunities and act within your limits.
            </div>
            <Select
              label="LLM Model"
              value={llmModel}
              onChange={e => setLlmModel(e.target.value)}
            >
              <optgroup label="Free Tier (No cost)">
                <option value="llama-3.3-70b-versatile">Llama 3.3 70B — Groq FREE ⭐ Recommended</option>
                <option value="llama-3.1-8b-instant">Llama 3.1 8B Instant — Groq FREE (fastest)</option>
              </optgroup>
              <optgroup label="Paid Tier">
                <option value="claude-haiku-3-5-20241022">Claude Haiku 3.5 — Anthropic</option>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash — Google</option>
                <option value="gpt-4o-mini">GPT-4o Mini — OpenAI</option>
              </optgroup>
            </Select>
            <Input
              label={agent?.hasLlmKey ? 'LLM API Key (leave blank to keep current)' : 'LLM API Key'}
              type="password"
              showPasswordToggle
              placeholder={agent?.hasLlmKey ? '••••••••••••••••••••••' : 'sk-ant-... / AIzaSy... / sk-... / gsk_...'}
              value={llmApiKey}
              onChange={e => setLlmApiKey(e.target.value)}
            />
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600 space-y-1">
              <p>
                <span className="font-semibold text-slate-800">Model:</span> {llmModel} ({getProviderLabel(llmModel)})
              </p>
              <p>
                <span className="font-semibold text-slate-800">Key status:</span>{' '}
                {llmApiKey.trim()
                  ? 'The key above will be tested now and saved only if you click Save Settings.'
                  : agent?.hasLlmKey
                    ? 'No new key entered. Save Settings will keep the current key.'
                    : 'No key is stored yet. Smart Mode will keep using built-in rules until you save one.'}
              </p>
            </div>
            {agent?.hasLlmKey && (
              <p className="text-xs text-arc-green">API key is stored securely.</p>
            )}
            {/* Groq onboarding card */}
            {(llmModel === 'llama-3.3-70b-versatile' || llmModel === 'llama-3.1-8b-instant') && (
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-xs text-blue-900 space-y-3">
                {/* Capability answer */}
                <div>
                  <p className="font-bold text-sm text-blue-800 mb-1">Is Groq's free tier capable enough?</p>
                  <p>
                    <span className="font-semibold text-arc-green">Yes.</span>{' '}
                    Llama 3.3 70B is a large, capable model — it can analyze market signals, evaluate trade conditions, and make decisions within your agent's limits.
                    This is a <span className="font-semibold">testnet environment</span>, so the free tier is more than sufficient to get started.
                  </p>
                </div>
                {/* Tier comparison */}
                <div className="rounded-lg border border-blue-200 bg-white/60 p-2 space-y-1">
                  <p className="font-semibold text-blue-700">Free vs Paid models:</p>
                  <p>• <span className="font-medium">Groq free (Llama 3.3 70B)</span> — handles testnet tasks well, no cost, great for getting started</p>
                  <p>• <span className="font-medium">Paid models</span> (Claude, GPT-4o, Gemini) — higher reasoning quality, better for complex strategies or mainnet</p>
                  <p className="text-blue-600 italic">You can always switch to a paid model later as your strategy gets more sophisticated.</p>
                </div>
                {/* Steps */}
                <div>
                  <p className="font-semibold mb-1">Get your free Groq API key (takes ~1 minute):</p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>Go to <a href="https://console.groq.com" target="_blank" rel="noopener noreferrer" className="underline font-medium text-blue-700">console.groq.com</a> and create a free account</li>
                    <li>In the left sidebar, click <strong>API Keys</strong></li>
                    <li>Click <strong>Create API Key</strong> and copy it — it starts with <code className="bg-blue-100 px-1 rounded font-mono">gsk_</code></li>
                    <li>Paste it in the field above and save</li>
                  </ol>
                </div>
                <p className="text-blue-600 border-t border-blue-200 pt-2">
                  Your key runs only for your agent. Groq's rate limits apply to your own account — not to this platform.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center gap-4">
          {smartMode && (
            <Button variant="outline" onClick={handleTestLlm} loading={testingLlm}>
              <FlaskConical size={14} /> Test connection
            </Button>
          )}
          <Button onClick={handleSaveSettings} loading={savingSettings}>Save Settings</Button>
          {settingsMsg && (
            <span className={'text-sm font-medium ' + (settingsMsg.startsWith('Error') ? 'text-red-500' : 'text-arc-green')}>
              {settingsMsg}
            </span>
          )}
        </div>
        {llmTestMsg && (
          <p className={'mt-3 text-sm font-medium ' + (llmTestMsg.startsWith('Error:') ? 'text-red-500' : 'text-arc-green')}>
            {llmTestMsg}
          </p>
        )}
        {smartMode && (
          <p className="mt-2 text-xs text-slate-500">
            This checks whether the selected key and model can complete a live request right now. A successful test does not guarantee that automatic jobs will run later.
          </p>
        )}
      </Card>

      {/* Permissions */}
      <Card>
        <div className="mb-4">
          <h3 className="font-bold text-slate-900">Strategy Preferences</h3>
          <p className="mt-1 text-xs text-slate-500">
            These switches work with Tasks -&gt; Automation and help decide which automatic actions are allowed.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Today, <strong>DeFi Protocol Scanner</strong> affects Market Analysis, and <strong>Arbitrage</strong> affects oracle checks plus DeFi Loop.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Stable pool actions are the next likely automatic expansion. cirBTC actions stay manual for now.
          </p>
        </div>
        <div className="space-y-3">
          {AGENT_PERMISSIONS.map(({ key, label, desc }) => {
            const isArbitrage = key === 'arbitrage';

            return (
              <div key={key} className="rounded-xl border border-slate-100 p-3 transition hover:bg-arc-greenBg/30">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <label className="flex cursor-pointer items-start gap-3 sm:flex-1">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded accent-arc-green"
                      checked={!!perms[key]}
                      onChange={e => setPerms(p => ({ ...p, [key]: e.target.checked }))}
                    />
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{label}</p>
                      <p className="text-xs text-slate-500">{desc}</p>
                    </div>
                  </label>

                  {isArbitrage && (
                    <div className="sm:w-64">
                      <Input
                        label="Keep At Least (USDC)"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0"
                        value={settings.defiWalletReserveUsdc ?? ''}
                        onChange={e => setSettings(s => ({ ...s, defiWalletReserveUsdc: e.target.value }))}
                      />
                    </div>
                  )}
                </div>

                {isArbitrage && (
                  <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                    <p className="text-xs font-semibold text-slate-700">This is the live autonomous DeFi permission.</p>
                    <p className="mt-1 text-xs text-slate-500">
                      When <strong>Arbitrage</strong> is on, the DeFi loop uses the smaller of your live wallet balance minus this reserve and the global per-trade cap above.
                      Current global cap: <strong>{Number(settings.maxTradeUsdc || 0).toFixed(2)} USDC</strong>.
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Example: if the wallet has 86 USDC and you keep 50 USDC reserved here, the next autonomous trade can use at most 36 USDC. After that, later signals will be held once the remaining tradable balance drops below the requested amount.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex items-center gap-4">
          <Button onClick={handleSavePerms} loading={savingPerms}>Save Strategy Preferences</Button>
          {permMsg && (
            <span className={'text-sm font-medium ' + (permMsg.startsWith('Error') ? 'text-red-500' : 'text-arc-green')}>
              {permMsg}
            </span>
          )}
        </div>
      </Card>

      {/* Danger zone */}
      <Card className="border-red-200 bg-red-50">
        <div className="flex items-center gap-2 mb-2">
          <Trash2 size={16} className="text-red-500" />
          <h3 className="font-bold text-red-800">Danger Zone</h3>
        </div>
        <p className="mb-4 text-sm text-red-700">
          Deleting your agent is irreversible. Recover funds using the private key.
        </p>
        {!confirmDelete ? (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete Agent</Button>
        ) : (
          <div className="flex gap-3">
            <Button variant="danger" onClick={handleDelete} loading={loading}>Confirm Delete</Button>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={loading}>Cancel</Button>
          </div>
        )}
        {error && <Alert type="error" className="mt-3">{error}</Alert>}
      </Card>
    </div>
  );
}
