'use strict';
/**
 * Blockchain Event Indexer
 *
 * Polls recent blocks over HTTP and only scans transfers sent to active agent
 * wallets. This avoids subscribing to the full chain firehose while still
 * backfilling missed transfers after restarts.
 */
const { ethers } = require('ethers');
const db         = require('../db');
const oracle     = require('./oracle');
const agentQueue = require('../queue/agentQueue');

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const TRANSFER_IFACE = new ethers.Interface(ERC20_ABI);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent('Transfer').topicHash;

const POLL_INTERVAL_MS        = 30_000;
const STARTUP_BACKFILL_BLOCKS = 300;
const BLOCK_CHUNK_SIZE        = 250;
const WALLET_CHUNK_SIZE       = 20;
const STALE_PENDING_EVENT_AGE_HOURS = parseInt(process.env.CHAIN_EVENTS_STALE_PENDING_HOURS || '48', 10);
const STALE_PENDING_RESTORE_BATCH_SIZE = parseInt(process.env.CHAIN_EVENTS_STALE_PENDING_RESTORE_BATCH_SIZE || '500', 10);
const STALE_PENDING_DELETE_BATCH_SIZE = parseInt(process.env.CHAIN_EVENTS_STALE_PENDING_DELETE_BATCH_SIZE || '10000', 10);
const STALE_PENDING_DELETE_MAX_BATCHES = parseInt(process.env.CHAIN_EVENTS_STALE_PENDING_DELETE_MAX_BATCHES || '120', 10);

const TOKEN_PRICE_SYMBOL_MAP = {
  CIRBTC: 'BTC',
};

const TOKEN_PRICE_FALLBACK_USD = {
  USDC: 1,
  EURC: 1.08,
};

const CHAIN_ENV_PREFIX = {
  'Arc Testnet': 'ARC_TESTNET',
  'Sepolia': 'SEPOLIA',
};

const WATCHED_CONTRACTS = {
  'Arc Testnet': {
    tokens: [
      { symbol: 'USDC', address: process.env.USDC_ADDRESS_ARC, decimals: 6 },
      { symbol: 'EURC', address: process.env.EURC_ADDRESS_ARC, decimals: 6 },
      { symbol: 'cirBTC', address: process.env.CIRBTC_ADDRESS_ARC, decimals: 8 },
    ],
    rpcHttp: process.env.ARC_TESTNET_INDEXER_RPC || process.env.ARC_TESTNET_RPC,
  },
  'Sepolia': {
    tokens: [
      { symbol: 'USDC', address: process.env.USDC_ADDRESS_SEPOLIA, decimals: 6 },
      { symbol: 'EURC', address: process.env.EURC_ADDRESS_SEPOLIA, decimals: 6 },
    ],
    rpcHttp: process.env.SEPOLIA_INDEXER_RPC || process.env.SEPOLIA_RPC,
  },
};

const httpProviders = new Map();
const lastPolledBlock = new Map();
const archiveBackfillSkippedChains = new Set();
const initialCursorLoadedChains = new Set();

let pollInFlight = false;
let lastWatcherCount = null;

function readPositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getHttpProvider(chain, rpcHttp) {
  let provider = httpProviders.get(chain);
  if (!provider) {
    provider = new ethers.JsonRpcProvider(rpcHttp);
    httpProviders.set(chain, provider);
  }
  return provider;
}

function chunk(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

function isArchiveAccessError(error) {
  const message = String(error?.message || error?.error?.message || '').toLowerCase();
  return message.includes('archive requests require');
}

function getChainEnvPrefix(chain) {
  return CHAIN_ENV_PREFIX[chain] || String(chain || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function readBackfillBlocks(chain) {
  const chainPrefix = getChainEnvPrefix(chain);
  const chainValue = Number.parseInt(process.env[`${chainPrefix}_INDEXER_BACKFILL_BLOCKS`] || '', 10);
  if (Number.isInteger(chainValue) && chainValue >= 0) return chainValue;

  const sharedValue = Number.parseInt(process.env.INDEXER_BACKFILL_BLOCKS || '', 10);
  if (Number.isInteger(sharedValue) && sharedValue >= 0) return sharedValue;

  return STARTUP_BACKFILL_BLOCKS;
}

function readPinnedStartBlock(chain) {
  const chainPrefix = getChainEnvPrefix(chain);
  const rawValue = process.env[`${chainPrefix}_INDEXER_START_BLOCK`] || process.env.INDEXER_START_BLOCK;
  const pinnedBlock = Number.parseInt(rawValue || '', 10);
  return Number.isInteger(pinnedBlock) && pinnedBlock >= 0 ? pinnedBlock : null;
}

async function loadInitialCursor(chain, latest) {
  if (initialCursorLoadedChains.has(chain)) return;

  const pinnedStartBlock = readPinnedStartBlock(chain);
  if (pinnedStartBlock != null) {
    lastPolledBlock.set(chain, Math.max(Math.min(pinnedStartBlock - 1, latest), -1));
    initialCursorLoadedChains.add(chain);
    return;
  }

  const { rows: [row] } = await db.query(
    `SELECT MAX(block_number)::bigint AS last_block
       FROM chain_events
      WHERE chain = $1`,
    [chain],
  );

  const persistedBlock = Number(row?.last_block);
  if (Number.isFinite(persistedBlock) && persistedBlock >= 0) {
    lastPolledBlock.set(chain, persistedBlock);
    initialCursorLoadedChains.add(chain);
    return;
  }

  const backfillBlocks = readBackfillBlocks(chain);
  lastPolledBlock.set(chain, Math.max(latest - backfillBlocks, -1));
  initialCursorLoadedChains.add(chain);
}

function normalizeWatchedTokenSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return 'USDC';
  if (normalized === 'CIRBTC') return 'cirBTC';
  return normalized;
}

function getPriceLookupSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  return TOKEN_PRICE_SYMBOL_MAP[normalized] || normalized;
}

function roundNumber(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const scale = 10 ** digits;
  return Math.round(numeric * scale) / scale;
}

async function getTokenUsdPrice(symbol) {
  const normalizedSymbol = normalizeWatchedTokenSymbol(symbol);
  const lookupSymbol = getPriceLookupSymbol(normalizedSymbol);

  try {
    const prices = await oracle.getMultipleTokenPrices([lookupSymbol]);
    const usdPrice = Number(prices?.[lookupSymbol]?.usdPrice);
    if (Number.isFinite(usdPrice) && usdPrice > 0) {
      return usdPrice;
    }
  } catch {
    // Fall through to the static fallback below.
  }

  return TOKEN_PRICE_FALLBACK_USD[String(normalizedSymbol).toUpperCase()] ?? null;
}

async function loadWatchedAgents() {
  const { rows } = await db.query(
    `SELECT id, is_smart_mode, llm_model, LOWER(wallet_address) AS wallet_address
       FROM agents
      WHERE wallet_address IS NOT NULL
        AND status != 'locked'`,
  );

  const watchedAgents = new Map();
  for (const row of rows) {
    const walletAddress = row.wallet_address;
    if (!watchedAgents.has(walletAddress)) watchedAgents.set(walletAddress, []);
    watchedAgents.get(walletAddress).push(row);
  }

  if (lastWatcherCount !== watchedAgents.size) {
    console.log(`[INDEXER] Watching ${watchedAgents.size} active agent wallet(s)`);
    lastWatcherCount = watchedAgents.size;
  }

  return watchedAgents;
}

async function lookupSenderAgentMeta(fromAddress) {
  if (!fromAddress) return {};

  const { rows: [sender] } = await db.query(
    `SELECT id, name
       FROM agents
      WHERE LOWER(wallet_address) = LOWER($1)
      LIMIT 1`,
    [fromAddress],
  );

  if (!sender) return {};

  return {
    senderAgentId: sender.id,
    senderAgentName: sender.name,
  };
}

async function ensureReceiveTransaction(agentId, chain, transfer, from, to, txHash) {
  const tokenSymbol = normalizeWatchedTokenSymbol(transfer?.tokenSymbol);
  const amountUsd = roundNumber(transfer?.amountUsd, 6) ?? 0;
  const tokenAmount = roundNumber(transfer?.tokenAmount, 10);
  const usdPrice = roundNumber(transfer?.usdPrice, 8);
  const tokenDecimals = Number(transfer?.decimals || 0) || null;

  const { rows: existing } = await db.query(
    `SELECT id
       FROM transactions
      WHERE agent_id = $1
        AND type = 'receive'
        AND tx_hash = $2
        AND token = $3
      LIMIT 1`,
    [agentId, txHash, tokenSymbol],
  );
  if (existing.length > 0) return false;

  const senderMeta = await lookupSenderAgentMeta(from);

  await db.query(
    `INSERT INTO transactions
       (agent_id, type, from_chain, to_chain, token, amount_usdc, from_address, to_address, tx_hash, status, meta)
     VALUES ($1, 'receive', $2, $2, $3, $4, $5, $6, $7, 'confirmed', $8)`,
    [agentId, chain, tokenSymbol, amountUsd, from, to, txHash, JSON.stringify({
      ...senderMeta,
      tokenAmount,
      usdValue: amountUsd,
      usdPrice,
      tokenDecimals,
    })],
  );

  return true;
}

// ── Core handler for matched transfers only ───────────────────────────────────
async function handleTransfer(chain, tokenConfig, agents, from, to, tokenAmount, txHash, blockNumber) {
  const tokenSymbol = normalizeWatchedTokenSymbol(tokenConfig?.symbol);

  // Deduplicate by tx_hash — skip if already recorded
  if (txHash) {
    const { rows: existing } = await db.query(
      `SELECT id
         FROM chain_events
        WHERE tx_hash = $1
          AND event_type = 'Transfer'
          AND contract_address = $2
        LIMIT 1`,
      [txHash, tokenConfig.address],
    );
    if (existing.length > 0) return; // already processed
  }

  const usdPrice = await getTokenUsdPrice(tokenSymbol);
  const amountUsd = Number.isFinite(Number(tokenAmount)) && Number.isFinite(Number(usdPrice))
    ? roundNumber(Number(tokenAmount) * Number(usdPrice), 6)
    : 0;
  const transfer = {
    tokenSymbol,
    tokenAmount: roundNumber(tokenAmount, 10),
    amountUsd,
    usdPrice: roundNumber(usdPrice, 8),
    decimals: tokenConfig?.decimals || null,
  };

  const { rows: [row] } = await db.query(
    `INSERT INTO chain_events (event_type, chain, contract_address, block_number, tx_hash, data)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    ['Transfer', chain, tokenConfig.address,
     blockNumber, txHash,
     JSON.stringify({
       from,
       to,
       token: tokenSymbol,
       tokenAmount: transfer.tokenAmount,
       amountUsd: transfer.amountUsd,
       usdPrice: transfer.usdPrice,
       tokenDecimals: transfer.decimals,
     })],
  );

  for (const agent of agents) {
    await ensureReceiveTransaction(agent.id, chain, transfer, from, to, txHash);

    if (agent.is_smart_mode) {
      agentQueue.add('INCOMING_TRANSFER', {
        eventId: row.id,
        agentId: agent.id,
        chain,
        amountUsdc: transfer.amountUsd,
        token: tokenSymbol,
        tokenAmount: transfer.tokenAmount,
        usdPrice: transfer.usdPrice,
        from,
        isSmartMode: agent.is_smart_mode,
        skipTransactionRecord: true,
      }).catch((err) => {
        console.error(`[INDEXER] ${chain} queue add error for agent ${agent.id}:`, err.message);
      });
    }

    console.log(`[INDEXER] ${chain} → agent ${agent.id}: ${transfer.tokenAmount} ${tokenSymbol} from ${from.slice(0, 10)}…`);
  }

  await db.query('UPDATE chain_events SET processed = TRUE WHERE id = $1', [row.id]);
}

async function reconcilePendingEvents() {
  const watchedAgents = await loadWatchedAgents();
  const { rows } = await db.query(
    `SELECT id, chain, tx_hash, data
       FROM chain_events
      WHERE event_type = 'Transfer'
        AND processed = FALSE
      ORDER BY created_at DESC
      LIMIT 200`,
  );

  if (rows.length > 0) {
    console.log(`[INDEXER] Reconciling ${rows.length} pending transfer event(s)`);
  }

  let restored = 0;
  let discarded = 0;

  for (const row of rows) {
    const to = String(row.data?.to || '').toLowerCase();
    const from = row.data?.from;
    const tokenSymbol = normalizeWatchedTokenSymbol(row.data?.token);
    const tokenAmount = Number(row.data?.tokenAmount || 0);
    const amountUsd = Number(row.data?.amountUsd || 0);
    const agents = watchedAgents.get(to);

    if (!agents?.length || !row.tx_hash || !from || tokenAmount <= 0) {
      await db.query('UPDATE chain_events SET processed = TRUE WHERE id = $1', [row.id]);
      discarded += 1;
      continue;
    }

    for (const agent of agents) {
      const inserted = await ensureReceiveTransaction(
        agent.id,
        row.chain,
        {
          tokenSymbol,
          tokenAmount,
          amountUsd,
          usdPrice: row.data?.usdPrice,
          decimals: row.data?.tokenDecimals,
        },
        from,
        row.data.to,
        row.tx_hash,
      );
      if (inserted) restored += 1;
    }

    await db.query('UPDATE chain_events SET processed = TRUE WHERE id = $1', [row.id]);
  }

  if (restored > 0 || discarded > 0) {
    console.log(`[INDEXER] Reconciled pending events: restored=${restored} discarded=${discarded}`);
  }
}

async function reconcileStalePendingEvents() {
  const staleAgeHours = readPositiveInteger(STALE_PENDING_EVENT_AGE_HOURS, 48);
  const restoreBatchSize = readPositiveInteger(STALE_PENDING_RESTORE_BATCH_SIZE, 500);
  const deleteBatchSize = readPositiveInteger(STALE_PENDING_DELETE_BATCH_SIZE, 10_000);
  const deleteMaxBatches = readPositiveInteger(STALE_PENDING_DELETE_MAX_BATCHES, 120);

  let restored = 0;
  let processed = 0;
  let deleted = 0;

  while (true) {
    const { rows } = await db.query(
      `SELECT ce.id, ce.chain, ce.tx_hash, ce.data, a.id AS agent_id
         FROM chain_events ce
         JOIN agents a ON LOWER(a.wallet_address) = LOWER(ce.data->>'to')
        WHERE ce.event_type = 'Transfer'
          AND ce.processed = FALSE
          AND ce.created_at < NOW() - ($1::int * INTERVAL '1 hour')
        ORDER BY ce.created_at ASC
        LIMIT $2`,
      [staleAgeHours, restoreBatchSize],
    );

    if (rows.length === 0) break;

    const events = new Map();
    for (const row of rows) {
      if (!events.has(row.id)) {
        events.set(row.id, {
          id: row.id,
          chain: row.chain,
          txHash: row.tx_hash,
          data: row.data || {},
          agentIds: [],
        });
      }
      events.get(row.id).agentIds.push(row.agent_id);
    }

    for (const event of events.values()) {
      const from = event.data?.from;
      const to = event.data?.to;
      const tokenSymbol = normalizeWatchedTokenSymbol(event.data?.token);
      const tokenAmount = Number(event.data?.tokenAmount || 0);
      const amountUsd = Number(event.data?.amountUsd || 0);

      if (event.txHash && from && to && tokenAmount > 0) {
        for (const agentId of event.agentIds) {
          const inserted = await ensureReceiveTransaction(
            agentId,
            event.chain,
            {
              tokenSymbol,
              tokenAmount,
              amountUsd,
              usdPrice: event.data?.usdPrice,
              decimals: event.data?.tokenDecimals,
            },
            from,
            to,
            event.txHash,
          );
          if (inserted) restored += 1;
        }
      }

      await db.query('UPDATE chain_events SET processed = TRUE WHERE id = $1', [event.id]);
      processed += 1;
    }

    if (rows.length < restoreBatchSize) break;
  }

  for (let batch = 0; batch < deleteMaxBatches; batch += 1) {
    const { rows: [row] } = await db.query(
      `WITH doomed AS (
         SELECT ce.id
           FROM chain_events ce
          WHERE ce.event_type = 'Transfer'
            AND ce.processed = FALSE
            AND ce.created_at < NOW() - ($1::int * INTERVAL '1 hour')
            AND NOT EXISTS (
              SELECT 1
                FROM agents a
               WHERE LOWER(a.wallet_address) = LOWER(ce.data->>'to')
            )
          LIMIT $2
       ), deleted AS (
         DELETE FROM chain_events ce
         USING doomed
         WHERE ce.id = doomed.id
         RETURNING 1
       )
       SELECT COUNT(*)::int AS deleted_count
         FROM deleted`,
      [staleAgeHours, deleteBatchSize],
    );

    const batchDeletedCount = Number(row?.deleted_count || 0);
    deleted += batchDeletedCount;

    if (batchDeletedCount < deleteBatchSize) break;
  }

  if (restored > 0 || processed > 0 || deleted > 0) {
    console.log(
      `[INDEXER] Reconciled stale pending events: restored=${restored} processed=${processed} deleted=${deleted}`,
    );
  }
}

async function getTransferLogs(provider, config, walletAddresses, fromBlock, toBlock) {
  const logs = [];
  const watchedTokens = (config.tokens || []).filter(token => token?.address);

  if (watchedTokens.length === 0) {
    return logs;
  }

  for (const blockRange of chunk(
    Array.from({ length: Math.ceil((toBlock - fromBlock + 1) / BLOCK_CHUNK_SIZE) }, (_, index) => ({
      fromBlock: fromBlock + (index * BLOCK_CHUNK_SIZE),
      toBlock: Math.min(fromBlock + ((index + 1) * BLOCK_CHUNK_SIZE) - 1, toBlock),
    })),
    1,
  )) {
    const { fromBlock: rangeStart, toBlock: rangeEnd } = blockRange[0];

    for (const walletChunk of chunk(walletAddresses, WALLET_CHUNK_SIZE)) {
      const topics = walletChunk.map((address) => ethers.zeroPadValue(address, 32));
      for (const token of watchedTokens) {
        const chunkLogs = await withTimeout(provider.getLogs({
          address: token.address,
          fromBlock: rangeStart,
          toBlock: rangeEnd,
          topics: [TRANSFER_TOPIC, null, topics],
        }), 12_000);
        logs.push(...chunkLogs.map(log => ({ log, token })));
      }
    }
  }

  return logs;
}

async function pollChain(chain, config) {
  const watchedTokens = (config.tokens || []).filter(token => token?.address);
  if (!config.rpcHttp || watchedTokens.length === 0) return;

  let latest = null;

  try {
    const watchedAgents = await loadWatchedAgents();
    const walletAddresses = [...watchedAgents.keys()];
    if (walletAddresses.length === 0) return;

    const httpProvider = getHttpProvider(chain, config.rpcHttp);
    latest = await withTimeout(httpProvider.getBlockNumber(), 8_000);
    await loadInitialCursor(chain, latest);
    const previousBlock = lastPolledBlock.get(chain);
    const fromBlock = previousBlock == null ? latest : previousBlock + 1;

    if (fromBlock > latest) {
      lastPolledBlock.set(chain, latest);
      return;
    }

    const logs = await getTransferLogs(httpProvider, config, walletAddresses, fromBlock, latest);
    let matchedTransfers = 0;

    for (const entry of logs) {
      const { log, token } = entry;
      const parsed = TRANSFER_IFACE.parseLog(log);
      const from = parsed.args.from;
      const to = parsed.args.to;
      const agents = watchedAgents.get(to.toLowerCase());
      if (!agents?.length) continue;

      const tokenAmount = parseFloat(ethers.formatUnits(parsed.args.value, token.decimals || 18));
      await handleTransfer(chain, token, agents, from, to, tokenAmount, log.transactionHash, log.blockNumber);
      matchedTransfers += 1;
    }

    lastPolledBlock.set(chain, latest);
    if (matchedTransfers > 0) {
      console.log(`[INDEXER] ${chain} poll blocks ${fromBlock}–${latest}: ${matchedTransfers} matched transfer(s)`);
    }
  } catch (err) {
    if (isArchiveAccessError(err)) {
      lastPolledBlock.set(chain, latest);

      if (!archiveBackfillSkippedChains.has(chain)) {
        archiveBackfillSkippedChains.add(chain);
        console.warn(
          `[INDEXER] ${chain} RPC does not allow historical eth_getLogs; skipping backfill to resume live polling from block ${latest}.`,
        );
      }

      return;
    }

    console.warn(`[INDEXER] ${chain} poll error:`, err.message);
  }
}

async function pollAllChains() {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
    for (const [chain, config] of Object.entries(WATCHED_CONTRACTS)) {
      await pollChain(chain, config);
    }
  } finally {
    pollInFlight = false;
  }
}

async function startIndexer() {
  console.log('[INDEXER] Starting HTTP polling indexer');
  await reconcilePendingEvents().catch(err =>
    console.error('[INDEXER] reconcile error:', err.message),
  );
  await reconcileStalePendingEvents().catch(err =>
    console.error('[INDEXER] stale reconcile error:', err.message),
  );
  await pollAllChains().catch(err =>
    console.error('[INDEXER] startup error:', err.message),
  );
  setInterval(() => {
    pollAllChains().catch(err => console.error('[INDEXER] poll loop error:', err.message));
  }, POLL_INTERVAL_MS);
}

module.exports = { startIndexer };
