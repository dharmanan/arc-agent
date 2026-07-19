/**
 * Arc Machina — Frontend API Client
 */

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

function readStoredToken() {
  const sessionToken = sessionStorage.getItem('arc_jwt');
  if (sessionToken) return sessionToken;

  const legacyPersistentToken = localStorage.getItem('arc_jwt');
  if (!legacyPersistentToken) return null;

  sessionStorage.setItem('arc_jwt', legacyPersistentToken);
  localStorage.removeItem('arc_jwt');
  return legacyPersistentToken;
}

let _token = readStoredToken();

export function setToken(t) {
  _token = t;
  if (t) {
    sessionStorage.setItem('arc_jwt', t);
  } else {
    localStorage.removeItem('arc_jwt');
    sessionStorage.removeItem('arc_jwt');
  }
}

export function getToken()  { return _token; }
export function isLoggedIn() { return !!_token; }

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    cache: method === 'GET' ? 'no-store' : 'default',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.errorCode || data.code || null;
    err.retryAfterMs = data.retryAfterMs ?? null;
    err.retryAt = data.retryAt ?? null;
    err.responseStatus = data.status || null;
    err.data = data;
    throw err;
  }
  return data;
}

const get  = (path)       => request('GET',    path);
const post = (path, body) => request('POST',   path, body);
const put  = (path, body) => request('PUT',    path, body);
const del  = (path)       => request('DELETE', path);

// ── Auth ──────────────────────────────────────────────────────────────────────
export const auth = {
  registerChallenge: (ownerAddress)       => post('/auth/passkey/register/challenge', { ownerAddress }),
  startRegister:  (ownerAddress, challengeId, signature) => post('/auth/passkey/register/start',  { ownerAddress, challengeId, signature }),
  finishRegister: (ownerAddress, cred, d) => post('/auth/passkey/register/finish', { ownerAddress, credential: cred, deviceName: d }),
  startLogin:     (ownerAddress)          => post('/auth/passkey/login/start',     { ownerAddress }),
  finishLogin:    (ownerAddress, cred)    => post('/auth/passkey/login/finish',     { ownerAddress, credential: cred }),
  logout:         ()                      => post('/auth/logout', {}),
  refresh:        ()                      => post('/auth/refresh'),
};

// ── Agents ────────────────────────────────────────────────────────────────────
export const agents = {
  list:              ()          => get('/agents'),
  create:            (data)      => post('/agents', data),
  get:               (id)        => get(`/agents/${id}`),
  update:            (id, data)  => put(`/agents/${id}`, data),
  testLlm:           (id, data)  => post(`/agents/${id}/test-llm`, data),
  updatePermissions: (id, perms) => put(`/agents/${id}/permissions`, perms),
  status:            (id)        => get(`/agents/${id}/status`),
  lending:           (id)        => get(`/agents/${id}/lending`),
  positions:         (id)        => get(`/agents/${id}/positions`),
  rewards:           (id, options = {}) => {
    const params = new URLSearchParams();
    if (options.programLimit) params.set('programLimit', String(options.programLimit));
    if (options.accrualLimit) params.set('accrualLimit', String(options.accrualLimit));
    if (options.claimLimit) params.set('claimLimit', String(options.claimLimit));
    if (options.snapshotLimit) params.set('snapshotLimit', String(options.snapshotLimit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return get(`/agents/${id}/rewards${suffix}`);
  },
  reputation:        (id, limit) => get(`/agents/${id}/reputation${limit ? `?limit=${limit}` : ''}`),
  reputationProof:   (id)        => get(`/agents/${id}/reputation/proof`),
  delete:            (id)        => del(`/agents/${id}`),
  retryIdentity:     (id)        => post(`/agents/${id}/register-identity`),
};

// ── Transactions ──────────────────────────────────────────────────────────────
export const transactions = {
  list:            (agentId) => get(`/transactions/${agentId}`),
  send:            (body)    => post('/transactions/send',      body),
  nanoPay:         (body)    => post('/transactions/nano-pay',  body),
  bridge:          (body)    => post('/transactions/bridge',    body),
  bridgeGasTopUp:  (body)    => post('/transactions/bridge/gas-topup', body),
  bridgeStep:      (body)    => post('/transactions/bridge/step', body),
  bridgeAttestation: (txId) => get(`/transactions/bridge/${txId}/attestation`),
  swap:            (body)    => post('/transactions/swap',      body),
  swapQuote:       (body)    => post('/transactions/swap/quote', body),
  getStatus:       (txId)    => get(`/transactions/tx/${txId}/status`),

  async poll(txId, onUpdate, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tx = await this.getStatus(txId);
      if (onUpdate) onUpdate(tx);
      if (tx.status === 'confirmed' || tx.status === 'failed') return tx;
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Transaction confirmation timeout');
  },
};

// ── Bridge Activities (paralel köprü takibi) ──────────────────────────────────
export const bridge = {
  getActivities: (agentId, limit = 30) =>
    get(`/bridge/activities?agentId=${agentId}&limit=${limit}`),
  dismiss:       (activityId, agentId) =>
    post(`/bridge/activities/${activityId}/dismiss`, { agentId }),
  claim:         (activityId, agentId) =>
    post(`/bridge/claim/${activityId}`, { agentId }),
};

// ── Tasks ─────────────────────────────────────────────────────────────────────
export const tasks = {
  featured:    ()                        => get('/tasks/featured'),
  catalog:     ()                        => get('/tasks/catalog'),
  circlePaidCatalog: ()                  => get('/tasks/circle-paid/catalog'),
  circlePaidPreview: (agentId, itemId, params) => post(`/tasks/agents/${agentId}/circle-paid/preview`, { itemId, params }),
  circlePaidRun: (agentId, itemId, params) => post(`/tasks/agents/${agentId}/circle-paid/run`, { itemId, params }),
  circlePaidUnlock: (agentId, previewId) => post(`/tasks/agents/${agentId}/circle-paid/unlock`, { previewId }),
  circlePaidSnapshots: (agentId, options = {}) => {
    const params = new URLSearchParams();
    if (options.itemId) params.set('itemId', options.itemId);
    if (options.status) params.set('status', options.status);
    if (options.limit) params.set('limit', String(options.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return get(`/tasks/agents/${agentId}/circle-paid/snapshots${suffix}`);
  },
  circlePaidSnapshot: (agentId, snapshotId) => get(`/tasks/agents/${agentId}/circle-paid/snapshots/${snapshotId}`),
  poolBalance: ()                        => get(`/tasks/pool-balance?ts=${Date.now()}`),
  runTask:     (agentId, taskId, params) => post(`/tasks/agents/${agentId}/tasks/run`, { taskId, params }),
  runs:        (agentId, status = 'recent', limit) => get(`/tasks/agents/${agentId}/tasks/runs?status=${encodeURIComponent(status)}${limit ? `&limit=${limit}` : ''}`),
  results:     (agentId, limit)          => get(`/tasks/agents/${agentId}/tasks/results${limit ? `?limit=${limit}` : ''}`),
};

// ── Oracle ───────────────────────────────────────────────────────────────────
export const oracle = {
  status: () => get('/oracle/status'),
  poolState: (pool, venue) => {
    const params = new URLSearchParams();
    if (pool) params.set('pool', pool);
    if (venue) params.set('venue', venue);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return get(`/oracle/pool-state${suffix}`);
  },
  reserveState: (assets) => {
    const params = new URLSearchParams();
    const normalizedAssets = Array.isArray(assets)
      ? assets.filter(Boolean).join(',')
      : String(assets || '').trim();
    if (normalizedAssets) params.set('assets', normalizedAssets);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return get(`/oracle/reserve-state${suffix}`);
  },
  gatewayBalance: (agentId, chainName) => {
    const params = new URLSearchParams({ agentId });
    if (chainName) params.set('chainName', chainName);
    return get(`/oracle/debug/gateway-balance?${params.toString()}`);
  },
  fundGateway: (agentId, body = {}) => post('/oracle/gateway/fund', { agentId, ...body }),
  testAlert: (body = {}) => post('/oracle/debug/test-alert', body),
};

// ── Manual DeFi ─────────────────────────────────────────────────────────────
export const defi = {
  manualQuote: (agentId, body) => post(`/tasks/agents/${agentId}/defi/manual/quote`, body),
  manualExecute: (agentId, body) => post(`/tasks/agents/${agentId}/defi/manual/execute`, body),
};

// ── Jobs (ERC-8183 AgenticCommerce) ───────────────────────────────────────────
export const jobs = {
  board:    (options = {})         => {
    const params = new URLSearchParams();
    if (options.includeFinalized) params.set('includeFinalized', 'true');
    if (options.limit) params.set('limit', String(options.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return get(`/jobs/public/board${suffix}`);
  },
  publicGet: (jobId)               => get(`/jobs/public/${jobId}`),
  publicApply: (jobId, body)       => post(`/jobs/public/${jobId}/apply`, body),
  publicDispute: (jobId, body)     => post(`/jobs/public/${jobId}/dispute`, body),
  publicDeliver: (jobId, body)     => post(`/jobs/public/${jobId}/deliver`, body),
  list:      (agentId, status)     => get(`/agents/${agentId}/jobs${status ? `?status=${status}` : ''}`),
  get:       (agentId, jobId)      => get(`/agents/${agentId}/jobs/${jobId}`),
  create:    (agentId, data)       => post(`/agents/${agentId}/jobs`, data),
  assignProvider: (agentId, jobId, providerAddress) => put(`/agents/${agentId}/jobs/${jobId}/assign-provider`, { providerAddress }),
  deliver:   (agentId, jobId, hash) => put(`/agents/${agentId}/jobs/${jobId}/deliver`, { deliverableHash: hash }),
  complete:  (agentId, jobId)      => put(`/agents/${agentId}/jobs/${jobId}/complete`, {}),
  reject:    (agentId, jobId)      => put(`/agents/${agentId}/jobs/${jobId}/reject`, {}),
  cancel:    (agentId, jobId)      => put(`/agents/${agentId}/jobs/${jobId}/cancel`, {}),
};

