import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requirePolicy } from '../middleware/auth.middleware.js';
import { rateLimitHandler } from '../middleware/rateLimitHandler.js';
import { getRepositories } from '../repositories/index.js';
import { organizationIdOf } from '../utils/policyResource.js';
import { createPaymentsController } from '../controllers/payments.controller.js';
import { PaymentService } from '../services/payments/payment.service.js';
import { PaymentStatusService } from '../services/payments/paymentStatus.service.js';
import { CheckoutService } from '../services/gateway/checkout.service.js';
import { PostgresCheckoutIntentStore } from '../repositories/postgres.js';
import { getPool } from '../db/pool.js';
import { env } from '../config/env.js';
import type { PaymentRepository } from '../types/repository.js';
import type { PaymentStatusStore } from '../services/payments/paymentStatus.service.js';

const STATUS_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/*
  ★ THE PUBLIC BUDGET IS SET ON WHAT A STRANGER COULD COST, NOT ON WHAT A PERSON
  NEEDS.

  This is the only route on the server with no session, so the number is not
  about an operator filling in a form — it is about what an unauthenticated
  caller can make this origin do. Sixty reads in a quarter of an hour is well
  beyond any real return page (which reads once, and refreshes a handful of times
  while someone waits for a callback) and still bounds the damage to a trivial
  indexed single-row probe.

  It is NOT sized as tightly as the settings callback limiter, and deliberately:
  that one reaches a third party on every successful call, so its cost is paid
  somewhere else. This one stays here, and a single indexed equality query is not
  a thing worth starving a customer's page over. The 256-bit token means the limit
  exists to bound COST, not to prevent guessing — which at this entropy it could
  not do anyway.
*/
const STATUS_RATE_LIMIT_MAX = 60;

export interface PaymentRouteDeps {
  payments?: PaymentRepository;
  /** Test seam: the checkout, so a route test never reaches the gateway. */
  checkout?: CheckoutService;
  /** Test seam: the status read behind the public token endpoint. */
  statusStore?: PaymentStatusStore;
}

/**
 * Payment routes.
 *
 * The response carries the checkout the browser posts to the gateway. The
 * Payment entity has no amount field and never will (FR-2.3); the figure travels
 * once, inside the checkout, and is not attached to anything we keep.
 */
export function createPaymentRouter(deps: PaymentRouteDeps = {}): express.Router {
  const intents = new PostgresCheckoutIntentStore(getPool());
  const service = new PaymentService(
    deps.payments ?? getRepositories().payments,
    deps.checkout ?? new CheckoutService(intents),
  );
  const controller = createPaymentsController({
    service,
    status: new PaymentStatusService(deps.statusStore ?? intents),
  });
  const router = express.Router();

  const statusLimiter = rateLimit({
    windowMs: STATUS_RATE_LIMIT_WINDOW_MS,
    max: STATUS_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  /*
    ★ THE ORGANIZATION PBAC EVALUATES AGAINST, WHICH IS NOT ALWAYS IN THE BODY.

    `organizationId` on this request is optional — the server knows it, and the
    console has no way to read it (no endpoint it can reach carries the id). But
    `organizationIdOf(req)` reads the body and falls back to the query string,
    returning `''` when neither is present, and an empty scope matches no policy
    attribute. So omitting the field produced a 403 on a request that was
    perfectly authorized — every `POST /payments` failed the moment the body got
    smaller.

    The fallback is `env.ORGANIZATION_ID`, which is the SAME value the controller
    will use, so authorization and the write cannot disagree about which
    organization this touches. A SUPPLIED foreign value is still evaluated as
    that organization, which is what turns "you wrote to somewhere else" into a
    refusal rather than a silent redirection.
  */
  const paymentScope = (req: express.Request) => ({
    scope: 'payments',
    organizationId: organizationIdOf(req) || env.ORGANIZATION_ID,
  });

  // POST /api/v1/payments — requires PBAC 'write' on scope 'payments'.
  router.post(
    '/payments',
    requireAuth,
    requirePolicy('write', paymentScope),
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

  /*
    GET /api/v1/payments/status/:token

    ★ THE ONLY ROUTE HERE WITH NO `requireAuth`, AND IT IS NOT AN OMISSION.

    Everyone else on this router is an operator acting inside their policy. This
    one is a customer who has just handed over a card and has no session, no uuid
    and no credentials — the gateway redirects them here through the webhook url,
    because that is the one address they can be given. The 256-bit token in the
    path IS the authorisation, which is why it is minted at checkout, stored with
    the intent, and time-limited.

    So the protection here is threefold and none of it is a session: the token is
    unguessable, the read is a single indexed row carrying only that one
    payment's own outcome, and the limiter above bounds what an anonymous caller
    can make this origin do.

    It is a GET, and it writes nothing. A page a customer refreshes must not be
    able to move the state of their own payment.
  */
  router.get('/payments/status/:token', statusLimiter, controller.getPaymentStatus);

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
