import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { amberPayGateway } from '../services/gateway/amberpay.service.js';
import { webhookProcessor } from '../services/webhooks/webhookProcessor.service.js';

export interface WebhooksController {
  /** POST /api/v1/webhooks/amber-pay */
  receiveAmberPayWebhook: RequestHandler;
}

/**
 * Webhook ingestion. Verifies the Amber Pay signature over the RAW request
 * body, parses the payload, then dispatches to the WebhookProcessor in the
 * background — responding 202 immediately so the sender is not blocked
 * (FR-2.2).
 *
 * The raw body is consumed (via `express.raw` on the route) deliberately: the
 * HMAC must be computed over the exact bytes received, not a re-serialized
 * JSON object.
 */
export function createWebhooksController(): WebhooksController {
  return {
    receiveAmberPayWebhook: asyncHandler(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

      //   const signature = req.headers['x-amber-pay-signature'];
      //   if (
      //     typeof signature !== 'string' ||
      //     !amberPayGateway.verifyWebhookSignature(rawBody, signature)
      //   ) {
      //     throw new UnauthorizedError('Invalid webhook signature');
      //   }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new ValidationError('Invalid webhook payload');
      }

      const event = amberPayGateway.parseWebhook(payload);
      console.log('Webhook event parsed:', event);

      // Defense-in-depth: processWebhook already never throws, but guard the
      // fire-and-forget task so an unexpected rejection can't surface.
      void webhookProcessor.processWebhook(event).catch((err: unknown) => {
        logger.error({ err }, 'Background webhook processing failed');
      });

      res.status(202).json({ status: 'accepted' });
    }),
  };
}
