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
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

  created_at                TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);

-- ── Migrations (idempotent) ───────────────────────────────────────────────────
-- Add private_key_encrypted if the column was missing from an earlier schema
ALTER TABLE agents ADD COLUMN IF NOT EXISTS private_key_encrypted TEXT;

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
