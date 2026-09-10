import express from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../lib/errors.js';
import { requireAuth } from '../auth/middleware.js';
import { getRepositories } from '../repositories/index.js';
import type { FailureRepository } from '../repositories/types.js';
import type { PolicyAttribute } from '../auth/types.js';

export interface FailuresRouteDeps {
  failures?: FailureRepository;
}

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

/**
 * Failure routes. `POST /failures/:id/acknowledge` persists an acknowledgement.
 *
 * Authorization is decoupled from any request-supplied organization: the caller
 * must hold the `ack` action on the `dashboard` scope for at least one
 * organization (checked below), and the repository enforces org-scoping by
 * only acknowledging failures in the caller's authorized orgs (404 otherwise).
 */
export function createFailuresRouter(deps: FailuresRouteDeps = {}): express.Router {
  const repositories = getRepositories();
  const failures = deps.failures ?? repositories.failures;
  const router = express.Router();

  router.post(
    '/failures/:id/acknowledge',
    requireAuth,
    asyncHandler(async (req, res) => {
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
      const acknowledged = await failures.acknowledge(
        failureId,
        new Date().toISOString(),
        organizationIds,
      );
      if (!acknowledged) {
        throw new NotFoundError('Failure not found');
      }
      res.status(200).json(acknowledged);
    }),
  );

  return router;
}