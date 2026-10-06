import express from 'express';
import { requireAuth, requirePolicy } from '../middleware/auth.middleware.js';
import { getRepositories } from '../repositories/index.js';
import { organizationIdOf } from '../utils/policyResource.js';
import { createPaymentsController } from '../controllers/payments.controller.js';
import { PaymentService } from '../services/payments/payment.service.js';
import { CheckoutService } from '../services/gateway/checkout.service.js';
import { PostgresCheckoutIntentStore } from '../repositories/postgres.js';
import { getPool } from '../db/pool.js';
import type { PaymentRepository } from '../types/repository.js';

export interface PaymentRouteDeps {
  payments?: PaymentRepository;
  /** Test seam: the checkout, so a route test never reaches the gateway. */
  checkout?: CheckoutService;
}

/**
 * Payment routes.
 *
 * The response carries the checkout the browser posts to the gateway. The
 * Payment entity has no amount field and never will (FR-2.3); the figure travels
 * once, inside the checkout, and is not attached to anything we keep.
 */
export function createPaymentRouter(deps: PaymentRouteDeps = {}): express.Router {
  const service = new PaymentService(
    deps.payments ?? getRepositories().payments,
    deps.checkout ??
      new CheckoutService(new PostgresCheckoutIntentStore(getPool())),
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
