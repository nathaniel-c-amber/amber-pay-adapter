import express from 'express';
import { requireAuth, requirePolicy } from '../middleware/auth.middleware.js';
import { organizationIdOf } from '../utils/policyResource.js';
import { createServiceController } from '../controllers/service.controller.js';

/**
 * Service status — the console's window into the backend it is watching.
 *
 * Handlers live in `controllers/service.controller.ts`. This module only
 * declares the route surface.
 */
export function createServiceRouter(): express.Router {
  const controller = createServiceController();
  const router = express.Router();

  // GET /api/v1/health — public liveness probe (no auth, no data). Backs the
  // console's online/offline indicator, which must work without a session.
  router.get('/health', controller.getHealth);

  // GET /api/v1/service/status — requires PBAC 'read' on scope 'dashboard'.
  router.get(
    '/service/status',
    requireAuth,
    requirePolicy('read', (req) => ({
      scope: 'dashboard',
      organizationId: organizationIdOf(req),
    })),
    controller.getStatus,
  );

  return router;
}
