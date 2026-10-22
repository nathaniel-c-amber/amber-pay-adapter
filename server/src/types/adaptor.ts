import type { PaymentStatus } from '../models/domain.js';

/**
 * Adaptor identifiers. Extensible: add new members as new accounting
 * platforms are supported.
 *
 * EXTENSION POINT: adding a new adaptor requires editing this union AND
 * registering it in `registry.ts`.
 */
export type AdaptorId = 'quickbooks' | 'sage';

/**
 * Operational adaptor status. `'error'` and `'syncing'` are reserved for
 * future use (e.g. surfaced from a live connection); the current stub
 * implementations only report `'connected'` / `'disconnected'`.
 */
export type AdaptorStatus = 'connected' | 'disconnected' | 'error' | 'syncing';

/**
 * Operational sync result. Counts only — NO amounts, NO PII.
 *
 * ERROR SIGNALING: methods THROW `AdaptorError` on failure (consistent with
 * the Phase 1 error model). This result is success/warning-shaped only;
 * `status: 'error'` is never returned.
 */
export interface SyncResult {
  status: 'ok' | 'warning';
  ranAt: string; // ISO 8601
  matched: number;
  unmatched: number;
  anomalies: number;
  /** Optional detail accompanying a `'warning'` status. */
  message?: string;
}

/**
 * How a completed payment is matched to an accounting customer.
 *
 * `displayName` and `customField` are resolved by a single upstream QUERY.
 * `notes` is NOT: QuickBooks does not mark `Customer.Notes` filterable, so it
 * can only be matched by paging every customer and comparing in memory. It
 * works, it costs several rate-limited calls, and the console says so.
 */
export type CustomerMatchStrategy = 'displayName' | 'customField' | 'notes';

/** Whether a match must be the whole value or may be a substring. */
export type CustomerMatchMode = 'exact' | 'contains';

/**
 * Why a pre-flight check refused a checkout.
 *
 * These are DEFINITIVE data answers: the accounting record says the payment
 * cannot be placed. They are values so the caller can map each to a sentence
 * that names the fix, and so an upstream fault can never be mistaken for one
 * of them (see `preflightPayment` below).
 */
export type PreflightRejection =
  | 'customer-not-found'
  | 'customer-ambiguous'
  | 'invoice-not-found'
  | 'amount-invalid'
  | 'amount-exceeds-balance'
  | 'currency-mismatch';

export interface PreflightOutcome {
  ok: boolean;
  /** Present only when `ok` is false. */
  reason?: PreflightRejection;
}

/**
 * What a pre-flight check is told about the payment being created.
 *
 * THE MATCH RULE IS PART OF THE INPUT, not read by the adaptor: an adaptor
 * reads no configuration (the same rule `pushCompletedPayment` follows), so the
 * caller resolves it and hands it over.
 */
export interface PreflightPaymentInput {
  matchValue: string;
  amount: string;
  currency: string;
  match: CustomerMatchConfig;
}

/**
 * HOW an adaptor resolves a payment to a customer and an invoice.
 *
 * Deployment configuration, supplied by the CALLER — an adaptor reads no
 * environment and no settings row, so the strategy has to arrive as an
 * argument. Without it there is exactly one strategy, hard-coded in whichever
 * adaptor is called, and a second deployment cannot use a different one.
 */
export interface CustomerMatchConfig {
  strategy: CustomerMatchStrategy;
  mode: CustomerMatchMode;
  /**
   * The upstream custom field's NAME, required when `strategy` is
   * `customField`. Names are matched exactly, so this is not case-insensitive
   * and not a wildcard.
   */
  fieldName: string | null;
  /**
   * Where received money is deposited. `null` omits the reference, which the
   * upstream resolves to its undeposited-funds account.
   */
  depositAccountId: string | null;
}

/**
 * Success-shaped push result. On failure the method THROWS `AdaptorError`.
 *
 * EVERY field here is safe to put in a log line, an event detail or a failure
 * title: opaque upstream ids, a strategy name and three booleans. There is
 * deliberately no field for a name, an amount or a balance — `privacy.test.ts`
 * checks that, and the adaptor's own request bodies are where money lives.
 */
export interface PushResult {
  externalRef: string;
  at: string; // ISO 8601
  /**
   * The upstream invoices this payment was applied to, in the order it was
   * allocated. Empty when a prior payment named none. IDS ONLY: no figures and
   * no names, for the same reason as every other field here.
   */
  invoiceRefs: string[];
  /**
   * Someone has to look at this by hand: either the upstream left part of the
   * payment unapplied, or a touched invoice moved by more than this payment
   * alone. A boolean rather than a reason, and never an amount — the figure
   * that would explain it is not allowed to leave the wire layer.
   */
  reconciliationRequired: boolean;
  /** Which strategy resolved the customer. `none` means nothing matched. */
  matchedBy: CustomerMatchStrategy | 'none';
  /** A prior payment already covered this reference; nothing was written. */
  alreadyApplied: boolean;
  /** The post-write re-read confirmed every allocated invoice moved as expected. */
  verified: boolean;
}

/**
 * Why an adaptor probe failed, as a value rather than a sentence.
 *
 * The lifecycle event recorder has to tell "the token expired" from "the
 * network is down" because they need opposite responses, and scraping a status
 * code out of a human-readable `message` with a regex is exactly the kind of
 * coupling that silently breaks when someone rewords the message.
 */
export type AdaptorFailureReason = 'auth' | 'rate-limited' | 'unreachable' | 'upstream';

/**
 * Health probe result. Unlike push/sync, health checks REPORT rather than
 * throw: `ok:false` + `message` is returned on a non-2xx response so callers
 * can distinguish healthy from unhealthy without exception handling.
 */
export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
  /** Present when `ok` is false; classifies the failure for callers. */
  reason?: AdaptorFailureReason;
}

/**
 * Minimal, privacy-safe reference to a completed payment that an adaptor
 * consumes. NO amounts, NO PII, NO raw card data.
 *
 * THERE IS NO INVOICE ID HERE, and that is the correction this type exists to
 * make. It used to carry `externalInvoiceId`, which the webhook processor
 * filled with the GATEWAY's order reference — a value QuickBooks has never
 * heard of, passed where an upstream transaction id belongs. An adaptor given
 * it had no way to do anything honest: apply a payment to a transaction that
 * does not exist, or guess. The invoice is now DISCOVERED, from the customer
 * the payment identifies.
 */
/**
 * What an adaptor is asked to reverse after the GATEWAY has already refunded.
 *
 * `originalAmount` and `refundAmount` are the two figures the accounting side
 * needs to tell a full reversal (remove the payment) from a partial one (which
 * must be adjusted by hand). They are named with the qualifier rather than
 * `amount` because they are not a figure the domain ever keeps — they exist
 * only for the duration of this call.
 */
export interface ReversalPaymentInput {
  transactionId: string;
  originalAmount: string;
  refundAmount: string;
}

/**
 * What the accounting system did about a refund that already happened.
 *
 * A PARTIAL REFUND IS NOT DELETED. Deleting the upstream payment would restore
 * the whole invoice balance, which is wrong when only part of the money went
 * back; the adaptor says so and a person completes the adjustment.
 */
export type ReversalOutcome =
  | { status: 'reversed' }
  | { status: 'manual-adjustment-required' };

export interface PaymentRef {
  /**
   * The gateway's transaction id for this payment. It is the pipeline's
   * dedup key, which makes it the right value for an upstream idempotency
   * field: it is the one identifier a retry is guaranteed to repeat.
   */
  id: string;
  /** The gateway's own stable reference for the payment. */
  transactionId: string;
  /**
   * The value an adaptor matches an accounting customer on — a student id, a
   * member number, whatever the deployment configured. It is today the same
   * string as `transactionId`, because the gateway sends one opaque reference
   * and the privacy boundary drops everything else. It is a separate field so
   * that a gateway able to report the identifier separately needs no change
   * here, and so the two roles cannot be silently conflated.
   *
   * Constrained to `OPAQUE_REFERENCE` at the adaptor boundary, because it is
   * interpolated into an upstream query string.
   */
  matchValue: string;
  status: PaymentStatus;
  processedAt: string; // ISO 8601
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Typed transport response. */
export interface AdaptorResponse {
  status: number;
  body: unknown;
}

/**
 * Thin transport seam used by adaptors to make HTTP calls. Real
 * implementations are stubbed pending credentials; tests inject a mock.
 */
export type AdaptorTransport = (
  method: HttpMethod,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<AdaptorResponse>;

/**
 * Credentials for one accounting connection, SUPPLIED by the caller.
 *
 * THE ADAPTOR READS NO ENVIRONMENT. It used to call `env.QUICKBOOKS_*` inside
 * `connect()`, which made credentials a property of the process rather than of
 * the deployment's configuration record — so there was nowhere to put a value an
 * administrator had entered, and a rotated refresh token had nowhere to be
 * written back to. Every field is optional because "configured but missing a
 * piece" is a real state whose error message an operator needs to read.
 */
export interface AdaptorCredentials {
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  /** The accounting company / tenant the credentials are scoped to. */
  realmId?: string;
  accessToken?: string;
  refreshToken?: string;
}

/**
 * What a connection attempt learned that the caller must remember.
 *
 * `rotated` exists because some upstreams invalidate a credential as they spend
 * it: Intuit issues a NEW refresh token on every exchange. If the caller does
 * not persist it, the next process start presents a token that has already been
 * used, and the connection dies one token-lifetime after every restart — which
 * looks like flakiness rather than like a bug.
 */
export interface ConnectResult {
  rotated?: AdaptorCredentials;
}

/**
 * The extensibility contract for accounting adaptors. Every accounting
 * platform (QuickBooks, Sage, ...) implements this interface.
 *
 * CONVENTIONS:
 * - `pushCompletedPayment` / `pullSyncStatus` THROW `AdaptorError` on failure.
 * - `healthCheck` reports via `ok:false` + `message` on failure (no throw).
 * - All methods that talk to the upstream MUST be called after `connect()`;
 *   they throw `AdaptorConnectionError` if the adaptor is not connected.
 * - `connect` takes its credentials as an argument and reads no environment.
 * - `pushCompletedPayment` takes its matching strategy as an argument for the
 *   same reason. An adaptor that reads configuration itself is the coupling
 *   this codebase removed from `connect`, reintroduced one method later.
 */
export interface AccountingAdaptor {
  readonly id: AdaptorId;
  readonly name: string;
  connect(credentials: AdaptorCredentials): Promise<ConnectResult | void>;
  disconnect(): Promise<void>;
  status(): Promise<AdaptorStatus>;
  /**
   * Apply a completed payment in the accounting system: resolve the customer,
   * find their open invoices, allocate the money across the oldest first, and
   * confirm every touched invoice moved. Throws on any failure, including a
   * match that found nothing or found too much — a wrong customer is not a
   * state to guess your way out of.
   *
   * `amount` IS A TRANSIENT ARGUMENT AND MUST NEVER BE STORED. It is the figure
   * the gateway signed and showed the customer, in major units ("250.00"), and
   * it exists only for the duration of this call. It is deliberately NOT on
   * `PaymentRef`: a domain entity, an event, a failure title or a log line that
   * carried it would outlive the payment being applied and leak a ledger figure
   * into the privacy boundary. `privacy.test.ts` checks the shapes that leave
   * this call; this parameter is not one of them.
   */
  pushCompletedPayment(
    payment: PaymentRef,
    match: CustomerMatchConfig,
    amount: string,
  ): Promise<PushResult>;
  /**
   * Check whether a payment COULD be placed before a checkout is minted.
   *
   * OPTIONAL on purpose. Absence means "this adaptor cannot check", which is
   * different from "the check passed": the caller skips validation and lets the
   * payment through, exactly as it does for a deployment with no accounting
   * integration at all. Sage therefore needs no change.
   *
   * A definitive data refusal is RETURNED (`ok:false`); an upstream fault
   * THROWS. The caller must not treat the second as the first — a QuickBooks
   * outage must never stop a customer from paying.
   */
  preflightPayment?(input: PreflightPaymentInput): Promise<PreflightOutcome>;
  /**
   * Reverse the accounting record after the GATEWAY has refunded the money.
   *
   * OPTIONAL for the same reason `preflightPayment` is. It is called only after
   * the provider has already accepted the refund, so a failure here is reported
   * as a bookkeeping problem and never treated as a refund failure — the gateway
   * permits exactly one refund and cannot be made to try again.
   */
  reverseCompletedPayment?(input: ReversalPaymentInput): Promise<ReversalOutcome>;
  pullSyncStatus(): Promise<SyncResult>;
  healthCheck(): Promise<HealthCheckResult>;
}
