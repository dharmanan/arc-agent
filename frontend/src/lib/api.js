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
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
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
  startRegister:  (ownerAddress)          => post('/auth/passkey/register/start',  { ownerAddress }),
  finishRegister: (ownerAddress, cred, d) => post('/auth/passkey/register/finish', { ownerAddress, credential: cred, deviceName: d }),
  startLogin:     (ownerAddress)          => post('/auth/passkey/login/start',     { ownerAddress }),
  finishLogin:    (ownerAddress, cred)    => post('/auth/passkey/login/finish',     { ownerAddress, credential: cred }),
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
  positions:         (id)        => get(`/agents/${id}/positions`),
  reputation:        (id, limit) => get(`/agents/${id}/reputation${limit ? `?limit=${limit}` : ''}`),
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
  poolBalance: ()                        => get(`/tasks/pool-balance?ts=${Date.now()}`),
  runTask:     (agentId, taskId, params) => post(`/tasks/agents/${agentId}/tasks/run`, { taskId, params }),
  runs:        (agentId, status = 'recent', limit) => get(`/tasks/agents/${agentId}/tasks/runs?status=${encodeURIComponent(status)}${limit ? `&limit=${limit}` : ''}`),
  results:     (agentId, limit)          => get(`/tasks/agents/${agentId}/tasks/results${limit ? `?limit=${limit}` : ''}`),
};

// ── Oracle ───────────────────────────────────────────────────────────────────
export const oracle = {
  status: () => get('/oracle/status'),
  gatewayBalance: (agentId, chainName) => {
    const params = new URLSearchParams({ agentId });
    if (chainName) params.set('chainName', chainName);
    return get(`/oracle/debug/gateway-balance?${params.toString()}`);
  },
  fundGateway: (agentId, body = {}) => post('/oracle/gateway/fund', { agentId, ...body }),
  testAlert: (body = {}) => post('/oracle/debug/test-alert', body),
};

// ── Jobs (ERC-8183 AgenticCommerce) ───────────────────────────────────────────
export const jobs = {
  list:     (agentId, status)      => get(`/agents/${agentId}/jobs${status ? `?status=${status}` : ''}`),
  get:      (agentId, jobId)       => get(`/agents/${agentId}/jobs/${jobId}`),
  create:   (agentId, data)        => post(`/agents/${agentId}/jobs`, data),
  deliver:  (agentId, jobId, hash) => put(`/agents/${agentId}/jobs/${jobId}/deliver`, { deliverableHash: hash }),
  complete: (agentId, jobId)       => put(`/agents/${agentId}/jobs/${jobId}/complete`, {}),
  cancel:   (agentId, jobId)       => put(`/agents/${agentId}/jobs/${jobId}/cancel`, {}),
};

