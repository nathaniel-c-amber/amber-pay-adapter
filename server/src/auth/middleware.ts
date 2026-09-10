import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { verifyAccessToken } from './tokens.js';
import { evaluatePolicy } from './pbac.js';
import type { AccessTokenPayload, PolicyResource } from './types.js';
import type { PolicyAction } from '../domain/types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by `requireAuth` after a valid access token is verified. */
      auth?: AccessTokenPayload;
    }
  }
}

/**
 * Extract and verify the Bearer access token, attaching the decoded payload to
 * `req.auth`. Responds 401 when missing/invalid/expired.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing bearer token'));
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch (err) {
    next(err instanceof UnauthorizedError ? err : new UnauthorizedError('Invalid access token'));
  }
};

/**
 * Build middleware that evaluates PBAC for a single action against a resource
 * derived per request. Responds 403 when the caller's policy does not grant
 * the action (FR-1.4).
 */
export function requirePolicy(
  action: PolicyAction,
  resourceOf: (req: Request) => Omit<PolicyResource, 'action'>,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      return next(new UnauthorizedError('Authentication required'));
    }
    const resource: PolicyResource = { ...resourceOf(req), action };
    const decision = evaluatePolicy(req.auth.policy, resource);
    if (!decision.allowed) {
      return next(new ForbiddenError(decision.reason));
    }
    next();
  };
}
