import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { evaluatePolicy } from '../utils/pbac.js';
import type { AccessTokenPayload, PolicyResource } from '../types/auth.js';
import type { PolicyAction } from '../models/domain.js';

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

/**
 * Build middleware requiring AT LEAST ONE of `actions` on a single resource.
 *
 * WHY ANY, NOT EACH: an operator who may manage this deployment is identified by
 * ONE idea — the console spells it `SYSTEM_MANAGE` — which is satisfied by
 * `system.write` OR `system.admin`. Expressed here as two gates in sequence it
 * would require BOTH, so an administrator holding only `admin` would be shown a
 * control the API then refuses. That mismatch is the same failure the console's
 * `has()` was tightened to remove, and it runs in the direction that wastes an
 * operator's time, so the gate matches the intention rather than the spelling.
 */
export function requirePolicyAnyAction(
  actions: PolicyAction[],
  resourceOf: (req: Request) => Omit<PolicyResource, 'action'>,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) {
      return next(new UnauthorizedError('Authentication required'));
    }
    const base = resourceOf(req);
    const allowed = actions.some(
      (action) => evaluatePolicy(auth.policy, { ...base, action }).allowed,
    );
    if (!allowed) {
      return next(
        new ForbiddenError(
          `No policy attribute grants '${actions.join("' or '")}' on scope '${base.scope}' for organization '${base.organizationId}'`,
        ),
      );
    }
    next();
  };
}

/**
 * Build middleware requiring `action` on `scope` for AT LEAST ONE organization.
 *
 * `requirePolicy` needs a concrete resource, which works for a request that
 * names the organization it targets. A directory listing does not: the caller
 * is asking "who exists across everything I administer", so there is no single
 * `organizationId` in the request to evaluate against.
 *
 * This checks the reach, not a specific row — the controller must still narrow
 * the results to the organizations the caller actually administers (see
 * `administeredOrganizations`), so this is an entry gate, never the filter.
 * A wildcard organization satisfies it for any caller holding the action.
 */
export function requirePolicyAnyOrganization(
  action: PolicyAction,
  scope: string,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      return next(new UnauthorizedError('Authentication required'));
    }
    const holds = req.auth.policy.some(
      (attribute) =>
        (attribute.scope === '*' || attribute.scope === scope) &&
        attribute.actions.includes(action),
    );
    if (!holds) {
      return next(
        new ForbiddenError(
          `No policy attribute grants '${action}' on scope '${scope}' for any organization`,
        ),
      );
    }
    next();
  };
}
