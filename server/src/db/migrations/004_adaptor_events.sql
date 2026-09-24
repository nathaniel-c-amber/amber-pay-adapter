-- 004_adaptor_events.sql
-- Widen the lifecycle event type CHECK constraint.
--
-- WHY: the console reports accounting-adaptor reachability (the Overview's
-- service window, the Connections rows), but those observations wrote nothing
-- to the event log — QuickBooks could answer 401 on every probe while the Event
-- log page stayed empty. The probe now files state CHANGES as lifecycle events,
-- which needs the constraint widened.
--
-- This also fixes a live bug: 'payment-refunded' has been in
-- LifecycleEventType (src/models/domain.ts) and is written by the webhook
-- processor, but was NEVER added to the constraint below, so on a Postgres
-- deployment every refund event failed its INSERT — the processor caught it,
-- released the dedup claim and retried the webhook forever.
--
-- Mirrors LifecycleEventType in src/models/domain.ts: a new event type needs a
-- migration, not just a TypeScript edit.
--
-- The constraint is dropped BY INSPECTION rather than by a guessed name. 001
-- declared it inline (`type text NOT NULL CHECK (...)`), so PostgreSQL named it
-- `lifecycle_events_type_check` — but `DROP CONSTRAINT IF EXISTS <guess>` would
-- have failed silently on any other name and then ADD CONSTRAINT would have
-- installed a SECOND check beside the old one. Both would apply, the old one
-- would still reject the new types, and the only symptom would be a real event
-- failing to insert in production.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'lifecycle_events'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) ILIKE '%type = ANY%'
        OR pg_get_constraintdef(oid) ILIKE '%type IN%'
      )
  LOOP
    EXECUTE format('ALTER TABLE lifecycle_events DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE lifecycle_events ADD CONSTRAINT lifecycle_events_type_check CHECK (
  type IN (
    'initiated',
    'collected',
    'record-updated',
    'sync-change',
    'webhook-received',
    'payment-declined',
    'payment-failed',
    'payment-refunded',
    'adaptor-unreachable',
    'adaptor-auth-failed',
    'adaptor-restored'
  )
);
