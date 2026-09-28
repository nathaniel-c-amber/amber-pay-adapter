-- 006_invoice_matching.sql
-- How a completed payment is matched to an accounting customer, and where the
-- money is deposited.
--
-- WHY A TABLE AND NOT .env, unchanged from 005: the operator sets these through
-- the console, and a running process cannot safely rewrite its own environment.
--
-- WHY THESE FOUR COLUMNS AND NOT ONE JSON BLOB. Every one of them is a value an
-- operator picks from a list or types once, and each needs its own constraint
-- and its own validation message. A blob would move every rule into application
-- code and give the database no say in whether the stored strategy is one the
-- pipeline can actually run.
--
-- `invoice_match_strategy` chooses WHERE the identifier is looked for on a
-- QuickBooks customer. The three values are not interchangeable in cost:
-- `displayName` and `customField` are a single lookup, while `notes` cannot be
-- searched upstream at all and is answered by paging through customers. The
-- value is constrained rather than free text so an unrunnable strategy cannot
-- be stored as though it were a supported one.
--
-- `invoice_match_field` names the QuickBooks custom field, and is required
-- only for the `customField` strategy. It is a NAME, not a numeric definition
-- id, because that is the only way the accounting query language can address
-- it — which also makes it the one value here a person types freely, and the
-- reason the application validates its character set rather than the database.
--
-- `payment_deposit_account_id` is optional. Left null, received money goes to
-- the provider's undeposited-funds account, which is the correct default and
-- the one a single-account deployment never needs to think about.
--
-- PRIVACY UNCHANGED (FR-2.3 / FR-5.2). These name a STRATEGY, not a value. No
-- identifier, no figure and no personal detail is stored here — the pipeline
-- reads the identifier from the payment at the moment it is used and does not
-- keep it.
--
-- NO `CREATE TABLE`: 005 owns that, and an `IF NOT EXISTS` here would be a
-- no-op on a fresh install and a second, narrower definition of the same table
-- on an upgrade that somehow ran out of order. Running before 005 must fail
-- loudly rather than quietly invent the table.
ALTER TABLE deployment_settings
  ADD COLUMN IF NOT EXISTS invoice_match_strategy text
    CHECK (invoice_match_strategy IN ('displayName', 'customField', 'notes'));
ALTER TABLE deployment_settings
  ADD COLUMN IF NOT EXISTS invoice_match_mode text
    CHECK (invoice_match_mode IN ('exact', 'contains'));
ALTER TABLE deployment_settings
  ADD COLUMN IF NOT EXISTS invoice_match_field text;
ALTER TABLE deployment_settings
  ADD COLUMN IF NOT EXISTS payment_deposit_account_id text;
