import express from 'express';
import { requireAuth, requirePolicy } from '../middleware/auth.middleware.js';
import { getRepositories } from '../repositories/index.js';
import { organizationIdOf } from '../utils/policyResource.js';
import { createReportsController } from '../controllers/reports.controller.js';
import type { ReconciliationRepository } from '../types/repository.js';

export interface ReportRouteDeps {
  reconciliation?: ReconciliationRepository;
}

/**
 * Reporting routes. The reconciliation report exposes operational counts
 * (matched/unmatched/anomalies) and timestamps only — NO monetary values.
 */
export function createReportRouter(deps: ReportRouteDeps = {}): express.Router {
  const controller = createReportsController({
    reconciliation: deps.reconciliation ?? getRepositories().reconciliation,
  });
  const router = express.Router();

  // GET /api/v1/reports/reconciliation — requires PBAC 'read' on scope 'reports'.
  router.get(
    '/reports/reconciliation',
    requireAuth,
    requirePolicy('read', (req) => ({
      scope: 'reports',
      organizationId: organizationIdOf(req),
    })),
    controller.getReconciliation,
  );

  return router;
}
