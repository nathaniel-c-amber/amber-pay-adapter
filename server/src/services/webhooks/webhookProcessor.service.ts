import { logger } from '../../utils/logger.js';
import { adaptorRegistry } from '../adaptors/registry.js';
import { eventLog } from '../events/eventLog.service.js';
import { failureTracker } from '../events/failureTracker.service.js';
import { getRepositories } from '../../repositories/index.js';
import { InMemoryWebhookDedupRepository } from '../../repositories/inMemory.js';
import type { WebhookDedupRepository } from '../../types/repository.js';
import type { AccountingAdaptor, AdaptorId, PaymentRef } from '../../types/adaptor.js';
import type { WebhookEvent } from '../../types/gateway.js';
import type { LifecycleEventType } from '../../models/domain.js';
import type { EventLog } from '../events/eventLog.service.js';
import type { FailureTracker } from '../events/failureTracker.service.js';

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
    const now = new Date().toISOString();

    // CLAIM the id before doing any work. This single statement decides
    // ownership, so two concurrent deliveries of one transaction cannot both
    // proceed — the previous "check processed, then mark processing" pair left
    // exactly that window. A false result means the id has already been seen in
    // ANY state (duplicate or replay) and is dropped.
    if (!(await this.dedup.claim(event.id, now))) {
      logger.warn({ webhookId: event.id }, 'Duplicate webhook ignored');
      return;
    }

    try {
      switch (event.type) {
        case 'payment.collected':
          await this.handleCollected(event);
          break;
        case 'payment.refunded':
          await this.handleRefunded(event);
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
      // Give the claim back. Without this the id would stay claimed, so every
      // subsequent delivery of a payment we failed to push would be dismissed
      // as a duplicate and the accounting record would never be written.
      await this.dedup.release(event.id);
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

    await this.pushToAdaptor(event, 'collected payment');
  }

  /**
   * A refund corrects a record that was already posted, so it takes the same
   * push path as a collection: the adaptor is told the new status ('refunded')
   * rather than this service inventing a local reversal it cannot verify.
   */
  private async handleRefunded(event: WebhookEvent): Promise<void> {
    await this.eventLog.recordEvent({
      type: 'payment-refunded',
      channel: 'webhook',
      ref: event.reference,
      detail: 'Payment refunded',
      organizationId: this.organizationId,
    });

    await this.pushToAdaptor(event, 'refund');
  }

  /**
   * Connect if needed, then push the payment to the active accounting adaptor.
   *
   * On failure a critical Failure is recorded (FR-5.3) and the error is
   * rethrown so the webhook is NOT marked processed and stays retryable (M2).
   * `processWebhook` catches it, so the pipeline still never throws outward.
   */
  private async pushToAdaptor(event: WebhookEvent, action: string): Promise<void> {
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
      logger.error({ err }, `Failed to push ${action} to adaptor`);
      await this.failureTracker.recordFailure({
        severity: 'critical',
        channel: 'accounting',
        title: 'Payment push to adaptor failed',
        detail: `Failed to push ${action} to accounting adaptor`,
        organizationId: this.organizationId,
      });
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
