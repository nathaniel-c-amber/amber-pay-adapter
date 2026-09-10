import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { NotFoundError, UnauthorizedError, ValidationError } from '../lib/errors.js';
import { requireAuth, requirePolicy } from '../auth/middleware.js';
import { PaymentService } from '../payments/paymentService.js';
import { getRepositories } from '../repositories/index.js';
import { authorizedOrganizationIds, organizationIdOf } from './policyResource.js';
import type { AmberPayGateway } from '../gateway/types.js';
import type { PaymentRepository } from '../repositories/types.js';

const createPaymentBodySchema = z.object({
  invoiceId: z.string().min(1),
  externalInvoiceId: z.string().min(1),
  // Opaque reference only (no amount / no PII).
  reference: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  organizationId: z.string().min(1),
});

export interface PaymentRouteDeps {
  payments?: PaymentRepository;
  gateway?: AmberPayGateway;
}

/**
 * Payment routes. Responses carry operational status and reference hashes
 * only — never amounts (FR-2.3 / FR-5.2). Business logic (gateway call +
 * entity assembly + persistence) lives in `PaymentService`; this route only
 * validates and dispatches (S1).
 */
export function createPaymentRouter(deps: PaymentRouteDeps = {}): express.Router {
  const service = new PaymentService(
    deps.payments ?? getRepositories().payments,
    deps.gateway,
  );
  const router = express.Router();

  // POST /api/v1/payments — requires PBAC 'write' on scope 'payments'.
  router.post(
    '/payments',
    requireAuth,
    requirePolicy('write', (req) => ({
      scope: 'payments',
      organizationId: organizationIdOf(req),
    })),
    asyncHandler(async (req, res) => {
      const parsed = createPaymentBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid payment payload');
      }

      const { payment, link } = await service.createPayment({
        invoiceId: parsed.data.invoiceId,
        externalInvoiceId: parsed.data.externalInvoiceId,
        reference: parsed.data.reference,
        organizationId: parsed.data.organizationId,
      });

      res.status(201).json({
        payment,
        link: { linkUrl: link.linkUrl, reference: link.reference, expiresAt: link.expiresAt },
      });
    }),
  );

  // GET /api/v1/payments/:id — requires PBAC 'read' on scope 'payments'.
  router.get(
    '/payments/:id',
    requireAuth,
    requirePolicy('read', (req) => ({
      scope: 'payments',
      organizationId: organizationIdOf(req),
    })),
    asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      // C1: 404 when the payment's org is not in the caller's authorized orgs.
      const organizationIds = authorizedOrganizationIds(req.auth.policy, 'payments');
      const payment = await service.findById(req.params['id'] ?? '', organizationIds);
      if (!payment) {
        throw new NotFoundError('Payment not found');
      }
      res.status(200).json({ payment });
    }),
  );

  return router;
}