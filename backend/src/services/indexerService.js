'use strict';
/**
 * Blockchain Event Indexer
 *
 * Listens to on-chain events (Transfer, Swap) using ethers.js WebSocket providers.
 * On event → inserts into chain_events table → enqueues Bull job for agent processing.
 *
 * Design: PUSH-based (event-driven), not polling.
 * Agent brains wake up only when something actually happens.
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

// Convert HTTP RPC to WSS for event subscriptions
function toWss(url) {
  if (!url) return null;
  return url.replace(/^https?:\/\//, 'wss://');
}

const WATCHED_CONTRACTS = {
  'Arc Testnet': {
    usdc: process.env.USDC_ADDRESS_ARC,
    rpc:  toWss(process.env.ARC_TESTNET_RPC),
  },
  'Sepolia': {
    usdc: process.env.USDC_ADDRESS_SEPOLIA,
    rpc:  toWss(process.env.SEPOLIA_RPC),
  },
};

// Active providers (kept alive for reconnects)
const activeProviders = new Map();

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

  // Listen for USDC incoming transfers → wake up receiving agents
  const usdcContract = new ethers.Contract(config.usdc, ERC20_ABI, provider);

  usdcContract.on('Transfer', async (from, to, value, event) => {
    const amountUsdc = parseFloat(ethers.formatUnits(value, 6));
    console.log(`[INDEXER] ${chain} Transfer: ${amountUsdc} USDC → ${to}`);

    try {
      const { rows: [row] } = await db.query(
        `INSERT INTO chain_events (event_type, chain, contract_address, block_number, tx_hash, data)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        ['Transfer', chain, config.usdc,
         event.log.blockNumber, event.log.transactionHash,
         JSON.stringify({ from, to, amountUsdc })],
      );

      // Find agents whose wallet_address matches `to` and queue a job
      const { rows: agents } = await db.query(
        `SELECT id, is_smart_mode, llm_model FROM agents WHERE LOWER(wallet_address) = LOWER($1) AND status != 'locked'`,
        [to],
      );
      for (const agent of agents) {
        await agentQueue.add('INCOMING_TRANSFER', {
          eventId: row.id, agentId: agent.id, chain, amountUsdc, from,
          isSmartMode: agent.is_smart_mode,
        });
      }
    } catch (err) {
      console.error('[INDEXER] DB insert error:', err.message);
    }
  });

  // Reconnect on close
  provider.websocket?.on?.('close', () => {
    console.warn(`[INDEXER] ${chain} WebSocket closed — reconnecting in 5s`);
    activeProviders.delete(chain);
    setTimeout(() => subscribeToChain(chain, config), 5000);
  });

  console.log(`[INDEXER] Subscribed to ${chain} events`);
}

async function startIndexer() {
  for (const [chain, config] of Object.entries(WATCHED_CONTRACTS)) {
    await subscribeToChain(chain, config).catch(err =>
      console.error(`[INDEXER] ${chain} startup failed:`, err.message),
    );
  }
}

module.exports = { startIndexer };
