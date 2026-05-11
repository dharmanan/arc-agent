'use strict';
/**
 * Transaction Service — Agentic Edition
 *
 * Decision tree for every transaction:
 *
 *   amount < NANO_THRESHOLD (< $0.01)
 *     → Nano payment: agent auto-executes via its own private key (no passkey)
 *       Reference: https://developers.circle.com/gateway/nanopayments#agentic-payments
 *
 *   amount ≤ agent.maxTradeUsdc  AND  daily_spent + amount ≤ daily_limit
 *     → Agentic execution: agent's private key signs & broadcasts autonomously
 *
 *   amount > agent.maxTradeUsdc
 *     → Blocked: user must raise the limit or approve manually
 *
 * The agent's private key (AES-256-GCM encrypted at rest) is ONLY decrypted
 * inside agentWalletService, never logged or returned to clients.
 */
const { ethers }            = require('ethers');
const { v4: uuidv4 }        = require('uuid');
const db                    = require('../db');
const relayerService        = require('./relayerService');
const agentService          = require('./agentService');
const agentWalletService    = require('./agentWalletService');
const bridgeActivityService = require('./bridgeActivityService');

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Check daily limit and atomically reserve the amount.
 * Throws 422 if daily cap would be exceeded.
 * Returns { maxTradeUsdc } for the caller to check per-trade limit.
 */
async function checkAndReserveDailyLimit(agent, amountUsdc, options = {}) {
  const { enforceMaxTrade = true } = options;
  const today = new Date().toISOString().slice(0, 10);

  const { rows } = await db.query(
    `SELECT daily_spent_usdc, daily_limit_usdc, max_trade_usdc, last_reset_day
     FROM agents WHERE id = $1 FOR UPDATE`,
    [agent.id],
  );
  const row = rows[0];
  const lastReset = row.last_reset_day.toISOString().slice(0, 10);
  let spent = parseFloat(row.daily_spent_usdc);

  if (lastReset < today) {
    spent = 0;
    await db.query('UPDATE agents SET daily_spent_usdc = 0, last_reset_day = $1 WHERE id = $2', [today, agent.id]);
  }

  const dailyLimit  = parseFloat(row.daily_limit_usdc);
  const maxTrade    = parseFloat(row.max_trade_usdc);

  // Block if above per-trade auto-approve threshold
  if (enforceMaxTrade && amountUsdc > maxTrade) {
    throw Object.assign(
      new Error(`Amount ${amountUsdc} USDC exceeds agent auto-approve limit (${maxTrade} USDC). Raise the limit in Agent Settings.`),
      { status: 422, code: 'EXCEEDS_MAX_TRADE' },
    );
  }

  // Block if daily cap would be exceeded
  if (spent + amountUsdc > dailyLimit) {
    throw Object.assign(
      new Error(`Daily limit exceeded (spent ${spent.toFixed(2)} + ${amountUsdc} > ${dailyLimit} USDC)`),
      { status: 422, code: 'DAILY_LIMIT_EXCEEDED' },
    );
  }

  await db.query(
    'UPDATE agents SET daily_spent_usdc = daily_spent_usdc + $1 WHERE id = $2',
    [amountUsdc, agent.id],
  );

  return { maxTradeUsdc: maxTrade };
}

async function rollbackDailyLimit(agentId, amountUsdc) {
  await db.query(
    'UPDATE agents SET daily_spent_usdc = GREATEST(0, daily_spent_usdc - $1) WHERE id = $2',
    [amountUsdc, agentId],
  ).catch(() => {});
}

async function recordTx(agentId, type, fields, status = 'pending') {
  const id = uuidv4();
  await db.query(
    `INSERT INTO transactions
       (id, agent_id, type, from_chain, to_chain, token, amount_usdc, from_address, to_address, status, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id, agentId, type,
      fields.fromChain, fields.toChain,
      fields.token || 'USDC',
      fields.amountUsdc,
      fields.fromAddress, fields.toAddress,
      status,
      JSON.stringify(fields.meta || {}),
    ],
  );
  return id;
}

async function updateTxStatus(txId, status, txHash = null) {
  await db.query(
    'UPDATE transactions SET status=$1, tx_hash=$2, confirmed_at=NOW() WHERE id=$3',
    [status, txHash, txId],
  );
}

function normalizeTransactionRow(row) {
  if (!row) return row;

  const meta = row.meta && typeof row.meta === 'object' ? { ...row.meta } : {};
  const isLegacyNativeBridge = row.type === 'gas_topup'
    && row.token === 'ETH'
    && ['native_gas_topup', 'native_eth_bridge'].includes(meta.kind);

  const next = { ...row, meta };

  if (isLegacyNativeBridge) {
    next.type = 'bridge';
    next.meta = {
      ...next.meta,
      kind: 'native_eth_bridge',
      bridgeType: 'native',
    };
  }

  if (next.type !== 'bridge') return next;

  const sourceTxHash = next.meta.sourceTxHash || next.meta.burnTxHash || next.meta.topUpTxHash || null;
  const destinationTxHash = next.meta.destinationTxHash
    || next.meta.mintTxHash
    || (next.tx_hash && next.tx_hash !== sourceTxHash ? next.tx_hash : null);

  return {
    ...next,
    meta: {
      ...next.meta,
      ...(sourceTxHash ? { sourceTxHash } : {}),
      ...(destinationTxHash ? { destinationTxHash } : {}),
    },
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Send USDC/EURC from agent wallet.
 * If amount < NANO_THRESHOLD → always agentic (nano payment).
 * If amount ≤ maxTradeUsdc  → agentic (agent signs with its own key).
 */
async function sendPayment({ agent, toAddress, amountUsdc, chain, token = 'USDC' }) {
  const isNano    = amountUsdc < agentWalletService.NANO_THRESHOLD_USDC;
  const txType    = isNano ? 'nano_payment' : 'send';

  // Check limits (nano payments skip per-trade max but still count toward daily)
  if (isNano) {
    // Just check daily, no per-trade check for nano
    const { rows } = await db.query(
      'SELECT daily_spent_usdc, daily_limit_usdc FROM agents WHERE id = $1',
      [agent.id],
    );
    const row = rows[0];
    if (parseFloat(row.daily_spent_usdc) + amountUsdc > parseFloat(row.daily_limit_usdc)) {
      throw Object.assign(new Error('Daily limit exceeded'), { status: 422 });
    }
    await db.query('UPDATE agents SET daily_spent_usdc = daily_spent_usdc + $1 WHERE id = $2', [amountUsdc, agent.id]);
  } else {
    await checkAndReserveDailyLimit(agent, amountUsdc);
  }

  // Get raw agent row (includes private key) for agentic execution
  const rawAgent = await agentService.getAgentWithKey(agent.id, agent.userId || agent.user_id);
  if (!rawAgent) throw new Error('Agent not found');

  const txId = await recordTx(agent.id, txType, {
    fromChain: chain, toChain: chain, amountUsdc, token,
    fromAddress: agent.walletAddress, toAddress,
    meta: { isAgentic: true, isNano },
  });

  // Execute agentically (non-blocking)
  const executePromise = isNano
    ? agentWalletService.nanoPayment({ agent: rawAgent, toAddress, amountUsdc, token })
    : agentWalletService.agentSend({ agent: rawAgent, toAddress, amountUsdc, token });

  executePromise
    .then(hash => updateTxStatus(txId, 'confirmed', hash))
    .catch(err => {
      console.error(`[TX ${txType.toUpperCase()}]`, err.message);
      updateTxStatus(txId, 'failed').catch(() => {});
      rollbackDailyLimit(agent.id, amountUsdc);
    });

  return { txId, status: 'executing', isAgentic: true, isNano };
}

/**
 * Cross-chain USDC bridge (Circle CCTP V2) — iki mod:
 *
 * mode='auto' (varsayılan):
 *   Limit dahilindeyse ajan tüm CCTP adımlarını otomatik çalıştırır.
 *   mode='manual' ya da limit üstündeyse → manuel modda kaydeder, txId döner.
 *
 * mode='manual':
 *   Sadece DB kaydı oluşturur. Kullanıcı her adımı /bridge/step ile tetikler.
 *   Backend ajan cüzdanını kullanır; MetaMask gerekmez.
 */
async function bridgeTokens({ agent, fromChain, toChain, amountUsdc, mode = 'auto' }) {
  let rawAgent = null;
  if (mode !== 'manual') {
    rawAgent = await agentService.getAgentWithKey(agent.id, agent.userId || agent.user_id);
    if (!rawAgent) throw new Error('Agent not found');
    await agentWalletService.ensureDestinationGasForAutoBridge(rawAgent, toChain);
  }

  await checkAndReserveDailyLimit(agent, amountUsdc, { enforceMaxTrade: mode !== 'manual' });

  const now   = new Date().toISOString();
  const txId  = await recordTx(agent.id, 'bridge', {
    fromChain, toChain, amountUsdc,
    fromAddress: agent.walletAddress || agent.wallet_address,
    meta: {
      provider: 'Circle CCTP v2',
      mode,
      isAgentic: mode !== 'manual',
      fromChain, toChain,
    },
  });

  if (mode === 'manual') {
    // Manuel mod: sadece DB kaydı, frontend adımları tetikler
    // Redis aktivite oluştur
    const walletAddress = agent.walletAddress || agent.wallet_address;
    await bridgeActivityService.upsertActivity({
      id:           txId,
      txId,
      agentId:      agent.id,
      walletAddress,
      fromChain, toChain,
      amount:       amountUsdc,
      token:        'USDC',
      mode:         'manual',
      status:       bridgeActivityService.STATUS.AWAITING_APPROVE,
      startedAt:    Date.now(),
    }).catch(e => console.error('[BRIDGE-ACT]', e.message));
    return { txId, status: 'pending', mode: 'manual', isAgentic: false };
  }

  // Redis aktivite oluştur (agentic mod)
  const walletAddress = agent.walletAddress || agent.wallet_address;
  const actBase = {
    id:           txId,
    txId,
    agentId:      agent.id,
    walletAddress,
    fromChain, toChain,
    amount:       amountUsdc,
    token:        'USDC',
    mode:         'auto',
    status:       bridgeActivityService.STATUS.AWAITING_APPROVE,
    startedAt:    Date.now(),
  };
  await bridgeActivityService.upsertActivity(actBase).catch(e => console.error('[BRIDGE-ACT]', e.message));

  // onStep callback → her CCTP adımında DB + Redis güncelle
  async function onStep(step, data) {
    const meta = { bridgeStep: step, lastUpdated: new Date().toISOString(), ...data };
    await db.query(
      "UPDATE transactions SET meta = meta || $1::jsonb WHERE id = $2",
      [JSON.stringify(meta), txId],
    );
    if (step === 'complete') {
      await updateTxStatus(txId, 'confirmed', data.mintTxHash || null);
    } else if (['approving', 'burning', 'attesting', 'minting'].includes(step)) {
      await updateTxStatus(txId, 'executing', data.burnTxHash || null);
    }

    // Redis aktivite güncelle
    const current = await bridgeActivityService.getActivity(txId).catch(() => actBase);
    const actUpdate = { ...(current || actBase) };
    const stepToStatus = {
      approving: bridgeActivityService.STATUS.AWAITING_APPROVE,
      approved:  bridgeActivityService.STATUS.AWAITING_BURN,
      burning:   bridgeActivityService.STATUS.AWAITING_BURN,
      burned:    bridgeActivityService.STATUS.PENDING_ATTESTATION,
      attesting: bridgeActivityService.STATUS.PENDING_ATTESTATION,
      attested:  bridgeActivityService.STATUS.READY_TO_MINT,
      minting:   bridgeActivityService.STATUS.READY_TO_MINT,
      complete:  bridgeActivityService.STATUS.MINTED,
    };
    if (stepToStatus[step]) actUpdate.status = stepToStatus[step];
    if (data.approveTxHash) actUpdate.approveTxHash = data.approveTxHash;
    if (data.burnTxHash)    actUpdate.sourceTxHash  = data.burnTxHash;
    if (data.messageHash)   actUpdate.messageHash   = data.messageHash;
    if (data.mintTxHash)    actUpdate.mintTxHash    = data.mintTxHash;
    await bridgeActivityService.upsertActivity(actUpdate).catch(e => console.error('[BRIDGE-ACT-STEP]', e.message));
  }

  agentWalletService.agentBridgeFull({
    agent: rawAgent, fromChain, toChain, amountUsdc, onStep,
  }).catch(err => {
    console.error('[AGENTIC BRIDGE]', err.message);

    const isInsufficientFunds = err.code === 'INSUFFICIENT_FUNDS'
      || err.code === 'INSUFFICIENT_DESTINATION_GAS'
      || /insufficient funds for gas \* price \+ value/i.test(err.message || '');

    if (isInsufficientFunds) {
      bridgeActivityService.getActivity(txId)
        .catch(() => null)
        .then(act => {
          const current = act || actBase;
          const isMintStage = current.status === bridgeActivityService.STATUS.READY_TO_MINT;
          if (!isMintStage) return null;

          db.query(
            "UPDATE transactions SET status='executing', meta = meta || $1::jsonb WHERE id = $2",
            [JSON.stringify({ bridgeStep: 'ready_to_mint', mintPendingGasTopUp: true, lastError: err.message }), txId],
          ).catch(() => {});

          return bridgeActivityService.upsertActivity({
            ...current,
            status: bridgeActivityService.STATUS.READY_TO_MINT,
            autoRetryReason: 'destination_gas_low',
            retryMessage: err.message,
          }).catch(() => {});
        });

      if (err.code === 'INSUFFICIENT_DESTINATION_GAS') {
        return;
      }

      bridgeActivityService.getActivity(txId)
        .then(act => {
          if (act?.status === bridgeActivityService.STATUS.READY_TO_MINT) return;
          updateTxStatus(txId, 'failed').catch(() => {});
          rollbackDailyLimit(agent.id, amountUsdc).catch(() => {});
          bridgeActivityService.upsertActivity({ ...(act || actBase), status: bridgeActivityService.STATUS.FAILED, error: err.message }).catch(() => {});
        })
        .catch(() => {
          updateTxStatus(txId, 'failed').catch(() => {});
          rollbackDailyLimit(agent.id, amountUsdc).catch(() => {});
          bridgeActivityService.upsertActivity({ ...actBase, status: bridgeActivityService.STATUS.FAILED, error: err.message }).catch(() => {});
        });
      return;
    }

    if (/attestation.*(timeout|zaman aşımı)/i.test(err.message || '')) {
      db.query(
        "UPDATE transactions SET status='executing', meta = meta || $1::jsonb WHERE id = $2",
        [JSON.stringify({ bridgeStep: 'attesting', attestationPending: true, lastError: err.message }), txId],
      ).catch(() => {});

      bridgeActivityService.getActivity(txId)
        .catch(() => null)
        .then(act => {
          const next = { ...(act || actBase), status: bridgeActivityService.STATUS.PENDING_ATTESTATION };
          delete next.error;
          return bridgeActivityService.upsertActivity(next).catch(() => {});
        });
      return;
    }

    updateTxStatus(txId, 'failed').catch(() => {});
    rollbackDailyLimit(agent.id, amountUsdc).catch(() => {});
    // Redis aktiviteyi failed yap — getActivity başarısız olursa actBase fallback kullan
    bridgeActivityService.getActivity(txId)
      .catch(() => null)
      .then(act => bridgeActivityService.upsertActivity({ ...(act || actBase), status: bridgeActivityService.STATUS.FAILED, error: err.message }).catch(() => {}));
  });

  return { txId, status: 'executing', mode: 'agentic', isAgentic: true };
}

async function bridgeNativeGasTopUp({ agent, toChain, amountEth }) {
  const rawAgent = await agentService.getAgentWithKey(agent.id, agent.userId || agent.user_id);
  if (!rawAgent) throw new Error('Agent not found');

  const walletAddress = agent.walletAddress || agent.wallet_address;
  const currentDestinationBalanceWei = await agentWalletService.getNativeBalance(toChain, walletAddress);
  const destinationStartBlock = await agentWalletService.getCurrentBlockNumber(toChain).catch(() => null);
  const topUpAmountWei = amountEth == null
    ? await agentWalletService.getRecommendedNativeTopUpWei(toChain, currentDestinationBalanceWei)
    : ethers.parseEther(String(amountEth));
  const amountEthFormatted = ethers.formatEther(topUpAmountWei);

  if (topUpAmountWei <= 0n) {
    throw Object.assign(
      new Error(`Agent wallet already has enough native gas on ${toChain}.`),
      { status: 409, code: 'DESTINATION_GAS_ALREADY_FUNDED' },
    );
  }

  const txId = await recordTx(agent.id, 'bridge', {
    fromChain: 'Sepolia',
    toChain,
    token: 'ETH',
    amountUsdc: 0,
    fromAddress: walletAddress,
    toAddress: walletAddress,
    meta: {
      provider: 'Native ETH bridge',
      kind: 'native_eth_bridge',
      bridgeType: 'native',
      amountEth: amountEthFormatted,
      destinationBalanceEthBefore: ethers.formatEther(currentDestinationBalanceWei),
      destinationBalanceBeforeWei: currentDestinationBalanceWei.toString(),
      destinationStartBlock,
      bridgeStep: 'source_submitted',
      bridgeCompletionStatus: 'source_submitted',
      isAgentic: true,
    },
  }, 'executing');

  const actBase = {
    id: txId,
    txId,
    agentId: agent.id,
    walletAddress,
    fromChain: 'Sepolia',
    toChain,
    amount: amountEthFormatted,
    amountWei: topUpAmountWei.toString(),
    token: 'ETH',
    mode: 'auto',
    bridgeType: 'native',
    status: bridgeActivityService.STATUS.SOURCE_SUBMITTED,
    destinationBalanceBeforeWei: currentDestinationBalanceWei.toString(),
    destinationStartBlock,
    startedAt: Date.now(),
  };

  await bridgeActivityService.upsertActivity(actBase).catch(() => {});

  agentWalletService.bridgeNativeGasTopUp({
    agent: rawAgent,
    toChain,
    recipient: walletAddress,
    amountWei: topUpAmountWei,
  })
    .then(({ topUpTxHash, fromChain, bridgeAddress, bridgeKind }) => {
      db.query(
        "UPDATE transactions SET status='executing', tx_hash=$1, from_chain=$2, meta = meta || $3::jsonb WHERE id = $4",
        [
          topUpTxHash,
          fromChain,
          JSON.stringify({
            sourceTxHash: topUpTxHash,
            topUpTxHash,
            bridgeAddress,
            bridgeKind,
            bridgeStep: 'destination_pending',
            bridgeCompletionStatus: 'destination_pending',
          }),
          txId,
        ],
      ).catch(() => {});

      bridgeActivityService.getActivity(txId)
        .catch(() => null)
        .then(act => bridgeActivityService.upsertActivity({
          ...(act || actBase),
          fromChain,
          status: bridgeActivityService.STATUS.PENDING_DESTINATION,
          sourceTxHash: topUpTxHash,
          bridgeKind,
          bridgeAddress,
        }).catch(() => {}));
    })
    .catch(err => {
      console.error('[NATIVE GAS TOP-UP]', err.message);
      updateTxStatus(txId, 'failed').catch(() => {});
      db.query(
        'UPDATE transactions SET meta = meta || $1::jsonb WHERE id = $2',
        [JSON.stringify({ lastError: err.message }), txId],
      ).catch(() => {});
      bridgeActivityService.getActivity(txId)
        .catch(() => null)
        .then(act => bridgeActivityService.upsertActivity({
          ...(act || actBase),
          status: bridgeActivityService.STATUS.FAILED,
          error: err.message,
        }).catch(() => {}));
    });

  return {
    txId,
    status: 'executing',
    isAgentic: true,
    fromChain: 'Sepolia',
    toChain,
    amountEth: amountEthFormatted,
  };
}

/**
 * Manuel mod: tek bir CCTP adımını ajan cüzdanıyla çalıştır.
 * step: 'approve' | 'burn' | 'mint'
 */
async function executeBridgeStep({ agent, txId, step, meta }) {
  // TX kaydını al
  const { rows } = await db.query(
    `SELECT t.*, a.user_id FROM transactions t JOIN agents a ON a.id = t.agent_id WHERE t.id = $1 AND a.user_id = $2`,
    [txId, agent.userId || agent.user_id],
  );
  const tx = rows[0];
  if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });
  if (tx.type !== 'bridge') throw Object.assign(new Error('Not a bridge transaction'), { status: 400 });

  const txMeta = tx.meta || {};
  const { fromChain, toChain } = txMeta;

  const rawAgent = await agentService.getAgentWithKey(agent.id, agent.userId || agent.user_id);
  if (!rawAgent) throw new Error('Agent not found');

  const amountUsdc = parseFloat(tx.amount_usdc);

  let result = {};

  if (step === 'approve') {
    result = await agentWalletService.cctpApprove({ agent: rawAgent, fromChain, amountUsdc });
    await db.query(
      "UPDATE transactions SET meta = meta || $1::jsonb WHERE id = $2",
      [JSON.stringify({ bridgeStep: 'approved', approveTxHash: result.approveTxHash }), txId],
    );
    // Redis aktivite güncelle
    const act1 = await bridgeActivityService.getActivity(txId).catch(() => null);
    if (act1) await bridgeActivityService.upsertActivity({ ...act1, status: bridgeActivityService.STATUS.AWAITING_BURN, approveTxHash: result.approveTxHash }).catch(() => {});

  } else if (step === 'burn') {
    result = await agentWalletService.cctpBurn({ agent: rawAgent, fromChain, toChain, amountUsdc });
    await db.query(
      "UPDATE transactions SET meta = meta || $1::jsonb, tx_hash = $2 WHERE id = $3",
      [JSON.stringify({ bridgeStep: 'burned', burnTxHash: result.burnTxHash, messageHash: result.messageHash, message: result.message }), result.burnTxHash, txId],
    );
    // Redis aktivite güncelle — pending_attestation'a geç, poller devralır
    const act2 = await bridgeActivityService.getActivity(txId).catch(() => null);
    if (act2) await bridgeActivityService.upsertActivity({ ...act2, status: bridgeActivityService.STATUS.PENDING_ATTESTATION, sourceTxHash: result.burnTxHash, messageHash: result.messageHash }).catch(() => {});

  } else if (step === 'mint') {
    const { message, attestation } = meta || {};
    if (!message || !attestation) throw Object.assign(new Error('message ve attestation gerekli'), { status: 400 });
    result = await agentWalletService.cctpMint({ agent: rawAgent, toChain, message, attestation });
    await db.query(
      "UPDATE transactions SET meta = meta || $1::jsonb, status='confirmed', confirmed_at=NOW() WHERE id = $2",
      [JSON.stringify({ bridgeStep: 'complete', mintTxHash: result.mintTxHash }), txId],
    );
    // Redis aktivite güncelle
    const act3 = await bridgeActivityService.getActivity(txId).catch(() => null);
    if (act3) await bridgeActivityService.upsertActivity({ ...act3, status: bridgeActivityService.STATUS.MINTED, mintTxHash: result.mintTxHash }).catch(() => {});

  } else {
    throw Object.assign(new Error(`Geçersiz adım: ${step}`), { status: 400 });
  }

  return { txId, step, ...result };
}

/**
 * Manuel mod: Circle attestation API'yi sorgula.
 * fromChain + messageHash tx meta'sından alınır.
 */
async function getBridgeAttestation({ txId, userId }) {
  const { rows } = await db.query(
    `SELECT t.meta FROM transactions t JOIN agents a ON a.id = t.agent_id WHERE t.id = $1 AND a.user_id = $2`,
    [txId, userId],
  );
  if (!rows[0]) throw Object.assign(new Error('Transaction not found'), { status: 404 });

  const { fromChain, toChain, messageHash, burnTxHash } = rows[0].meta || {};
  if (!burnTxHash && !messageHash) return { status: 'waiting_for_burn', attestation: null };

  // Poll attestation API (tek sefer — yükleme yoksa 'pending' döner)
  try {
    const { cctpPollAttestation } = agentWalletService;
    const data = await cctpPollAttestation({ fromChain, toChain, sourceTxHash: burnTxHash, messageHash, maxWaitMs: 8000 });
    // Attestation alındıysa meta'ya kaydet
    await db.query(
      "UPDATE transactions SET meta = meta || $1::jsonb WHERE id = $2",
      [JSON.stringify({ bridgeStep: 'attested', attestation: data.attestation, attestedMessage: data.message }), txId],
    );
    return { status: 'complete', attestation: data.attestation, message: data.message };
  } catch {
    return { status: 'pending', attestation: null };
  }
}


/**
 * Agentic swap: USDC / EURC / cirBTC on Arc Testnet only.
 * Agent signs with its own private key — no user MetaMask interaction needed.
 */
async function swapTokens({ agent, fromToken, toToken, amountIn, slippage, chain }) {
  if (chain !== 'Arc Testnet') {
    throw Object.assign(new Error('Swap is only supported on Arc Testnet'), { status: 400 });
  }

  if (!agentWalletService.isSwapConfigured()) {
    throw Object.assign(new Error('Swap is not configured on this deployment. Set CIRCLE_KIT_KEY and try again.'), { status: 503 });
  }

  const allowedTokens = ['USDC', 'EURC', 'cirBTC'];
  const pairValid = fromToken !== toToken && allowedTokens.includes(fromToken) && allowedTokens.includes(toToken);
  if (!pairValid) {
    throw Object.assign(new Error('Only USDC, EURC, and cirBTC swaps are supported on Arc Testnet'), { status: 400 });
  }

  // Amount in for limit check. Stable inputs are ~1:1 with USD; cirBTC uses a live quote.
  let usdcEquiv = parseFloat(amountIn);
  if (fromToken === 'cirBTC') {
    const quotedOut = await agentWalletService.getSwapQuote({ fromToken, toToken, amountIn });
    usdcEquiv = parseFloat(quotedOut);
    if (!Number.isFinite(usdcEquiv) || usdcEquiv <= 0) {
      throw Object.assign(new Error('Could not determine a live cirBTC limit quote. Try again.'), { status: 503 });
    }
  }

  await checkAndReserveDailyLimit(agent, usdcEquiv);

  // Get raw agent row for private key access
  const rawAgent = await agentService.getAgentWithKey(agent.id, agent.userId || agent.user_id);
  if (!rawAgent) throw new Error('Agent not found');

  const txId = await recordTx(agent.id, 'swap', {
    fromChain: 'Arc Testnet', toChain: 'Arc Testnet',
    token: fromToken, amountUsdc: usdcEquiv,
    fromAddress: agent.walletAddress,
    meta: { fromToken, toToken, amountIn, slippage, isAgentic: true },
  });

  // Execute swap agentically (non-blocking)
  agentWalletService.agentSwap({
    agent: rawAgent,
    fromToken, toToken,
    amountIn: parseFloat(amountIn),
    slippagePct: slippage ?? parseFloat(agent.settings?.slippagePercent ?? 0.5),
  })
    .then(({ hash, amountOut }) => {
      updateTxStatus(txId, 'confirmed', hash);
      // Store output amount in meta
      db.query("UPDATE transactions SET meta = meta || $1::jsonb WHERE id = $2",
        [JSON.stringify({ amountOut }), txId]).catch(() => {});
    })
    .catch(err => {
      console.error('[AGENT SWAP]', err.message);
      updateTxStatus(txId, 'failed').catch(() => {});
      rollbackDailyLimit(agent.id, usdcEquiv);
    });

  return { txId, status: 'executing', isAgentic: true };
}

async function listTransactions(agentId) {
  const { rows } = await db.query(
    'SELECT * FROM transactions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 50',
    [agentId],
  );
  return rows.map(normalizeTransactionRow);
}

async function getTransactionStatus(txId, userId) {
  const { rows } = await db.query(
    `SELECT t.* FROM transactions t
     JOIN agents a ON a.id = t.agent_id
     WHERE t.id = $1 AND a.user_id = $2`,
    [txId, userId],
  );
  return normalizeTransactionRow(rows[0] || null);
}

module.exports = {
  sendPayment,
  bridgeTokens,
  bridgeNativeGasTopUp,
  executeBridgeStep,
  getBridgeAttestation,
  swapTokens,
  listTransactions,
  getTransactionStatus,
};

