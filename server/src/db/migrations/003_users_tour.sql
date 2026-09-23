-- 003_users_tour.sql
-- First-run guided tour completion.
--
-- NULL  = this account has never finished or dismissed the tour, so the console
--         may offer it once on the next sign-in.
-- stamp = finished, OR explicitly skipped. The tour is not offered automatically
--         again; the user can still replay it from Profile.
--
-- Operational metadata only: no financial data, no customer PII (FR-2.3 / FR-5.2).
ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_completed_at timestamptz;

-- Existing accounts pre-date the tour. Without this, every current user would be
-- ambushed by it on their next sign-in. Accounts created from here on are NOT
-- covered by this statement — they start NULL and are toured once, which is the
-- intent. (The environment-seeded super admin is additionally stamped at seed
-- time in db/seed.ts, so a fresh install never tours its own installer.)
UPDATE users SET tour_completed_at = now() WHERE tour_completed_at IS NULL;
