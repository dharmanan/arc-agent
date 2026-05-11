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
    rpc:           'https://sepolia.optimism.io',
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
const ARC_SWAP_CHAIN = getChainByEnum(SwapChain.Arc_Testnet);
const SWAP_KIT = new SwapKit();
const SWAP_QUOTE_PRIVATE_KEY = `0x${'11'.repeat(32)}`;

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

function getSwapKitKey() {
  return process.env.CIRCLE_KIT_KEY || process.env.KIT_KEY || '';
}

function isSwapConfigured() {
  return Boolean(getSwapKitKey());
}

function toSlippageBps(slippagePct = 0.5) {
  const normalized = Number(slippagePct);
  if (!Number.isFinite(normalized) || normalized <= 0) return 50;
  return Math.max(1, Math.round(normalized * 100));
}

function createArcSwapAdapter(privateKey) {
  return createEthersAdapterFromPrivateKey({
    privateKey,
    getProvider: () => getProvider('Arc Testnet'),
  });
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
    const tx = await portal.depositTransaction(
      toAddress,
      value,
      BigInt(route.minGasLimit),
      false,
      '0x',
      {
        value,
        ...(await buildTxOverrides(route.fromChain, 250_000n)),
      },
    );
    const receipt = await tx.wait(1);
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
    const tx = await inbox.depositEth({
      value,
      ...(await buildTxOverrides(route.fromChain, 200_000n)),
    });
    const receipt = await tx.wait(1);
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
  const tx      = await usdc.approve(cfg.tokenMessenger, ethers.MaxUint256, await buildTxOverrides(fromChain, 80_000n));
  const receipt = await tx.wait(1);
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

  // mintRecipient: 32 byte'a padlenmiş ajan adresi
  const mintRecipient = ethers.zeroPadValue(signer.address, 32);

  console.log(`[CCTP-BURN] ${amountUsdc} USDC: ${fromChain}(domain ${srcCfg.domain}) → ${toChain}(domain ${dstCfg.domain})`);

  const tx = await messenger.depositForBurn(
    amount,
    dstCfg.domain,
    mintRecipient,
    srcCfg.usdcAddress,
    ethers.ZeroHash,   // destinationCaller: any caller can relay
    0n,               // maxFee: no fee on testnet
    1000,             // minFinalityThreshold: standard finality
    await buildTxOverrides(fromChain, 300_000n),
  );
  const receipt = await tx.wait(1);

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
async function cctpPollAttestation({ fromChain, toChain, sourceTxHash, messageHash, maxWaitMs = 10 * 60 * 1000 }) {
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

  throw new Error('Attestation zaman aşımına uğradı (10 dakika)');
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
  const tx      = await transmitter.receiveMessage(message, attestation, await buildTxOverrides(toChain, gasLimit));
  const receipt = await tx.wait(1);
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
    if (onStep) await onStep(step, data).catch(e => console.error('[BRIDGE STEP CB]', e.message));
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
  const signer    = getAgentSigner(agent);
  const tokenAddr = resolveTokenAddress(token);
  const contract  = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const amount    = ethers.parseUnits(String(amountUsdc), 6);
  console.log(`[AGENT-NANO] ${agent.wallet_address} → ${toAddress}: ${amountUsdc} ${token}`);
  const tx      = await contract.transfer(toAddress, amount, { gasLimit: 100_000 });
  const receipt = await tx.wait(1);
  console.log(`[AGENT-NANO] ✓ ${receipt.hash}`);
  return receipt.hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENTIC SWAP (USDC ↔ EURC on Arc Testnet)
// ─────────────────────────────────────────────────────────────────────────────
async function agentSwap({ agent, fromToken, toToken, amountIn, slippagePct = 0.5 }) {
  if (!isSwapConfigured()) throw new Error('CIRCLE_KIT_KEY is not configured');

  const adapter = createArcSwapAdapter(getAgentPrivateKey(agent));
  const quote = await estimateArcSwap({
    adapter,
    fromToken,
    toToken,
    amountIn,
    slippagePct,
  });

  const result = await SWAP_KIT.swap({
    from: { adapter, chain: ARC_SWAP_CHAIN },
    tokenIn: fromToken,
    tokenOut: toToken,
    amountIn: String(amountIn),
    config: {
      kitKey: getSwapKitKey(),
      slippageBps: toSlippageBps(slippagePct),
      stopLimit: quote.stopLimit.amount,
    },
  });

  const amountOut = result.amountOut || quote.estimatedOutput.amount;
  console.log(`[AGENT-SWAP] ✓ ${result.txHash} | out: ${amountOut} ${toToken}`);
  return { hash: result.txHash, amountOut };
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE (okuma, tx yok)
// ─────────────────────────────────────────────────────────────────────────────
async function getSwapQuote({ fromToken, toToken, amountIn }) {
  if (!isSwapConfigured()) return null;

  try {
    const adapter = createArcSwapAdapter(SWAP_QUOTE_PRIVATE_KEY);
    const quote = await estimateArcSwap({
      adapter,
      fromToken,
      toToken,
      amountIn,
      slippagePct: 0.5,
    });
    return quote.estimatedOutput.amount;
  } catch (error) {
    console.warn('[AGENT-SWAP-QUOTE]', error.message);
    return null;
  }
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
  const tx      = await contract.transfer(toAddress, amount, { gasLimit: 100_000, maxFeePerGas: AGENT_MAX_GAS });
  const receipt = await tx.wait(1);
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
