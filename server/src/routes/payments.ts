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

  /*
    GET /api/v1/payments/by-transaction/:transactionId

    ★ REGISTERED BEFORE `/payments/:id`, because Express matches in order and
    `:id` would otherwise swallow `by-transaction` and answer every lookup with
    a 404 about a payment id. That failure is silent — it looks exactly like
    "no such payment" — which is why the ordering is commented rather than left
    to whoever adds the next route.

    It exists because a customer returning from the gateway knows their
    TRANSACTION reference, not our payment's uuid. The uuid is generated here
    and never leaves this origin until somebody is signed in to read it; the
    transaction id is the one value the gateway echoes and the customer can
    carry. Requiring a session to resolve it would make the return page
    unreachable for the person who just paid.
  */
  router.get(
    '/payments/by-transaction/:transactionId',
    requireAuth,
    requirePolicy('read', (req) => ({
      scope: 'payments',
      organizationId: organizationIdOf(req),
    })),
    controller.getPaymentByTransaction,
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
