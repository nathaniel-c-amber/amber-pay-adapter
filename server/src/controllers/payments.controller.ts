import { z } from 'zod';
import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors.js';
import { authorizedOrganizationIds } from '../utils/policyResource.js';
import { env } from '../config/env.js';
import type { PaymentService } from '../services/payments/payment.service.js';

const createPaymentBodySchema = z.object({
  invoiceId: z.string().min(1),
  externalInvoiceId: z.string().min(1),
  // Opaque reference only (no amount / no PII).
  reference: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  /*
    Must be THIS deployment's organization. The field is kept, rather than the
    server quietly ignoring it, so a caller that believes it is writing to a
    different organization gets a refusal instead of a row filed somewhere it
    did not ask for — and a row that its own policy would then not match.
  */
  organizationId: z
    .string()
    .min(1)
    .refine((id) => id === env.ORGANIZATION_ID, {
      message: 'must be the organization this deployment serves',
    }),
});

export interface PaymentsControllerDeps {
  service: PaymentService;
}

export interface PaymentsController {
  /** POST /api/v1/payments */
  createPayment: RequestHandler;
  /** GET /api/v1/payments/:id */
  getPayment: RequestHandler;
}

/**
 * Payment endpoints. Responses carry operational status and reference hashes
 * only — never amounts (FR-2.3 / FR-5.2). Business logic (gateway call +
 * entity assembly + persistence) lives in `PaymentService`; this controller
 * only validates and dispatches (S1).
 */
export function createPaymentsController(deps: PaymentsControllerDeps): PaymentsController {
  return {
    createPayment: asyncHandler(async (req, res) => {
      const parsed = createPaymentBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid payment payload');
      }

      const { payment, link } = await deps.service.createPayment({
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

    getPayment: asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      // C1: 404 when the payment's org is not in the caller's authorized orgs.
      const organizationIds = authorizedOrganizationIds(req.auth.policy, 'payments');
      const payment = await deps.service.findById(req.params['id'] ?? '', organizationIds);
      if (!payment) {
        throw new NotFoundError('Payment not found');
      }
      res.status(200).json({ payment });
    }),
  };
}
