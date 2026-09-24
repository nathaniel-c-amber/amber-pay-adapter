-- 005_deployment_settings.sql
-- Configuration for the ONE organization this deployment serves.
--
-- WHY A TABLE AND NOT .env: the onboarding wizard runs against a live
-- deployment, through nginx or the tunnel. Writing an environment file from the
-- running process means file permissions, a restart to re-read it, config drift
-- from the process that is already up, and -- because config/env.ts validates at
-- boot and refuses to start -- a bad write that takes the API down. So anything
-- an administrator sets lives here instead.
--
-- The values that must stay in the environment are the ones needed to REACH this
-- table: DATABASE_URL, JWT_SECRET, SECRETS_KEY, ORGANIZATION_ID, SMTP_*, and the
-- proxy/CORS settings.
--
-- Secrets are never stored in the clear. The *_sealed columns hold a
-- self-describing AES-256-GCM envelope (version, nonce, auth tag, ciphertext)
-- produced by utils/secrets.ts. The key version travels INSIDE the envelope
-- rather than in a column, so each credential carries the key that sealed it and
-- a rotation can leave older rows readable.
--
-- ONE ROW, ENFORCED BY THE PRIMARY KEY. `id boolean PRIMARY KEY DEFAULT true
-- CHECK (id)` permits exactly the value true and therefore exactly one row, so
-- the wizard is an UPDATE and never an insert-or-update race.
CREATE TABLE IF NOT EXISTS deployment_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  organization_name text,
  gateway_client_id text,
  gateway_webhook_secret_sealed bytea,
  adaptor_id text CHECK (adaptor_id IN ('quickbooks', 'sage')),
  adaptor_realm_id text,
  adaptor_base_url text,
  adaptor_credentials_sealed bytea,
  sync_interval text,
  alert_target text,
  -- When the connection was last proven to work, and when the wizard finished.
  verified_at timestamptz,
  configured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Materialise the row so every read has something to select and no code path has
-- to decide whether "no row" means "unconfigured" or "not yet installed".
INSERT INTO deployment_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
