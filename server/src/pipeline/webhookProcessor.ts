import { logger } from '../lib/logger.js';
import { adaptorRegistry } from '../adaptors/registry.js';
import { eventLog } from '../events/eventLog.js';
import { failureTracker } from '../events/failures.js';
import { getRepositories } from '../repositories/index.js';
import { InMemoryWebhookDedupRepository } from '../repositories/inMemory.js';
import type { WebhookDedupRepository } from '../repositories/types.js';
import type { AccountingAdaptor, AdaptorId, PaymentRef } from '../adaptors/types.js';
import type { WebhookEvent } from '../gateway/types.js';
import type { LifecycleEventType } from '../domain/types.js';
import type { EventLog } from '../events/eventLog.js';
import type { FailureTracker } from '../events/failures.js';

/** Resolves an accounting adaptor by id (defaults to the singleton registry). */
export interface AdaptorResolver {
  get(id: AdaptorId): AccountingAdaptor;
}

/**
 * Async webhook processing pipeline (FR-2.2). Never throws — a webhook must
 * never crash the process. On adaptor failure it records a critical Failure
 * (FR-5.3) instead of propagating.
 *
 * Idempotency (M2): processed webhook ids are tracked via a two-phase
 * `WebhookDedupRepository`. A webhook is marked `processing` before handling
 * and only flipped to `processed` once it succeeds, so a failed webhook is NOT
 * deduped and is retried on the next delivery.
 *
 * Org-scoping (C1): every recorded event/failure carries the configured
 * `organizationId` for this processor.
 */
export class WebhookProcessor {
  constructor(
    private readonly eventLog: EventLog,
    private readonly failureTracker: FailureTracker,
    private readonly adaptorResolver: AdaptorResolver = adaptorRegistry,
    private readonly pushTimeoutMs = 5000,
    private readonly activeAdaptorId: AdaptorId = 'quickbooks',
    private readonly dedup: WebhookDedupRepository = new InMemoryWebhookDedupRepository(),
    private readonly organizationId = 'org-1',
  ) {}

  async processWebhook(event: WebhookEvent): Promise<void> {
    if (await this.dedup.hasProcessed(event.id)) {
      logger.warn({ webhookId: event.id }, 'Duplicate webhook ignored');
      return;
    }
    const now = new Date().toISOString();
    await this.dedup.markProcessing(event.id, now);

    try {
      switch (event.type) {
        case 'payment.collected':
          await this.handleCollected(event);
          break;
        case 'payment.declined':
        case 'payment.failed':
          await this.handleFailure(event);
          break;
        case 'payment.initiated':
          await this.handleInitiated(event);
          break;
        default:
          logger.warn({ webhookType: event.type }, 'Unhandled webhook type');
      }
      // Only mark processed after the whole handler succeeded, so a failure
      // leaves the webhook retryable (M2).
      await this.dedup.markProcessed(event.id, now);
    } catch (err) {
      logger.error({ err }, 'Webhook processing failed');
    }
  }

  private async handleCollected(event: WebhookEvent): Promise<void> {
    await this.eventLog.recordEvent({
      type: 'collected',
      channel: 'webhook',
      ref: event.reference,
      detail: 'Payment collected',
      organizationId: this.organizationId,
    });

    try {
      const adaptor = this.adaptorResolver.get(this.activeAdaptorId);
      if ((await adaptor.status()) !== 'connected') {
        await adaptor.connect();
      }
      await this.pushWithTimeout(adaptor, {
        id: event.id,
        transactionId: event.reference,
        externalInvoiceId: event.reference,
        status: event.status,
        processedAt: event.at,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to push collected payment to adaptor');
      await this.failureTracker.recordFailure({
        severity: 'critical',
        channel: 'accounting',
        title: 'Payment push to adaptor failed',
        detail: 'Failed to push collected payment to accounting adaptor',
        organizationId: this.organizationId,
      });
      // Rethrow so the webhook is NOT marked processed (M2): a failed push
      // remains retryable on the next delivery. `processWebhook` catches this
      // internally, so the pipeline still never throws to the caller.
      throw err;
    }
  }

  /**
   * Enforce the ≤5s push budget (FR-3.2). A hung adaptor call is surfaced as
   * a timeout rejection (treated as a push failure) instead of hanging forever.
   */
  private async pushWithTimeout(adaptor: AccountingAdaptor, payment: PaymentRef): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Adaptor push exceeded ${this.pushTimeoutMs}ms`)),
        this.pushTimeoutMs,
      );
      timer.unref();
    });

    try {
      await Promise.race([adaptor.pushCompletedPayment(payment), timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async handleFailure(event: WebhookEvent): Promise<void> {
    const type: LifecycleEventType =
      event.type === 'payment.declined' ? 'payment-declined' : 'payment-failed';
    await this.eventLog.recordEvent({
      type,
      channel: 'webhook',
      ref: event.reference,
      detail: 'Payment declined or failed',
      organizationId: this.organizationId,
    });
    await this.failureTracker.recordFailure({
      severity: 'critical',
      channel: 'payment',
      title: 'Payment declined or failed',
      detail: 'Payment was declined or failed',
      organizationId: this.organizationId,
    });
  }

  private async handleInitiated(event: WebhookEvent): Promise<void> {
    await this.eventLog.recordEvent({
      type: 'initiated',
      channel: 'webhook',
      ref: event.reference,
      detail: 'Payment initiated',
      organizationId: this.organizationId,
    });
  }
}

/** Singleton webhook processor wired to the default services and repositories. */
export const webhookProcessor = new WebhookProcessor(
  eventLog,
  failureTracker,
  adaptorRegistry,
  5000,
  'quickbooks',
  getRepositories().webhookDedup,
  'org-1',
);
