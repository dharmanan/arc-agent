-- Arc Machina — PostgreSQL schema
-- Run via: psql $DATABASE_URL -f schema.sql
-- Docker: mounted to /docker-entrypoint-initdb.d/

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. USERS (identified by their EOA owner address)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_address       VARCHAR(42) NOT NULL UNIQUE,  -- EVM hex address (lowercase)
  failed_auth_count   SMALLINT NOT NULL DEFAULT 0,  -- brute-force counter
  locked_until        TIMESTAMPTZ,                  -- NULL = not locked
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration: add lockout columns to existing deployments
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_auth_count SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. PASSKEY CREDENTIALS (WebAuthn / FIDO2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id       TEXT NOT NULL UNIQUE,          -- base64url encoded
  public_key          TEXT NOT NULL,                 -- COSE public key bytes (base64url)
  counter             BIGINT NOT NULL DEFAULT 0,
  device_name         VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PASSKEY CHALLENGES (server-side challenge storage, short TTL)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS passkey_challenges (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
  challenge           TEXT NOT NULL,
  purpose             VARCHAR(20) NOT NULL,          -- 'register' | 'authenticate'
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_challenges_user ON passkey_challenges(user_id);

-- Auto-clean expired challenges
CREATE OR REPLACE FUNCTION delete_expired_challenges() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN DELETE FROM passkey_challenges WHERE expires_at < NOW(); RETURN NULL; END; $$;

DROP TRIGGER IF EXISTS trg_clean_challenges ON passkey_challenges;
CREATE TRIGGER trg_clean_challenges
  AFTER INSERT ON passkey_challenges
  EXECUTE FUNCTION delete_expired_challenges();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. AGENTS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                      VARCHAR(100) NOT NULL,

  -- Smart contract wallet deployed on Arc Testnet
  wallet_address            VARCHAR(42),

  -- Agent's own EOA private key, AES-256-GCM encrypted at rest.
  -- Decrypted server-side ONLY for agentic execution within approved limits.
  -- Never logged or returned to clients.
  private_key_encrypted     TEXT,

  -- Security
  daily_limit_usdc          NUMERIC(20,6) NOT NULL DEFAULT 1000,
  max_gas_gwei              INTEGER        NOT NULL DEFAULT 50,
  slippage_percent          NUMERIC(5,2)   NOT NULL DEFAULT 0.5,
  max_trade_usdc            NUMERIC(20,6)  NOT NULL DEFAULT 200,
  auto_lock_minutes         INTEGER        NOT NULL DEFAULT 5,
  contract_guard_enabled    BOOLEAN        NOT NULL DEFAULT TRUE,
  totp_enabled              BOOLEAN        NOT NULL DEFAULT FALSE,
  passkey_enabled           BOOLEAN        NOT NULL DEFAULT TRUE,

  -- LLM (key encrypted at rest with AES-256-GCM via ENCRYPTION_KEY)
  llm_api_key_encrypted     TEXT,
  llm_model                 VARCHAR(100),
  is_smart_mode             BOOLEAN        NOT NULL DEFAULT FALSE,

  -- Runtime state
  status                    VARCHAR(20)    NOT NULL DEFAULT 'idle',  -- idle|active|locked
  daily_spent_usdc          NUMERIC(20,6)  NOT NULL DEFAULT 0,
  last_reset_day            DATE           NOT NULL DEFAULT CURRENT_DATE,
  market_analysis_last_run_at TIMESTAMPTZ,
  market_analysis_last_status VARCHAR(30) NOT NULL DEFAULT 'idle',
  oracle_last_run_at         TIMESTAMPTZ,
  oracle_last_status         VARCHAR(30) NOT NULL DEFAULT 'idle',
  defi_loop_last_run_at      TIMESTAMPTZ,
  defi_loop_last_status      VARCHAR(30) NOT NULL DEFAULT 'idle',
  reputation_last_run_at     TIMESTAMPTZ,
  reputation_last_status     VARCHAR(30) NOT NULL DEFAULT 'idle',

  -- ERC-8004 onchain identity (Arc Testnet IdentityRegistry)
  -- status: 'pending' | 'registered' | 'failed'
  erc8004_status            VARCHAR(20)    NOT NULL DEFAULT 'pending',
  erc8004_token_id          VARCHAR(100),   -- NFT token ID from IdentityRegistry
  erc8004_tx_hash           VARCHAR(100),   -- registration tx hash
  erc8004_registered_at     TIMESTAMPTZ,
  erc8004_error             TEXT,           -- last error message if failed

  created_at                TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);

-- ── Migrations (idempotent) ───────────────────────────────────────────────────
-- Add private_key_encrypted if the column was missing from an earlier schema
ALTER TABLE agents ADD COLUMN IF NOT EXISTS private_key_encrypted TEXT;

-- ERC-8004 identity columns (added after initial schema)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_status        VARCHAR(20)  NOT NULL DEFAULT 'pending';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_token_id      VARCHAR(100);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_tx_hash       VARCHAR(100);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_registered_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_error         TEXT;

-- Faza 2.0: opt-in feature flags (all default OFF — nothing runs without user choice)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS daily_tasks_enabled        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS market_analysis_enabled    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS oracle_enabled             BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS defi_loop_enabled          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_enabled         BOOLEAN NOT NULL DEFAULT FALSE;

-- Faza 2.0: daily operation counters (reset at 00:00 UTC via daily_limit_reset_at)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS daily_free_task_count       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS daily_paid_task_count       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS daily_defi_loop_count       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS daily_market_analysis_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS daily_auto_tx_count         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS daily_limit_reset_at        TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE agents ADD COLUMN IF NOT EXISTS market_analysis_last_run_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS market_analysis_last_status VARCHAR(30) NOT NULL DEFAULT 'idle';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS oracle_last_run_at         TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS oracle_last_status         VARCHAR(30) NOT NULL DEFAULT 'idle';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS defi_loop_last_run_at      TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS defi_loop_last_status      VARCHAR(30) NOT NULL DEFAULT 'idle';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_last_run_at     TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_last_status     VARCHAR(30) NOT NULL DEFAULT 'idle';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. AGENT PERMISSIONS (only relevant in smart mode)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_permissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  permission_key VARCHAR(100) NOT NULL,               -- e.g. 'arbitrage', 'defi_scan'
  is_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, permission_key)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. SESSION KEYS (delegated signing authority, on-chain + off-chain record)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_keys (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key_address         VARCHAR(42) NOT NULL,           -- EOA address of the hot key
  daily_limit_usdc    NUMERIC(20,6) NOT NULL,
  allowed_contracts   TEXT[] NOT NULL DEFAULT '{}',
  expires_at          TIMESTAMPTZ NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sk_agent ON session_keys(agent_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. TRANSACTIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type            VARCHAR(20) NOT NULL,               -- send|receive|bridge|swap
  from_chain      VARCHAR(50),
  to_chain        VARCHAR(50),
  token           VARCHAR(20) NOT NULL DEFAULT 'USDC',
  amount_usdc     NUMERIC(20,6) NOT NULL,
  from_address    VARCHAR(100),
  to_address      VARCHAR(100),
  tx_hash         VARCHAR(100),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|confirmed|failed
  meta            JSONB,                              -- extra data (swap out amount, etc.)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tx_agent   ON transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_tx_status  ON transactions(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. CHAIN EVENTS (indexer queue — processed by Bull workers)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chain_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type       VARCHAR(100) NOT NULL,             -- e.g. 'Transfer', 'Swap'
  chain            VARCHAR(50) NOT NULL,
  contract_address VARCHAR(100) NOT NULL,
  block_number     BIGINT,
  tx_hash          VARCHAR(100),
  data             JSONB NOT NULL,
  processed        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_processed ON chain_events(processed) WHERE NOT processed;
CREATE INDEX IF NOT EXISTS idx_events_processed_created_at ON chain_events(created_at) WHERE processed = TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. LLM AUDIT LOG (every AI decision recorded for transparency)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID REFERENCES agents(id) ON DELETE SET NULL,
  model         VARCHAR(100) NOT NULL,
  prompt_hash   TEXT NOT NULL,                       -- SHA-256 of the prompt (not stored raw)
  decision      TEXT NOT NULL,
  latency_ms    INTEGER,
  from_cache    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_llm_agent ON llm_audit(agent_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. SECURITY POLICIES (per-agent whitelist/blacklist)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_policies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  policy_type    VARCHAR(30) NOT NULL,               -- 'whitelist_address' | 'blacklist_contract'
  value          VARCHAR(200) NOT NULL,
  note           VARCHAR(200),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, policy_type, value)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto updated_at trigger for agents
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_agents_updated_at ON agents;
CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. TASK CATALOG (static free/paid task definitions)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_catalog (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  tier        INTEGER NOT NULL DEFAULT 1,   -- 1=free, 2=paid
  fee_usdc    NUMERIC(10,4) NOT NULL DEFAULT 0,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE
);

-- Seed the 5 free daily tasks (idempotent)
INSERT INTO task_catalog (id, title, description, tier, fee_usdc, enabled) VALUES
  ('DAILY_PRICE_REPORT',  'FX Price Report',    'EURC/USDC + BRLA/USDC live rates via Frankfurter',        1, 0, true),
  ('DAILY_POOL_HEALTH',   'Pool Health Check',  'Curve pool spread%, virtual_price and coin balances',     1, 0, true),
  ('DAILY_YIELD_RANK',    'Yield Ranking',      'Top 3 APY opportunities across USDC/EURC pools',          1, 0, true),
  ('DAILY_ARB_SCAN',      'Arb Signal Scan',    'Stablecoin spread arbitrage opportunity detector',        1, 0, true),
  ('DAILY_WALLET_DIGEST', 'Wallet Digest',      '24h activity summary and agent wallet balance snapshot',  1, 0, true)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. AGENT TASK RESULTS (output of each DAILY_* job run)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_task_results (
  id         BIGSERIAL PRIMARY KEY,
  agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES task_catalog(id),
  payload    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_results_agent ON agent_task_results(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_results_task  ON agent_task_results(task_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. ORACLE PAYMENTS (x402 nanopayment audit log — one row per verified tx)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash     TEXT UNIQUE NOT NULL,
  endpoint    TEXT NOT NULL,                -- e.g. 'stablecoin-fx'
  amount_usdc NUMERIC(10,6) NOT NULL,
  from_addr   TEXT,                         -- payer address (from Transfer log)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oracle_payments_endpoint ON oracle_payments(endpoint, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 13.1 ORACLE ALERT EVENTS (threshold-triggered observability + alarm ledger)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_alert_events (
  id             BIGSERIAL PRIMARY KEY,
  event_type     TEXT NOT NULL,
  event_count    INTEGER NOT NULL,
  delivery       TEXT NOT NULL DEFAULT 'database',
  delivery_state TEXT NOT NULL,
  message        TEXT,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oracle_alert_events_type
  ON oracle_alert_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_alert_events_state
  ON oracle_alert_events(delivery_state, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. AGENT REPUTATION EVENTS (local record of ERC-8004 reputation calls)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_reputation_events (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,              -- e.g. 'TRANSACTION_COMPLETED'
  score_delta INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rep_events_agent ON agent_reputation_events(agent_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. AGENT JOBS (ERC-8183 AgenticCommerce escrow jobs)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  job_id_onchain    VARCHAR(100),        -- jobId from AgenticCommerce contract
  client_address    VARCHAR(42),         -- who created the job
  provider_address  VARCHAR(42),         -- agent wallet (fulfills the job)
  amount_usdc       NUMERIC(20,6),
  description       TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'funded',
                                         -- funded|delivered|completed|cancelled (legacy open rows may still exist)
  deliverable_hash  VARCHAR(100),        -- keccak256 hash of deliverable
  tx_hash_create    VARCHAR(100),
  tx_hash_deliver   VARCHAR(100),
  tx_hash_settle    VARCHAR(100),
  economy           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE agent_jobs ALTER COLUMN status SET DEFAULT 'funded';
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS economy JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE agent_jobs
SET status = 'funded', updated_at = NOW()
WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_jobs_agent  ON agent_jobs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON agent_jobs(status);

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON agent_jobs;
CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON agent_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 16. AGENTIC PAYMENT EVENTS (central audit log for gateway-backed economy)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agentic_payment_events (
  id                   BIGSERIAL PRIMARY KEY,
  agent_id             UUID REFERENCES agents(id) ON DELETE SET NULL,
  event_type           TEXT NOT NULL,
  rail                 TEXT NOT NULL,
  reference_type       TEXT NOT NULL,
  reference_id         TEXT,
  tx_hash              TEXT,
  amount_usdc          NUMERIC(20,6),
  token                TEXT NOT NULL DEFAULT 'USDC',
  status               TEXT NOT NULL,
  source_chain         TEXT,
  destination_chain    TEXT,
  counterparty_address TEXT,
  payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agentic_payment_events_agent
  ON agentic_payment_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agentic_payment_events_reference
  ON agentic_payment_events(reference_type, reference_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agentic_payment_events_rail
  ON agentic_payment_events(rail, created_at DESC);
