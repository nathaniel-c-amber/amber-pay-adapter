import express from 'express';
import { requireAuth, requirePolicyAnyOrganization } from '../middleware/auth.middleware.js';
import { getRepositories } from '../repositories/index.js';
import { createFailuresController } from '../controllers/failures.controller.js';
import type { FailureRepository } from '../types/repository.js';

export interface FailuresRouteDeps {
  failures?: FailureRepository;
}

/**
 * Failure routes. `POST /failures/:id/acknowledge` persists an acknowledgement;
 * the handler and its PBAC reasoning live in
 * `controllers/failures.controller.ts`.
 */
export function createFailuresRouter(deps: FailuresRouteDeps = {}): express.Router {
  const failures = deps.failures ?? getRepositories().failures;
  const controller = createFailuresController({ failures });
  const router = express.Router();

  // The gate is "holds `ack` on `dashboard` for SOME organization": a failure
  // id in the path names no organization, so there is nothing concrete to
  // evaluate against. The controller then narrows per record — this is an
  // entry gate, never the filter.
  router.post(
    '/failures/:id/acknowledge',
    requireAuth,
    requirePolicyAnyOrganization('ack', 'dashboard'),
    controller.acknowledgeFailure,
  );

  return router;
}
