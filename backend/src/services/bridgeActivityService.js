'use strict';
/**
 * Bridge Activity Service — Paralel köprü takibi (Postgres tabanlı)
 *
 * Eski repo (Arc-Testnet-Bridge-Swap) mimarisinden adapte edildi.
 * Her bridge aktivitesi `bridge_activities` tablosunda JSONB olarak tutulur;
 * wallet/status/mode/bridge_type/source_tx_hash kolonları eski Redis
 * set/sorted-set indekslerinin (wallet lookup, pending/auto-mint/native-pending
 * kuyrukları, burn-hash reverse lookup) yerini alan sorgulanabilir alanlardır.
 *
 * State machine:
 *   awaiting_approve → awaiting_burn → pending_attestation → ready_to_mint → minted
 *                                                           (veya failed / dismissed)
 */
const { ethers }     = require('ethers');
const { v4: uuidv4 } = require('uuid');
const https          = require('https');
const db             = require('../db');
const agentWalletService = require('./agentWalletService');

// ── Sabitler ──────────────────────────────────────────────────────────────────
const IRIS_API   = 'https://iris-api-sandbox.circle.com';

// ── CCTP zincir domain haritası ───────────────────────────────────────────────
const CHAIN_DOMAIN = {
  'Arc Testnet':       26,
  'Sepolia':           0,
  'Base Sepolia':      6,
  'Optimism Sepolia':  2,
  'Arbitrum Sepolia':  3,
};

// ── Durum sabitleri ───────────────────────────────────────────────────────────
const STATUS = {
  SOURCE_SUBMITTED:    'source_submitted',
  PENDING_DESTINATION: 'pending_destination',
  AWAITING_APPROVE:    'awaiting_approve',
  AWAITING_BURN:       'awaiting_burn',
  PENDING_ATTESTATION: 'pending_attestation',
  READY_TO_MINT:       'ready_to_mint',
  MINTED:              'minted',
  FAILED:              'failed',
  DISMISSED:           'dismissed',
};

const TERMINAL_STATUSES = new Set([STATUS.MINTED, STATUS.FAILED, STATUS.DISMISSED]);

function normalizeActivity(data) {
  if (!data) return null;
  const rec = { ...data };
  if (rec.error && !TERMINAL_STATUSES.has(rec.status)) {
    rec.status = STATUS.FAILED;
  }
  return rec;
}

// ── Key üreticiler ────────────────────────────────────────────────────────────
const normalizeWallet = addr => String(addr || '').toLowerCase();
const normalizeTxHash = hash => (hash ? String(hash).toLowerCase() : null);

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Yeni aktivite oluştur veya mevcut aktiviteyi güncelle.
 * data.id varsa update; yoksa yeni kayıt.
 */
async function upsertActivity(data) {
  const now = Date.now();
  const rec = normalizeActivity({
    ...data,
    id:        data.id || uuidv4(),
    updatedAt: now,
    createdAt: data.createdAt || now,
  });

  await db.query(
    `INSERT INTO bridge_activities (id, wallet_address, status, mode, bridge_type, source_tx_hash, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0))
     ON CONFLICT (id) DO UPDATE SET
       wallet_address = EXCLUDED.wallet_address,
       status         = EXCLUDED.status,
       mode           = EXCLUDED.mode,
       bridge_type    = EXCLUDED.bridge_type,
       source_tx_hash = EXCLUDED.source_tx_hash,
       data           = EXCLUDED.data,
       updated_at     = EXCLUDED.updated_at`,
    [
      rec.id,
      normalizeWallet(rec.walletAddress),
      rec.status,
      rec.mode || null,
      rec.bridgeType || null,
      normalizeTxHash(rec.sourceTxHash),
      JSON.stringify(rec),
      rec.createdAt,
      rec.updatedAt,
    ],
  );

  return rec;
}

async function getActivity(id) {
  try {
    const { rows } = await db.query('SELECT data FROM bridge_activities WHERE id = $1', [id]);
    return normalizeActivity(rows[0]?.data || null);
  } catch (err) {
    // Malformed / non-UUID ids (e.g. arbitrary route params) should behave
    // like a Redis cache miss, not a 500 — same as the old key-lookup did.
    if (err.code === '22P02') return null;
    throw err;
  }
}

async function getActivitiesForWallet(walletAddress, limit = 30) {
  const { rows } = await db.query(
    'SELECT data FROM bridge_activities WHERE wallet_address = $1 ORDER BY updated_at DESC LIMIT $2',
    [normalizeWallet(walletAddress), limit],
  );
  const activities = rows
    .map(r => normalizeActivity(r.data))
    .filter(Boolean);

  const hasAutoReady = activities.some(act => act.status === STATUS.READY_TO_MINT && act.mode === 'auto');
  if (hasAutoReady) {
    setImmediate(() => {
      pollOnce().catch(e => console.error('[BRIDGE-POLL]', e.message));
    });
  }

  return activities;
}

async function getPendingActivities() {
  const { rows } = await db.query(
    `SELECT data FROM bridge_activities
      WHERE status = $1
        AND data ? 'messageHash'`,
    [STATUS.PENDING_ATTESTATION],
  );
  return rows.map(r => normalizeActivity(r.data)).filter(Boolean);
}

async function getAutoMintActivities() {
  const { rows } = await db.query(
    'SELECT data FROM bridge_activities WHERE status = $1 AND mode = $2',
    [STATUS.READY_TO_MINT, 'auto'],
  );
  return rows.map(r => normalizeActivity(r.data)).filter(Boolean);
}

async function getPendingNativeActivities() {
  const { rows } = await db.query(
    `SELECT data FROM bridge_activities
      WHERE bridge_type = 'native'
        AND status NOT IN ($1, $2, $3)`,
    [STATUS.MINTED, STATUS.FAILED, STATUS.DISMISSED],
  );
  return rows.map(r => normalizeActivity(r.data)).filter(Boolean);
}

async function dismissActivity(id, walletAddress) {
  const act = await getActivity(id);
  if (!act) throw Object.assign(new Error('Aktivite bulunamadı'), { status: 404 });
  if (act.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    throw Object.assign(new Error('Bu aktivite size ait değil'), { status: 403 });
  }
  return upsertActivity({ ...act, status: STATUS.DISMISSED });
}

// ── Circle Attestation Kontrolü ───────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' } }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
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

/**
 * Verilen messageHash için Circle Iris API'yi kontrol eder.
 * ready_to_mint ise { ready: true, attestation, message } döner.
 */
async function checkAttestation(fromChain, sourceTxHash, toChain, messageHash) {
  const sourceDomain = CHAIN_DOMAIN[fromChain];
  const destinationDomain = CHAIN_DOMAIN[toChain];
  if (sourceDomain === undefined) return { ready: false };

  try {
    if (sourceTxHash) {
      const data = await httpGet(`${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${sourceTxHash}`);
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      const readyMessage = messages.find(message => isIrisMessageMintReady(message, destinationDomain));
      if (readyMessage) {
        return {
          ready: true,
          attestation: readAttestationValue(readyMessage),
          message: readyMessage.message,
        };
      }
    }

    if (messageHash) {
      const data = await httpGet(`${IRIS_API}/v1/messages/${sourceDomain}/${messageHash}`);
      const msg = data?.messages?.[0];
      if (msg && isIrisMessageMintReady(msg, destinationDomain)) {
        return {
          ready: true,
          attestation: readAttestationValue(msg),
          message: msg.message,
        };
      }
    }
  } catch {
    return { ready: false };
  }

  return { ready: false };
}

// ── Arka Plan Attestation Poller ─────────────────────────────────────────────
// Her POLL_INTERVAL ms'de bir pending aktiviteleri kontrol eder.
// ready_to_mint durumuna geçenleri günceller.
// mode='auto' olan aktiviteleri otomatik mint eder (cctpMint ile).

const POLL_INTERVAL = 60_000; // 60 saniye — Upstash free tier koruma
let _pollTimer = null;
let _mintFn = null; // agentWalletService.cctpMint inject edilir (circular dep kaçınmak için)
let _agentFetchFn = null; // agentService.getAgentWithKeyById inject edilir

function setMintInjection(mintFn, agentFetchFn) {
  _mintFn     = mintFn;
  _agentFetchFn = agentFetchFn;
}

async function attemptAutoMint(act) {
  if (!_mintFn || !_agentFetchFn) return;
  if (act.mode !== 'auto' || act.status !== STATUS.READY_TO_MINT) return;

  let current = act;
  if (!current.attestation || !current.attestedMessage) {
    const { ready, attestation, message } = await checkAttestation(
      current.fromChain,
      current.sourceTxHash,
      current.toChain,
      current.messageHash,
    );
    if (!ready || !attestation || !message) return;

    current = await upsertActivity({
      ...current,
      status: STATUS.READY_TO_MINT,
      attestation,
      attestedMessage: message,
    });
  }

  console.log(`[BRIDGE-POLL] auto-mint başlıyor: activity=${current.id}`);
  try {
    const agent = await _agentFetchFn(current.agentId);
    if (!agent) {
      console.warn(`[BRIDGE-POLL] agent bulunamadı: ${current.agentId}`);
      return;
    }

    const { mintTxHash } = await _mintFn({
      agent,
      toChain: current.toChain,
      message: current.attestedMessage,
      attestation: current.attestation,
    });

    await upsertActivity({ ...current, status: STATUS.MINTED, mintTxHash });
    if (current.txId) {
      const db = require('../db');
      await db.query(
        "UPDATE transactions SET status='confirmed', tx_hash=$1, confirmed_at=NOW(), meta = meta || $2::jsonb WHERE id=$3",
        [mintTxHash, JSON.stringify({ bridgeStep: 'complete', mintTxHash }), current.txId],
      ).catch(() => {});
    }
    console.log(`[BRIDGE-POLL] auto-mint ✓: mintTxHash=${mintTxHash}`);
  } catch (mintErr) {
    const msg = String(mintErr.message || mintErr);
    console.error(`[BRIDGE-POLL] auto-mint hata: ${msg}`);
    if (msg.toLowerCase().includes('nonce already used')) {
      await upsertActivity({ ...act, status: STATUS.MINTED }).catch(() => {});
    }
  }
}

async function attemptNativeBridgeCompletion(act) {
  if (act.bridgeType !== 'native' || TERMINAL_STATUSES.has(act.status)) return;
  if (!act.walletAddress || !act.toChain || !act.amountWei || act.destinationBalanceBeforeWei == null) return;

  const amountWei = BigInt(act.amountWei);
  const balanceBeforeWei = BigInt(act.destinationBalanceBeforeWei);
  const currentBalanceWei = await agentWalletService.getNativeBalance(act.toChain, act.walletAddress).catch(() => null);
  if (currentBalanceWei == null) return;

  if (currentBalanceWei < balanceBeforeWei + amountWei) {
    if (act.status !== STATUS.PENDING_DESTINATION && act.sourceTxHash) {
      await upsertActivity({ ...act, status: STATUS.PENDING_DESTINATION });
    }
    return;
  }

  const destinationReceipt = await agentWalletService.findRecentIncomingNativeTransfer({
    chainName: act.toChain,
    recipient: act.walletAddress,
    amountWei,
    startBlock: act.destinationStartBlock,
  }).catch(() => null);

  const destinationTxHash = destinationReceipt?.hash || act.destinationTxHash || act.mintTxHash || null;
  await upsertActivity({
    ...act,
    status: STATUS.MINTED,
    destinationTxHash,
    mintTxHash: destinationTxHash || act.mintTxHash,
    destinationBalanceAfterWei: currentBalanceWei.toString(),
  });

  if (!act.txId) return;

  const db = require('../db');
  const metaPatch = {
    bridgeStep: 'complete',
    bridgeCompletionStatus: 'received',
    destinationBalanceEthAfter: ethers.formatEther(currentBalanceWei),
    ...(act.sourceTxHash ? { sourceTxHash: act.sourceTxHash } : {}),
    ...(destinationTxHash ? { destinationTxHash, mintTxHash: destinationTxHash } : {}),
  };

  if (destinationTxHash) {
    await db.query(
      "UPDATE transactions SET status='confirmed', tx_hash=$1, confirmed_at=NOW(), meta = meta || $2::jsonb WHERE id=$3",
      [destinationTxHash, JSON.stringify(metaPatch), act.txId],
    ).catch(() => {});
    return;
  }

  await db.query(
    "UPDATE transactions SET status='confirmed', confirmed_at=NOW(), meta = meta || $1::jsonb WHERE id=$2",
    [JSON.stringify(metaPatch), act.txId],
  ).catch(() => {});
}

async function pollOnce() {
  let pending;
  try { pending = await getPendingActivities(); }
  catch (e) { console.error('[BRIDGE-POLL] getPendingActivities error:', e.message); return; }

  for (const act of pending) {
    try {
      if (!act.messageHash) continue;

      const { ready, attestation, message } = await checkAttestation(act.fromChain, act.sourceTxHash, act.toChain, act.messageHash);
      if (!ready) continue;

      console.log(`[BRIDGE-POLL] ready_to_mint: activity=${act.id} wallet=${act.walletAddress}`);

      // Attestation verilerini kaydet + durumu güncelle
      const updated = await upsertActivity({
        ...act,
        status:      STATUS.READY_TO_MINT,
        attestation,
        attestedMessage: message,
      });
    } catch (err) {
      console.error(`[BRIDGE-POLL] activity ${act.id} error:`, err.message);
    }
  }

  let autoReady;
  try { autoReady = await getAutoMintActivities(); }
  catch (e) { console.error('[BRIDGE-POLL] getAutoMintActivities error:', e.message); return; }

  for (const act of autoReady) {
    await attemptAutoMint(act);
  }

  let nativePending;
  try { nativePending = await getPendingNativeActivities(); }
  catch (e) { console.error('[BRIDGE-POLL] getPendingNativeActivities error:', e.message); return; }

  for (const act of nativePending) {
    try {
      await attemptNativeBridgeCompletion(act);
    } catch (err) {
      console.error(`[BRIDGE-POLL] native activity ${act.id} error:`, err.message);
    }
  }
}

function startPoller() {
  if (_pollTimer) return;
  pollOnce().catch(e => console.error('[BRIDGE-POLL]', e.message));
  _pollTimer = setInterval(() => { pollOnce().catch(e => console.error('[BRIDGE-POLL]', e.message)); }, POLL_INTERVAL);
  console.log(`[BRIDGE-POLL] Attestation poller started (interval=${POLL_INTERVAL / 1000}s)`);
}

function stopPoller() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  STATUS,
  upsertActivity,
  getActivity,
  getActivitiesForWallet,
  getPendingActivities,
  dismissActivity,
  checkAttestation,
  startPoller,
  stopPoller,
  setMintInjection,
};
