import { z } from 'zod';
import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors.js';
import { authorizedOrganizationIds } from '../utils/policyResource.js';
import { env } from '../config/env.js';
import { GATEWAY_CURRENCIES, STUDENT_ID } from '../services/gateway/amberPayWire.js';
import { OPAQUE_REFERENCE } from '../services/adaptors/quickbooksWire.js';
import type { PaymentService } from '../services/payments/payment.service.js';

const createPaymentBodySchema = z.object({
  invoiceId: z.string().min(1),
  /*
    The customer paying, as the organization's own opaque identifier (`STU0026`).

    Validated with the SAME pattern the adaptor will later interpolate into a
    query against the organization's accounting data, and at this boundary
    rather than downstream — so a value that could never be matched is refused
    where the operator can still see which field was wrong.

    This replaces `externalInvoiceId`, which named an accounting invoice
    reference but held a gateway order id. A checkout needs to know WHO is
    paying, because that is what the gateway echoes back.
  */
  studentId: z.string().regex(STUDENT_ID),
  /*
    MINOR UNITS, in an integer — 25000 is 250.00. Not a float: a figure that
    cannot be represented exactly would round, and a signature computed over a
    rounded figure is rejected (or, worse, accepted for a different sum).
  */
  amountMinorUnits: z.number().int().positive(),
  currency: z.enum(GATEWAY_CURRENCIES),
  /*
    OPTIONAL, and validated when supplied.

    It was required, which meant every client had to echo back a constant the
    server already holds — and the console had no way to obtain it, because
    `/auth/me` carries the organization's NAME but not its id, and `/settings`
    (which does carry the id) requires the `system` scope an ordinary operator
    does not hold. So the only way a real console could have called this was to
    hardcode the id.

    Supplying a FOREIGN one is still refused rather than ignored, which is the
    property that was worth keeping: a caller that believes it is writing to a
    different organization gets told, instead of a row filed somewhere it did
    not ask for.
  */
  organizationId: z
    .string()
    .min(1)
    .optional()
    .refine((id) => id === undefined || id === env.ORGANIZATION_ID, {
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
  /**
   * GET /api/v1/payments/by-transaction/:transactionId
   *
   * For the customer arriving back from the gateway, who holds the transaction
   * reference rather than our payment's uuid.
   */
  getPaymentByTransaction: RequestHandler;
}

/**
 * Payment endpoints.
 *
 * The response carries the checkout parameters the browser needs to reach the
 * gateway, plus the Payment entity — which has no amount field and never will
 * (FR-2.3, enforced by `privacy.test.ts`). The figure goes out to the browser
 * once, in the checkout, and is not attached to anything we keep.
 *
 * Business logic lives in `PaymentService`; this controller only validates and
 * dispatches.
 */
export function createPaymentsController(deps: PaymentsControllerDeps): PaymentsController {
  return {
    createPayment: asyncHandler(async (req, res) => {
      const parsed = createPaymentBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid payment payload');
      }

      const { payment, session } = await deps.service.createPayment({
        invoiceId: parsed.data.invoiceId,
        studentId: parsed.data.studentId,
        amountMinorUnits: parsed.data.amountMinorUnits,
        currency: parsed.data.currency,
        organizationId: parsed.data.organizationId ?? env.ORGANIZATION_ID,
      });

      res.status(201).json({
        payment,
        /*
          A CHECKOUT, not a link.

          The gateway issues no URL a customer can visit: it expects a signed POST
          and answers with the payment form. So what goes back is a destination
          plus the parameters for it, and the BROWSER posts to the gateway
          directly — which is the point. It is why card details never reach this
          origin, and it is also why the CSP has to name the gateway in
          `form-action`.

          Explicitly field-by-field rather than spreading the session, so a new
          service field cannot be published by accident.
        */
        checkout: {
          checkoutUrl: session.checkoutUrl,
          params: session.params,
          transactionId: session.transactionId,
          ...(session.simulated === true ? { simulated: true } : {}),
        },
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

    getPaymentByTransaction: asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      // Validated with the same shape the gateway generates, so a hand-typed
      // URL cannot put anything into a query. It is not used in one — the
      // repository binds it as a parameter — so this is about refusing
      // nonsense, not about escaping.
      const transactionId = req.params['transactionId'] ?? '';
      if (!OPAQUE_REFERENCE.test(transactionId)) {
        throw new NotFoundError('Payment not found');
      }
      const organizationIds = authorizedOrganizationIds(req.auth.policy, 'payments');
      const payment = await deps.service.findByTransactionId(transactionId, organizationIds);
      if (!payment) {
        throw new NotFoundError('Payment not found');
      }
      res.status(200).json({ payment });
    }),
  };
}
