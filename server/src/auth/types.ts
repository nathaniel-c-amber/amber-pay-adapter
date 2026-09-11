import type { PolicyAction, User } from '../domain/types.js';

/**
 * A single PBAC policy attribute granted to a user. Authorization is entirely
 * attribute-driven — there are no static roles (FR-1.4).
 */
export interface PolicyAttribute {
  scope: string;
  organizationId: string;
  actions: PolicyAction[];
}

/**
 * Internal auth user: the domain `User` plus the PBAC attributes granted at
 * invite time. This is an auth-internal record (not part of the domain model).
 */
export interface AuthUser extends User {
  policyAttributes: PolicyAttribute[];
}

/**
 * An invitation to create an account (FR-1.1 / FR-1.2 / FR-1.3).
 *
 * Only the SHA-256 HASH of the invite token is stored — the raw token is
 * returned to the caller exactly once and emailed to the recipient.
 */
export interface Invite {
  id: string;
  email: string;
  policyAttributes: PolicyAttribute[];
  tokenHash: string;
  expiresAt: string; // ISO 8601
  acceptedAt?: string; // ISO 8601
  createdAt: string; // ISO 8601
}

/**
 * Decoded access-token payload. Short-lived (≤ 1 hour, FR-1.5). Carries the
 * user's policy attributes so PBAC can be evaluated per request.
 */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  policy: PolicyAttribute[];
  iat: number;
  exp: number;
}

/** The resource an access decision is evaluated against. */
export interface PolicyResource {
  scope: string;
  organizationId: string;
  action: PolicyAction;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

/**
 * An in-flight email 2FA challenge. Only the SHA-256 HASH of the 6-digit code
 * is stored, alongside an expiry and an attempt counter.
 * The raw code is only included in dev/test environments for convenience.
 */
export interface TwoFactorChallenge {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: string; // ISO 8601
  attempts: number;
  /** Raw 2FA code — only set in non-production environments. Never persisted. */
  code?: string;
}
