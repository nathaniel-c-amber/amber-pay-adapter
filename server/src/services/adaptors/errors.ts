import { AppError } from '../../utils/errors.js';
import type { AdaptorFailureReason } from '../../types/adaptor.js';

/**
 * Base adaptor error. Extends AppError so it flows through `toHttpError` and
 * the centralized error handler.
 */
export class AdaptorError extends AppError {
  constructor(statusCode: number, code: string, message: string, isOperational = true) {
    super(statusCode, code, message, isOperational);
  }
}

export class AdaptorConnectionError extends AdaptorError {
  constructor(message = 'Adaptor connection failed') {
    super(502, 'ADAPTOR_CONNECTION_ERROR', message);
  }
}

/**
 * Upstream authentication/authorization failure. Mapped to 502 (Bad Gateway)
 * because the failure is on the upstream adaptor, not the client. 401 is
 * reserved for client-facing auth (Phase 4).
 */
export class AdaptorAuthError extends AdaptorError {
  constructor(message = 'Adaptor authentication failed') {
    super(502, 'ADAPTOR_AUTH_ERROR', message);
  }
}

/**
 * Upstream rate limit. Mapped to 502 (Bad Gateway) to avoid confusing the
 * client with a 429 that implies the client is rate-limited.
 */
export class AdaptorRateLimitError extends AdaptorError {
  constructor(message = 'Adaptor rate limit exceeded') {
    super(502, 'ADAPTOR_RATE_LIMIT_ERROR', message);
  }
}

export class AdaptorSyncError extends AdaptorError {
  constructor(message = 'Adaptor sync failed') {
    super(502, 'ADAPTOR_SYNC_ERROR', message);
  }
}

/**
 * WHY applying a payment to the ledger did not produce a payment.
 *
 * A value rather than a sentence, for the same reason `AdaptorFailureReason` is
 * one: the failure tracker, the lifecycle event and the console all need to
 * tell these apart, and none of them can afford to pattern-match an error
 * message that someone will eventually reword.
 *
 * These are OPERATOR problems, not transport problems. An upstream that is
 * unreachable is `AdaptorConnectionError`; a payment that could not be placed
 * is this.
 */
export type AdaptorApplyFailure =
  /** The identifier matched no customer at all. */
  | 'customer-not-found'
  /** More than one customer matched, so choosing one would be a guess. */
  | 'customer-ambiguous'
  /** The customer has nothing outstanding. */
  | 'invoice-not-found'
  /** The amount charged is not a figure this process can compare. */
  | 'amount-invalid'
  /** The amount charged is more than the customer's total outstanding balance. */
  | 'amount-exceeds-balance'
  /** The customer has several open invoices and no rule to pick between them. */
  | 'invoice-ambiguous'
  /** The payment was recorded but the invoice did not clear. */
  | 'invoice-not-cleared'
  /** A bounded scan ran out of pages before it found a match. */
  | 'scan-limit-reached'
  /** No upstream payment carries the reference a reversal was asked for. */
  | 'payment-not-found'
  /** The upstream accepted the refund but its own record could not be corrected. */
  | 'refund-reversal-failed';

/**
 * A payment that could not be applied. Thrown, never returned, so it cannot be
 * mistaken for success — the processor turns it into a critical finding and
 * keeps the webhook retryable.
 *
 * `matches` is the number of candidates found, for the ambiguous cases. It is a
 * count and never a name, a reference or a figure, which is what lets it go
 * straight into an operator-facing message.
 */
export class AdaptorApplyError extends AdaptorError {
  constructor(
    readonly reason: AdaptorApplyFailure,
    message: string,
    readonly matches: number | null = null,
  ) {
    super(502, 'ADAPTOR_APPLY_ERROR', message);
  }
}

/**
 * Map an upstream HTTP status to the appropriate adaptor error. Used by
 * adaptors when a transport response is non-2xx.
 */
export function adaptorErrorForStatus(status: number, message: string): AdaptorError {
  if (status === 401 || status === 403) {
    return new AdaptorAuthError(message);
  }
  if (status === 429) {
    return new AdaptorRateLimitError(message);
  }
  if (status >= 500) {
    return new AdaptorConnectionError(message);
  }
  return new AdaptorError(status, 'ADAPTOR_ERROR', message);
}

/**
 * Classify an upstream HTTP status for reporting (the `HealthCheckResult`
 * counterpart of `adaptorErrorForStatus`, which throws instead of reporting).
 */
export function failureReasonForStatus(status: number): AdaptorFailureReason {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 429) {
    return 'rate-limited';
  }
  if (status >= 500) {
    return 'unreachable';
  }
  return 'upstream';
}

/**
 * Classify a thrown adaptor error for reporting.
 *
 * A non-`AdaptorError` (a `TypeError` from `fetch`, a DNS failure) is reported
 * as `unreachable`: the call did not produce an HTTP answer at all, which is
 * what "we could not reach it" means.
 */
export function failureReasonForError(error: unknown): AdaptorFailureReason {
  if (error instanceof AdaptorAuthError) {
    return 'auth';
  }
  if (error instanceof AdaptorRateLimitError) {
    return 'rate-limited';
  }
  return 'unreachable';
}
