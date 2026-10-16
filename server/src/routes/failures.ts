import express from 'express';
import { requireAuth, requirePolicyAnyOrganization } from '../middleware/auth.middleware.js';
import { getRepositories } from '../repositories/index.js';
import { createFailuresController } from '../controllers/failures.controller.js';
import type { FailureRepository } from '../types/repository.js';

export interface FailuresRouteDeps {
  failures?: FailureRepository;
}

/**
 * Failure routes. `POST /failures/:id/acknowledge` persists one
 * acknowledgement; `POST /failures/acknowledge` persists a batch as a single
 * operator action. The handlers and their PBAC reasoning live in
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

  /*
    The batch form of the same gate. Declared after the `/:id` route because it
    reads better beside the single-id handler it mirrors; the two cannot shadow
    each other either way, since `/failures/acknowledge` is two path segments
    and `/failures/:id/acknowledge` is three.

    The body carries the id list and nothing else. Organization and actor are
    resolved from the token in the controller, so a client cannot acknowledge
    outside its scope or record an acknowledgement as somebody else.
  */
  router.post(
    '/failures/acknowledge',
    requireAuth,
    requirePolicyAnyOrganization('ack', 'dashboard'),
    controller.acknowledgeFailures,
  );

  return router;
}
