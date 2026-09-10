import express from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { UnauthorizedError } from '../lib/errors.js';
import { requireAuth, requirePolicy } from '../auth/middleware.js';
import { getRepositories } from '../repositories/index.js';
import { authorizedOrganizationIds, organizationIdOf } from './policyResource.js';
import type { ReconciliationRepository } from '../repositories/types.js';

export interface ReportRouteDeps {
  reconciliation?: ReconciliationRepository;
}

/**
 * Reporting routes. The reconciliation report exposes operational counts
 * (matched/unmatched/anomalies) and timestamps only — NO monetary values.
 */
export function createReportRouter(deps: ReportRouteDeps = {}): express.Router {
  const reconciliation = deps.reconciliation ?? getRepositories().reconciliation;
  const router = express.Router();

  // GET /api/v1/reports/reconciliation — requires PBAC 'read' on scope 'reports'.
  router.get(
    '/reports/reconciliation',
    requireAuth,
    requirePolicy('read', (req) => ({
      scope: 'reports',
      organizationId: organizationIdOf(req),
    })),
    asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      // C1: only return jobs for organizations the caller can read.
      const organizationIds = authorizedOrganizationIds(req.auth.policy, 'reports');
      const jobs = await reconciliation.list(organizationIds);
      res.status(200).json({
        reconciliation: jobs[0]?.summary ?? null,
        jobs,
        generatedAt: new Date().toISOString(),
      });
    }),
  );

  return router;
}
