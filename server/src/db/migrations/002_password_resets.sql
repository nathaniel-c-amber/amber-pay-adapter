-- 002_password_resets.sql
-- Self-service password reset (credential recovery).
--
-- PRIVACY: this table holds no secrets in the clear. Only the SHA-256 HASH of
-- the reset token is stored; the raw token is emailed to the account holder and
-- is never persisted or logged.
--
-- SINGLE USE: `used_at` is stamped when the token is redeemed, so a reset link
-- cannot be replayed. Requesting a new reset marks every outstanding token for
-- that user used, so only the most recent link is ever valid.
--
-- NOTE: unlike `users`/`invites`, `user_id` is a uuid FK — a reset always
-- belongs to a real account, and the cascade keeps the table clean when the
-- account is removed.

CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at ON password_resets (expires_at);
