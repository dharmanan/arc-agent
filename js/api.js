/**
 * Arc Machina — Frontend API Client
 * Communicates with the Express backend (BASE_URL below).
 * All requests include the stored JWT in Authorization header.
 */
'use strict';

const BASE_URL = window.ARC_API_URL || 'http://localhost:3001/api';

let _token = sessionStorage.getItem('arc_jwt') || null;

export function setToken(t) {
  _token = t;
  if (t) sessionStorage.setItem('arc_jwt', t);
  else    sessionStorage.removeItem('arc_jwt');
}

export function getToken() { return _token; }
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

const get    = (path)        => request('GET',    path);
const post   = (path, body)  => request('POST',   path, body);
const put    = (path, body)  => request('PUT',    path, body);
const del    = (path)        => request('DELETE', path);

// ── Auth ───────────────────────────────────────────────────────────────────────
export const auth = {
  startRegister:  (ownerAddress)          => post('/auth/passkey/register/start',  { ownerAddress }),
  finishRegister: (ownerAddress, cred, d) => post('/auth/passkey/register/finish', { ownerAddress, credential: cred, deviceName: d }),
  startLogin:     (ownerAddress)          => post('/auth/passkey/login/start',     { ownerAddress }),
  finishLogin:    (ownerAddress, cred)    => post('/auth/passkey/login/finish',     { ownerAddress, credential: cred }),
  refresh:        ()                      => post('/auth/refresh'),
};

// ── Agents ─────────────────────────────────────────────────────────────────────
export const agents = {
  list:              ()               => get('/agents'),
  create:            (data)           => post('/agents', data),
  get:               (id)             => get(`/agents/${id}`),
  update:            (id, data)       => put(`/agents/${id}`, data),
  updatePermissions: (id, perms)      => put(`/agents/${id}/permissions`, perms),
  status:            (id)             => get(`/agents/${id}/status`),
  delete:            (id)             => del(`/agents/${id}`),
};

// ── Transactions ───────────────────────────────────────────────────────────────
export const transactions = {
  list:        (agentId)      => get(`/transactions/${agentId}`),
  send:        (body)         => post('/transactions/send',   body),
  bridge:      (body)         => post('/transactions/bridge', body),
  swap:        (body)         => post('/transactions/swap',   body),
  getStatus:   (txId)         => get(`/transactions/tx/${txId}/status`),

  /** Poll until status is confirmed|failed (max 60s) */
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
