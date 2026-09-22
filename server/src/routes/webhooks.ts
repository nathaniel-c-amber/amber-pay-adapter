import express from 'express';
import { createWebhooksController } from '../controllers/webhooks.controller.js';

/**
 * Webhook ingestion route. Handlers live in
 * `controllers/webhooks.controller.ts`.
 *
 * `express.raw` is mounted on the route (not app-wide) so the HMAC is computed
 * over the exact bytes received, not a re-serialized JSON object — and so the
 * route can be mounted BEFORE the global JSON body parser in `app.ts`.
 */
export function createWebhookRouter(): express.Router {
  const controller = createWebhooksController();
  const router = express.Router();

  router.post(
    '/webhooks/amber-pay',
    express.raw({ type: 'application/json' }),
    controller.receiveAmberPayWebhook,
  );

  return router;
}
