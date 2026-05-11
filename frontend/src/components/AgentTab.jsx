import React, { useState, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useAgent } from '../providers/AgentProvider.jsx';
import { agents as agentApi } from '../lib/api.js';
import { AGENT_PERMISSIONS } from '../lib/chains.js';
import { registerPasskey, authenticatePasskey, isPasskeySupported } from '../lib/passkey.js';
import {
  Card, Button, Input, Badge, Alert, AddressBox, Spinner, SectionHeader, Select
} from './ui/index.jsx';
import { Bot, Plus, Trash2, Key, AlertTriangle, LogOut, Brain, Shield, Zap } from 'lucide-react';

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

  // Settings state
  const [settings, setSettings]   = useState({});
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmModel, setLlmModel]   = useState('claude-sonnet-4-20250514');
  const [smartMode, setSmartMode] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg]       = useState('');

  const pendingAgent = useRef(null);

  useEffect(() => {
    if (agent?.permissions) setPerms(agent.permissions);
    if (agent?.settings) {
      setSettings(agent.settings);
    }
    if (agent?.isSmartMode !== undefined) setSmartMode(agent.isSmartMode);
    if (agent?.llmModel) setLlmModel(agent.llmModel);
  }, [agent]);

  if (!ownerAddress) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Bot size={32} className="mb-4 text-slate-300" />
        <h2 className="text-lg font-bold text-slate-900">Wallet Not Connected</h2>
        <p className="mt-1 text-sm text-slate-500">Connect your wallet to manage your agent.</p>
      </div>
    );
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
              <Alert type="warning">Your browser may not support Passkeys.</Alert>
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
              <option value="claude-sonnet-4-20250514">Claude Sonnet 4 (Recommended)</option>
              <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
              <option value="gpt-4o">GPT-4o</option>
            </Select>
            <Input
              label={agent?.hasLlmKey ? 'LLM API Key (leave blank to keep current)' : 'LLM API Key'}
              type="password"
              placeholder={agent?.hasLlmKey ? '••••••••••••••••••••••' : 'sk-ant-... / AIzaSy... / sk-...'}
              value={llmApiKey}
              onChange={e => setLlmApiKey(e.target.value)}
            />
            {agent?.hasLlmKey && (
              <p className="text-xs text-arc-green">✓ API key is stored (encrypted at rest with AES-256-GCM)</p>
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
