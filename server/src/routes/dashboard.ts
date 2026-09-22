import express from 'express';
import { requireAuth, requirePolicy } from '../middleware/auth.middleware.js';
import { getRepositories } from '../repositories/index.js';
import { organizationIdOf } from '../utils/policyResource.js';
import { createDashboardController } from '../controllers/dashboard.controller.js';
import type {
  ConnectorStateRepository,
  EventRepository,
  FailureRepository,
} from '../types/repository.js';

export interface DashboardRouteDeps {
  connectorStates?: ConnectorStateRepository;
  events?: EventRepository;
  failures?: FailureRepository;
}

/**
 * Dashboard metrics endpoint (consumed by the frontend). Handlers live in
 * `controllers/dashboard.controller.ts`; this module only declares the route
 * surface and its authorization policy.
 */
export function createDashboardRouter(deps: DashboardRouteDeps = {}): express.Router {
  const repositories = getRepositories();
  const controller = createDashboardController({
    connectorStates: deps.connectorStates ?? repositories.connectorStates,
    events: deps.events ?? repositories.events,
    failures: deps.failures ?? repositories.failures,
  });
  const router = express.Router();

  // GET /api/v1/dashboard/metrics — requires PBAC 'read' on scope 'dashboard'.
  router.get(
    '/dashboard/metrics',
    requireAuth,
    requirePolicy('read', (req) => ({
      scope: 'dashboard',
      organizationId: organizationIdOf(req),
    })),
    controller.getMetrics,
  );

  return router;
}
