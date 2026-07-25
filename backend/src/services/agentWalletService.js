'use strict';
/**
 * Agent Wallet Service — Autonomous (agentic) on-chain execution
 *
 * İki köprü modu:
 *   AGENTIC  → Limit dahilindeyse ajan kendi private key'iyle tüm adımları otomatik yapar
 *   MANUAL   → Kullanıcı her adımı tetikler, ajan imzalar (MetaMask değil, ajan cüzdanı)
 *
 * Circle CCTP V2 akışı:
 *   1. Approve  → USDC'yi TokenMessenger'a onayla
 *   2. Burn     → depositForBurn() çağır, burnTxHash al
 *   3. Attest   → Circle attestation API'yi poll et (iris-api-sandbox)
 *   4. Mint     → Hedef zincirde receiveMessage() çağır
 *
 * Nano payment referans: https://developers.circle.com/gateway/nanopayments#agentic-payments
 */
const { ethers } = require('ethers');
const https      = require('https');
const { decrypt } = require('./cryptoService');
const protocols = require('./protocols');
const { resolveDirectSwapFallbackPool } = require('./oracle/pools');
const gatewayBuyerService = require('./agenticEconomy/gatewayBuyer');
const { runProtectedWrite, sendProtectedContractTx } = require('./txSecurityService');
const { createEthersAdapterFromPrivateKey } = require('@circle-fin/adapter-ethers-v6');
const { SwapKit, SwapChain, getChainByEnum } = require('@circle-fin/swap-kit');

// ── Sabitler ──────────────────────────────────────────────────────────────────
const NANO_THRESHOLD_USDC = 0.01;
const AGENT_MAX_GAS       = BigInt(process.env.AGENT_MAX_GAS_GWEI || 50) * BigInt(1e9);
const CCTP_MINT_GAS_LIMIT = 400_000n;
const DEFAULT_CCTP_MINT_GAS_ESTIMATE = 180_000n;

const NATIVE_TOPUP_ROUTES = {
  'Base Sepolia': {
    fromChain: process.env.NATIVE_TOPUP_SOURCE_CHAIN || 'Sepolia',
    kind: 'op-stack',
    bridgeAddress: process.env.BASE_SEPOLIA_OP_PORTAL || process.env.BASE_SEPOLIA_PORTAL || '0x49f53e41452c74589e85ca1677426ba426459e85',
    minGasLimit: Number(process.env.BASE_SEPOLIA_TOPUP_MIN_GAS || 200000),
  },
  'Optimism Sepolia': {
    fromChain: process.env.NATIVE_TOPUP_SOURCE_CHAIN || 'Sepolia',
    kind: 'op-stack',
    bridgeAddress: process.env.OPTIMISM_SEPOLIA_OP_PORTAL || process.env.OPTIMISM_SEPOLIA_PORTAL || '0x16fc5058f25648194471939df75cf27a2fdc48bc',
    minGasLimit: Number(process.env.OPTIMISM_SEPOLIA_TOPUP_MIN_GAS || 200000),
  },
  'Arbitrum Sepolia': {
    fromChain: process.env.NATIVE_TOPUP_SOURCE_CHAIN || 'Sepolia',
    kind: 'arbitrum',
    bridgeAddress: process.env.ARBITRUM_SEPOLIA_INBOX || '0xaae29b0366299461418f5324a79afc425be5ae21',
  },
};

function normalizeAddress(address) {
  return ethers.getAddress(String(address).toLowerCase());
}

async function assertContractAddress(chainName, address) {
  const provider = getProvider(chainName);
  const code = await provider.getCode(address);
  if (code === '0x') {
    throw new Error(`Bridge route misconfigured for ${chainName}: ${address} is not a contract address.`);
  }
}

// ── CCTP Zincir Konfigürasyonları (Circle SDK'dan: @circle-fin/bridge-kit) ────
// Kaynak: her zincirin cctp.domain ve cctp.contracts.v2 değerleri
const CCTP_CHAINS = {
  'Arc Testnet': {
    chainId:       5042002,
    rpc:           process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network',
    domain:        26,
    usdcAddress:   process.env.USDC_ADDRESS_ARC || '0x3600000000000000000000000000000000000000',
    tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    msgTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  },
  'Sepolia': {
    chainId:       11155111,
    rpc:           process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com',
    domain:        0,
    usdcAddress:   '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    tokenMessenger:'0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
    msgTransmitter:'0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  },
  'Base Sepolia': {
    chainId:       84532,
    rpc:           'https://sepolia.base.org',
    domain:        6,
    usdcAddress:   '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenMessenger:'0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
    msgTransmitter:'0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  },
  'Optimism Sepolia': {
    chainId:       11155420,
    rpc:           process.env.OPTIMISM_SEPOLIA_RPC || 'https://optimism-sepolia-rpc.publicnode.com',
    domain:        2,
    usdcAddress:   '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    tokenMessenger:'0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
    msgTransmitter:'0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  },
  'Arbitrum Sepolia': {
    chainId:       421614,
    rpc:           'https://sepolia-rollup.arbitrum.io/rpc',
    domain:        3,
    usdcAddress:   '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    msgTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  },
};

// Circle Attestation API (testnet sandbox)
const IRIS_API = 'https://iris-api-sandbox.circle.com';

// ── Token adresleri (Arc Testnet) ─────────────────────────────────────────────
const USDC_ARC   = process.env.USDC_ADDRESS_ARC || '0x3600000000000000000000000000000000000000';
const EURC_ARC   = process.env.EURC_ADDRESS_ARC || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const CIRBTC_ARC = process.env.CIRBTC_ADDRESS_ARC || '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF';
const ARC_SWAP_CHAIN = getChainByEnum(SwapChain.Arc_Testnet);
const SWAP_KIT = new SwapKit();
const SWAP_QUOTE_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const DEFAULT_CIRBTC_MAX_USDC_IN = 10;
const DEFAULT_CIRBTC_MAX_EURC_IN = 8;
const EXTERNAL_UNISWAP_V2_ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
];
const EXTERNAL_EXIT_VENUES = Object.freeze({
  'Sepolia': {
    venue: 'uniswap_v2',
    venueLabel: 'Uniswap V2 (Sepolia)',
    routerAddress: process.env.SEPOLIA_UNISWAP_V2_ROUTER || '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008',
    intermediaryToken: 'WETH',
  },
});
const EXTERNAL_CHAIN_TOKEN_CONFIG = Object.freeze({
  'Sepolia': {
    USDC: {
      address: process.env.USDC_ADDRESS_SEPOLIA || CCTP_CHAINS['Sepolia'].usdcAddress,
      decimals: 6,
    },
    EURC: {
      address: process.env.EURC_ADDRESS_SEPOLIA || null,
      decimals: 6,
    },
    WETH: {
      address: process.env.WETH_ADDRESS_SEPOLIA || '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
      decimals: 18,
    },
  },
});

// ── ABI'lar ───────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const TOKEN_MESSENGER_ABI = [
  // CCTP V2 signature (7 params)
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64 nonce)',
];

const MSG_TRANSMITTER_ABI = [
  'event MessageSent(bytes message)',
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
];

const OP_PORTAL_ABI = [
  'function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable',
];

const ARBITRUM_INBOX_ABI = [
  'function depositEth() payable returns (uint256)',
];

// ── Provider cache ────────────────────────────────────────────────────────────
const _providers = {};
function getProvider(chainName) {
  if (!_providers[chainName]) {
    const cfg = CCTP_CHAINS[chainName];
    if (!cfg) throw new Error(`Bilinmeyen zincir: ${chainName}`);
    _providers[chainName] = new ethers.JsonRpcProvider(cfg.rpc, { chainId: cfg.chainId, name: chainName });
  }
  return _providers[chainName];
}

// ── Ajan imzalayıcı (private key şifre çözme) ─────────────────────────────────
function getAgentPrivateKey(agent) {
  const encrypted = agent.private_key_encrypted || agent.privateKeyEncrypted;
  if (!encrypted) throw new Error('Agent private key kaydedilmemiş (ajanı yeniden oluşturun)');
  return decrypt(encrypted);
}

function getAgentSigner(agent, chainName = 'Arc Testnet') {
  return new ethers.Wallet(getAgentPrivateKey(agent), getProvider(chainName));
}

function getAgentIdentity(agent, fallbackWalletAddress = null) {
  return {
    agentId: agent?.id || null,
    walletAddress: agent?.wallet_address || agent?.walletAddress || fallbackWalletAddress || null,
  };
}

function getSwapKitKey() {
  return process.env.CIRCLE_KIT_KEY || process.env.KIT_KEY || '';
}

function isSwapConfigured() {
  return Boolean(getSwapKitKey());
}

function readPositiveNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeChainEnvSuffix(chainName) {
  return String(chainName || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
}

function getCctpMinFinalityThreshold(chainName) {
  const defaultThreshold = readPositiveIntegerEnv('CCTP_MIN_FINALITY_THRESHOLD', 1000);
  const perChainEnvName = `CCTP_MIN_FINALITY_THRESHOLD_${normalizeChainEnvSuffix(chainName)}`;
  return readPositiveIntegerEnv(perChainEnvName, defaultThreshold);
}

function getCirbtcInputLimit(fromToken) {
  if (fromToken === 'EURC') {
    return readPositiveNumberEnv('CIRBTC_SWAP_MAX_EURC_IN', DEFAULT_CIRBTC_MAX_EURC_IN);
  }

  return readPositiveNumberEnv('CIRBTC_SWAP_MAX_USDC_IN', DEFAULT_CIRBTC_MAX_USDC_IN);
}

function getCirbtcSwapSizeGuard({ fromToken, toToken, amountIn }) {
  if (toToken !== 'cirBTC') {
    return null;
  }

  const normalizedFromToken = String(fromToken || '').trim().toUpperCase();
  if (!['USDC', 'EURC'].includes(normalizedFromToken)) {
    return null;
  }

  const normalizedAmountIn = Number(amountIn);
  if (!Number.isFinite(normalizedAmountIn) || normalizedAmountIn <= 0) {
    return null;
  }

  const maxAmountIn = getCirbtcInputLimit(normalizedFromToken);
  if (normalizedAmountIn <= maxAmountIn) {
    return null;
  }

  return {
    code: 'CIRBTC_SIZE_LIMIT',
    fromToken: normalizedFromToken,
    maxAmountIn,
    userMessage: `This cirBTC market is thin right now. For reliable swaps, stay at or below ${maxAmountIn} ${normalizedFromToken}. Try a smaller amount.`,
  };
}

function getDirectSwapFallbackPool(fromToken, toToken) {
  if (!fromToken || !toToken || fromToken === toToken) {
    return null;
  }

  return resolveDirectSwapFallbackPool(`${fromToken}-${toToken}`);
}

function isCirbtcPair(fromToken, toToken) {
  return fromToken === 'cirBTC' || toToken === 'cirBTC';
}

function getDirectFallbackRouteReason(fallbackPool) {
  if (!fallbackPool?.address) {
    return null;
  }

  if (fallbackPool.protocol === 'curve') {
    return 'This pair can still trade through the app\'s direct Arc stable pool if the main route is busy.';
  }

  return 'This pair can still trade through the app\'s direct Arc pool if the main route is busy.';
}

function getFallbackOnlyRouteReason(fallbackPool) {
  if (!fallbackPool?.address) {
    return 'This pair does not have a backup direct pool on this deployment right now.';
  }

  if (fallbackPool.protocol === 'curve') {
    return 'This quote uses the app\'s direct Arc stable pool only.';
  }

  return 'This quote uses the app\'s direct Arc pool only.';
}

function normalizeSwapRouteMode(routeMode = 'auto') {
  const normalized = String(routeMode || 'auto').trim().toLowerCase();
  if (normalized === 'primary_only') return 'primary_only';
  if (normalized === 'fallback_only') return 'fallback_only';
  return 'auto';
}

function getSwapRouteStrategy({ fromToken, toToken, routeMode = 'auto' }) {
  const normalizedRouteMode = normalizeSwapRouteMode(routeMode);
  const fallbackPool = getDirectSwapFallbackPool(fromToken, toToken);
  const cirbtcPair = isCirbtcPair(fromToken, toToken);

  if (normalizedRouteMode === 'primary_only') {
    return {
      routeStrategy: isSwapConfigured() ? 'swap_kit_primary_only' : 'swap_kit_required',
      routeReason: isSwapConfigured()
        ? 'This route uses the live app swap path only and does not fall back to a direct pool.'
        : 'This route needs the live app swap path, but it is not available on this deployment.',
      fallbackAvailable: false,
    };
  }

  if (normalizedRouteMode === 'fallback_only') {
    if (cirbtcPair) {
      return {
        routeStrategy: 'route_unavailable',
        routeReason: 'cirBTC swaps do not allow direct pool fallback on this deployment.',
        fallbackAvailable: false,
      };
    }

    if (!fallbackPool?.address) {
      return {
        routeStrategy: 'route_unavailable',
        routeReason: getFallbackOnlyRouteReason(fallbackPool),
        fallbackAvailable: false,
      };
    }

    const isCurveFallback = fallbackPool.protocol === 'curve';
    return {
      routeStrategy: isCurveFallback ? 'curve_fallback_only' : 'v2_fallback_only',
      routeReason: getFallbackOnlyRouteReason(fallbackPool),
      fallbackAvailable: true,
      poolAddress: fallbackPool.address,
      poolSource: fallbackPool.source || 'verified_default',
    };
  }

  if (cirbtcPair) {
    return {
      routeStrategy: isSwapConfigured() ? 'swap_kit_only' : 'swap_kit_required',
      routeReason: isSwapConfigured()
        ? 'cirBTC swaps use the Circle route only on this deployment.'
        : 'cirBTC swaps require the Circle route on this deployment, but it is not configured.',
      fallbackAvailable: false,
    };
  }

  if (fallbackPool?.address) {
    const isCurveFallback = fallbackPool.protocol === 'curve';
    return {
      routeStrategy: isSwapConfigured()
        ? (isCurveFallback ? 'swap_kit_primary_with_curve_fallback' : 'swap_kit_primary_with_v2_fallback')
        : (isCurveFallback ? 'curve_fallback_only' : 'v2_fallback_only'),
      routeReason: getDirectFallbackRouteReason(fallbackPool),
      fallbackAvailable: true,
      poolAddress: fallbackPool.address,
      poolSource: fallbackPool.source || 'verified_default',
    };
  }

  return {
    routeStrategy: isSwapConfigured() ? 'swap_kit_only' : 'route_unavailable',
    routeReason: 'This pair does not have a working swap route on this deployment right now.',
    fallbackAvailable: false,
  };
}

function normalizeTokenSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function getExternalChainToken(chainName, tokenSymbol) {
  const chainTokens = EXTERNAL_CHAIN_TOKEN_CONFIG[chainName] || null;
  if (!chainTokens) {
    return null;
  }

  return chainTokens[normalizeTokenSymbol(tokenSymbol)] || null;
}

function buildExternalRouteCandidates(chainName, fromToken, toToken) {
  const venue = EXTERNAL_EXIT_VENUES[chainName] || null;
  const directPath = [fromToken, toToken];
  const candidates = [directPath];

  if (venue?.intermediaryToken) {
    const bridgeToken = normalizeTokenSymbol(venue.intermediaryToken);
    if (bridgeToken !== fromToken && bridgeToken !== toToken) {
      candidates.push([fromToken, bridgeToken, toToken]);
    }
  }

  return candidates;
}

async function getExternalSwapQuoteResult({ chainName = 'Sepolia', fromToken, toToken, amountIn }) {
  const normalizedChainName = String(chainName || 'Sepolia').trim() || 'Sepolia';
  const normalizedFromToken = normalizeTokenSymbol(fromToken);
  const normalizedToToken = normalizeTokenSymbol(toToken);
  const venue = EXTERNAL_EXIT_VENUES[normalizedChainName] || null;
  const tokenIn = getExternalChainToken(normalizedChainName, normalizedFromToken);
  const tokenOut = getExternalChainToken(normalizedChainName, normalizedToToken);
  const numericAmountIn = Number(amountIn);

  if (!venue || !venue.routerAddress || !tokenIn?.address || !tokenOut?.address) {
    return {
      amountOut: null,
      quoteError: 'External exit venue is not configured on this deployment.',
      executionRail: null,
      venue: venue?.venue || null,
      venueLabel: venue?.venueLabel || null,
      chainName: normalizedChainName,
      routeCandidates: [],
    };
  }

  if (!Number.isFinite(numericAmountIn) || numericAmountIn <= 0) {
    return {
      amountOut: null,
      quoteError: 'External exit quote requires a positive amount.',
      executionRail: null,
      venue: venue.venue,
      venueLabel: venue.venueLabel,
      chainName: normalizedChainName,
      routeCandidates: [],
    };
  }

  if (normalizedFromToken === normalizedToToken) {
    return {
      amountOut: String(numericAmountIn),
      quoteError: null,
      executionRail: 'external_identity_quote',
      venue: venue.venue,
      venueLabel: venue.venueLabel,
      chainName: normalizedChainName,
      routeCandidates: [[normalizedFromToken]],
    };
  }

  const amountInRaw = ethers.parseUnits(String(numericAmountIn), tokenIn.decimals || 6);
  const provider = getProvider(normalizedChainName);
  const router = new ethers.Contract(venue.routerAddress, EXTERNAL_UNISWAP_V2_ROUTER_ABI, provider);
  const routeCandidates = buildExternalRouteCandidates(normalizedChainName, normalizedFromToken, normalizedToToken);
  let bestQuote = null;

  for (const candidate of routeCandidates) {
    const addresses = candidate.map(symbol => getExternalChainToken(normalizedChainName, symbol)?.address).filter(Boolean);
    if (addresses.length !== candidate.length) {
      continue;
    }

    try {
      const amounts = await router.getAmountsOut(amountInRaw, addresses);
      const outputRaw = amounts?.[amounts.length - 1];
      if (!outputRaw || outputRaw <= 0n) {
        continue;
      }

      if (!bestQuote || outputRaw > bestQuote.outputRaw) {
        bestQuote = {
          path: candidate,
          outputRaw,
        };
      }
    } catch (error) {
      console.warn('[AGENT-EXTERNAL-SWAP-QUOTE]', normalizedChainName, candidate.join('->'), error.message);
    }
  }

  if (!bestQuote) {
    return {
      amountOut: null,
      quoteError: 'No live external exit quote is available for this pair right now.',
      executionRail: null,
      venue: venue.venue,
      venueLabel: venue.venueLabel,
      chainName: normalizedChainName,
      routerAddress: venue.routerAddress,
      routeCandidates,
    };
  }

  return {
    amountOut: ethers.formatUnits(bestQuote.outputRaw, tokenOut.decimals || 6),
    quoteError: null,
    executionRail: 'external_uniswap_v2_quote',
    venue: venue.venue,
    venueLabel: venue.venueLabel,
    chainName: normalizedChainName,
    routerAddress: venue.routerAddress,
    routeCandidates,
    path: bestQuote.path,
  };
}

function buildSwapQuotePreview(quoteResult) {
  if (quoteResult?.amountOut == null) {
    return null;
  }

  return {
    amountOut: quoteResult.amountOut,
    executionRail: quoteResult.executionRail || null,
    routeStrategy: quoteResult.routeStrategy || null,
    routeReason: quoteResult.routeReason || null,
    poolAddress: quoteResult.poolAddress || null,
    poolSource: quoteResult.poolSource || null,
  };
}

async function getDirectSwapFallbackQuote({ fromToken, toToken, amountIn, routeMode = 'fallback_only' }) {
  const fallbackPool = getDirectSwapFallbackPool(fromToken, toToken);
  const strategy = getSwapRouteStrategy({ fromToken, toToken, routeMode });
  if (!fallbackPool?.address) {
    return {
      amountOut: null,
      quoteError: strategy.routeReason || 'No direct Curve fallback is available for this pair.',
      ...strategy,
    };
  }

  try {
    let quote = null;
    let executionRail = 'curve_fallback';

    if (fallbackPool.protocol === 'curve') {
      quote = await protocols.getCurveQuote(
        fallbackPool.address,
        fallbackPool.baseToken.index,
        fallbackPool.quoteToken.index,
        amountIn,
        fallbackPool.baseToken.decimals || 6,
        fallbackPool.quoteToken.decimals || 6,
      );
    } else {
      quote = await protocols.getConstantProductQuote({
        pairAddress: fallbackPool.address,
        tokenInAddress: fallbackPool.baseToken.address,
        tokenOutAddress: fallbackPool.quoteToken.address,
        amountIn,
        decimalsIn: fallbackPool.baseToken.decimals || 6,
        decimalsOut: fallbackPool.quoteToken.decimals || 6,
        feePct: fallbackPool.feePct || 0.3,
      });
      executionRail = 'uniswap_v2_fallback';
    }

    return {
      amountOut: quote.amountOut,
      quoteError: null,
      ...strategy,
      executionRail,
      poolAddress: fallbackPool.address,
      poolSource: fallbackPool.source || 'verified_default',
    };
  } catch (error) {
    console.warn('[AGENT-SWAP-QUOTE:FALLBACK]', error.message);
    return {
      amountOut: null,
      quoteError: 'A backup quote is unavailable right now. Try again in a moment.',
      ...strategy,
    };
  }
}

async function executeDirectSwapFallback({ agent, fromToken, toToken, amountIn, slippagePct, strategy = getSwapRouteStrategy({ fromToken, toToken }) }) {
  const fallbackPool = getDirectSwapFallbackPool(fromToken, toToken);
  if (!fallbackPool?.address) {
    throw new Error(strategy.routeReason || 'No direct Curve fallback is available for this pair.');
  }

  let result = null;
  let executionRail = 'curve_fallback';

  if (fallbackPool.protocol === 'curve') {
    const executeCurveFallback = (effectiveSlippagePct) => protocols.executeCurveSwap({
      poolAddress: fallbackPool.address,
      tokenInAddress: fallbackPool.baseToken.address,
      indexIn: fallbackPool.baseToken.index,
      indexOut: fallbackPool.quoteToken.index,
      amountIn: String(amountIn),
      slippagePct: effectiveSlippagePct,
      agentPrivateKey: getAgentPrivateKey(agent),
      decimalsIn: fallbackPool.baseToken.decimals || 6,
      decimalsOut: fallbackPool.quoteToken.decimals || 6,
    });

    try {
      result = await executeCurveFallback(slippagePct);
    } catch (error) {
      const baseSlippagePct = Number(slippagePct) || 0.5;
      const retrySlippagePct = Math.max(baseSlippagePct, 1.5);

      if (!isCurveInsufficientAmountOutError(error) || retrySlippagePct <= baseSlippagePct) {
        throw error;
      }

      console.warn('[AGENT-SWAP:FALLBACK-RETRY]', error.message);
      result = await executeCurveFallback(retrySlippagePct);
    }
  } else {
    result = await protocols.executeConstantProductSwap({
      pairAddress: fallbackPool.address,
      tokenInAddress: fallbackPool.baseToken.address,
      tokenOutAddress: fallbackPool.quoteToken.address,
      amountIn: String(amountIn),
      slippagePct,
      agentPrivateKey: getAgentPrivateKey(agent),
      decimalsIn: fallbackPool.baseToken.decimals || 6,
      decimalsOut: fallbackPool.quoteToken.decimals || 6,
      feePct: fallbackPool.feePct || 0.3,
    });
    executionRail = 'uniswap_v2_fallback';
  }

  console.log(`[AGENT-SWAP:FALLBACK] ✓ ${result.txHash} | out: ${result.amountOut} ${toToken}`);
  return {
    hash: result.txHash,
    amountOut: result.amountOut,
    ...strategy,
    executionRail,
    poolAddress: fallbackPool.address,
    poolSource: fallbackPool.source || 'verified_default',
  };
}

function toSlippageBps(slippagePct = 0.5) {
  const normalized = Number(slippagePct);
  if (!Number.isFinite(normalized) || normalized <= 0) return 50;
  return Math.max(1, Math.round(normalized * 100));
}

function isPrimarySwapFallbackCandidate(error) {
  if (!error) return false;

  const message = String(error.userMessage || error.message || '').trim();
  const txHash = error.txHash || error.hash || error.transactionHash || null;

  if (txHash) {
    return false;
  }

  return /simulation failed|insufficientamountout|0xe52970aa|stop limit|execution reverted|swap failed/i.test(message);
}

function createArcSwapAdapter(privateKey) {
  return createEthersAdapterFromPrivateKey({
    privateKey,
    getProvider: () => getProvider('Arc Testnet'),
  });
}

function normalizeSwapQuoteError(error) {
  const message = error?.userMessage || error?.message || 'Live quote is unavailable right now.';

  if (error?.code === 'CIRBTC_SIZE_LIMIT') {
    return message;
  }

  if (message.includes('No route available')) {
    return 'This market is too thin for that size right now. Try a smaller amount.';
  }

  if (message.includes('Invalid API key format')) {
    return 'This deployment is missing a working live swap route.';
  }

  if (
    /insufficient liquidity/i.test(message)
    || /CALL_EXCEPTION/i.test(message)
    || /transaction execution reverted/i.test(message)
  ) {
    return 'This market moved or ran out of depth before the swap could be sent. Try a smaller amount.';
  }

  return 'Live quote is unavailable right now.';
}

function isCurveInsufficientAmountOutError(error) {
  const message = error?.userMessage || error?.message || '';
  return /InsufficientAmountOut/i.test(message) || message.includes('0xe52970aa');
}

async function createSwapFallbackConfirmationError({ fromToken, toToken, amountIn, primaryAmountOut = null, error = null }) {
  const fallbackQuote = await getDirectSwapFallbackQuote({
    fromToken,
    toToken,
    amountIn,
    routeMode: 'fallback_only',
  }).catch(() => null);

  if (!fallbackQuote || fallbackQuote.amountOut == null) {
    return null;
  }

  const nextError = new Error('The live app route changed before broadcast. Review the updated backup quote and confirm if you want to continue.');
  nextError.code = 'SWAP_FALLBACK_CONFIRMATION_REQUIRED';
  nextError.userMessage = 'The live app route changed before broadcast. Review the updated backup quote and confirm if you want to continue on the direct Arc pool.';
  nextError.requiresFallbackConfirmation = true;
  nextError.primaryAmountOut = primaryAmountOut;
  nextError.primaryError = error?.userMessage || error?.message || null;
  nextError.fallbackQuote = buildSwapQuotePreview(fallbackQuote);
  return nextError;
}

async function estimateArcSwap({ adapter, fromToken, toToken, amountIn, slippagePct }) {
  return SWAP_KIT.estimate({
    from: { adapter, chain: ARC_SWAP_CHAIN },
    tokenIn: fromToken,
    tokenOut: toToken,
    amountIn: String(amountIn),
    config: {
      kitKey: getSwapKitKey(),
      slippageBps: toSlippageBps(slippagePct),
    },
  });
}

async function getNativeBalance(chainName, address) {
  if (!address) return 0n;
  const provider = getProvider(chainName);
  return provider.getBalance(address);
}

async function getCurrentBlockNumber(chainName) {
  return getProvider(chainName).getBlockNumber();
}

async function findRecentIncomingNativeTransfer({ chainName, recipient, amountWei, startBlock, endBlock, maxBlocks = 1200 }) {
  if (!chainName || !recipient || amountWei == null) return null;

  const provider = getProvider(chainName);
  const latestBlock = Number(endBlock ?? await provider.getBlockNumber());
  const lowerBound = Math.max(0, Number(startBlock ?? (latestBlock - maxBlocks)));
  const recipientLower = recipient.toLowerCase();

  for (let blockNumber = latestBlock; blockNumber >= lowerBound; blockNumber -= 1) {
    const block = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), true]).catch(() => null);
    const txs = Array.isArray(block?.transactions) ? block.transactions : [];

    const match = txs.find(tx => {
      if (!tx?.hash || !tx?.to) return false;
      if (String(tx.to).toLowerCase() !== recipientLower) return false;
      try {
        return BigInt(tx.value || '0x0') === amountWei;
      } catch {
        return false;
      }
    });

    if (match) {
      return {
        hash: match.hash,
        blockNumber,
        from: match.from || null,
        to: match.to || recipient,
      };
    }
  }

  return null;
}

function applyGasMargin(value, bps = 12500n) {
  return (value * bps) / 10000n;
}

function clampFeePerGas(value) {
  if (!value || value <= 0n) return null;
  return value > AGENT_MAX_GAS ? AGENT_MAX_GAS : value;
}

async function getFeeOverrides(chainName) {
  const provider = getProvider(chainName);
  const feeData = await provider.getFeeData().catch(() => ({}));

  const maxFeePerGas = clampFeePerGas(feeData.maxFeePerGas);
  const maxPriorityFeePerGas = clampFeePerGas(feeData.maxPriorityFeePerGas);
  if (maxFeePerGas) {
    return {
      maxFeePerGas,
      ...(maxPriorityFeePerGas && maxPriorityFeePerGas <= maxFeePerGas ? { maxPriorityFeePerGas } : {}),
    };
  }

  return { gasPrice: clampFeePerGas(feeData.gasPrice) || AGENT_MAX_GAS };
}

async function buildTxOverrides(chainName, gasLimit) {
  const feeOverrides = await getFeeOverrides(chainName);
  return gasLimit ? { gasLimit, ...feeOverrides } : feeOverrides;
}

function getRequiredMintGasWei() {
  return applyGasMargin(DEFAULT_CCTP_MINT_GAS_ESTIMATE * AGENT_MAX_GAS, 15000n);
}

async function estimateDestinationMintGasWei(toChain) {
  const feeOverrides = await getFeeOverrides(toChain);
  const pricePerGas = feeOverrides.maxFeePerGas || feeOverrides.gasPrice || AGENT_MAX_GAS;
  return applyGasMargin(DEFAULT_CCTP_MINT_GAS_ESTIMATE * pricePerGas, 15000n);
}

function getNativeTopUpRoute(toChain) {
  const route = NATIVE_TOPUP_ROUTES[toChain];
  if (!route) throw new Error(`Native gas top-up desteklemiyor: ${toChain}`);
  return {
    ...route,
    bridgeAddress: normalizeAddress(route.bridgeAddress),
  };
}

async function getRecommendedNativeTopUpWei(toChain, currentBalanceWei = 0n) {
  const requiredWei = await estimateDestinationMintGasWei(toChain);
  if (currentBalanceWei >= requiredWei) return 0n;
  const shortfallWei = requiredWei - currentBalanceWei;
  return applyGasMargin(shortfallWei, 12500n);
}

async function ensureDestinationGasForAutoBridge(agent, toChain) {
  const address = agent.wallet_address || agent.walletAddress;
  const balanceWei = await getNativeBalance(toChain, address);
  const requiredWei = await estimateDestinationMintGasWei(toChain);
  if (balanceWei < requiredWei) {
    const symbol = CCTP_CHAINS[toChain]?.chainId === 5042002 ? 'ARC' : 'ETH';
    throw Object.assign(
      new Error(`Agent wallet needs at least ${ethers.formatEther(requiredWei)} ${symbol} on ${toChain} for destination mint gas. Current balance: ${ethers.formatEther(balanceWei)} ${symbol}. Fund the destination gas wallet or use manual mode.`),
      { code: 'INSUFFICIENT_DESTINATION_GAS', balanceWei, requiredWei, toChain },
    );
  }
}

async function bridgeNativeGasTopUp({ agent, toChain, recipient, amountEth, amountWei }) {
  const route = getNativeTopUpRoute(toChain);
  const signer = getAgentSigner(agent, route.fromChain);
  const toAddress = recipient || signer.address;
  const value = amountWei ?? ethers.parseEther(String(amountEth));
  if (value <= 0n) throw new Error('Top-up amount must be greater than zero');

  await assertContractAddress(route.fromChain, route.bridgeAddress);

  if (route.kind === 'op-stack') {
    const portal = new ethers.Contract(route.bridgeAddress, OP_PORTAL_ABI, signer);
    const { receipt } = await sendProtectedContractTx({
      contract: portal,
      methodName: 'depositTransaction',
      args: [toAddress, value, BigInt(route.minGasLimit), false, '0x'],
      txOptions: {
        value,
        ...(await buildTxOverrides(route.fromChain)),
      },
      chainName: route.fromChain,
      ...getAgentIdentity(agent, signer.address),
      operation: 'native_gas_topup_op_stack',
      replayFingerprint: [toChain, toAddress, value.toString(), route.bridgeAddress],
    });
    return {
      topUpTxHash: receipt.hash,
      fromChain: route.fromChain,
      toChain,
      recipient: toAddress,
      amountWei: value,
      bridgeAddress: route.bridgeAddress,
      bridgeKind: route.kind,
    };
  }

  if (route.kind === 'arbitrum') {
    const inbox = new ethers.Contract(route.bridgeAddress, ARBITRUM_INBOX_ABI, signer);
    const { receipt } = await sendProtectedContractTx({
      contract: inbox,
      methodName: 'depositEth',
      args: [],
      txOptions: {
        value,
        ...(await buildTxOverrides(route.fromChain)),
      },
      chainName: route.fromChain,
      ...getAgentIdentity(agent, signer.address),
      operation: 'native_gas_topup_arbitrum',
      replayFingerprint: [toChain, toAddress, value.toString(), route.bridgeAddress],
    });
    return {
      topUpTxHash: receipt.hash,
      fromChain: route.fromChain,
      toChain,
      recipient: toAddress,
      amountWei: value,
      bridgeAddress: route.bridgeAddress,
      bridgeKind: route.kind,
    };
  }

  throw new Error(`Desteklenmeyen native top-up route türü: ${route.kind}`);
}

// ── Token adresi çözümleme ────────────────────────────────────────────────────
function resolveTokenAddress(symbol) {
  if (symbol === 'USDC') return USDC_ARC;
  if (symbol === 'EURC') return EURC_ARC;
  if (symbol === 'cirBTC') return CIRBTC_ARC;
  throw new Error(`Bilinmeyen token: ${symbol}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CCTP KÖPRÜ — TEK TEK ADIMLAR
// Her adım hem agentic hem de manual mod tarafından çağrılabilir.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adım 1: USDC → TokenMessenger approve
 * Returns: { approveTxHash }
 */
async function cctpApprove({ agent, fromChain, amountUsdc }) {
  const cfg    = CCTP_CHAINS[fromChain];
  if (!cfg) throw new Error(`CCTP desteklemiyor: ${fromChain}`);

  const signer = getAgentSigner(agent, fromChain);
  const usdc   = new ethers.Contract(cfg.usdcAddress, ERC20_ABI, signer);
  const amount = ethers.parseUnits(String(amountUsdc), 6);

  // Mevcut allowance yeterliyse tekrar approve etme
  const existing = await usdc.allowance(signer.address, cfg.tokenMessenger);
  if (existing >= amount) {
    console.log(`[CCTP-APPROVE] Zaten yeterli allowance: ${fromChain}`);
    return { approveTxHash: null, alreadyApproved: true };
  }

  console.log(`[CCTP-APPROVE] ${amountUsdc} USDC → TokenMessenger (${fromChain})`);
  const { receipt } = await sendProtectedContractTx({
    contract: usdc,
    methodName: 'approve',
    args: [cfg.tokenMessenger, ethers.MaxUint256],
    txOptions: await buildTxOverrides(fromChain),
    chainName: fromChain,
    ...getAgentIdentity(agent, signer.address),
    operation: 'cctp_approve',
    replayFingerprint: [fromChain, cfg.tokenMessenger, amount.toString()],
  });
  console.log(`[CCTP-APPROVE] ✓ ${receipt.hash}`);
  return { approveTxHash: receipt.hash };
}

/**
 * Adım 2: depositForBurn → USDC'yi kaynak zincirde yak
 * Returns: { burnTxHash, message, messageHash }
 */
async function cctpBurn({ agent, fromChain, toChain, amountUsdc }) {
  const srcCfg = CCTP_CHAINS[fromChain];
  const dstCfg = CCTP_CHAINS[toChain];
  if (!srcCfg) throw new Error(`CCTP desteklemiyor: ${fromChain}`);
  if (!dstCfg) throw new Error(`CCTP desteklemiyor: ${toChain}`);

  const signer    = getAgentSigner(agent, fromChain);
  const amount    = ethers.parseUnits(String(amountUsdc), 6);
  const messenger = new ethers.Contract(srcCfg.tokenMessenger, TOKEN_MESSENGER_ABI, signer);
  const destinationCaller = ethers.ZeroHash;
  const maxFee = 0n;
  const minFinalityThreshold = getCctpMinFinalityThreshold(fromChain);

  // mintRecipient: 32 byte'a padlenmiş ajan adresi
  const mintRecipient = ethers.zeroPadValue(signer.address, 32);

  console.log(`[CCTP-BURN] ${amountUsdc} USDC: ${fromChain}(domain ${srcCfg.domain}) → ${toChain}(domain ${dstCfg.domain})`);

  let receipt;
  try {
    const burnResult = await sendProtectedContractTx({
      contract: messenger,
      methodName: 'depositForBurn',
      args: [
        amount,
        dstCfg.domain,
        mintRecipient,
        srcCfg.usdcAddress,
        destinationCaller,
        maxFee,
        minFinalityThreshold,
      ],
      txOptions: await buildTxOverrides(fromChain),
      chainName: fromChain,
      ...getAgentIdentity(agent, signer.address),
      operation: 'cctp_burn',
      replayFingerprint: [fromChain, toChain, amount.toString(), signer.address],
    });
    receipt = burnResult.receipt;
  } catch (error) {
    console.error('[CCTP-BURN] depositForBurn failed', {
      fromChain,
      toChain,
      amountUsdc,
      sourceDomain: srcCfg.domain,
      destinationDomain: dstCfg.domain,
      burnToken: srcCfg.usdcAddress,
      tokenMessenger: srcCfg.tokenMessenger,
      maxFee: maxFee.toString(),
      minFinalityThreshold,
      errorCode: error?.code || null,
      errorShortMessage: error?.shortMessage || null,
      errorReason: error?.reason || null,
      errorName: error?.name || null,
    });

    if (error && typeof error === 'object') {
      error.bridgeStep = error.bridgeStep || 'burning';
      error.bridgeOperation = error.bridgeOperation || 'depositForBurn';
      throw error;
    }

    const wrappedError = new Error(error?.message || 'CCTP burn failed');
    wrappedError.bridgeStep = 'burning';
    wrappedError.bridgeOperation = 'depositForBurn';
    throw wrappedError;
  }

  // MessageSent event'inden message bytes'ını çıkar
  const transmitter = new ethers.Contract(srcCfg.msgTransmitter, MSG_TRANSMITTER_ABI, getProvider(fromChain));
  const iface = transmitter.interface;
  let message = null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === 'MessageSent') {
        message = parsed.args.message;
        break;
      }
    } catch { /* farklı kontrat logu */ }
  }

  if (!message) throw new Error('MessageSent event bulunamadı — burn başarısız olmuş olabilir');

  const messageHash = ethers.keccak256(message);
  console.log(`[CCTP-BURN] ✓ burnTxHash=${receipt.hash} messageHash=${messageHash}`);
  return { burnTxHash: receipt.hash, message, messageHash };
}

/**
 * Adım 3: Circle Attestation API'yi poll et
 * sourceTxHash (primary) ve messageHash (fallback) ile attestation'ı bekle.
 * Returns: { attestation } (0x... hex string)
 */
async function cctpPollAttestation({
  fromChain,
  toChain,
  sourceTxHash,
  messageHash,
  maxWaitMs = parseInt(process.env.CCTP_ATTESTATION_MAX_WAIT_MS || `${30 * 60 * 1000}`, 10),
}) {
  const srcCfg  = CCTP_CHAINS[fromChain];
  const dstCfg  = toChain ? CCTP_CHAINS[toChain] : null;
  if (!srcCfg) throw new Error(`CCTP desteklemiyor: ${fromChain}`);

  const deadline = Date.now() + maxWaitMs;
  const POLL_MS  = 5000;

  console.log(`[CCTP-ATTEST] Polling: domain=${srcCfg.domain} sourceTx=${sourceTxHash || '-'} messageHash=${messageHash || '-'}`);

  while (Date.now() < deadline) {
    if (sourceTxHash) {
      const data = await httpGet(`${IRIS_API}/v2/messages/${srcCfg.domain}?transactionHash=${sourceTxHash}`);
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      const readyMessage = messages.find(message => isIrisMessageMintReady(message, dstCfg?.domain));
      if (readyMessage) {
        console.log('[CCTP-ATTEST] ✓ Attestation alındı (v2)');
        return { attestation: readAttestationValue(readyMessage), message: readyMessage.message };
      }
      console.log(`[CCTP-ATTEST] Bekleniyor… v2 status=${messages[0]?.status ?? 'yok'}`);
    }

    if (messageHash) {
      const data = await httpGet(`${IRIS_API}/v1/messages/${srcCfg.domain}/${messageHash}`);
      const msg  = data?.messages?.[0];
      if (msg && isIrisMessageMintReady(msg, dstCfg?.domain)) {
        console.log('[CCTP-ATTEST] ✓ Attestation alındı (v1 fallback)');
        return { attestation: readAttestationValue(msg), message: msg.message };
      }
      console.log(`[CCTP-ATTEST] Bekleniyor… v1 status=${msg?.status ?? 'yok'}`);
    }

    await sleep(POLL_MS);
  }

  throw new Error('Attestation zaman aşımına uğradı (30 dakika)');
}

/**
 * Adım 4: Hedef zincirde receiveMessage → USDC mint et
 * Returns: { mintTxHash }
 */
async function cctpMint({ agent, toChain, message, attestation }) {
  const dstCfg     = CCTP_CHAINS[toChain];
  if (!dstCfg) throw new Error(`CCTP desteklemiyor: ${toChain}`);

  const signer      = getAgentSigner(agent, toChain);
  const transmitter = new ethers.Contract(dstCfg.msgTransmitter, MSG_TRANSMITTER_ABI, signer);
  const estimatedGas = await transmitter.receiveMessage.estimateGas(message, attestation).catch(() => DEFAULT_CCTP_MINT_GAS_ESTIMATE);
  const gasLimit = estimatedGas > 0n ? applyGasMargin(estimatedGas, 12500n) : CCTP_MINT_GAS_LIMIT;

  console.log(`[CCTP-MINT] receiveMessage on ${toChain}`);
  const { receipt } = await sendProtectedContractTx({
    contract: transmitter,
    methodName: 'receiveMessage',
    args: [message, attestation],
    txOptions: await buildTxOverrides(toChain, gasLimit),
    chainName: toChain,
    ...getAgentIdentity(agent, signer.address),
    operation: 'cctp_mint',
    replayFingerprint: [toChain, ethers.keccak256(message)],
  });
  console.log(`[CCTP-MINT] ✓ mintTxHash=${receipt.hash}`);
  return { mintTxHash: receipt.hash };
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENTIC BRIDGE — tüm 4 adımı arka planda sırayla çalıştır
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Limit dahilindeyse ajan tüm köprü akışını otomatik tamamlar.
 * onStep callback → her adımda DB güncelleme için çağrılır.
 */
async function agentBridgeFull({ agent, fromChain, toChain, amountUsdc, onStep }) {
  const report = async (step, data) => {
    console.log(`[AGENTIC-BRIDGE] step=${step}`, data);
    if (onStep) {
      await Promise.resolve(onStep(step, data)).catch(e => console.error('[BRIDGE STEP CB]', e.message));
    }
  };

  // 1. Approve
  await report('approving', {});
  const { approveTxHash } = await cctpApprove({ agent, fromChain, amountUsdc });
  await report('approved', { approveTxHash });

  // 2. Burn
  await report('burning', {});
  const { burnTxHash, message, messageHash } = await cctpBurn({ agent, fromChain, toChain, amountUsdc });
  await report('burned', { burnTxHash, messageHash });

  // 3. Attestation
  await report('attesting', { messageHash });
  const { attestation, message: attestedMessage } = await cctpPollAttestation({ fromChain, toChain, sourceTxHash: burnTxHash, messageHash });
  await report('attested', {});

  // 4. Mint
  await report('minting', {});
  const { mintTxHash } = await cctpMint({ agent, toChain, message: attestedMessage || message, attestation });
  await report('complete', { mintTxHash });

  return { approveTxHash, burnTxHash, messageHash, mintTxHash };
}

// ─────────────────────────────────────────────────────────────────────────────
// YARDIMCI FONKSİYONLAR
// ─────────────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

function readMessageDestinationDomain(message) {
  const value = message?.destinationDomain ?? message?.destination_domain ?? message?.destination_domain_id;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readAttestationValue(message) {
  const value =
    message?.attestation
    ?? message?.signedAttestation
    ?? message?.signed_attestation
    ?? message?.attestationSignature;
  return typeof value === 'string' ? value : '';
}

function isAttestationReady(message) {
  const attestation = readAttestationValue(message);
  if (attestation.startsWith('0x') && attestation.length > 130 && attestation.toLowerCase() !== 'pending') {
    return true;
  }
  const statusRaw = message?.attestationStatus ?? message?.attestation_status;
  const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : '';
  return ['complete', 'ready', 'available', 'success'].includes(status);
}

function isIrisStatusReady(message) {
  const status = typeof message?.status === 'string' ? message.status.toLowerCase() : '';
  return ['complete', 'attested', 'ready_to_mint', 'ready'].includes(status);
}

function hasDestinationMintTx(message) {
  const destinationTxHash =
    message?.destinationTxHash
    ?? message?.destination_tx_hash
    ?? message?.destinationTransactionHash
    ?? message?.mintTxHash
    ?? message?.eventLog?.transactionHash;
  return typeof destinationTxHash === 'string' && destinationTxHash.startsWith('0x') && destinationTxHash.length > 10;
}

function isIrisMessageMintReady(message, expectedDestinationDomain) {
  const destinationDomain = readMessageDestinationDomain(message);
  const destinationMatches = expectedDestinationDomain == null || destinationDomain == null || destinationDomain === expectedDestinationDomain;
  const alreadyMinted = hasDestinationMintTx(message);
  return (isIrisStatusReady(message) || isAttestationReady(message)) && destinationMatches && !alreadyMinted;
}

// ─────────────────────────────────────────────────────────────────────────────
// NANO PAYMENT
// ─────────────────────────────────────────────────────────────────────────────
async function nanoPayment({ agent, toAddress, amountUsdc, token = 'USDC' }) {
  if (amountUsdc >= NANO_THRESHOLD_USDC) {
    throw new Error(`nanoPayment requires amount < ${NANO_THRESHOLD_USDC} USDC (got ${amountUsdc})`);
  }

  if (token === 'USDC') {
    console.log(`[AGENT-NANO] ${agent.wallet_address} → ${toAddress}: ${amountUsdc} ${token} via Gateway`);
    const result = await gatewayBuyerService.executeGatewayTransfer({
      agent,
      amountUsdc,
      recipient: toAddress,
      fromChain: 'Arc Testnet',
      toChain: 'Arc Testnet',
      replayFingerprint: ['gateway_nano_payment', toAddress, String(amountUsdc), token],
    });
    console.log(`[AGENT-NANO] ✓ ${result.transferResult?.mintTxHash || 'gateway-transfer-confirmed'}`);
    return result.transferResult?.mintTxHash || null;
  }

  const signer    = getAgentSigner(agent);
  const tokenAddr = resolveTokenAddress(token);
  const contract  = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const amount    = ethers.parseUnits(String(amountUsdc), 6);
  console.log(`[AGENT-NANO] ${agent.wallet_address} → ${toAddress}: ${amountUsdc} ${token}`);
  const { receipt } = await sendProtectedContractTx({
    contract,
    methodName: 'transfer',
    args: [toAddress, amount],
    txOptions: await buildTxOverrides('Arc Testnet'),
    chainName: 'Arc Testnet',
    ...getAgentIdentity(agent, signer.address),
    operation: 'agent_nano_transfer',
    replayFingerprint: [toAddress, amount.toString(), token],
  });
  console.log(`[AGENT-NANO] ✓ ${receipt.hash}`);
  return receipt.hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENTIC SWAP (USDC / EURC / cirBTC on Arc Testnet)
// ─────────────────────────────────────────────────────────────────────────────
async function agentSwap({ agent, fromToken, toToken, amountIn, slippagePct = 0.5, routeMode = 'auto', requireFallbackConfirmation = false }) {
  const normalizedRouteMode = normalizeSwapRouteMode(routeMode);
  const strategy = getSwapRouteStrategy({ fromToken, toToken, routeMode });
  const cirbtcSizeGuard = getCirbtcSwapSizeGuard({ fromToken, toToken, amountIn });
  if (cirbtcSizeGuard) {
    const error = new Error(cirbtcSizeGuard.userMessage);
    error.code = cirbtcSizeGuard.code;
    error.userMessage = cirbtcSizeGuard.userMessage;
    error.recommendedMaxAmountIn = cirbtcSizeGuard.maxAmountIn;
    throw error;
  }

  if (normalizedRouteMode === 'fallback_only') {
    if (!strategy.fallbackAvailable) {
      throw new Error(strategy.routeReason || 'This pair does not allow backup pool execution on this deployment.');
    }
    return executeDirectSwapFallback({ agent, fromToken, toToken, amountIn, slippagePct, strategy });
  }

  if (!isSwapConfigured()) {
    if (normalizedRouteMode === 'primary_only' || !strategy.fallbackAvailable) {
      throw new Error(strategy.routeReason || 'This route needs the live app swap path on this deployment.');
    }

    return executeDirectSwapFallback({ agent, fromToken, toToken, amountIn, slippagePct, strategy });
  }

  const adapter = createArcSwapAdapter(getAgentPrivateKey(agent));
  let quote = null;
  try {
    quote = await estimateArcSwap({
      adapter,
      fromToken,
      toToken,
      amountIn,
      slippagePct,
    });
  } catch (error) {
    const fallbackPool = getDirectSwapFallbackPool(fromToken, toToken);
    if (normalizedRouteMode === 'primary_only' || !strategy.fallbackAvailable || !fallbackPool?.address) {
      throw error;
    }

    console.warn('[AGENT-SWAP:PRIMARY-QUOTE]', error.message);
    return executeDirectSwapFallback({ agent, fromToken, toToken, amountIn, slippagePct, strategy });
  }

  let result = null;
  try {
    result = await runProtectedWrite({
      chainName: 'Arc Testnet',
      ...getAgentIdentity(agent),
      operation: 'swap_kit_swap',
      replayFingerprint: [fromToken, toToken, String(amountIn), String(slippagePct)],
    }, () => SWAP_KIT.swap({
      from: { adapter, chain: ARC_SWAP_CHAIN },
      tokenIn: fromToken,
      tokenOut: toToken,
      amountIn: String(amountIn),
      config: {
        kitKey: getSwapKitKey(),
        slippageBps: toSlippageBps(slippagePct),
        stopLimit: quote.stopLimit.amount,
      },
    }));
  } catch (error) {
    const fallbackPool = getDirectSwapFallbackPool(fromToken, toToken);
    if (
      normalizedRouteMode === 'primary_only'
      || !strategy.fallbackAvailable
      || !fallbackPool?.address
      || !isPrimarySwapFallbackCandidate(error)
    ) {
      throw error;
    }

    console.warn('[AGENT-SWAP:PRIMARY-EXECUTE]', error.message);
    if (!requireFallbackConfirmation) {
      return executeDirectSwapFallback({ agent, fromToken, toToken, amountIn, slippagePct, strategy });
    }

    const fallbackConfirmationError = await createSwapFallbackConfirmationError({
      fromToken,
      toToken,
      amountIn,
      primaryAmountOut: quote?.estimatedOutput?.amount || null,
      error,
    });
    throw fallbackConfirmationError || error;
  }

  const amountOut = result.amountOut || quote.estimatedOutput.amount;
  console.log(`[AGENT-SWAP] ✓ ${result.txHash} | out: ${amountOut} ${toToken}`);
  return {
    hash: result.txHash,
    amountOut,
    ...strategy,
    executionRail: 'swap_kit',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE (okuma, tx yok)
// ─────────────────────────────────────────────────────────────────────────────
async function getSwapQuoteResult({ fromToken, toToken, amountIn, routeMode = 'auto' }) {
  const normalizedRouteMode = normalizeSwapRouteMode(routeMode);
  const strategy = getSwapRouteStrategy({ fromToken, toToken, routeMode: normalizedRouteMode });
  const cirbtcSizeGuard = getCirbtcSwapSizeGuard({ fromToken, toToken, amountIn });

  if (cirbtcSizeGuard) {
    return {
      amountOut: null,
      quoteError: cirbtcSizeGuard.userMessage,
      routeStrategy: 'size_limited',
      routeReason: cirbtcSizeGuard.userMessage,
      fallbackAvailable: false,
      recommendedMaxAmountIn: cirbtcSizeGuard.maxAmountIn,
      recommendedMaxAmountToken: cirbtcSizeGuard.fromToken,
    };
  }

  if (normalizedRouteMode === 'fallback_only') {
    if (!strategy.fallbackAvailable) {
      return {
        amountOut: null,
        quoteError: strategy.routeReason || 'This pair does not allow backup pool quotes on this deployment.',
        ...strategy,
      };
    }
    return getDirectSwapFallbackQuote({ fromToken, toToken, amountIn, routeMode: normalizedRouteMode });
  }

  if (!isSwapConfigured()) {
    if (normalizedRouteMode === 'primary_only' || !strategy.fallbackAvailable) {
      return {
        amountOut: null,
        quoteError: strategy.routeReason || 'This route needs the live app swap path on this deployment.',
        ...strategy,
      };
    }

    return getDirectSwapFallbackQuote({ fromToken, toToken, amountIn });
  }

  try {
    const adapter = createArcSwapAdapter(SWAP_QUOTE_PRIVATE_KEY);
    const quote = await estimateArcSwap({
      adapter,
      fromToken,
      toToken,
      amountIn,
      slippagePct: 0.5,
    });
    const fallbackQuote = strategy.fallbackAvailable
      ? buildSwapQuotePreview(await getDirectSwapFallbackQuote({
        fromToken,
        toToken,
        amountIn,
        routeMode: 'fallback_only',
      }).catch(() => null))
      : null;
    return {
      amountOut: quote.estimatedOutput.amount,
      quoteError: null,
      ...strategy,
      executionRail: 'swap_kit',
      fallbackQuote,
    };
  } catch (error) {
    const rawErrorMessage = String(error?.message || error?.userMessage || '').trim();
    const expectedQuoteMiss = /no route available|invalid api key format/i.test(rawErrorMessage);
    if (!expectedQuoteMiss) {
      console.warn('[AGENT-SWAP-QUOTE]', error.message);
    }
    const normalizedQuoteError = normalizeSwapQuoteError(error);
    const cirbtcCircleOnlyUnavailableMessage = isCirbtcPair(fromToken, toToken)
      ? 'The Circle route is currently unavailable for this cirBTC pair. Direct Arc fallback is disabled.'
      : normalizedQuoteError;
    if (normalizedRouteMode === 'primary_only' || !strategy.fallbackAvailable) {
      return {
        amountOut: null,
        quoteError: !strategy.fallbackAvailable ? cirbtcCircleOnlyUnavailableMessage : normalizedQuoteError,
        ...strategy,
      };
    }

    const directFallback = await getDirectSwapFallbackQuote({ fromToken, toToken, amountIn, routeMode: 'fallback_only' });
    if (directFallback.amountOut !== null) {
      return directFallback;
    }
    return {
      amountOut: null,
      quoteError: normalizedQuoteError,
      ...strategy,
    };
  }
}

async function getSwapQuote(params) {
  const { amountOut } = await getSwapQuoteResult(params);
  return amountOut;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENTIC SEND
// ─────────────────────────────────────────────────────────────────────────────
async function agentSend({ agent, toAddress, amountUsdc, token = 'USDC' }) {
  const signer    = getAgentSigner(agent);
  const tokenAddr = resolveTokenAddress(token);
  const contract  = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const amount    = ethers.parseUnits(String(amountUsdc), 6);
  console.log(`[AGENT-SEND] ${agent.wallet_address} → ${toAddress}: ${amountUsdc} ${token}`);
  const { receipt } = await sendProtectedContractTx({
    contract,
    methodName: 'transfer',
    args: [toAddress, amount],
    txOptions: await buildTxOverrides('Arc Testnet'),
    chainName: 'Arc Testnet',
    ...getAgentIdentity(agent, signer.address),
    operation: 'agent_send',
    replayFingerprint: [toAddress, amount.toString(), token],
  });
  console.log(`[AGENT-SEND] ✓ ${receipt.hash}`);
  return receipt.hash;
}

module.exports = {
  NANO_THRESHOLD_USDC,
  CCTP_CHAINS,
  // CCTP adım adım
  cctpApprove,
  cctpBurn,
  cctpPollAttestation,
  cctpMint,
  // Agentic tam köprü
  agentBridgeFull,
  // Diğerleri
  nanoPayment,
  agentSwap,
  agentSend,
  getSwapQuote,
  getSwapQuoteResult,
  getExternalSwapQuoteResult,
  getSwapRouteStrategy,
  isSwapConfigured,
  getAgentSigner,
  getCurrentBlockNumber,
  getNativeBalance,
  findRecentIncomingNativeTransfer,
  getRequiredMintGasWei,
  estimateDestinationMintGasWei,
  getRecommendedNativeTopUpWei,
  bridgeNativeGasTopUp,
  getNativeTopUpRoute,
  ensureDestinationGasForAutoBridge,
};
