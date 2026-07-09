'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { ethers } = require('ethers');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { createArcOracleBuyer } = require('../examples/arcOracleBuyerHelper');

const DEFAULT_ORACLE_BASE_URL = 'https://arcmachina.xyz';
const CORE_TASK_RULES = {
  EXEC_CCTP_BRIDGE: { mode: 'ready' },
  EXEC_CURVE_SWAP: { mode: 'ready' },
  EXEC_CURVE_LIQUIDITY_ADD: { mode: 'ready' },
  EXEC_CURVE_LIQUIDITY_REMOVE: {
    mode: 'ready_or_guarded',
    allowedReasons: new Set(['insufficient_lp_position', 'lp_position_not_found']),
  },
  EXEC_ARB: { mode: 'ready' },
  EXEC_REBALANCE: {
    mode: 'ready_or_guarded',
    allowedReasons: new Set(['lp_position_exit_required']),
  },
};

function getSmokePrivateKey() {
  const candidates = [
    process.env.SMOKE_AGENT_PRIVATE_KEY,
    process.env.ORACLE_BUYER_PRIVATE_KEY,
  ];

  const privateKey = candidates.find((value) => /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim())) || '';
  if (!privateKey) {
    throw new Error('Missing smoke private key. Define ORACLE_BUYER_PRIVATE_KEY or SMOKE_AGENT_PRIVATE_KEY in root .env.');
  }

  return privateKey;
}

function getSmokeWalletAddress(privateKey) {
  return new ethers.Wallet(privateKey).address;
}

function buildOracleUrl(endpoint, searchParams = {}) {
  const baseUrl = String(process.env.ORACLE_PUBLIC_BASE_URL || DEFAULT_ORACLE_BASE_URL).trim();
  const url = new URL(`/api/oracle/public/${endpoint}`, baseUrl);

  Object.entries(searchParams).forEach(([key, value]) => {
    if (value == null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Request failed for ${url} with status ${response.status}`);
  }
  return body;
}

function runNodeJson(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${stderr || stdout}`));
        return;
      }

      try {
        const newlineJsonStart = stdout.lastIndexOf('\n{');
        const jsonStart = newlineJsonStart >= 0 ? newlineJsonStart + 1 : stdout.indexOf('{');
        const jsonEnd = stdout.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
          throw new Error('No JSON object found in stdout');
        }

        resolve(JSON.parse(stdout.slice(jsonStart, jsonEnd + 1).trim()));
      } catch (error) {
        reject(new Error(`Unable to parse JSON output from ${scriptPath}: ${error.message}`));
      }
    });
  });
}

function summarizeCoreTaskChecks(report) {
  const checksByTask = new Map((report.checks || []).map((check) => [check.taskId, check]));

  return Object.entries(CORE_TASK_RULES).map(([taskId, rule]) => {
    const check = checksByTask.get(taskId);
    if (!check) {
      return {
        taskId,
        ok: false,
        status: 'missing',
        reason: 'missing_check',
      };
    }

    if (check.preflight?.ok) {
      return {
        taskId,
        ok: true,
        status: 'ready',
        reason: null,
      };
    }

    const reason = check.preflight?.reason || check.reason || check.error || null;
    if (rule.mode === 'ready_or_guarded' && reason && rule.allowedReasons.has(reason)) {
      return {
        taskId,
        ok: true,
        status: 'guarded',
        reason,
      };
    }

    return {
      taskId,
      ok: false,
      status: 'failed',
      reason: reason || 'unknown_failure',
    };
  });
}

async function waitForRevenueUpdate(before, expectedAmountUsdc) {
  const deadline = Date.now() + 15000;
  const epsilon = 0.000001;
  const minimumCount = Number(before.requestCount || 0) + 1;
  const minimumTotal = Number(before.totalUsdc || 0) + Number(expectedAmountUsdc || 0);
  let latest = before;

  while (Date.now() < deadline) {
    latest = await fetchJson(buildOracleUrl('revenue'));
    const countOk = Number(latest.requestCount || 0) >= minimumCount;
    const totalOk = Number(latest.totalUsdc || 0) + epsilon >= minimumTotal;
    if (countOk && totalOk) {
      return latest;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Oracle revenue counters did not update in time. before=${JSON.stringify(before)} latest=${JSON.stringify(latest)}`);
}

async function main() {
  const privateKey = getSmokePrivateKey();
  const walletAddress = getSmokeWalletAddress(privateKey);

  const paidTaskReport = await runNodeJson(path.resolve(__dirname, 'paidTaskSmoke.js'), ['--wallet', walletAddress]);
  const coreTasks = summarizeCoreTaskChecks(paidTaskReport);
  const coreFailures = coreTasks.filter((task) => !task.ok);
  if (coreFailures.length) {
    throw new Error(`Paid task smoke failed: ${JSON.stringify(coreFailures)}`);
  }

  const buyer = createArcOracleBuyer({
    privateKey,
    chain: process.env.ORACLE_BUYER_CHAIN || 'arcTestnet',
    rpcUrl: process.env.ORACLE_BUYER_RPC_URL || process.env.ARC_TESTNET_RPC || undefined,
    fundingBufferUsdc: process.env.ORACLE_BUYER_FUNDING_BUFFER_USDC || '0',
  });

  const revenueBefore = await fetchJson(buildOracleUrl('revenue'));
  const oracleResult = await buyer.pay(buildOracleUrl('prediction-market-check', {
    topic: process.env.ORACLE_PUBLIC_TOPIC || 'crypto',
    limit: process.env.ORACLE_PUBLIC_LIMIT || '4',
  }));

  if (!oracleResult.paid) {
    throw new Error(`Oracle smoke did not execute a paid request: ${JSON.stringify(oracleResult.preview || oracleResult)}`);
  }

  const revenueAfter = await waitForRevenueUpdate(revenueBefore, oracleResult.amountUsdc);

  console.log(JSON.stringify({
    smokeWalletAddress: walletAddress,
    paidTasks: {
      revenuePool: paidTaskReport.revenuePool,
      readinessOverall: paidTaskReport.readiness?.overall || null,
      coreTasks,
    },
    oracle: {
      endpoint: 'prediction-market-check',
      amountUsdc: oracleResult.amountUsdc,
      deposited: oracleResult.deposited,
      paymentResponse: oracleResult.paymentResponse || null,
      revenueBefore,
      revenueAfter,
      requestCountDelta: Number(revenueAfter.requestCount || 0) - Number(revenueBefore.requestCount || 0),
      totalUsdcDelta: Number(revenueAfter.totalUsdc || 0) - Number(revenueBefore.totalUsdc || 0),
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});