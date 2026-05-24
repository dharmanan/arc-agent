'use strict';

const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ethers } = require('ethers');
const db = require('../src/db');
const { signToken } = require('../src/middleware/auth');

const DEFAULT_BASE_URL = String(
  process.env.BACKEND_BASE_URL
    || process.env.JOBS_SMOKE_BASE_URL
    || 'https://backend-production-597c.up.railway.app',
).trim();
const MANUAL_DEFI_TIMEOUT_MS = 180000;
const MANUAL_DEFI_POLL_MS = 3000;

function resolveSmokeWalletAddress() {
  const privateKey = String(process.env.SMOKE_AGENT_PRIVATE_KEY || '').trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    return new ethers.Wallet(privateKey).address.toLowerCase();
  }

  const walletAddress = String(process.env.SMOKE_AGENT_WALLET || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return walletAddress.toLowerCase();
  }

  throw new Error('Missing smoke wallet address. Define SMOKE_AGENT_PRIVATE_KEY or SMOKE_AGENT_WALLET in root .env.');
}

async function resolveSmokeAgent() {
  const walletAddress = resolveSmokeWalletAddress();
  const { rows: [agent] } = await db.query(
    `SELECT a.id,
            a.user_id,
            a.wallet_address,
            a.status,
            a.is_active,
            a.daily_tasks_enabled,
            u.owner_address
       FROM agents a
       JOIN users u ON u.id = a.user_id
      WHERE LOWER(a.wallet_address) = $1
      ORDER BY a.updated_at DESC NULLS LAST, a.created_at DESC
      LIMIT 1`,
    [walletAddress],
  );

  if (!agent) {
    throw new Error(`Smoke agent not found for wallet ${walletAddress}`);
  }

  return agent;
}

function buildHeaders(token, extraHeaders = {}) {
  const headers = {
    Accept: 'application/json',
    ...extraHeaders,
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function requestJson({
  method = 'GET',
  routePath,
  token = '',
  body,
  headers = {},
  baseUrl = DEFAULT_BASE_URL,
}) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: {
      ...buildHeaders(token, headers),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');

  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: payload,
  };
}

function sanitizeReportDetail(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeReportDetail(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitized = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (key === 'token') {
      sanitized[key] = '[redacted]';
      continue;
    }
    sanitized[key] = sanitizeReportDetail(entryValue);
  }
  return sanitized;
}

async function runStep(report, key, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    report.steps.push({
      key,
      ok: true,
      durationMs: Date.now() - startedAt,
      detail: sanitizeReportDetail(detail),
    });
    return detail;
  } catch (error) {
    report.steps.push({
      key,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error.message || String(error),
    });
    throw error;
  }
}

async function readPermissionState(agentId, permissionKey) {
  const { rows: [row] } = await db.query(
    `SELECT is_enabled
       FROM agent_permissions
      WHERE agent_id = $1
        AND permission_key = $2`,
    [agentId, permissionKey],
  );
  return row ? Boolean(row.is_enabled) : null;
}

async function setPermissionState(agentId, permissionKey, enabled) {
  await db.query(
    `INSERT INTO agent_permissions (agent_id, permission_key, is_enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id, permission_key)
     DO UPDATE SET is_enabled = $3, updated_at = NOW()`,
    [agentId, permissionKey, Boolean(enabled)],
  );
}

async function waitForTaskRun(agentId, runId, token) {
  const deadline = Date.now() + MANUAL_DEFI_TIMEOUT_MS;
  let latestRun = null;

  while (Date.now() < deadline) {
    const response = await requestJson({
      routePath: `/api/tasks/agents/${agentId}/tasks/runs?status=recent&limit=10`,
      token,
    });

    if (!response.ok) {
      throw new Error(`Failed to poll task runs: ${response.status} ${JSON.stringify(response.body)}`);
    }

    latestRun = Array.isArray(response.body?.runs)
      ? response.body.runs.find((run) => run.id === runId) || null
      : null;

    if (latestRun && !['queued', 'running'].includes(String(latestRun.status || '').toLowerCase())) {
      return latestRun;
    }

    await new Promise((resolve) => setTimeout(resolve, MANUAL_DEFI_POLL_MS));
  }

  throw new Error(`Timed out waiting for task run ${runId}. Last state: ${JSON.stringify(latestRun)}`);
}

async function readLatestTransactions(agentId, limit = 3) {
  const { rows } = await db.query(
    `SELECT type,
            status,
            tx_hash,
            created_at::text AS created_at,
            meta
       FROM transactions
      WHERE agent_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [agentId, limit],
  );
  return rows;
}

async function main() {
  const report = {
    suite: 'checklist_live_smoke_v1',
    baseUrl: DEFAULT_BASE_URL,
    startedAt: new Date().toISOString(),
    steps: [],
  };

  const agent = await resolveSmokeAgent();
  const baselineToken = signToken(agent.user_id, String(agent.owner_address || '').toLowerCase());
  let activeToken = baselineToken;
  let originalPermissionState = null;

  report.agent = {
    id: agent.id,
    userId: agent.user_id,
    walletAddress: agent.wallet_address,
    ownerAddress: agent.owner_address,
    status: agent.status,
    isActive: agent.is_active,
  };

  try {
    const refreshed = await runStep(report, 'auth_refresh_before_logout', async () => {
      const response = await requestJson({
        method: 'POST',
        routePath: '/api/auth/refresh',
        token: baselineToken,
      });

      if (!response.ok || !response.body?.token) {
        throw new Error(`Refresh failed: ${response.status} ${JSON.stringify(response.body)}`);
      }

      return {
        status: response.status,
        tokenIssued: Boolean(response.body.token),
        token: response.body.token,
      };
    });

    activeToken = refreshed?.token || activeToken;

    await runStep(report, 'auth_logout', async () => {
      const response = await requestJson({
        method: 'POST',
        routePath: '/api/auth/logout',
        token: baselineToken,
      });

      if (!response.ok || response.body?.ok !== true) {
        throw new Error(`Logout failed: ${response.status} ${JSON.stringify(response.body)}`);
      }

      return { status: response.status, ok: true };
    });

    await runStep(report, 'auth_refresh_after_logout_blocked', async () => {
      const response = await requestJson({
        method: 'POST',
        routePath: '/api/auth/refresh',
        token: baselineToken,
      });

      if (response.status !== 401) {
        throw new Error(`Expected 401 after logout, got ${response.status}: ${JSON.stringify(response.body)}`);
      }

      return {
        status: response.status,
        error: response.body?.error || null,
      };
    });

    activeToken = signToken(agent.user_id, String(agent.owner_address || '').toLowerCase());

    await runStep(report, 'api_security_headers', async () => {
      const response = await requestJson({ routePath: '/api/tasks/catalog' });
      if (!response.ok) {
        throw new Error(`Catalog request failed: ${response.status}`);
      }

      const csp = response.headers['content-security-policy'] || '';
      if (!csp.includes("default-src 'none'")) {
        throw new Error(`Missing strict CSP header: ${csp}`);
      }

      return {
        status: response.status,
        csp,
        xContentTypeOptions: response.headers['x-content-type-options'] || null,
        xFrameOptions: response.headers['x-frame-options'] || null,
      };
    });

    await runStep(report, 'oracle_blocked_user_agent', async () => {
      const response = await requestJson({
        routePath: '/api/oracle/public/prediction-market-check?topic=crypto&limit=2',
        headers: { 'User-Agent': 'sqlmap/1.8.5#stable' },
      });

      if (response.status !== 403) {
        throw new Error(`Expected blocked UA 403, got ${response.status}: ${JSON.stringify(response.body)}`);
      }

      return {
        status: response.status,
        error: response.body?.error || null,
      };
    });

    await runStep(report, 'permission_guard_live', async () => {
      originalPermissionState = await readPermissionState(agent.id, 'defi_scan');
      await setPermissionState(agent.id, 'defi_scan', false);

      const response = await requestJson({
        method: 'POST',
        routePath: `/api/tasks/agents/${agent.id}/tasks/run`,
        token: activeToken,
        body: { taskId: 'DAILY_ARB_SCAN', params: {} },
      });

      if (response.status !== 403 || response.body?.error !== 'permission_blocked') {
        throw new Error(`Expected permission_blocked 403, got ${response.status}: ${JSON.stringify(response.body)}`);
      }

      return {
        status: response.status,
        permission: response.body?.permission || null,
        detail: response.body?.detail || null,
      };
    });

    await runStep(report, 'manual_defi_quote', async () => {
      const response = await requestJson({
        method: 'POST',
        routePath: `/api/tasks/agents/${agent.id}/defi/manual/quote`,
        token: activeToken,
        body: {
          lane: 'liquidity',
          poolKey: 'USDC-EURC',
          action: 'swap',
          params: {
            fromToken: 'USDC',
            toToken: 'EURC',
            amountIn: 1,
          },
        },
      });

      if (!response.ok || response.body?.quoteError) {
        throw new Error(`Manual quote failed: ${response.status} ${JSON.stringify(response.body)}`);
      }

      return {
        status: response.status,
        amountIn: response.body?.amountIn || null,
        amountOut: response.body?.amountOut || null,
        poolAddress: response.body?.poolAddress || null,
      };
    });

    const manualExecution = await runStep(report, 'manual_defi_execute', async () => {
      const response = await requestJson({
        method: 'POST',
        routePath: `/api/tasks/agents/${agent.id}/defi/manual/execute`,
        token: activeToken,
        body: {
          lane: 'liquidity',
          poolKey: 'USDC-EURC',
          action: 'swap',
          params: {
            fromToken: 'USDC',
            toToken: 'EURC',
            amountIn: 1,
          },
        },
      });

      if (response.status !== 202 || !response.body?.run?.id) {
        throw new Error(`Manual execute failed: ${response.status} ${JSON.stringify(response.body)}`);
      }

      return {
        status: response.status,
        run: response.body.run,
        feeUsdc: response.body?.feeUsdc || null,
      };
    });

    await runStep(report, 'manual_defi_poll_complete', async () => {
      const finalRun = await waitForTaskRun(agent.id, manualExecution.run.id, activeToken);
      const latestTransactions = await readLatestTransactions(agent.id, 3);

      if (String(finalRun.status || '').toLowerCase() !== 'completed') {
        throw new Error(`Manual DeFi run ended as ${finalRun.status}: ${finalRun.error || finalRun.stage_detail || 'unknown_error'}`);
      }

      return {
        runId: finalRun.id,
        status: finalRun.status,
        stageLabel: finalRun.stage_label,
        stageDetail: finalRun.stage_detail,
        latestTransactions,
      };
    });

    report.ok = true;
  } finally {
    if (originalPermissionState != null) {
      await setPermissionState(agent.id, 'defi_scan', originalPermissionState);
    }
  }

  report.completedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});