import express from 'express';
import { createWebhooksController } from '../controllers/webhooks.controller.js';
import type { AmberPayGateway } from '../types/gateway.js';
import type { WebhookProcessor } from '../services/webhooks/webhookProcessor.service.js';

/**
 * Hard cap on a webhook body. Well above any legitimate Amber Pay payload, and
 * low enough that an unauthenticated caller cannot make the process buffer
 * arbitrary memory before the signature is checked.
 */
const MAX_WEBHOOK_BODY = '64kb';

export interface WebhookRouteDeps {
  gateway?: AmberPayGateway;
  processor?: Pick<WebhookProcessor, 'processWebhook'>;
}

/**
 * Webhook ingestion route. Handlers live in
 * `controllers/webhooks.controller.ts`.
 *
 * `express.raw` is mounted on the route (not app-wide) so the HMAC is computed
 * over the exact bytes received, not a re-serialized JSON object — and so the
 * route can be mounted BEFORE the global JSON body parser in `app.ts`.
 */
export function createWebhookRouter(deps: WebhookRouteDeps = {}): express.Router {
  const controller = createWebhooksController(deps);
  const router = express.Router();

  router.post(
    '/webhooks/amber-pay',
    express.raw({ type: 'application/json', limit: MAX_WEBHOOK_BODY }),
    controller.receiveAmberPayWebhook,
  );

  return router;
}
