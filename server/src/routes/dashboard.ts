import express from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { UnauthorizedError } from '../lib/errors.js';
import { requireAuth, requirePolicy } from '../auth/middleware.js';
import { getRepositories } from '../repositories/index.js';
import { authorizedOrganizationIds, organizationIdOf } from './policyResource.js';
import { policyScopesOf } from '../lib/policyScopes.js';
import type {
  ConnectorStateRepository,
  EventRepository,
  FailureRepository,
} from '../repositories/types.js';

export interface DashboardRouteDeps {
  connectorStates?: ConnectorStateRepository;
  events?: EventRepository;
  failures?: FailureRepository;
}

/**
 * Dashboard metrics endpoint (consumed by the frontend). Returns the exact
 * domain shapes: ConnectorState[], LifecycleEvent[], Failure[], PolicyScope[].
 */
export function createDashboardRouter(deps: DashboardRouteDeps = {}): express.Router {
  const repositories = getRepositories();
  const connectorStates = deps.connectorStates ?? repositories.connectorStates;
  const events = deps.events ?? repositories.events;
  const failures = deps.failures ?? repositories.failures;
  const router = express.Router();

  // GET /api/v1/dashboard/metrics — requires PBAC 'read' on scope 'dashboard'.
  router.get(
    '/dashboard/metrics',
    requireAuth,
    requirePolicy('read', (req) => ({
      scope: 'dashboard',
      organizationId: organizationIdOf(req),
    })),
    asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      // C1: only return rows for organizations the caller can read.
      const organizationIds = authorizedOrganizationIds(req.auth.policy, 'dashboard');
      const [connectors, lifecycleEvents, failureList] = await Promise.all([
        connectorStates.list(organizationIds),
        events.list(organizationIds),
        failures.list(organizationIds),
      ]);

      res.status(200).json({
        connectors,
        events: lifecycleEvents,
        failures: failureList,
        policies: policyScopesOf(req.auth.policy),
        generatedAt: new Date().toISOString(),
      });
    }),
  );

  return router;
}
