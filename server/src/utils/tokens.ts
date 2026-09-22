import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';
import { InternalError, UnauthorizedError } from './errors.js';
import { parseDurationSeconds } from './duration.js';
import type { AccessTokenPayload, PolicyAttribute } from '../types/auth.js';

/** Access tokens MUST be short-lived (FR-1.5): hard cap of 1 hour. */
export const MAX_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Resolve a configured duration to seconds, rejecting any value above the 1h
 * cap. Exported so the cap can be unit-tested directly.
 */
export function resolveAccessTokenTtlSeconds(ttl: string): number {
  const seconds = parseDurationSeconds(ttl);
  if (seconds <= 0) {
    throw new InternalError(`JWT_TTL must be positive (got '${ttl}')`);
  }
  if (seconds > MAX_ACCESS_TOKEN_TTL_SECONDS) {
    throw new InternalError(`JWT_TTL must not exceed 1 hour (got '${ttl}')`);
  }
  return seconds;
}

const policyAttributeSchema = z.object({
  scope: z.string(),
  organizationId: z.string(),
  actions: z.array(z.enum(['read', 'ack', 'write', 'admin'])),
});

const accessTokenPayloadSchema = z.object({
  sub: z.string(),
  email: z.string(),
  policy: z.array(policyAttributeSchema),
  iat: z.number().optional(),
  exp: z.number().optional(),
});

/** The subset of a user needed to mint an access token. */
export interface TokenUser {
  id: string;
  email: string;
  policyAttributes: PolicyAttribute[];
}

/**
 * Issue a short-lived (≤ 1h) access token carrying the user's PBAC policy.
 *
 * NOTE (accepted trade-off): the policy is embedded in the token, so policy
 * changes only take effect when the token is refreshed (up to 1h). This is
 * acceptable for a monitoring system with short-lived tokens; endpoint-level
 * PBAC still evaluates dynamically against whatever policy the token carries.
 */
export function issueAccessToken(user: TokenUser): string {
  const ttlSeconds = resolveAccessTokenTtlSeconds(env.JWT_TTL);
  return jwt.sign(
    { sub: user.id, email: user.email, policy: user.policyAttributes },
    env.JWT_SECRET,
    { expiresIn: ttlSeconds },
  );
}

/**
 * Verify an access token, enforcing signature validity and expiry, and return
 * the typed payload. The embedded policy is shape-validated so a malformed
 * token can never smuggle an invalid policy past PBAC. Throws
 * `UnauthorizedError` on any failure.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }

  const result = accessTokenPayloadSchema.safeParse(decoded);
  if (!result.success) {
    throw new UnauthorizedError('Invalid access token payload');
  }

  return {
    sub: result.data.sub,
    email: result.data.email,
    policy: result.data.policy,
    iat: result.data.iat ?? 0,
    exp: result.data.exp ?? 0,
  };
}

// Fail fast at startup: enforce the 1h access-token cap (FR-1.5) as soon as
// this module loads, not merely when a token is first issued.
resolveAccessTokenTtlSeconds(env.JWT_TTL);
