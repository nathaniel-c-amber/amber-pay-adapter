import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors.js';
import type { FailureRepository } from '../types/repository.js';
import type { PolicyAttribute } from '../types/auth.js';

/**
 * Derive the organization ids the caller is authorized to ACK for the
 * dashboard scope, from the token policy (C1). Never trusts the request body
 * or query for the authorized set — the repository enforces org-scoping.
 */
function ackOrganizationIds(policy: PolicyAttribute[]): string[] {
  return [
    ...new Set(
      policy
        .filter((attribute) => attribute.scope === 'dashboard' && attribute.actions.includes('ack'))
        .map((attribute) => attribute.organizationId),
    ),
  ];
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
      if (organizationIds.length === 0) {
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
