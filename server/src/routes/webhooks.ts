import express from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { amberPayGateway } from '../gateway/amberpay.js';
import { webhookProcessor } from '../pipeline/webhookProcessor.js';

/**
 * Webhook ingestion route. Verifies the Amber Pay signature over the RAW
 * request body, parses the payload, then dispatches to the WebhookProcessor
 * in the background — responding 202 immediately so the sender is not blocked
 * (FR-2.2).
 *
 * `express.raw` is used deliberately: the HMAC must be computed over the exact
 * bytes received, not a re-serialized JSON object.
 */
export function createWebhookRouter(): express.Router {
  const router = express.Router();

  router.post(
    '/webhooks/amber-pay',
    express.raw({ type: 'application/json' }),
    asyncHandler(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

      const signature = req.headers['x-amber-pay-signature'];
      if (
        typeof signature !== 'string' ||
        !amberPayGateway.verifyWebhookSignature(rawBody, signature)
      ) {
        throw new UnauthorizedError('Invalid webhook signature');
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new ValidationError('Invalid webhook payload');
      }

      const event = amberPayGateway.parseWebhook(payload);

      // Defense-in-depth: processWebhook already never throws, but guard the
      // fire-and-forget task so an unexpected rejection can't surface.
      void webhookProcessor.processWebhook(event).catch((err: unknown) => {
        logger.error({ err }, 'Background webhook processing failed');
      });

      res.status(202).json({ status: 'accepted' });
    }),
  );

  return router;
}
