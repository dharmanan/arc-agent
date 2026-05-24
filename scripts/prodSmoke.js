'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const FRONTEND_PROJECT_FILE = path.join(ROOT_DIR, 'frontend', '.vercel', 'project.json');
const FRONTEND_VERCEL_CONFIG = path.join(ROOT_DIR, 'frontend', 'vercel.json');

const FRONTEND_URL = process.env.PROD_FRONTEND_URL || 'https://arcmachina.xyz';
const BACKEND_HEALTH_URL = process.env.PROD_BACKEND_HEALTH_URL || 'https://backend-production-597c.up.railway.app/health';
const PUBLIC_ORACLE_URL = `${FRONTEND_URL}/api/oracle/public/pool-state?pool=USDC-EURC`;

function logResult(status, label, detail) {
  const prefix = status ? '[PASS]' : '[FAIL]';
  console.log(`${prefix} ${label}: ${detail}`);
}

async function runCheck(label, callback) {
  try {
    const detail = await callback();
    logResult(true, label, detail);
    return true;
  } catch (error) {
    logResult(false, label, error.message || String(error));
    return false;
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'arc-agent-prod-smoke/1.0',
      'accept': 'application/json, text/html;q=0.9, */*;q=0.8',
    },
  });
  const text = await response.text();
  return { response, text };
}

function requireFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${path.relative(ROOT_DIR, filePath)}`);
  }
}

function parseJsonFile(filePath) {
  requireFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function findMainJsAsset(html) {
  const specificMatch = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
  if (specificMatch) return specificMatch[0];

  const genericMatch = html.match(/\/assets\/[^"'\s>]+\.js/);
  return genericMatch ? genericMatch[0] : null;
}

async function main() {
  let allPassed = true;
  let homepageHtml = '';

  allPassed = (await runCheck('Frontend Vercel Link', async () => {
    const project = parseJsonFile(FRONTEND_PROJECT_FILE);
    if (project.projectName !== 'arc-agent-frontend') {
      throw new Error(`Expected arc-agent-frontend, got ${project.projectName}`);
    }
    return `projectName=${project.projectName}`;
  })) && allPassed;

  allPassed = (await runCheck('Frontend Vercel Config', async () => {
    requireFile(FRONTEND_VERCEL_CONFIG);
    return 'frontend/vercel.json present';
  })) && allPassed;

  allPassed = (await runCheck('Homepage', async () => {
    const { response, text } = await fetchText(FRONTEND_URL);
    homepageHtml = text;
    if (response.status !== 200) {
      throw new Error(`Expected 200, got ${response.status}`);
    }
    return `status=${response.status}`;
  })) && allPassed;

  allPassed = (await runCheck('Frontend Bundle Marker', async () => {
    if (!homepageHtml) {
      const { text } = await fetchText(FRONTEND_URL);
      homepageHtml = text;
    }

    const assetPath = findMainJsAsset(homepageHtml);
    if (!assetPath) {
      throw new Error('Could not find the main JS asset in the homepage HTML');
    }

    const assetUrl = new URL(assetPath, FRONTEND_URL).toString();
    const { response, text } = await fetchText(assetUrl);
    if (response.status !== 200) {
      throw new Error(`Expected bundle status 200, got ${response.status}`);
    }
    if (!text.includes('Run free checks, paid actions, Circle Paid cards and automation controls from one screen.')) {
      throw new Error('Tasks hub marker string not found in the live bundle');
    }

    return `${assetPath} contains the tasks hub marker`;
  })) && allPassed;

  allPassed = (await runCheck('Backend Health', async () => {
    const { response, text } = await fetchText(BACKEND_HEALTH_URL);
    if (response.status !== 200) {
      throw new Error(`Expected 200, got ${response.status}`);
    }

    const payload = JSON.parse(text);
    if (payload.status !== 'ok' || payload.db !== 'ok' || payload.redis !== 'ok') {
      throw new Error(`Unexpected health payload: ${text}`);
    }

    return text.trim();
  })) && allPassed;

  allPassed = (await runCheck('Public Oracle Unpaid Flow', async () => {
    const { response, text } = await fetchText(PUBLIC_ORACLE_URL);
    if (response.status !== 402) {
      throw new Error(`Expected 402, got ${response.status}`);
    }

    const payload = JSON.parse(text);
    const errorCode = String(payload.error || payload.code || payload.errorCode || '').toLowerCase();
    if (!errorCode.includes('payment_required')) {
      throw new Error(`Unexpected unpaid payload: ${text}`);
    }

    return `status=${response.status}`;
  })) && allPassed;

  if (!allPassed) {
    process.exitCode = 1;
    return;
  }

  console.log('[PASS] Production smoke complete');
}

main().catch((error) => {
  console.error('[FAIL] Production smoke crashed:', error.message || String(error));
  process.exit(1);
});