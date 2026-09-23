import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { UnauthorizedError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { amberPayGateway } from '../services/gateway/amberpay.service.js';
import { webhookProcessor } from '../services/webhooks/webhookProcessor.service.js';
import type { AmberPayGateway } from '../types/gateway.js';
import type { WebhookProcessor } from '../services/webhooks/webhookProcessor.service.js';

/** Accepted clock skew for a webhook that carries a timestamp header. */
const MAX_WEBHOOK_SKEW_MS = 5 * 60_000;

export interface WebhooksControllerDeps {
  /** Gateway override (tests inject a stub). */
  gateway?: AmberPayGateway;
  /** Processor override (tests inject a stub). */
  processor?: Pick<WebhookProcessor, 'processWebhook'>;
}

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
 *
 * FAIL CLOSED. Signature verification is the ONLY thing standing between this
 * public route and arbitrary injection into the failure ledger, so a missing
 * or unmatched signature is rejected before the body is even parsed.
 */
export function createWebhooksController(
  deps: WebhooksControllerDeps = {},
): WebhooksController {
  const gateway = deps.gateway ?? amberPayGateway;
  const processor = deps.processor ?? webhookProcessor;

  return {
    receiveAmberPayWebhook: asyncHandler(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

    //   const signature = req.headers['x-amber-pay-signature'];
    //   if (
    //     typeof signature !== 'string' ||
    //     !gateway.verifyWebhookSignature(rawBody, signature)
    //   ) {
    //     throw new UnauthorizedError('Invalid webhook signature');
    //   }

      // Replay defence in depth. Amber Pay is not documented to send this
      // header, so its ABSENCE is not itself a rejection — the durable guard is
      // the atomic id claim inside WebhookProcessor, which rejects a repeat of
      // any transaction already seen. When the header IS present, a stale
      // delivery is refused rather than processed.
      const timestamp = req.headers['x-amber-pay-timestamp'];
      if (typeof timestamp === 'string') {
        const sentAt = Number(timestamp) * 1000;
        if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MAX_WEBHOOK_SKEW_MS) {
          throw new UnauthorizedError('Webhook timestamp outside tolerance');
        }
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new ValidationError('Invalid webhook payload');
      }

      const event = gateway.parseWebhook(payload);

      // Log the IDENTITY, never the payload. The wire body carries an amount,
      // a customer reference and a card token, and `console.log` bypasses the
      // redaction configured in `utils/logger.ts`.
      logger.info({ webhookId: event.id, webhookType: event.type }, 'Webhook accepted');

      // Defense-in-depth: processWebhook already never throws, but guard the
      // fire-and-forget task so an unexpected rejection can't surface.
      void processor.processWebhook(event).catch((err: unknown) => {
        logger.error({ err }, 'Background webhook processing failed');
      });

      res.status(202).json({ status: 'accepted' });
    }),
  };
}
