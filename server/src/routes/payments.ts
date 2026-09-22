import express from 'express';
import { requireAuth, requirePolicy } from '../middleware/auth.middleware.js';
import { getRepositories } from '../repositories/index.js';
import { organizationIdOf } from '../utils/policyResource.js';
import { createPaymentsController } from '../controllers/payments.controller.js';
import { PaymentService } from '../services/payments/payment.service.js';
import type { AmberPayGateway } from '../types/gateway.js';
import type { PaymentRepository } from '../types/repository.js';

export interface PaymentRouteDeps {
  payments?: PaymentRepository;
  gateway?: AmberPayGateway;
}

/**
 * Payment routes. Responses carry operational status and reference hashes
 * only — never amounts (FR-2.3 / FR-5.2).
 */
export function createPaymentRouter(deps: PaymentRouteDeps = {}): express.Router {
  const service = new PaymentService(
    deps.payments ?? getRepositories().payments,
    deps.gateway,
  );
  const controller = createPaymentsController({ service });
  const router = express.Router();

  // POST /api/v1/payments — requires PBAC 'write' on scope 'payments'.
  router.post(
    '/payments',
    requireAuth,
    requirePolicy('write', (req) => ({
      scope: 'payments',
      organizationId: organizationIdOf(req),
    })),
    controller.createPayment,
  );

  // GET /api/v1/payments/:id — requires PBAC 'read' on scope 'payments'.
  router.get(
    '/payments/:id',
    requireAuth,
    requirePolicy('read', (req) => ({
      scope: 'payments',
      organizationId: organizationIdOf(req),
    })),
    controller.getPayment,
  );

  return router;
}
