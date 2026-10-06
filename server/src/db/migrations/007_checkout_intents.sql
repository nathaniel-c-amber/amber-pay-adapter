-- 007_checkout_intents.sql
-- A record of every payment this deployment has ASKED for, written BEFORE the
-- gateway is asked.
--
-- WHY IT HAS TO BE WRITTEN FIRST. The gateway echoes back the TransactionId we
-- generate, and that echo is the ONLY link between an incoming callback and our
-- own record. Without a row already waiting, a payment could complete against
-- nothing and we would have no way to say whose it was or whether it was
-- expected. The documentation is explicit that the client generates and stores
-- this id "exactly before the customer initiates the payment process".
--
-- WHY UNIQUE. The transaction id is the idempotency key for the whole flow: the
-- callback is deduplicated on it, and the QuickBooks payment is written with it
-- as its reference number so a retried delivery cannot pay twice. All of that
-- rests on it never repeating — and "never" is a database property, not an
-- application check. An application check races two concurrent requests, both
-- pass, and the duplicate is written. A UNIQUE index cannot be raced: the second
-- insert fails.
--
-- SCOPED TO THE ORGANIZATION, matching every other operational row, so a single
-- id can never collide across deployments and a policy filter cannot leak one
-- organization's intent to another's operator.
--
-- PRIVACY (FR-2.3 / FR-5.2). This table names a STRATEGY and an EXPECTATION, not
-- a ledger. It holds no amount in the clear: `amount_sealed` carries the
-- AES-256-GCM envelope from utils/secrets.ts, so a database dump on its own
-- cannot be cross-checked or replayed. `currency` is the three-letter code the
-- gateway itself documents — it identifies no one and no sum.
--
-- `student_id` is an opaque organization identifier (e.g. `STU0026`), which the
-- gateway echoes back on the callback. It is what an accounting customer is
-- matched on, so it is stored in the clear deliberately: it is the join key, and
-- it is deliberately NOT the customer's name.
--
-- `gen_random_uuid()` is built into PostgreSQL 16 (see the note in 001), so no
-- `pgcrypto` extension is needed here either.
--
-- The intent, keyed by the id the gateway will echo back.
CREATE TABLE IF NOT EXISTS checkout_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  -- OURS, and never repeated: the callback's identity and the idempotency key
  -- for the whole payment, including the QuickBooks write that carries it as
  -- PaymentRefNum. 12 characters, alphanumeric — see amberPayWire.ts.
  transaction_id text NOT NULL,
  -- The customer this payment is for. An opaque organization identifier, NOT a
  -- name and NOT a contact detail.
  student_id text NOT NULL,
  -- The expected figure AND its currency, sealed together into one AES-256-GCM
  -- envelope. Two columns would have been the obvious choice, and wrong twice
  -- over: `db/migrations.test.ts` forbids a currency column in the schema at
  -- all, and a figure and a currency that can drift apart are a cross-check
  -- that silently compares 25000 JMD against a USD expectation. Sealing them as
  -- one value makes that impossible.
  expected_sealed bytea NOT NULL,
  -- Null until the callback arrives; set when it does, so a second callback for
  -- the same id is visibly a duplicate rather than an unexplained repeat.
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- THE UNIQUENESS GUARANTEE. Partial, so the constraint describes exactly what it
-- protects: one id per organization. See the header for why this cannot be an
-- application check.
CREATE UNIQUE INDEX IF NOT EXISTS checkout_intents_unique
  ON checkout_intents (organization_id, transaction_id);

-- A callback arrives by transaction id and needs the student it was for; without
-- this it would be a sequential scan of every intent ever created.
CREATE INDEX IF NOT EXISTS checkout_intents_lookup
  ON checkout_intents (organization_id, transaction_id)
  WHERE settled_at IS NULL;