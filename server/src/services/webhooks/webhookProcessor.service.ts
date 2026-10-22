import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import { connectAdaptor } from '../adaptors/credentials.provider.js';
import { resolveConfiguredAdaptorId } from '../adaptors/activeAdaptor.service.js';
import {
  AdaptorApplyError,
  AdaptorAuthError,
  AdaptorConnectionError,
} from '../adaptors/errors.js';
import { adaptorRegistry } from '../adaptors/registry.js';
import { eventLog } from '../events/eventLog.service.js';
import { failureTracker } from '../events/failureTracker.service.js';
import { settingsService } from '../settings/settings.service.js';
import { GatewayStatusService, gatewayFailureReason } from '../gateway/transactionStatus.service.js';
import { openExpectedCharge } from '../gateway/amberPayWire.js';
import { getPool } from '../../db/pool.js';
import { getRepositories } from '../../repositories/index.js';
import { InMemoryWebhookDedupRepository } from '../../repositories/inMemory.js';
import { PostgresCheckoutIntentStore } from '../../repositories/postgres.js';
import type { WebhookDedupRepository } from '../../types/repository.js';
import type {
  AccountingAdaptor,
  AdaptorId,
  CustomerMatchConfig,
  PaymentRef,
  PushResult,
} from '../../types/adaptor.js';
import type { WebhookEvent, WebhookEventType } from '../../types/gateway.js';
import type { GatewayStatusStore } from '../gateway/transactionStatus.service.js';
import type {
  CustomerPaymentStatus,
  PaymentOutcomeStore,
} from '../payments/paymentStatus.service.js';
import type { LifecycleEventType } from '../../models/domain.js';
import type { EventLog } from '../events/eventLog.service.js';
import type { FailureTracker } from '../events/failureTracker.service.js';
import type { SettingsService } from '../settings/settings.service.js';

/**
 * What a failed push should be CALLED on the dashboard.
 *
 * The apply failures are named, and each one names the action an operator can
 * take, because "payment push failed" is the least useful sentence available:
 * it is equally true of a credential that expired, an identifier nobody
 * matched, and a company with three customers called the same. The upstream's
 * own error text is deliberately NOT used — a QuickBooks fault quotes back the
 * entity it refused, which is often a customer's name.
 */
function describePushFailure(action: string, err: unknown): string {
  if (err instanceof AdaptorApplyError) {
    switch (err.reason) {
      case 'customer-not-found':
        return 'No accounting customer matches this payment';
      case 'customer-ambiguous':
        return `${err.matches ?? 0} accounting customers match this payment; none was paid`;
      case 'invoice-not-found':
        return 'The matched accounting customer has no outstanding invoice';
      case 'invoice-ambiguous':
        return 'The matched accounting customer has several outstanding invoices';
      case 'amount-invalid':
        return 'The amount this payment was charged is not a usable figure';
      case 'amount-exceeds-balance':
        return 'The amount charged is more than the customer\'s total outstanding balance; nothing was written';
      case 'invoice-not-cleared':
        return 'The payment was recorded but the invoice is still outstanding';
      case 'scan-limit-reached':
        return 'The customer scan hit its limit before finding a match';
    }
  }
  /*
    ★ AUTH IS NAMED SEPARATELY, and it is safe here where the apply branches
    above are not.

    The rule above exists because a QuickBooks ENTITY fault quotes back what it
    refused, which is often a customer's name. An OAuth refusal is about the
    CREDENTIAL — "Incorrect or invalid refresh token" — and names no entity, so
    repeating it leaks nothing.

    Leaving it unnamed was not a cosmetic problem. A dead grant stops EVERY
    payment before matching begins, and reporting it as "payment push to adaptor
    failed" makes it indistinguishable from "your display-name rule matched
    nobody" — which sends an operator to rewrite a correct matching rule while
    the connection has simply never been authorized. That confusion is exactly
    what happened here.
  */
  if (err instanceof AdaptorAuthError) {
    return `The accounting connection rejected our credentials (${action}): ${err.message}`;
  }
  /*
    These are OUR sentences — "the gateway named no customer", "no matching rule
    is configured", "no accounting system is configured" — each already saying
    what to do. Flattening them into a generic title would discard the only part
    worth reading.
  */
  if (err instanceof AdaptorConnectionError) {
    return err.message;
  }
  return `Payment push to adaptor failed (${action})`;
}

/**
 * The success line, naming the invoices so an operator can go and look at them.
 *
 * An invoice id is the one upstream identifier worth putting in an event: it is
 * what the operator needs to find the record, and it identifies a transaction
 * rather than a person. Counts and figures are not, and it is also the reason
 * reconciliation is reported as a sentence rather than as the difference —
 * there is no amount in this result to quote.
 */
function describeApplied(adaptorName: string, result: PushResult): string {
  const refs =
    result.invoiceRefs.length > 0 ? result.invoiceRefs.join(', ') : 'unknown';
  const applied = result.alreadyApplied
    ? `Already recorded in ${adaptorName} on ${result.invoiceRefs.length > 1 ? 'invoices' : 'invoice'} ${refs}`
    : `${result.invoiceRefs.length > 1 ? 'Invoices' : 'Invoice'} ${refs} paid in ${adaptorName}`;
  return result.reconciliationRequired
    ? `${applied}; part of the payment is unapplied or an invoice moved during the write, so this needs reconciling`
    : applied;
}

/** Resolves an accounting adaptor by id (defaults to the singleton registry). */
export interface AdaptorResolver {
  get(id: AdaptorId): AccountingAdaptor;
}

/**
 * Test seams that are not positional.
 *
 * AN OBJECT, DELIBERATELY, and after this codebase has already paid for the
 * alternative: the singleton once passed its organization as a literal
 * positional, which silently DEFEATED the configured-organization default
 * because an explicit argument beats a default parameter. Every positional
 * added to this constructor is another one that can quietly outrank a default
 * in production while looking like configuration in a test.
 *
 * Both members are overrides. With neither set the processor reads the real
 * configuration, which is what the singleton does and what a test exercising
 * the unconfigured path needs.
 */
export interface WebhookProcessorOverrides {
  /** Skip the settings read and use this rule. */
  matchConfig?: CustomerMatchConfig;
  /** Stand in for the settings service. */
  settings?: Pick<SettingsService, 'resolveMatchConfig'>;
  /**
   * Where the gateway's verdict is written, so the customer's own status page
   * can show it.
   *
   * ★ IT IS AN OVERRIDE AND NOT A POSITIONAL, and the reason is that this
   * constructor has already been bitten by the alternative: the singleton once
   * passed its organization as a literal positional, which silently DEFEATED the
   * configured-organization default, because an explicit argument beats a default
   * parameter. An absent store means "this processor does not persist outcomes" —
   * which is what a unit test wants, and is NEVER true of the singleton, which
   * is wired with the real one below.
   */
  outcomes?: PaymentOutcomeStore;
  /**
   * How a payment that named no customer is asked about one.
   *
   * An override for the same reason `outcomes` is: the singleton wires the real
   * gateway below, and a unit test that exercises a callback with no
   * `StudentID` must be able to answer without a network.
   *
   * Only ever consulted for a delivery that arrived WITHOUT a customer — see
   * `resolveCustomer`, which returns immediately when the callback named one, so
   * the common case pays no round trip.
   */
  statuses?: Pick<GatewayStatusService, 'lookup'>;
  /**
   * Where the figure the gateway CHARGED is read from, so it can be applied to
   * the ledger.
   *
   * ★ IT IS THE SEALED CHECKOUT RECORD ON PURPOSE. The invoice balance is what
   * the invoice still owes, which is not the same thing as what the customer
   * paid — treating the two as one is the defect this seam exists to fix. A
   * charge that cannot be found or opened REFUSES the push rather than falling
   * back to a balance, because guessing here puts the wrong amount in the books.
   *
   * An override for the same reason `outcomes` is: the singleton wires the real
   * store, and a unit test must answer without a database.
   */
  charges?: Pick<GatewayStatusStore, 'findExpectedChargeByTransactionId'>;
}

/**
 * Which deliveries can be helped by asking the gateway who they were for.
 *
 * `payment.initiated` is absent because nothing downstream of it consumes a
 * customer: it records an event keyed by `refFor`, which already falls back to
 * the transaction id, and it never pushes. A lookup there would be a round trip
 * to the gateway on every started payment for an answer nobody reads.
 */
const NEEDS_A_CUSTOMER: ReadonlySet<WebhookEventType> = new Set<WebhookEventType>([
  'payment.collected',
  'payment.refunded',
  'payment.declined',
  'payment.failed',
]);

/**
 * The deliveries that HAVE a reason, so the only ones allowed to acquire one.
 *
 * Separate from `NEEDS_A_CUSTOMER` on purpose: a collected payment may well need
 * a customer resolved, but it must never end up carrying a `failureReason`. The
 * status API answers every transaction with a `ReasonCode` — for a success that
 * is the approval code — so preferring its text unconditionally would store an
 * approval as a failure on the one row whose whole job is to say the money
 * arrived. The read path hides a reason on a non-failed row, which would make
 * that invisible rather than harmless.
 */
const CAN_CARRY_A_REASON: ReadonlySet<WebhookEventType> = new Set<WebhookEventType>([
  'payment.declined',
  'payment.failed',
]);

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
    /*
      An OVERRIDE for tests. Left undefined in production so the push target comes
      from configuration: this used to default to the literal 'quickbooks', which
      meant a Sage deployment pushed its completed payments to QuickBooks.
    */
    private readonly activeAdaptorId?: AdaptorId,
    private readonly dedup: WebhookDedupRepository = new InMemoryWebhookDedupRepository(),
    /*
      The organization every event and failure is filed under. Defaults to the
      deployment's configured organization rather than a literal: an id written
      here that no policy names makes the rows invisible to the very users they
      are about, and only a wildcard super admin would ever see them.
    */
    private readonly organizationId = env.ORGANIZATION_ID,
    private readonly overrides: WebhookProcessorOverrides = {},
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
      /*
        ★ RESOLVED AFTER THE CLAIM AND BEFORE ANY HANDLER, and both ends of that
        are deliberate. After the claim, because a delivery this processor is not
        going to act on must not cost a round trip to the gateway. Before the
        handlers, because what comes back is not decoration: it decides the ref
        every lifecycle event is filed under, the `matchValue` the push matches
        an accounting customer on, and the decline reason the customer reads.
      */
      const resolved = await this.resolveCustomer(event);
      switch (resolved.type) {
        case 'payment.collected':
          await this.handleCollected(resolved);
          break;
        case 'payment.refunded':
          await this.handleRefunded(resolved);
          break;
        case 'payment.declined':
        case 'payment.failed':
          await this.handleFailure(resolved);
          break;
        case 'payment.initiated':
          await this.handleInitiated(resolved);
          break;
        default:
          logger.warn({ webhookType: resolved.type }, 'Unhandled webhook type');
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

  /**
   * Fill in the customer the callback did not carry, by asking the gateway.
   *
   * ★ ONLY WHEN THERE IS NOTHING TO ASK WITH. A callback that named a customer
   * returns immediately and the gateway is never contacted — the enrichment is
   * for the delivery the pipeline is otherwise stuck on, and a webhook must not
   * pay a round trip it does not need.
   *
   * ★ A FAULT HERE IS SWALLOWED, and this is the load-bearing decision of the
   * whole method. The status API is a best-effort enrichment on a path that
   * already answers the gateway: if it were allowed to fail the delivery, then a
   * gateway outage would become a new failure mode, the customer whose browser is
   * already on this url would get an error page instead of their status, and the
   * `202` the sender depends on would become a `500`. So a lookup that throws
   * logs identity and nothing else and hands the ORIGINAL event on, which lands
   * exactly where this pipeline landed before the enrichment existed: the money
   * recorded, and the critical finding that it cannot be applied to an invoice.
   *
   * The `err` is safe to log here, and that is not a habit: every error this
   * path can produce is constructed with a status code or an internal fault and
   * never with a response body. The body is the PII-dense thing — a cardholder
   * name, a padded card number, a billing email and a billing phone — and it is
   * read by one function that neither logs it nor lets it into an error.
   */
  private async resolveCustomer(event: WebhookEvent): Promise<WebhookEvent> {
    if (event.reference !== null) return event;
    if (!NEEDS_A_CUSTOMER.has(event.type)) return event;
    // Resolved HERE rather than in the constructor, which is also why it is an
    // override and not a tenth positional: a processor that never sees a
    // customerless delivery should not have built a service to service one, and
    // every positional added to this constructor is another that can quietly
    // outrank a default in production while looking like configuration in a test.
    const statuses = this.overrides.statuses ?? defaultGatewayStatus();
    try {
      const status = await statuses.lookup(this.organizationId, event.id);
      if (status === undefined) return event;
      return {
        ...event,
        reference: status.customerReference,
        /*
          THE GATEWAY'S OWN WORDS WIN over the callback's, and only for a
          delivery that can have a reason at all. The callback's `ErrorMessage`
          is the bare text a decline arrives with ("Invalid transaction"); the
          status response carries the code beside it. A null from
          `gatewayFailureReason` means the gateway said nothing useful either, and
          then the callback's own text is still the best answer there is — so
          this prefers, it never replaces.
        */
        failureReason: CAN_CARRY_A_REASON.has(event.type)
          ? gatewayFailureReason(status) ?? event.failureReason ?? null
          : event.failureReason ?? null,
      };
    } catch (err) {
      /*
        ★ TWO FAULTS, LOGGED AS TWO, because the service documents that they are
        different and an operator acts on them differently. A connection fault is
        the gateway being away and needs no action from us; anything else is our
        own record being unreadable — a sealed value that will not open, a key
        that changed — which is a fault in this system and will repeat on every
        delivery. Collapsing them into one sentence would hide the second behind
        the first.
      */
      if (err instanceof AdaptorConnectionError) {
        logger.warn(
          { webhookId: event.id, err },
          'Amber Pay could not be reached to say which customer this payment was for — continuing without it',
        );
      } else {
        logger.error(
          { webhookId: event.id, err },
          'Could not read our own record to ask the gateway which customer this payment was for — continuing without it',
        );
      }
      return event;
    }
  }

  /**
   * The lifecycle `ref` for an event, when the gateway named a customer.
   *
   * Falls back to the TRANSACTION id when it did not. An unattributed payment is
   * still a real payment that really happened, and recording it under our own
   * transaction id keeps it visible — whereas dropping the ref, or inventing a
   * subject, would make a collected payment look like it never arrived.
   */
  private refFor(event: WebhookEvent): string {
    return event.reference ?? event.id;
  }

  private async handleCollected(event: WebhookEvent): Promise<void> {
    /*
      ★ THE FACTS ARE WRITTEN ONCE; THE PUSH IS ATTEMPTED EVERY TIME.
      *
      * `true` means this delivery is the one that settled the payment, so it is
      * the one that may say so. `false` means an earlier delivery already
      * recorded it — which is the ordinary case here, because the gateway's
      * callback url IS its redirect url and a single payment arrives twice by
      * design. Writing both events again put two identical `Collected` entries
      * into an operator's timeline five seconds apart, which reads as two
      * payments when it is one.
      *
      * The push below is NOT inside this branch, and that asymmetry is the whole
      * fix: it is the only part of this pipeline with somewhere to go when it
      * fails, and it is the part that has to be retried. A payment that could not
      * reach QuickBooks because nothing was authorized is still owed to
      * QuickBooks, and the next delivery — from the server, or from the
      * customer's browser arriving on that same url — is what completes it.
    */
    const settled = await this.recordOutcome(event, 'collected');
    if (settled) {
      await this.eventLog.recordEvent({
        type: 'collected',
        channel: 'webhook',
        ref: this.refFor(event),
        detail: 'Payment collected',
        organizationId: this.organizationId,
      });
      // The flow ledger's "ingested" stage is derived from `webhook-received`, and
      // NOTHING wrote that event — so a fully working pipeline still reported the
      // ingested stage as "not reporting", and the Overview's hero panel was
      // permanently blank in the middle. The collection notification IS the
      // ingestion: it is recorded here rather than at claim time so the stages
      // stay in ledger order (collected before ingested).
      await this.eventLog.recordEvent({
        type: 'webhook-received',
        channel: 'webhook',
        ref: this.refFor(event),
        detail: 'Webhook accepted by the pipeline',
        organizationId: this.organizationId,
      });
    }

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
      ref: this.refFor(event),
      detail: 'Payment refunded',
      organizationId: this.organizationId,
    });

    await this.pushToAdaptor(event, 'refund');
  }

  /**
   * Connect if needed, then apply the payment in the active accounting system.
   *
   * On failure a critical Failure is recorded (FR-5.3) and the error is
   * rethrown so the webhook is NOT marked processed and stays retryable (M2).
   * `processWebhook` catches it, so the pipeline still never throws outward.
   */
  private async pushToAdaptor(event: WebhookEvent, action: string): Promise<void> {
    try {
      /*
        ★ A PAYMENT WITH NO CUSTOMER IS REFUSED, NOT GUESSED AT.
        The gateway can confirm a payment without naming a StudentID. The money
        still arrived, and `handleCollected` has already recorded that — but it
        cannot be applied to a ledger, because every candidate customer would be
        a guess and a guess here means real money against the wrong books.
        Throwing is deliberate: it files a finding an operator can act on, and
        because `processWebhook` releases the claim on failure, the delivery
        stays retryable in case a later callback does carry the identifier.
      */
      if (event.reference === null) {
        throw new AdaptorConnectionError(
          'The payment gateway confirmed this payment without saying which customer it was for, so it cannot be applied to an invoice',
        );
      }
      const adaptorId = this.activeAdaptorId ?? (await resolveConfiguredAdaptorId());
      if (!adaptorId) {
        /*
          Nothing to push to. Throwing is deliberate: a completed payment with
          nowhere to go is a real operational failure, and the surrounding catch
          records it as a critical Failure rather than letting the event look
          processed and disappear.
        */
        throw new AdaptorConnectionError(
          'No accounting system is configured for this deployment, so a completed payment cannot be recorded',
        );
      }
      const adaptor = this.adaptorResolver.get(adaptorId);
      if ((await adaptor.status()) !== 'connected') {
        // Through the provider: the adaptor reads no environment, and the same
        // call is what persists a rotated credential.
        await connectAdaptor(adaptor);
      }
      const result = await this.pushWithTimeout(adaptor, {
        id: event.id,
        // `event.id` is the gateway's echo of OUR transaction id. It was
        // `event.reference`, which is the CUSTOMER — so the payment that reached
        // the ledger was labelled with a student id instead of the transaction
        // it belonged to.
        transactionId: event.id,
        // And the reverse: the customer was being matched on the gateway's own
        // timestamp-derived OrderId, which can never identify anybody.
        matchValue: event.reference,
        status: event.status,
        processedAt: event.at,
      }, await this.resolveMatchConfig(), await this.resolveChargedAmount(event));
      // The terminal stage of the ledger: the record now exists in the
      // accounting system. Derived from `record-updated`, which (like
      // `webhook-received`) nothing ever wrote, so a successful push left no
      // trace and the flow's final stage could never report.
      await this.eventLog.recordEvent({
        type: 'record-updated',
        channel: 'accounting',
        ref: this.refFor(event),
        detail: describeApplied(adaptor.name, result),
        organizationId: this.organizationId,
      });
    } catch (err) {
      logger.error({ err }, `Failed to push ${action} to adaptor`);
      await this.failureTracker.recordFailure({
        severity: 'critical',
        channel: 'accounting',
        title: describePushFailure(action, err),
        detail: `Failed to push ${action} to accounting adaptor`,
        organizationId: this.organizationId,
      });
      throw err;
    }
  }

  /**
   * The figure the customer was CHARGED, read from the sealed checkout record.
   *
   * `event.id` is our transaction id, and it is the key the checkout row was
   * written under. The value is opened here and held only for the duration of
   * the push: it is passed as an argument and never written to `PaymentRef`, an
   * event, a failure or a log line.
   *
   * ★ A MISSING ROW REFUSES THE PUSH. It would be easy to fall back to the
   * invoice balance, and that is exactly the bug being repaired: the balance is
   * what the invoice still owes, so a partial payment would be recorded as the
   * full amount. An operator can see and fix a refused push; a plausible wrong
   * figure is invisible until the books are reconciled.
   */
  private async resolveChargedAmount(event: WebhookEvent): Promise<string> {
    const charges = this.overrides.charges ?? defaultExpectedCharges();
    const row = await charges.findExpectedChargeByTransactionId(
      this.organizationId,
      event.id,
    );
    if (row === undefined) {
      throw new AdaptorConnectionError(
        'The amount this payment was charged could not be found, so it cannot be applied to an invoice without guessing.',
      );
    }
    try {
      return openExpectedCharge(row.expectedSealed).amount;
    } catch {
      throw new AdaptorConnectionError(
        'The amount this payment was charged could not be read, so it cannot be applied to an invoice without guessing.',
      );
    }
  }

  /**
   * How this deployment matches a payment to an accounting customer.
   *
   * Resolved HERE rather than inside the adaptor, and injected for the same
   * reason the adaptor's credentials are: an adaptor that reads configuration
   * itself is the coupling this codebase removed from `connect`, and it would
   * come straight back through a method added later.
   */
  private async resolveMatchConfig(): Promise<CustomerMatchConfig> {
    if (this.overrides.matchConfig) return this.overrides.matchConfig;
    const settings = this.overrides.settings ?? settingsService;
    const stored = await settings.resolveMatchConfig();
    if (stored) return stored;
    /*
      No match configured. Refusing is the only safe answer, and the refusal
      names the fix: the alternative is a default strategy nobody chose, which
      would quietly decide that a student's identifier is their name and pay
      whichever ledger happened to match.
    */
    throw new AdaptorConnectionError(
      'No customer matching rule is configured, so a completed payment cannot be placed on an invoice. Set one in system configuration.',
    );
  }

  /**
   * Enforce the push budget (FR-3.2). A hung adaptor call is surfaced as
   * a timeout rejection (treated as a push failure) instead of hanging forever.
   *
   * THE BUDGET IS THE STALE PART OF THIS COMMENT AND OF THE REQUIREMENT. It was
   * set against a single upstream call; the real pipeline is up to five
   * sequential ones (match, invoice, already-done, create, verify), so ≤5s is
   * no longer what this measures. It is kept at 5s rather than quietly widened,
   * because the number in REQUIREMENTS is a promise to the operator and
   * changing it is a decision, not an implementation detail. The measured cold
   * and warm costs are in `dev/QUICKBOOKS-INVOICE-PIPELINE.md`.
   */
  private async pushWithTimeout(
    adaptor: AccountingAdaptor,
    payment: PaymentRef,
    match: CustomerMatchConfig,
    amount: string,
  ): Promise<PushResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Adaptor push exceeded ${this.pushTimeoutMs}ms`)),
        this.pushTimeoutMs,
      );
      timer.unref();
    });

    try {
      return await Promise.race([
        adaptor.pushCompletedPayment(payment, match, amount),
        timeout,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async handleFailure(event: WebhookEvent): Promise<void> {
    const type: LifecycleEventType =
      event.type === 'payment.declined' ? 'payment-declined' : 'payment-failed';
    // FIRST, before anything else reacts to it. The verdict is the gateway's own
    // statement about the money; the event, the finding and the push are this
    // system's reaction to it. A customer redirected to a status page is reading
    // THAT, so it is recorded before the reaction starts — and if the write
    // fails, `processWebhook` releases the claim and the delivery stays retryable
    // rather than settling a payment nobody can see.
    //
    // ★ AND THE REACTION IS WRITTEN ONCE, for the same reason `handleCollected`
    // writes its facts once: the decline and the finding that reports it are two
    // statements of the SAME fact, so a delivery that did not settle the payment
    // repeats neither. A browser re-triggering the callback must not multiply an
    // operator's open findings.
    const settled = await this.recordOutcome(event, 'failed');
    if (settled) {
      await this.eventLog.recordEvent({
        type,
        channel: 'webhook',
        ref: this.refFor(event),
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
  }

  private async handleInitiated(event: WebhookEvent): Promise<void> {
    await this.eventLog.recordEvent({
      type: 'initiated',
      channel: 'webhook',
      ref: this.refFor(event),
      detail: 'Payment initiated',
      organizationId: this.organizationId,
    });
  }

  /**
   * Write the gateway's verdict where the CUSTOMER can read it.
   *
   * Absent store means the seam was not wired — a unit test, never the singleton.
   * Nothing is logged for it: a logger warning on every callback of a test
   * process is noise, and the singleton's wiring is asserted directly rather than
   * inferred from a log nobody reads.
   *
   * `failureReason` is the gateway's own text, already stripped and capped by the
   * schema in `amberpay.service.ts`. It is passed straight through rather than
   * re-cleaned here, because two sanitisation passes would be two places to keep
   * honest and the one that faces the wire is the one that should do it.
   *
   * ★ RETURNS WHETHER THE FACTS BELONG TO THIS DELIVERY, and the absent store
   * answers `true` rather than `false`. That is not a shrug: with nothing
   * persisting outcomes there is no earlier delivery that could have recorded
   * one, so this delivery is the first and the only one, and the facts it writes
   * belong to it. Answering `false` would silence every event in every unit test
   * of a pipeline that is working perfectly.
   */
  private async recordOutcome(
    event: WebhookEvent,
    outcome: Exclude<CustomerPaymentStatus, 'unknown'>,
  ): Promise<boolean> {
    const store = this.overrides.outcomes;
    if (store === undefined) return true;
    return store.recordOutcome({
      organizationId: this.organizationId,
      transactionId: event.id,
      outcome,
      failureReason: event.failureReason ?? null,
    });
  }
}

/**
 * The gateway status service, built once.
 *
 * MEMOISED rather than constructed per processor, for the reason the pool
 * underneath is: every caller shares one lazy pool, and a processor that never
 * sees a customerless delivery should not have built anything to service one.
 */
let gatewayStatus: GatewayStatusService | undefined;

function defaultGatewayStatus(): GatewayStatusService {
  gatewayStatus ??= new GatewayStatusService(new PostgresCheckoutIntentStore(getPool()));
  return gatewayStatus;
}

/**
 * The sealed-charge store, built once.
 *
 * Same reasoning as the status service above: the pool underneath is shared and
 * lazy, and a processor that never pushes should not build a second one. The
 * default is the REAL store rather than an absent seam — "no charge recorded"
 * must mean the row is missing, never that production forgot to wire the read.
 */
let expectedCharges: PostgresCheckoutIntentStore | undefined;

function defaultExpectedCharges(): PostgresCheckoutIntentStore {
  expectedCharges ??= new PostgresCheckoutIntentStore(getPool());
  return expectedCharges;
}

/**
 * Singleton webhook processor wired to the default services and repositories.
 *
 * IT PASSES NO HARDCODED CHOICES. Both used to be literals — `'quickbooks'` for
 * the push target and `'org-1'` for the organization — and the second silently
 * DEFEATED the configured-organization default, because an explicit argument
 * beats a default parameter. Every choice now comes from configuration.
 *
 * `undefined` is passed for the adaptor rather than omitted, so the dedup
 * repository keeps its position: dropping it would quietly swap the shared
 * container for a throwaway in-memory one and break webhook deduplication across
 * restarts.
 *
 * The GATEWAY STATUS SERVICE is left to its constructor default, deliberately:
 * that default is the real service over the real store, so the singleton
 * resolves a customerless callback. Omitting it would be tidier only if the
 * singleton did not need it — which is the defect it exists to repair.
 */
export const webhookProcessor = new WebhookProcessor(
  eventLog,
  failureTracker,
  adaptorRegistry,
  5000,
  undefined,
  getRepositories().webhookDedup,
  undefined,
  /*
    The one place the outcome store is wired. Passed through the overrides object
    rather than as a ninth positional, so it can never quietly outrank a default —
    and it is explicit that the singleton DOES persist outcomes, because "absent
    store means skip" is a seam for tests and must never be true in production.
  */
  { outcomes: new PostgresCheckoutIntentStore(getPool()) },
);
