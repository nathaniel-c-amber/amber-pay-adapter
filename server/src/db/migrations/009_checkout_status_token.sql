-- 009_checkout_status_token.sql
-- The customer's unguessable handle on their own payment, and the outcome the
-- gateway reported for it.
--
-- WHY A TOKEN AT ALL. The gateway was registered with the SAME URL as both its
-- "Callback API URL" and its "Redirect URL": POST /api/v1/webhooks/amber-pay.
-- That is deliberate — the browser redirect doubles as a manual re-trigger of
-- the webhook when the server-to-server call failed — but it means the person
-- arriving back from the gateway has no session, holds no uuid (ours, and it
-- never leaves this origin), and is not the operator an authenticated endpoint
-- is written for. Something in the URL has to be both the identifier and the
-- credential. The transaction id cannot be it: it is 12 alphanumerics drawn
-- from 36 characters with the generation biased away from time prefixes, which
-- is ample for a key we never publish and thin for one we do.
--
-- 32 RANDOM BYTES, base64url. 256 bits is not a guessable space, so this is a
-- capability URL rather than a guessable reference, and it is stored in the
-- clear ON PURPOSE. It must be resolvable by lookup from an unauthenticated GET,
-- and a hash would buy nothing here: at 256 bits an offline attack over the
-- stored value is not a threat model, while every hash would add a column, a
-- constant-time comparison, and a second failure mode to the simplest read in
-- the system.
--
-- ★ SHORT-LIVED, BUT DELIBERATELY NOT SINGLE-USE. This was specified as a
-- one-time token, and it is not, on purpose. This is the page a customer lands
-- on AFTER paying, and a consumed token breaks exactly the behaviours people
-- reach for at that moment: refresh, the back button, "open in new tab", a
-- forwarded link to a relative. Each of those would render a dead page, and each
-- dead page is a support call raised while the customer is mid-payment. The
-- window below is the control; single use is not, because the thing being
-- protected is a read of a status the customer already paid for, and repeating
-- a read of it adds no material risk at 256 bits. To make it single-use, set
-- `status_token_consumed_at = now()` in the read path and filter on it — no
-- other change is needed, because nothing else has to change for that to work.
--
-- 30 DAYS. Long enough that a forgotten bookmark, a re-sent email thread or a
-- parent's delayed browser still resolves; short enough that a link pasted into
-- a group chat stops working a month later. The expiry is STORED rather than
-- derived from `created_at`, so the window is a per-row fact an operator can
-- read, and shortening or extending it later is a policy change rather than a
-- data migration that has to guess what the original intent was.
--
-- NULLABLE. Every intent already in the table predates this column, and minting
-- a token for a checkout nobody is waiting on would be inventing a handle for a
-- payment that has not happened. A missing token is a true statement: this row
-- cannot be resolved by a public link.
--
-- `outcome` AND `failure_reason` ARE THE CUSTOMER-FACING HALF OF THE CALLBACK.
-- Until now the gateway's verdict was recorded as lifecycle events and nothing
-- else — which meant the page a customer is redirected to could not tell them
-- whether their payment had been collected, or why it had not. `outcome` holds
-- the verdict; `failure_reason` holds the gateway's OWN words for it
-- (`ErrorMessage`, falling back to `ResponseMsg`), which is the customer's own
-- decline text quoted back to them and not a payment instrument detail. The
-- amount, the currency and every card field stay out of this table: the figure
-- is already inside `expected_sealed` and nothing about a reason may widen that.
--
-- The CHECK is the vocabulary, stated in the database rather than only in a
-- TypeScript union: `unknown` is deliberately absent because it is an ABSENCE
-- of a verdict (the callback has not been processed), and a column that could
-- hold the string 'unknown' would make "we don't know" indistinguishable from
-- "the gateway said unknown" — the same confusion a nullable column exists to
-- prevent. `pending` is here for the follow-up that reads the gateway's status
-- API; the callback only ever reports Success or Failed, so nothing writes it
-- yet.
--
-- `IF NOT EXISTS` keeps the file replayable: the migrator wraps each script in
-- a transaction and records it by filename, so an already-applied migration is
-- skipped — but a database rebuilt from an earlier schema snapshot may reach
-- these statements with the columns present.
ALTER TABLE checkout_intents
  ADD COLUMN IF NOT EXISTS status_token text,
  ADD COLUMN IF NOT EXISTS status_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome text,
  ADD COLUMN IF NOT EXISTS failure_reason text;

ALTER TABLE checkout_intents
  DROP CONSTRAINT IF EXISTS checkout_intents_outcome;

ALTER TABLE checkout_intents
  ADD CONSTRAINT checkout_intents_outcome
  CHECK (outcome IS NULL OR outcome IN ('collected', 'failed', 'pending'));

-- ★ UNIQUE, not merely indexed. A duplicate status token would make two
-- different customers' payments resolve to one page, so the guarantee has to be
-- the database's — an application check races two concurrent checkouts, both
-- pass, and the collision is written. PARTIAL, because every row that predates
-- this migration has no token at all and a plain unique index would treat all of
-- them as colliding with each other (SQL NULLs are exempt, which is exactly why
-- `WHERE ... IS NOT NULL` is load-bearing rather than tidiness).
--
-- Also the only index this table needs for the status lookup, which is a single
-- equality probe from an anonymous request.
CREATE UNIQUE INDEX IF NOT EXISTS checkout_intents_status_token
  ON checkout_intents (status_token)
  WHERE status_token IS NOT NULL;