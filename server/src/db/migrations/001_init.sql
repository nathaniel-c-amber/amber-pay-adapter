-- 001_init.sql
-- Amber Pay operational schema.
--
-- PRIVACY (FR-2.3 / FR-5.2): this schema stores ONLY operational statuses and
-- reference hashes. It MUST NOT contain financial amounts, currency values,
-- customer PII, or raw card data. Note the absence of any amount/currency
-- columns on invoices/payments and of any customer identity columns.
--
-- TENANCY (C1): every operational/monitoring table carries `organization_id`
-- and is indexed on it. Reads are always filtered by the caller's authorized
-- organizations so PBAC org checks actually restrict returned data.
--
-- NOTE: `gen_random_uuid()` is built into PostgreSQL 16, so no `pgcrypto`
-- extension is required.

-- Auth entities (invite-only). `policy_attributes` holds the PBAC attributes
-- granted at invite time (operational metadata, not PII).
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  hashed_password text NOT NULL,
  policy_attributes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Accounting/ledger accounts (organization-scoped) — NOT customer accounts.
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  organization_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Invoices: operational status + external reference only. NO amount/currency.
CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  organization_id text NOT NULL,
  external_invoice_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'overdue', 'void')),
  due_date timestamptz
);

-- Payments: status + transaction reference hash only. NO amount.
-- `invoice_id` is a nullable TEXT reference (not a uuid FK): there is no
-- invoice-creation route, and the domain `Payment.invoiceId` is a string, so
-- the column must accept arbitrary opaque invoice ids to match the in-memory
-- behavior. No FK to `invoices` is declared for it.
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id text,
  organization_id text NOT NULL,
  transaction_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('initiated', 'collected', 'failed', 'refunded')),
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Reconciliation: typed counts only (matched/unmatched/anomalies). No
-- free-form financial JSON.
CREATE TABLE IF NOT EXISTS reconciliation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  matched integer NOT NULL DEFAULT 0,
  unmatched integer NOT NULL DEFAULT 0,
  anomalies integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL CHECK (
    type IN (
      'initiated',
      'collected',
      'record-updated',
      'sync-change',
      'webhook-received',
      'payment-declined',
      'payment-failed'
    )
  ),
  channel text NOT NULL CHECK (channel IN ('payment', 'accounting', 'webhook', 'system')),
  ref text NOT NULL,
  detail text NOT NULL
);

CREATE TABLE IF NOT EXISTS failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'attention')),
  channel text NOT NULL CHECK (channel IN ('payment', 'accounting', 'webhook', 'system')),
  title text NOT NULL,
  detail text NOT NULL,
  since timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);

CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  policy_attributes jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS two_factor_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz
);

-- Idempotency for replayed webhooks. Two-phase state: a webhook is inserted
-- as `processing` and only flipped to `processed` once it succeeds, so a
-- failed webhook remains retryable (M2).
CREATE TABLE IF NOT EXISTS processed_webhooks (
  id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'processing' CHECK (state IN ('processing', 'processed')),
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Dashboard connector states (monitoring).
CREATE TABLE IF NOT EXISTS connector_states (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  label text NOT NULL,
  terminus text NOT NULL CHECK (
    terminus IN ('quickbooks', 'sage', 'amber-pay', 'audit-trail')
  ),
  status text NOT NULL CHECK (status IN ('open', 'arriving', 'delayed', 'suspended')),
  reading text NOT NULL,
  note text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_organization ON accounts (organization_id);
CREATE INDEX IF NOT EXISTS idx_invoices_organization ON invoices (organization_id);
CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices (account_id);
CREATE INDEX IF NOT EXISTS idx_invoices_external ON invoices (external_invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_organization ON payments (organization_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_transaction ON payments (transaction_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_jobs_organization ON reconciliation_jobs (organization_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_jobs_run_at ON reconciliation_jobs (run_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_organization ON lifecycle_events (organization_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_at ON lifecycle_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_ref ON lifecycle_events (ref);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_type ON lifecycle_events (type);
CREATE INDEX IF NOT EXISTS idx_failures_organization ON failures (organization_id);
CREATE INDEX IF NOT EXISTS idx_failures_since ON failures (since DESC);
CREATE INDEX IF NOT EXISTS idx_failures_acknowledged_at ON failures (acknowledged_at);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites (email);
CREATE INDEX IF NOT EXISTS idx_invites_expires_at ON invites (expires_at);
CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_user ON two_factor_challenges (user_id);
CREATE INDEX IF NOT EXISTS idx_connector_states_organization ON connector_states (organization_id);