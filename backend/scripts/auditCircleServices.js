'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const CATALOG_URL = 'https://agents.circle.com/api/v1/internal/x402/services';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '../artifacts/circle-audits');
const PAYMENT_REQUIRED_HEADER_NAMES = ['PAYMENT-REQUIRED', 'X-PAYMENT-REQUIRED'];
const V1_NETWORK_ALIASES = {
  ethereum: 'eip155:1',
  sepolia: 'eip155:11155111',
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  polygon: 'eip155:137',
  'polygon-amoy': 'eip155:80002',
  arbitrum: 'eip155:42161',
  'arbitrum-sepolia': 'eip155:421614',
  optimism: 'eip155:10',
  'optimism-sepolia': 'eip155:11155420',
  avalanche: 'eip155:43114',
  'avalanche-fuji': 'eip155:43113',
};

const TESTNET_NETWORK_LABELS = {
  'eip155:5042002': 'Arc Testnet',
  'eip155:84532': 'Base Sepolia',
  'eip155:11155111': 'Sepolia',
  'eip155:421614': 'Arbitrum Sepolia',
  'eip155:11155420': 'Optimism Sepolia',
  'eip155:80002': 'Polygon Amoy',
  'eip155:43113': 'Avalanche Fuji',
  'solana:devnet': 'Solana Devnet',
};

loadEnv();

function loadEnv() {
  const envCandidates = [
    path.resolve(__dirname, '../../.env'),
    path.resolve(__dirname, '../.env'),
  ];

  for (const candidate of envCandidates) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return candidate;
    }
  }

  return null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const options = {
    category: null,
    service: null,
    limit: null,
    concurrency: parsePositiveInt(process.env.CIRCLE_AUDIT_CONCURRENCY, DEFAULT_CONCURRENCY),
    timeoutMs: parsePositiveInt(process.env.CIRCLE_AUDIT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--category') {
      options.category = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--service') {
      options.service = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      options.limit = parsePositiveInt(argv[index + 1], null);
      index += 1;
      continue;
    }

    if (arg === '--concurrency') {
      options.concurrency = parsePositiveInt(argv[index + 1], options.concurrency);
      index += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      options.timeoutMs = parsePositiveInt(argv[index + 1], options.timeoutMs);
      index += 1;
      continue;
    }

    if (arg === '--output') {
      options.output = argv[index + 1] || null;
      index += 1;
    }
  }

  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/auditCircleServices.js [options]',
    '',
    'Options:',
    '  --service <slug|id>     Probe one service only',
    '  --category <name>       Probe one category only',
    '  --limit <n>             Limit number of services',
    '  --concurrency <n>       Concurrent probes (default: 4)',
    '  --timeout-ms <n>        Per-request timeout in ms (default: 10000)',
    '  --output <path>         Write JSON report to a custom path',
    '  --help                  Show this help',
  ].join('\n'));
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function decodeBase64Json(headerValue) {
  if (!headerValue) return null;

  try {
    return JSON.parse(Buffer.from(String(headerValue), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function parseJson(raw) {
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeNetworkName(network) {
  const value = String(network || '').trim();
  if (!value) return null;

  if (value.includes(':')) return value;
  return V1_NETWORK_ALIASES[value] || value;
}

function isRpcLikeEndpoint(service, endpoint) {
  const joined = [
    service?.slug,
    service?.name,
    service?.category,
    endpoint?.path,
    endpoint?.description,
    endpoint?.baseUrl,
  ].join(' ').toLowerCase();

  return joined.includes('rpc') || joined.includes('/evm/') || joined.includes('json-rpc');
}

function buildProbePayload(service, endpoint) {
  if (isRpcLikeEndpoint(service, endpoint)) {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_chainId',
      params: [],
    };
  }

  return {
    probe: true,
    input: 'probe',
    query: 'probe',
  };
}

function buildProbeRequest(endpoint) {
  return buildProbeRequestForService(null, endpoint);
}

function buildProbeRequestForService(service, endpoint) {
  const method = String(endpoint?.method || 'GET').toUpperCase();
  const headers = {
    Accept: 'application/json',
  };

  if (method === 'GET' || method === 'HEAD') {
    return { method, headers };
  }

  headers['Content-Type'] = 'application/json';
  return {
    method,
    headers,
    body: JSON.stringify(buildProbePayload(service, endpoint)),
  };
}

function buildEndpointUrl(service, endpoint) {
  const baseUrl = endpoint?.baseUrl || service?.baseUrl;
  return new URL(endpoint?.path || '/', baseUrl).toString();
}

function extractPaymentSummary(paymentRequired) {
  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];

  return {
    x402Version: paymentRequired?.x402Version ?? null,
    resource: paymentRequired?.resource || null,
    acceptsCount: accepts.length,
    networks: uniq(accepts.map((item) => normalizeNetworkName(item?.network))),
    schemes: uniq(accepts.map((item) => item?.scheme)),
    gatewayKinds: uniq(accepts.map((item) => item?.extra?.name)),
  };
}

function extractPaymentSummaryFromBody(raw) {
  const parsed = parseJson(raw);
  if (!parsed || !Array.isArray(parsed.accepts)) {
    return null;
  }

  return extractPaymentSummary({
    x402Version: parsed.x402Version ?? null,
    resource: parsed.resource || parsed.url || null,
    accepts: parsed.accepts,
  });
}

async function safeReadSnippet(response) {
  try {
    const raw = await response.text();
    return raw || null;
  } catch {
    return null;
  }
}

async function probeEndpoint(service, endpoint, timeoutMs) {
  const url = buildEndpointUrl(service, endpoint);
  const request = buildProbeRequestForService(service, endpoint);

  try {
    const response = await fetch(url, {
      ...request,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const headerName = PAYMENT_REQUIRED_HEADER_NAMES.find((name) => response.headers.get(name)) || null;
    const paymentRequired = decodeBase64Json(headerName ? response.headers.get(headerName) : null);
    const rawSnippet = headerName ? null : await safeReadSnippet(response);
    const bodyPaymentSummary = headerName ? null : extractPaymentSummaryFromBody(rawSnippet);
    const paymentSummary = paymentRequired
      ? extractPaymentSummary(paymentRequired)
      : (bodyPaymentSummary || extractPaymentSummary(null));
    const snippet = rawSnippet ? rawSnippet.slice(0, 280) : null;

    return {
      method: request.method,
      url,
      status: response.status,
      ok: response.ok,
      paymentHeaderName: headerName,
      paymentRequired: paymentSummary,
      responseSnippet: snippet,
      error: null,
    };
  } catch (error) {
    return {
      method: request.method,
      url,
      status: null,
      ok: false,
      paymentHeaderName: null,
      paymentRequired: extractPaymentSummary(null),
      responseSnippet: null,
      error: error.message,
    };
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

function classifyService(serviceResult) {
  const networks = uniq(serviceResult.endpointProbes.flatMap((probe) => probe.paymentRequired.networks));
  const hasArc = networks.includes('eip155:5042002');
  const testnetNetworks = networks.filter((network) => TESTNET_NETWORK_LABELS[network]);
  const hasOtherTestnet = testnetNetworks.some((network) => network !== 'eip155:5042002');
  const hasPaymentHeader = serviceResult.endpointProbes.some((probe) => Boolean(probe.paymentHeaderName));
  const hasPaymentOptions = serviceResult.endpointProbes.some((probe) => Number(probe.paymentRequired.acceptsCount) > 0);
  const anyOpen = serviceResult.endpointProbes.some((probe) => probe.ok && !probe.paymentHeaderName);
  const anyProbeError = serviceResult.endpointProbes.some((probe) => probe.error);

  if (hasArc) return 'arc_testnet_supported';
  if (hasOtherTestnet) return 'other_testnet_only';
  if ((hasPaymentHeader || hasPaymentOptions) && networks.length > 0) return 'mainnet_or_non_arc_only';
  if (hasPaymentHeader || hasPaymentOptions) return 'paywalled_unknown_network';
  if (anyOpen) return 'open_or_not_paywalled';
  if (anyProbeError) return 'probe_failed';
  return 'unknown';
}

function summarizeService(service, endpointProbes) {
  const networks = uniq(endpointProbes.flatMap((probe) => probe.paymentRequired.networks));
  const schemes = uniq(endpointProbes.flatMap((probe) => probe.paymentRequired.schemes));
  const gatewayKinds = uniq(endpointProbes.flatMap((probe) => probe.paymentRequired.gatewayKinds));
  const endpointCount = Array.isArray(service?.endpoints) ? service.endpoints.length : 0;

  const result = {
    id: service.id,
    name: service.name,
    slug: service.slug,
    category: service.category,
    supportsCircleGateway: Boolean(service.supportsCircleGateway),
    partyType: service.partyType || null,
    endpointCount,
    networks,
    networkLabels: networks.map((network) => TESTNET_NETWORK_LABELS[network] || network),
    schemes,
    gatewayKinds,
    endpointProbes,
  };

  result.classification = classifyService(result);
  return result;
}

function buildSummary(auditResults) {
  const byClassification = auditResults.reduce((accumulator, item) => {
    accumulator[item.classification] = (accumulator[item.classification] || 0) + 1;
    return accumulator;
  }, {});

  const byCategory = auditResults.reduce((accumulator, item) => {
    accumulator[item.category] = (accumulator[item.category] || 0) + 1;
    return accumulator;
  }, {});

  return {
    totalServices: auditResults.length,
    totalEndpointsProbed: auditResults.reduce((sum, item) => sum + item.endpointProbes.length, 0),
    byClassification,
    byCategory,
    arcTestnetServices: auditResults.filter((item) => item.classification === 'arc_testnet_supported'),
    otherTestnetServices: auditResults.filter((item) => item.classification === 'other_testnet_only'),
    mainnetOnlyServices: auditResults.filter((item) => item.classification === 'mainnet_or_non_arc_only'),
  };
}

function printSummary(summary) {
  console.log(`Services probed: ${summary.totalServices}`);
  console.log(`Endpoints probed: ${summary.totalEndpointsProbed}`);
  console.log('');
  console.log('Classification counts:');

  Object.entries(summary.byClassification)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([label, count]) => {
      console.log(`- ${label}: ${count}`);
    });

  console.log('');
  console.log('Arc testnet-compatible services:');
  if (!summary.arcTestnetServices.length) {
    console.log('- none');
  } else {
    summary.arcTestnetServices.forEach((service) => {
      console.log(`- ${service.slug} [${service.category}] networks=${service.networks.join(',') || 'unknown'} gateway=${service.supportsCircleGateway}`);
    });
  }

  console.log('');
  console.log('Other testnet-only services:');
  if (!summary.otherTestnetServices.length) {
    console.log('- none');
  } else {
    summary.otherTestnetServices.forEach((service) => {
      console.log(`- ${service.slug} [${service.category}] networks=${service.networks.join(',') || 'unknown'} gateway=${service.supportsCircleGateway}`);
    });
  }
}

function resolveOutputPath(options) {
  if (options.output) return path.resolve(process.cwd(), options.output);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(DEFAULT_OUTPUT_DIR, `circle-service-audit-${timestamp}.json`);
}

async function fetchCatalog() {
  const response = await fetch(CATALOG_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Circle catalog: ${response.status}`);
  }

  const payload = await response.json();
  const services = Array.isArray(payload)
    ? payload
    : payload?.services || payload?.data || payload?.results || payload?.items || payload?.data?.services || null;

  if (!Array.isArray(services)) {
    throw new Error('Circle catalog payload does not expose a services array');
  }

  return services;
}

function filterServices(services, options) {
  let filtered = [...services];

  if (options.category) {
    const expectedCategory = normalizeText(options.category);
    filtered = filtered.filter((service) => normalizeText(service.category) === expectedCategory);
  }

  if (options.service) {
    const expectedService = normalizeText(options.service);
    filtered = filtered.filter((service) => {
      return [service.id, service.slug, service.name].some((value) => normalizeText(value) === expectedService);
    });
  }

  if (options.limit) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const services = filterServices(await fetchCatalog(), options);
  if (!services.length) {
    throw new Error('No Circle services matched the requested filters');
  }

  const auditResults = await mapWithConcurrency(services, options.concurrency, async (service) => {
    const endpoints = Array.isArray(service.endpoints) ? service.endpoints : [];
    const endpointProbes = await mapWithConcurrency(endpoints, options.concurrency, async (endpoint) => {
      return probeEndpoint(service, endpoint, options.timeoutMs);
    });

    return summarizeService(service, endpointProbes);
  });

  const summary = buildSummary(auditResults);
  const outputPath = resolveOutputPath(options);
  const report = {
    generatedAt: new Date().toISOString(),
    catalogUrl: CATALOG_URL,
    filters: {
      category: options.category,
      service: options.service,
      limit: options.limit,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
    },
    summary,
    services: auditResults,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  printSummary(summary);
  console.log('');
  console.log(`Report written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});