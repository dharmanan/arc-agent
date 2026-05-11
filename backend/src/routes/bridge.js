'use strict';
/**
 * Bridge Activity Routes — paralel köprü takibi (Redis tabanlı)
 *
 * GET  /api/bridge/activities?agentId=...&limit=30   — cüzdana ait tüm köprüler
 * POST /api/bridge/activities/:id/dismiss             — aktiviteyi gizle
 * POST /api/bridge/claim/:id                          — ready_to_mint aktiviteyi mint et
 * GET  /api/bridge/cron/attestations                  — cron endpoint (opsiyonel, manuel tetik)
 */
const router  = require('express').Router();
const { z }   = require('zod');
const { requireAuth }     = require('../middleware/auth');
const { txRateLimit }     = require('../middleware/rateLimit');
const agentService        = require('../services/agentService');
const bridgeActivity      = require('../services/bridgeActivityService');
const agentWalletService  = require('../services/agentWalletService');

router.use(requireAuth);
// txRateLimit only on mutating routes (POST) — GET /activities is polled frequently,
// no need to rate-limit it with Redis-backed counters

// ── GET /activities?agentId=...&limit=30 ─────────────────────────────────────
router.get('/activities', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const limit   = Math.min(parseInt(req.query.limit || '30', 10), 100);
    if (!agentId) return res.status(400).json({ error: 'agentId gerekli' });

    const agent = await agentService.getAgent(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'Agent bulunamadı' });

    const walletAddress = agent.walletAddress || agent.wallet_address;
    if (!walletAddress) return res.json({ activities: [] });

    const activities = await bridgeActivity.getActivitiesForWallet(walletAddress, limit);
    res.json({ activities });
  } catch (err) { next(err); }
});

// ── POST /activities/:id/dismiss ─────────────────────────────────────────────
router.post('/activities/:id/dismiss', txRateLimit, async (req, res, next) => {
  try {
    const agentId = req.body.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId gerekli' });

    const agent = await agentService.getAgent(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'Agent bulunamadı' });

    const walletAddress = agent.walletAddress || agent.wallet_address;
    const activity = await bridgeActivity.dismissActivity(req.params.id, walletAddress);
    res.json({ activity });
  } catch (err) { next(err); }
});

// ── POST /claim/:id — ready_to_mint aktiviteyi ajan ile mint et ───────────────
const claimSchema = z.object({
  agentId: z.string().uuid(),
});

router.post('/claim/:id', txRateLimit, async (req, res, next) => {
  try {
    const { agentId } = claimSchema.parse(req.body);

    const agent = await agentService.getAgent(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'Agent bulunamadı' });

    const walletAddress = agent.walletAddress || agent.wallet_address;
    const act = await bridgeActivity.getActivity(req.params.id);
    if (!act) return res.status(404).json({ error: 'Aktivite bulunamadı' });
    if (act.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'Bu aktivite size ait değil' });
    }
    if (act.status !== bridgeActivity.STATUS.READY_TO_MINT) {
      return res.status(400).json({ error: `Claim için aktivite ready_to_mint olmalı (şu an: ${act.status})` });
    }

    // Attestation verisi hazır mı? (poller kaydetmiş olmalı)
    let { attestation, attestedMessage } = act;

    // Poller henüz kaydetmediyse kendimiz kontrol edelim
    if (!attestation || !attestedMessage) {
      const check = await bridgeActivity.checkAttestation(act.fromChain, act.sourceTxHash, act.toChain, act.messageHash);
      if (!check.ready) return res.status(400).json({ error: 'Attestation henüz hazır değil' });
      attestation     = check.attestation;
      attestedMessage = check.message;
    }

    // Ajan private key ile mint et
    const rawAgent = await agentService.getAgentWithKey(agentId, req.user.userId);
    if (!rawAgent) return res.status(404).json({ error: 'Agent kaydı bulunamadı' });

    // Hemen 202 döndür, arka planda çalıştır
    res.status(202).json({ activityId: act.id, status: 'minting' });

    // Async mint
    agentWalletService.cctpMint({ agent: rawAgent, toChain: act.toChain, message: attestedMessage, attestation })
      .then(async ({ mintTxHash }) => {
        await bridgeActivity.upsertActivity({ ...act, status: bridgeActivity.STATUS.MINTED, mintTxHash });
        // DB kaydını da güncelle (varsa)
        if (act.txId) {
          const db = require('../db');
          await db.query(
            "UPDATE transactions SET status='confirmed', tx_hash=$1, confirmed_at=NOW(), meta = meta || $2::jsonb WHERE id=$3",
            [mintTxHash, JSON.stringify({ bridgeStep: 'complete', mintTxHash }), act.txId],
          ).catch(() => {});
        }
        console.log(`[BRIDGE-CLAIM] ✓ mint tamamlandı: activity=${act.id} mintTx=${mintTxHash}`);
      })
      .catch(err => {
        console.error(`[BRIDGE-CLAIM] mint hatası: ${err.message}`);
        // Nonce already used = zaten mint edilmiş
        if (err.message?.toLowerCase().includes('nonce already used')) {
          bridgeActivity.upsertActivity({ ...act, status: bridgeActivity.STATUS.MINTED }).catch(() => {});
        }
        // else: ready_to_mint kalır, kullanıcı tekrar deneyebilir
      });
  } catch (err) { next(err); }
});

// ── GET /cron/attestations — manuel tetik (cron veya test amaçlı) ─────────────
router.get('/cron/attestations', async (req, res, next) => {
  // Basit bir secret kontrolü (opsiyonel)
  const secret = process.env.BRIDGE_CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { pollOnce } = require('../services/bridgeActivityService');
    // pollOnce export edilmedi, startPoller içinde — direkt getPendingActivities + checkAttestation çağıralım
    const pending = await bridgeActivity.getPendingActivities();
    let readyToMint = 0;
    for (const act of pending) {
      if (!act.sourceTxHash && !act.messageHash) continue;
      const { ready, attestation, message } = await bridgeActivity.checkAttestation(act.fromChain, act.sourceTxHash, act.toChain, act.messageHash);
      if (ready) {
        await bridgeActivity.upsertActivity({ ...act, status: bridgeActivity.STATUS.READY_TO_MINT, attestation, attestedMessage: message });
        readyToMint++;
      }
    }
    res.json({ ok: true, scanned: pending.length, readyToMint });
  } catch (err) { next(err); }
});

module.exports = router;
