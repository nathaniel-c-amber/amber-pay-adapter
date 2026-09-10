import { logger } from '../lib/logger.js';
import { adaptorRegistry } from '../adaptors/registry.js';
import { eventLog } from '../events/eventLog.js';
import { failureTracker } from '../events/failures.js';
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
 * Idempotency: processed webhook ids are tracked in-memory so duplicate or
 * replayed webhooks are skipped. DB-backed dedup is Phase 5.
 */
export class WebhookProcessor {
  private readonly processedIds = new Set<string>();

  constructor(
    private readonly eventLog: EventLog,
    private readonly failureTracker: FailureTracker,
    private readonly adaptorResolver: AdaptorResolver = adaptorRegistry,
    private readonly pushTimeoutMs = 5000,
    private readonly activeAdaptorId: AdaptorId = 'quickbooks',
  ) {}

  async processWebhook(event: WebhookEvent): Promise<void> {
    if (this.processedIds.has(event.id)) {
      logger.warn({ webhookId: event.id }, 'Duplicate webhook ignored');
      return;
    }
    this.processedIds.add(event.id);

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
      });
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
    });
    await this.failureTracker.recordFailure({
      severity: 'critical',
      channel: 'payment',
      title: 'Payment declined or failed',
      detail: 'Payment was declined or failed',
    });
  }

  private async handleInitiated(event: WebhookEvent): Promise<void> {
    await this.eventLog.recordEvent({
      type: 'initiated',
      channel: 'webhook',
      ref: event.reference,
      detail: 'Payment initiated',
    });
  }
}

/** Singleton webhook processor wired to the default event log, failure tracker and adaptor registry. */
export const webhookProcessor = new WebhookProcessor(eventLog, failureTracker);
