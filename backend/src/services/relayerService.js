'use strict';
/**
 * Transaction Relayer
 *
 * Builds and broadcasts transactions via the agent's AgentWallet smart contract.
 * The relayer is a hot wallet with gas only — it NEVER holds user funds.
 * Actual USDC flows through the user's AgentWallet contract, enforced on-chain
 * by session key limits.
 */
const { ethers } = require('ethers');

// ABI snippets for the contracts we interact with
const AGENT_WALLET_ABI = require('../contracts/AgentWallet.abi.json');
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// ── Chain configuration ───────────────────────────────────────────────────────
const CHAIN_CONFIG = {
  'Arc Testnet': { rpc: process.env.ARC_TESTNET_RPC, chainId: 5042002 },
  'Sepolia':     { rpc: process.env.SEPOLIA_RPC,     chainId: 11155111 },
  'Base':        { rpc: process.env.BASE_RPC,         chainId: 8453 },
  'Optimism':    { rpc: process.env.OPTIMISM_RPC,     chainId: 10 },
  'Arbitrum':    { rpc: process.env.ARBITRUM_RPC,     chainId: 42161 },
};

const USDC_ADDRESSES = {
  'Arc Testnet': process.env.USDC_ADDRESS_ARC,
  'Sepolia':     process.env.USDC_ADDRESS_SEPOLIA,
  'Base':        process.env.USDC_ADDRESS_BASE,
};

const UNISWAP_V2_ROUTER = '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008'; // Sepolia

// ── Provider / signer factory ─────────────────────────────────────────────────
const providers = {};
function getProvider(chain) {
  if (!providers[chain]) {
    const cfg = CHAIN_CONFIG[chain];
    if (!cfg) throw new Error(`Unknown chain: ${chain}`);
    providers[chain] = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
  }
  return providers[chain];
}

function getRelayerSigner(chain) {
  if (!process.env.RELAYER_PRIVATE_KEY) throw new Error('RELAYER_PRIVATE_KEY not configured');
  return new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, getProvider(chain));
}

// ── Send USDC ─────────────────────────────────────────────────────────────────
async function relaySend({ agent, toAddress, amountUsdc, chain }) {
  if (!agent.walletAddress) throw new Error('Agent has no deployed wallet address');

  const signer  = getRelayerSigner(chain);
  const wallet  = new ethers.Contract(agent.walletAddress, AGENT_WALLET_ABI, signer);
  const usdc    = USDC_ADDRESSES[chain];
  const amount  = ethers.parseUnits(String(amountUsdc), 6); // USDC = 6 decimals

  // Encode ERC-20 transferFrom call
  const erc20Interface = new ethers.Interface(ERC20_ABI);
  const data = erc20Interface.encodeFunctionData('transfer', [toAddress, amount]);

  const tx = await wallet.execute(usdc, 0n, data, amount, { gasLimit: 200_000 });
  const receipt = await tx.wait(1);
  console.log(`[RELAYER] send ${amountUsdc} USDC on ${chain}: ${receipt.hash}`);
  return receipt.hash;
}

// ── Bridge via Circle Bridge Kit ──────────────────────────────────────────────
async function relayBridge({ agent, fromChain, toChain, amountUsdc, txId }) {
  // Circle CCTP (Cross-Chain Transfer Protocol) integration point.
  // In production: call Circle's attestation API, then relay on destination.
  // Here we simulate the flow and emit a pending bridge tx.
  console.log(`[RELAYER] bridge ${amountUsdc} USDC: ${fromChain} → ${toChain} (txId: ${txId})`);

  // Step 1: Approve USDC to TokenMessenger
  // Step 2: Call depositForBurn on TokenMessenger
  // Step 3: Poll Circle attestation API
  // Step 4: Call receiveMessage on destination MessageTransmitter
  // → Full implementation requires Circle CCTP SDK and cross-chain relay logic

  // Simulate bridge delay for testnet demo
  await new Promise(r => setTimeout(r, 2000));
  // Return null — no real on-chain hash yet (CCTP not fully integrated)
  return null;
}

// ── Swap via Uniswap V2 ───────────────────────────────────────────────────────
async function relaySwap({ agent, fromToken, toToken, amountIn, slippage, chain }) {
  if (!agent.walletAddress) throw new Error('Agent has no deployed wallet address');

  const signer = getRelayerSigner(chain);
  const wallet = new ethers.Contract(agent.walletAddress, AGENT_WALLET_ABI, signer);

  const ROUTER_ABI = [
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)',
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
    'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
  ];

  const WETH  = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9'; // Sepolia WETH
  const usdc  = USDC_ADDRESSES[chain] || USDC_ADDRESSES['Sepolia'];
  const path  = fromToken === 'ETH' ? [WETH, usdc] : [usdc, WETH];

  const parsedIn = fromToken === 'ETH'
    ? ethers.parseEther(String(amountIn))
    : ethers.parseUnits(String(amountIn), 6);

  const slippageBps = Math.round((slippage || 0.5) * 100); // 0.5% → 50 bps
  const deadline    = Math.floor(Date.now() / 1000) + 600;

  const routerInterface = new ethers.Interface(ROUTER_ABI);
  let data;
  if (fromToken === 'ETH') {
    // ETH → USDC
    data = routerInterface.encodeFunctionData('swapExactETHForTokens', [
      0n, path, agent.walletAddress, BigInt(deadline),
    ]);
    const tx = await wallet.execute(UNISWAP_V2_ROUTER, parsedIn, data, 0n, { gasLimit: 300_000 });
    const receipt = await tx.wait(1);
    console.log(`[RELAYER] swap ${amountIn} ETH→USDC: ${receipt.hash}`);
    return receipt.hash;
  } else {
    // USDC → ETH: first approve router, then swap
    const approveData = new ethers.Interface(ERC20_ABI)
      .encodeFunctionData('approve', [UNISWAP_V2_ROUTER, parsedIn]);
    const approveTx = await wallet.execute(usdc, 0n, approveData, 0n, { gasLimit: 100_000 });
    await approveTx.wait(1);

    data = routerInterface.encodeFunctionData('swapExactTokensForETH', [
      parsedIn, 0n, path, agent.walletAddress, BigInt(deadline),
    ]);
    const tx = await wallet.execute(UNISWAP_V2_ROUTER, 0n, data, parsedIn, { gasLimit: 300_000 });
    const receipt = await tx.wait(1);
    console.log(`[RELAYER] swap ${amountIn} USDC→ETH: ${receipt.hash}`);
    return receipt.hash;
  }
}

// ── Deploy AgentWallet via Factory ────────────────────────────────────────────
const FACTORY_ABI = [
  'function createWallet() external returns (address wallet)',
  'function walletOf(address owner) external view returns (address)',
  'event WalletCreated(address indexed owner, address indexed wallet, uint256 timestamp)',
];

async function deployAgentWallet(ownerAddress, chain = 'Sepolia') {
  const factoryAddress = process.env.FACTORY_ADDRESS;
  if (!factoryAddress) throw new Error('FACTORY_ADDRESS not set in .env — run deploy first');

  const signer  = getRelayerSigner(chain);
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, signer);

  // Check if owner already has a wallet
  const existing = await factory.walletOf(ownerAddress);
  if (existing !== ethers.ZeroAddress) {
    console.log(`[RELAYER] wallet already exists for ${ownerAddress}: ${existing}`);
    return existing;
  }

  console.log(`[RELAYER] deploying AgentWallet for ${ownerAddress} on ${chain}...`);
  const tx = await factory.createWallet({ gasLimit: 500_000 });
  const receipt = await tx.wait(1);

  // Extract wallet address from WalletCreated event
  const iface = new ethers.Interface(FACTORY_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'WalletCreated') {
        console.log(`[RELAYER] AgentWallet deployed: ${parsed.args.wallet}`);
        return parsed.args.wallet;
      }
    } catch (_) {}
  }

  // Fallback: read from mapping
  const walletAddr = await factory.walletOf(ownerAddress);
  if (walletAddr === ethers.ZeroAddress) throw new Error('Wallet deployment failed');
  return walletAddr;
}

module.exports = { relaySend, relayBridge, relaySwap, deployAgentWallet };
