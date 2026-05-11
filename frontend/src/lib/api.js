/**
 * Arc Machina — Frontend API Client
 */

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

let _token = sessionStorage.getItem('arc_jwt') || null;

export function setToken(t) {
  _token = t;
  if (t) sessionStorage.setItem('arc_jwt', t);
  else   sessionStorage.removeItem('arc_jwt');
}

export function getToken()  { return _token; }
export function isLoggedIn() { return !!_token; }

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
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
  updatePermissions: (id, perms) => put(`/agents/${id}/permissions`, perms),
  status:            (id)        => get(`/agents/${id}/status`),
  delete:            (id)        => del(`/agents/${id}`),
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

