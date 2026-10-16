import express from 'express';
import { createWebhooksController } from '../controllers/webhooks.controller.js';
import type { AmberPayGateway } from '../types/gateway.js';
import type { WebhookProcessor } from '../services/webhooks/webhookProcessor.service.js';
import type { CheckoutIntentStore } from '../services/gateway/checkout.service.js';

/**
 * Hard cap on a webhook body. Well above any legitimate Amber Pay payload, and
 * low enough that the caller — whom this route does not otherwise authenticate
 * (see `controllers/webhooks.controller.ts`) — cannot make the process buffer
 * arbitrary memory.
 */
const MAX_WEBHOOK_BODY = '64kb';

export interface WebhookRouteDeps {
  gateway?: AmberPayGateway;
  processor?: Pick<WebhookProcessor, 'processWebhook'>;
  /** Test seam for the browser redirect's intent lookup. */
  intents?: Pick<CheckoutIntentStore, 'findByTransactionId'>;
}

/**
 * The two encodings this route buffers.
 *
 * `application/x-www-form-urlencoded` is what Amber Pay ACTUALLY sends: a live
 * callback (captured 2026-10-16) is form-encoded. Listing only `application/json`
 * made `express.raw` type-mismatch, call `next()` without parsing and leave
 * `req.body` undefined, so every genuine delivery was answered 400 and dropped.
 * The gateway's encoding is not something this side can choose.
 *
 * `application/json` stays because nothing about the route's contract requires
 * the gateway to be the only caller.
 */
const WEBHOOK_CONTENT_TYPES = ['application/json', 'application/x-www-form-urlencoded'];

/**
 * Webhook ingestion route. Handlers live in
 * `controllers/webhooks.controller.ts`.
 *
 * `express.raw` is mounted on the route (not app-wide) so the route can be
 * mounted BEFORE the global JSON body parser in `app.ts`, and so the buffered
 * body is bounded by `MAX_WEBHOOK_BODY` — the controller parses the exact bytes
 * received rather than a re-serialized object.
 *
 * ★ `express.urlencoded()` IS DELIBERATELY NOT USED, and this is the reason the
 * route is still raw rather than just "fixed" with the obvious one-liner. It
 * would parse the body in place and THROW THE ORIGINAL BYTES AWAY — and those
 * bytes are the thing that caps the payload (`MAX_WEBHOOK_BODY`) and the thing
 * any signature is computed over. Buffer the raw body once and let the
 * controller decide how to read it; `urlencoded` would make the second
 * impossible.
 */
export function createWebhookRouter(deps: WebhookRouteDeps = {}): express.Router {
  const controller = createWebhooksController({
    ...(deps.gateway ? { gateway: deps.gateway } : {}),
    ...(deps.processor ? { processor: deps.processor } : {}),
    ...(deps.intents ? { intents: deps.intents } : {}),
  });
  const router = express.Router();

  router.post(
    '/webhooks/amber-pay',
    express.raw({ type: WEBHOOK_CONTENT_TYPES, limit: MAX_WEBHOOK_BODY }),
    controller.receiveAmberPayWebhook,
  );

  return router;
}
