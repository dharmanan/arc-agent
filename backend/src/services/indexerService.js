'use strict';
/**
 * Blockchain Event Indexer
 *
 * Primary:  WebSocket event subscription (push-based)
 * Fallback: HTTP polling every 60s to catch any missed blocks
 */
const { ethers } = require('ethers');
const db         = require('../db');
const agentQueue = require('../queue/agentQueue');

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const UNISWAP_PAIR_ABI = [
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
];

function toWss(url) {
  if (!url) return null;
  return url.replace(/^https?:\/\//, 'wss://');
}

const WATCHED_CONTRACTS = {
  'Arc Testnet': {
    usdc: process.env.USDC_ADDRESS_ARC,
    rpc:  toWss(process.env.ARC_TESTNET_RPC),
    rpcHttp: process.env.ARC_TESTNET_RPC,
  },
  'Sepolia': {
    usdc: process.env.USDC_ADDRESS_SEPOLIA,
    rpc:  toWss(process.env.SEPOLIA_RPC),
    rpcHttp: process.env.SEPOLIA_RPC,
  },
};

const activeProviders = new Map();

// ── Core handler (shared between WS events and polling) ───────────────────────
async function handleTransfer(chain, config, from, to, amountUsdc, txHash, blockNumber) {
  // Deduplicate by tx_hash — skip if already recorded
  if (txHash) {
    const { rows: existing } = await db.query(
      `SELECT id FROM chain_events WHERE tx_hash = $1 AND event_type = 'Transfer'`,
      [txHash],
    );
    if (existing.length > 0) return; // already processed
  }

  const { rows: [row] } = await db.query(
    `INSERT INTO chain_events (event_type, chain, contract_address, block_number, tx_hash, data)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    ['Transfer', chain, config.usdc,
     blockNumber, txHash,
     JSON.stringify({ from, to, amountUsdc })],
  );

  const { rows: agents } = await db.query(
    `SELECT id, is_smart_mode, llm_model FROM agents WHERE LOWER(wallet_address) = LOWER($1) AND status != 'locked'`,
    [to],
  );
  for (const agent of agents) {
    await agentQueue.add('INCOMING_TRANSFER', {
      eventId: row.id, agentId: agent.id, chain, amountUsdc, from,
      isSmartMode: agent.is_smart_mode,
    });
    console.log(`[INDEXER] ${chain} → agent ${agent.id}: ${amountUsdc} USDC from ${from.slice(0, 10)}…`);
  }
}

async function subscribeToChain(chain, config) {
  if (!config.rpc || !config.usdc) {
    console.warn(`[INDEXER] ${chain}: missing RPC or USDC address — skipping`);
    return;
  }

  let provider;
  try {
    provider = new ethers.WebSocketProvider(config.rpc);
    activeProviders.set(chain, provider);
  } catch (err) {
    console.error(`[INDEXER] ${chain}: WebSocket provider failed (${err.message}), falling back to polling`);
    return;
  }

  const usdcContract = new ethers.Contract(config.usdc, ERC20_ABI, provider);

  usdcContract.on('Transfer', async (from, to, value, event) => {
    const amountUsdc = parseFloat(ethers.formatUnits(value, 6));
    console.log(`[INDEXER] ${chain} Transfer: ${amountUsdc} USDC → ${to}`);
    try {
      await handleTransfer(chain, config, from, to, amountUsdc, event.log.transactionHash, event.log.blockNumber);
    } catch (err) {
      console.error('[INDEXER] WS handler error:', err.message);
    }
  });

  provider.websocket?.on?.('close', () => {
    console.warn(`[INDEXER] ${chain} WebSocket closed — reconnecting in 5s`);
    activeProviders.delete(chain);
    setTimeout(() => subscribeToChain(chain, config), 5000);
  });

  console.log(`[INDEXER] Subscribed to ${chain} events`);
}

// ── HTTP polling fallback — scans last ~10 blocks every 60s ──────────────────
const lastPolledBlock = new Map();

async function pollChain(chain, config) {
  if (!config.rpcHttp || !config.usdc) return;
  try {
    const httpProvider = new ethers.JsonRpcProvider(config.rpcHttp);
    const usdcContract = new ethers.Contract(config.usdc, ERC20_ABI, httpProvider);

    const latest = await httpProvider.getBlockNumber();
    const fromBlock = (lastPolledBlock.get(chain) ?? latest - 10) + 1;
    if (fromBlock > latest) return;

    const filter = usdcContract.filters.Transfer();
    const logs = await usdcContract.queryFilter(filter, fromBlock, latest);

    for (const log of logs) {
      const [from, to, value] = log.args;
      const amountUsdc = parseFloat(ethers.formatUnits(value, 6));
      await handleTransfer(chain, config, from, to, amountUsdc, log.transactionHash, log.blockNumber);
    }

    lastPolledBlock.set(chain, latest);
    if (logs.length > 0) {
      console.log(`[INDEXER] ${chain} poll blocks ${fromBlock}–${latest}: ${logs.length} transfers`);
    }
  } catch (err) {
    console.error(`[INDEXER] ${chain} poll error:`, err.message);
  }
}

async function startIndexer() {
  for (const [chain, config] of Object.entries(WATCHED_CONTRACTS)) {
    await subscribeToChain(chain, config).catch(err =>
      console.error(`[INDEXER] ${chain} startup failed:`, err.message),
    );
  }

  // Polling fallback — every 60s, catches any transfers the WS missed
  setInterval(async () => {
    for (const [chain, config] of Object.entries(WATCHED_CONTRACTS)) {
      await pollChain(chain, config).catch(() => {});
    }
  }, 60_000);

  // Initial poll on startup to catch transfers since last restart
  setTimeout(async () => {
    for (const [chain, config] of Object.entries(WATCHED_CONTRACTS)) {
      await pollChain(chain, config).catch(() => {});
    }
  }, 5_000);
}

module.exports = { startIndexer };
