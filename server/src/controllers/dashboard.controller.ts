import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { UnauthorizedError } from '../utils/errors.js';
import { authorizedOrganizationIds } from '../utils/policyResource.js';
import { policyScopesOf } from '../utils/policyScopes.js';
import { computeStageFlow } from '../services/flow/stageFlow.service.js';
import { withAdaptorConnections } from '../services/adaptors/connectorState.service.js';
import type {
  ConnectorStateRepository,
  EventRepository,
  FailureRepository,
} from '../types/repository.js';

export interface DashboardControllerDeps {
  connectorStates: ConnectorStateRepository;
  events: EventRepository;
  failures: FailureRepository;
}

export interface DashboardController {
  /** GET /api/v1/dashboard/metrics */
  getMetrics: RequestHandler;
}

/**
 * Dashboard metrics. Returns the exact domain shapes the console consumes:
 * `ConnectorState[]`, `LifecycleEvent[]`, `Failure[]`, `PolicyScope[]`, plus
 * the authoritative per-stage flow aggregate.
 */
export function createDashboardController(deps: DashboardControllerDeps): DashboardController {
  return {
    getMetrics: asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      // C1: only return rows for organizations the caller can read.
      const organizationIds = authorizedOrganizationIds(req.auth.policy, 'dashboard');
      const [connectorRows, lifecycleEvents, failureList] = await Promise.all([
        deps.connectorStates.list(organizationIds),
        deps.events.list(organizationIds),
        deps.failures.list(organizationIds),
      ]);

      /*
        Connector rows are stored state, and a Postgres install stores none at
        all; the adaptors' ability to reach their accounting platform is live.
        Merge the two so the Connections page and the service window cannot
        disagree about whether a route works — see the module comment.
      */
      const connectors = await withAdaptorConnections(connectorRows, organizationIds);

      res.status(200).json({
        connectors,
        events: lifecycleEvents,
        failures: failureList,
        policies: policyScopesOf(req.auth.policy),
        // Authoritative per-stage flow counts + durations. The console MUST
        // read these rather than deriving from `events`, which is a capped
        // window and would present a partial count as a total.
        stages: computeStageFlow(lifecycleEvents),
        generatedAt: new Date().toISOString(),
      });
    }),
  };
}
