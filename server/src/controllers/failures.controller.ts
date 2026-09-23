import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors.js';
import type { FailureRepository } from '../types/repository.js';
import type { PolicyAttribute } from '../types/auth.js';

/**
 * Derive the organization ids the caller is authorized to ACK for the
 * dashboard scope, from the token policy (C1). Never trusts the request body
 * or query for the authorized set — the repository enforces org-scoping.
 *
 * Mirrors the canonical engine in `utils/pbac.ts`: a wildcard `scope` or
 * `organizationId` matches, and the action must still be named explicitly
 * (`admin` does not imply `ack`).
 *
 * Returns `null` for an unrestricted caller, which the repository reads as
 * "no organization filter". The previous exact-match version returned `[]` for
 * a super admin holding `{scope:'*', organizationId:'*'}`, so the
 * highest-privilege account in the system could not acknowledge anything; and
 * when the scope did match, a literal `'*'` organization was passed to
 * `WHERE organization_id = ANY($3)`, where it matched no row.
 */
function ackOrganizationIds(policy: PolicyAttribute[]): string[] | null {
  const grants = policy.filter(
    (attribute) =>
      (attribute.scope === 'dashboard' || attribute.scope === '*') &&
      attribute.actions.includes('ack'),
  );
  if (grants.length === 0) {
    return [];
  }
  if (grants.some((attribute) => attribute.organizationId === '*')) {
    return null;
  }
  return [...new Set(grants.map((attribute) => attribute.organizationId))];
}

export interface FailuresControllerDeps {
  failures: FailureRepository;
}

export interface FailuresController {
  /** POST /api/v1/failures/:id/acknowledge */
  acknowledgeFailure: RequestHandler;
}

/**
 * Failure acknowledgement.
 *
 * Authorization is decoupled from any request-supplied organization: the caller
 * must hold the `ack` action on the `dashboard` scope for at least one
 * organization (checked below), and the repository enforces org-scoping by
 * only acknowledging failures in the caller's authorized orgs (404 otherwise).
 */
export function createFailuresController(deps: FailuresControllerDeps): FailuresController {
  return {
    acknowledgeFailure: asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const organizationIds = ackOrganizationIds(req.auth.policy);
      if (organizationIds !== null && organizationIds.length === 0) {
        throw new ForbiddenError('No policy grants ack on scope dashboard');
      }
      const failureId = req.params.id;
      if (!failureId) {
        throw new NotFoundError('Failure not found');
      }
      const acknowledged = await deps.failures.acknowledge(
        failureId,
        new Date().toISOString(),
        organizationIds,
      );
      if (!acknowledged) {
        throw new NotFoundError('Failure not found');
      }
      res.status(200).json(acknowledged);
    }),
  };
}
