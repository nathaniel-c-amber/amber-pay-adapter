import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { UnauthorizedError } from '../utils/errors.js';
import { authorizedOrganizationIds } from '../utils/policyResource.js';
import type { ReconciliationRepository } from '../types/repository.js';

export interface ReportsControllerDeps {
  reconciliation: ReconciliationRepository;
}

export interface ReportsController {
  /** GET /api/v1/reports/reconciliation */
  getReconciliation: RequestHandler;
}

/**
 * Reconciliation report. Exposes operational counts
 * (matched/unmatched/anomalies) and timestamps only — NO monetary values.
 */
export function createReportsController(deps: ReportsControllerDeps): ReportsController {
  return {
    getReconciliation: asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      // C1: only return jobs for organizations the caller can read.
      const organizationIds = authorizedOrganizationIds(req.auth.policy, 'reports');
      const jobs = await deps.reconciliation.list(organizationIds);
      res.status(200).json({
        reconciliation: jobs[0]?.summary ?? null,
        jobs,
        generatedAt: new Date().toISOString(),
      });
    }),
  };
}
