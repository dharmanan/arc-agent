import React, { useState, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useAgent } from '../providers/AgentProvider.jsx';
import { agents as agentApi, tasks as tasksApi } from '../lib/api.js';
import { AGENT_PERMISSIONS } from '../lib/chains.js';
import { registerPasskey, authenticatePasskey, isPasskeySupported } from '../lib/passkey.js';
import {
  Card, Button, Input, Badge, Alert, AddressBox, Spinner, SectionHeader, Select
} from './ui/index.jsx';
import { Bot, Plus, Trash2, Key, AlertTriangle, LogOut, Brain, Shield, Zap, CheckCircle, XCircle, RefreshCw, PlayCircle, Clock } from 'lucide-react';

export default function AgentTab() {
  const { address: ownerAddress } = useAccount();
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
  const [features, setFeatures]   = useState({
    dailyTasksEnabled:     false,
    marketAnalysisEnabled: false,
    oracleEnabled:         false,
    defiLoopEnabled:       false,
    reputationEnabled:     false,
  });
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg]       = useState('');

  // Today's featured tasks (rotates daily at 00:00 UTC)
  const [featuredTasks, setFeaturedTasks]   = useState([]);
  const [taskRunning, setTaskRunning]       = useState(null);  // taskId currently running
  const [taskMsg, setTaskMsg]               = useState('');
  const [ranToday, setRanToday]             = useState(new Set()); // taskIds run today

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

  // Load today's featured tasks once on mount
  useEffect(() => {
    tasksApi.featured().then(data => setFeaturedTasks(data.tasks || [])).catch(() => {});
  }, []);

  // Track which tasks the agent already ran today
  useEffect(() => {
    if (!agent?.id) return;
    tasksApi.results(agent.id, 50).then(data => {
      const todayUtc = new Date().toISOString().slice(0, 10);
      const done = new Set(
        (data.results || [])
          .filter(r => r.created_at.startsWith(todayUtc))
          .map(r => r.task_id),
      );
      setRanToday(done);
    }).catch(() => {});
  }, [agent?.id]);

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
      const authResult = await registerPasskey(ownerAddress, deviceName);
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

  async function handleLogin() {
    setError('');
    setLoading(true);
    try {
      const authResult = await authenticatePasskey(ownerAddress);
      setJwt(authResult.token);
      const list = await agentApi.list();
      if (list.length > 0) setAgent(list[0]);
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

  async function handleSavePerms() {
    if (!agent?.id) return;
    setSavingPerms(true);
    setPermMsg('');
    try {
      await agentApi.updatePermissions(agent.id, perms);
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
          <Button
            variant="outline"
            onClick={disconnectSession}
            className="ml-auto flex items-center gap-2 text-slate-500 hover:text-red-600 hover:border-red-300"
          >
            <LogOut size={14} />
            Disconnect Session
          </Button>
        </div>
        <AddressBox address={agent?.walletAddress} label="Agent Wallet Address" />
        <p className="mt-2 text-xs text-slate-400">
          Send ARC or ETH to this address to fund your agent operations.
        </p>

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
            label="Auto-approve below (USDC) — no passkey needed"
            type="number"
            min="1"
            placeholder="50"
            value={settings.maxTradeUsdc ?? ''}
            onChange={e => setSettings(s => ({ ...s, maxTradeUsdc: e.target.value }))}
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
        <p className="mt-3 text-xs text-slate-400 flex items-center gap-1">
          <Zap size={11} /> Transactions below the auto-approve limit are signed automatically by the agent without prompting.
        </p>
      </Card>

      {/* Today's Featured Tasks */}
      {featuredTasks.length > 0 && (
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <PlayCircle size={16} className="text-arc-green" />
          <h3 className="font-bold text-slate-900">Today's Featured Tasks</h3>
          <span className="ml-auto flex items-center gap-1 text-xs text-slate-400">
            <Clock size={12} /> Rotates at midnight UTC
          </span>
        </div>
        {!features.dailyTasksEnabled && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Enable <strong>Daily Tasks</strong> in Autonomous Features below to run these.
          </div>
        )}
        <div className="space-y-2">
          {featuredTasks.map(task => {
            const alreadyRan = ranToday.has(task.id);
            const isRunning  = taskRunning === task.id;
            const disabled   = !features.dailyTasksEnabled || alreadyRan || isRunning || !agent?.id;
            return (
              <div key={task.id} className="flex items-center justify-between rounded-xl border border-slate-100 p-3">
                <div className="min-w-0 mr-3">
                  <p className="text-sm font-semibold text-slate-800 truncate">{task.title}</p>
                  <p className="text-xs text-slate-500 truncate">{task.description}</p>
                </div>
                <button
                  disabled={disabled}
                  onClick={async () => {
                    setTaskRunning(task.id);
                    setTaskMsg('');
                    try {
                      await tasksApi.runTask(agent.id, task.id);
                      setRanToday(s => new Set([...s, task.id]));
                      setTaskMsg(`"${task.title}" queued successfully.`);
                    } catch (e) {
                      setTaskMsg(e.message || 'Failed to queue task.');
                    } finally {
                      setTaskRunning(null);
                    }
                  }}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition
                    ${alreadyRan
                      ? 'bg-slate-100 text-slate-400 cursor-default'
                      : disabled
                        ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                        : 'bg-arc-green text-white hover:opacity-90'
                    }`}
                >
                  {isRunning ? <Spinner size={12} /> : alreadyRan ? 'Done' : 'Run'}
                </button>
              </div>
            );
          })}
        </div>
        {taskMsg && (
          <p className={`mt-2 text-xs ${taskMsg.includes('Failed') ? 'text-red-500' : 'text-arc-green'}`}>
            {taskMsg}
          </p>
        )}
      </Card>
      )}

      {/* Autonomous Features */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <Zap size={16} className="text-arc-green" />
          <h3 className="font-bold text-slate-900">Autonomous Features</h3>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          All features are <strong>off by default</strong>. Enable only what you want your agent to do autonomously.
          Daily limits apply per feature — see the plan docs for Tier 1 / Tier 2 caps.
        </p>
        <div className="space-y-3">
          {[
            { key: 'dailyTasksEnabled',     label: 'Daily Tasks (Tier 1)',      desc: 'Agent runs up to 5 free tasks per day (oracle checks, analysis pings).' },
            { key: 'marketAnalysisEnabled', label: 'Market Analysis',           desc: 'Periodic price & opportunity scans via oracle feeds.' },
            { key: 'oracleEnabled',         label: 'Oracle Data Feed',          desc: 'Pull live forex, DeFi TVL, and on-chain price data.' },
            { key: 'defiLoopEnabled',       label: 'DeFi Loop Execution',       desc: 'Automated borrow-supply loops within daily limits.' },
            { key: 'reputationEnabled',     label: 'Reputation Tracking',       desc: 'Track on-chain agent score and broadcast actions.' },
          ].map(({ key, label, desc }) => (
            <div key={key} className="flex items-center justify-between rounded-xl border border-slate-100 p-3 hover:bg-arc-greenBg/20 transition">
              <div>
                <p className="text-sm font-semibold text-slate-800">{label}</p>
                <p className="text-xs text-slate-500">{desc}</p>
              </div>
              <label className="flex cursor-pointer items-center gap-2 ml-4 shrink-0">
                <span className="text-sm text-slate-500">{features[key] ? 'On' : 'Off'}</span>
                <div
                  onClick={() => setFeatures(f => ({ ...f, [key]: !f[key] }))}
                  className={`relative h-6 w-11 rounded-full transition-colors ${features[key] ? 'bg-arc-green' : 'bg-slate-200'}`}
                >
                  <div className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${features[key] ? 'translate-x-5' : ''}`} />
                </div>
              </label>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Changes take effect after clicking <strong>Save Settings</strong> below.
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
            <p className="font-medium text-slate-800 mb-1">Basic Mode (default)</p>
            <p>Agent runs with built-in rules: respects daily limit, auto-approves trades under the threshold, executes bridge/swap when you trigger them manually.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-arc-green/20 bg-arc-greenBg p-3 text-xs text-slate-600">
              Smart Mode uses an LLM to autonomously scan opportunities, decide trade timing, and execute within your set limits — no manual trigger needed.
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
              placeholder={agent?.hasLlmKey ? '••••••••••••••••••••••' : 'sk-ant-... / AIzaSy... / sk-... / gsk_...'}
              value={llmApiKey}
              onChange={e => setLlmApiKey(e.target.value)}
            />
            {agent?.hasLlmKey && (
              <p className="text-xs text-arc-green">✓ API key is stored (encrypted at rest with AES-256-GCM)</p>
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
          <Button onClick={handleSaveSettings} loading={savingSettings}>Save Settings</Button>
          {settingsMsg && (
            <span className={'text-sm font-medium ' + (settingsMsg.startsWith('Error') ? 'text-red-500' : 'text-arc-green')}>
              {settingsMsg}
            </span>
          )}
        </div>
      </Card>

      {/* Permissions */}
      <Card>
        <h3 className="mb-4 font-bold text-slate-900">Agent Permissions</h3>
        <div className="space-y-3">
          {AGENT_PERMISSIONS.map(({ key, label, desc }) => (
            <label key={key} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-100 p-3 hover:bg-arc-greenBg/30 transition">
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
          ))}
        </div>
        <div className="mt-4 flex items-center gap-4">
          <Button onClick={handleSavePerms} loading={savingPerms}>Save Permissions</Button>
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
