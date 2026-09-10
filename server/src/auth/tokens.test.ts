import jwt from 'jsonwebtoken';
import {
  MAX_ACCESS_TOKEN_TTL_SECONDS,
  issueAccessToken,
  resolveAccessTokenTtlSeconds,
  verifyAccessToken,
} from './tokens.js';
import { env } from '../config/env.js';
import { InternalError, UnauthorizedError } from '../lib/errors.js';
import type { PolicyAttribute } from './types.js';

const policy: PolicyAttribute[] = [
  { scope: 'users', organizationId: 'org-1', actions: ['admin'] },
];

const user = { id: 'u1', email: 'user@example.com', policyAttributes: policy };

describe('tokens', () => {
  it('issues and verifies an access token carrying the policy', () => {
    const token = issueAccessToken(user);
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe('u1');
    expect(payload.email).toBe('user@example.com');
    expect(payload.policy).toEqual(policy);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyAccessToken('not-a-token')).toThrow(UnauthorizedError);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign(
      { sub: 'u1', email: 'user@example.com', policy },
      env.JWT_SECRET,
      { expiresIn: -10 },
    );
    expect(() => verifyAccessToken(expired)).toThrow(UnauthorizedError);
  });

  it('rejects a configured TTL greater than 1 hour', () => {
    expect(() => resolveAccessTokenTtlSeconds('2h')).toThrow(InternalError);
    expect(() => resolveAccessTokenTtlSeconds('61m')).toThrow(InternalError);
  });

  it('accepts a TTL at or below the 1 hour cap', () => {
    expect(resolveAccessTokenTtlSeconds('30m')).toBe(1800);
    expect(resolveAccessTokenTtlSeconds('1h')).toBe(MAX_ACCESS_TOKEN_TTL_SECONDS);
  });
});
