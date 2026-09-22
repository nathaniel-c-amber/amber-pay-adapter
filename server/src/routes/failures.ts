import express from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
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

  router.post('/failures/:id/acknowledge', requireAuth, controller.acknowledgeFailure);

  return router;
}
