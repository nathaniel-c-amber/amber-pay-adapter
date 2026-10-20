/* What a customer is told about a payment they have just made.
 *
 * ★ THIS IS THE ONLY READ IN THE SYSTEM WITH NO SESSION, AND IT IS WHY IT IS
 * THIS NARROW.
 *
 * The Amber Pay gateway was registered with the SAME url as its callback and as
 * its redirect — `POST /api/v1/webhooks/amber-pay` — deliberately, so the
 * browser's arrival doubles as a manual re-trigger of a callback that failed to
 * arrive. Whoever lands there is a customer who has just handed over card
 * details: they hold no session, no uuid (ours, and it never leaves this
 * origin), and no operator's credentials. A 256-bit token in the url is what
 * makes the page reachable at all, and it is also the whole authorisation.
 *
 * So the response is the minimum a page can be drawn from — an outcome, the
 * reference to quote at support, the gateway's own words when it declined, and
 * the figure the customer was charged — and nothing else. There is no student
 * identifier, no invoice, no organization, no card field, and no way to ask a
 * question that would return anything a token holder should not already know
 * about their own payment.
 *
 * ★ NO 404, DELIBERATELY. An unknown token answers 200 with `status: 'unknown'`
 * and nulls, never 404. At 256 bits there is nothing to enumerate, so a 404
 * would buy no security — while it WOULD tell the SPA to render an error page
 * for the one case that is entirely normal: a customer who has just paid and
 * whose callback has not been processed yet. That is a waiting state, and a
 * waiting state must look like a waiting state.
 */

import { logger } from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';
import { isStatusToken, openExpectedCharge } from '../gateway/amberPayWire.js';

/**
 * What the customer is told, as a closed union.
 *
 * `unknown` is the absence of a verdict, not a verdict: the token resolved (or
 * did not) but the gateway's callback has not been processed. It is the NORMAL
 * state for someone who has just paid, and it is distinct from `pending`,
 * which will mean "the gateway says this payment is still in flight" once the
 * status-API follow-up lands. That vocabulary is also the database's — see the
 * CHECK constraint in migration 009 — so the two cannot drift.
 */
export type CustomerPaymentStatus = 'collected' | 'failed' | 'pending' | 'unknown';

/**
 * A checkout intent as the status page needs it.
 *
 * `expectedSealed` is read ONLY here and only to draw the figure back to the
 * person who already paid it. It is not returned, logged, or recorded anywhere;
 * the service opens it and immediately reduces it to the two strings the page
 * shows.
 */
export interface CheckoutStatusRow {
  /** Ours, and the gateway's echo of it — what a customer quotes at support. */
  transactionId: string;
  expectedSealed: Buffer;
  /** Null until the callback has been processed. See `CustomerPaymentStatus`. */
  outcome: Exclude<CustomerPaymentStatus, 'unknown'> | null;
  /** The gateway's own failure text, when it sent one. Never an instrument detail. */
  failureReason: string | null;
}

/** The row the status endpoint reads by. Separate from `CheckoutIntentStore`. */
export interface PaymentStatusStore {
  findByStatusToken(token: string): Promise<CheckoutStatusRow | undefined>;
}

/**
 * Where the gateway's verdict is WRITTEN.
 *
 * Declared beside the read rather than on `CheckoutIntentStore` so the checkout
 * writer is not made to care: a checkout has no verdict to record, and every
 * test stub of the store would otherwise have to implement a method that has no
 * business existing yet at that point in the flow.
 */
export interface PaymentOutcomeStore {
  /**
   * Record what the gateway reported, idempotently — a repeated callback for a
   * payment that has already settled must not move it.
   *
   * This is the write the customer-facing page is built on. It is a write, not a
   * read, and it happens on the webhook's own path; the status endpoint itself
   * never calls it.
   *
   * ★ IT ANSWERS WHETHER THE FACTS BELONG TO THIS DELIVERY, and that is the
   * return value's only job. The gateway's callback url is also its redirect
   * url, so one payment genuinely arrives twice: the money is real, the facts
   * are the same, and only the ACCOUNTING PUSH should ever be attempted again. A
   * caller that cannot tell the two deliveries apart therefore has no way to
   * write the `collected` lifecycle event once and retry the push — and writing
   * it twice is what put two identical events into an operator's timeline five
   * seconds apart.
   *
   * `true` therefore means "write the events for this payment now"; `false` means
   * "an earlier delivery already recorded this payment". It must NOT be
   * implemented as "the row changed": a transaction with no intent row at all
   * changes nothing either, and answering `false` there would silently drop the
   * record of a payment that really arrived — the one case where the events are
   * the only trace there is. `false` never means "something is wrong"; it means
   * "someone already said this".
   */
  recordOutcome(input: {
    organizationId: string;
    transactionId: string;
    /** Never 'unknown' — that is an absence of a verdict, not one. */
    outcome: Exclude<CustomerPaymentStatus, 'unknown'>;
    /** The gateway's own words, already sanitised and capped by the gateway layer. */
    failureReason: string | null;
  }): Promise<boolean>;
}

/**
 * ★ A FIGURE APPEARS IN THIS INTERFACE, AND THIS IS THE ALLOW-LIST ENTRY THAT
 * SAYS WHY.
 *
 * `models/privacy.test.ts` exists because "no money outside two wire files" was
 * an assertion in a comment and a `TotalAmt` added anywhere else would have
 * typechecked and gone green. It scans every interface in the server tree and
 * permits a named set. This interface is in that set, for the same reason
 * `StandardCheckoutParams` is: a figure the CUSTOMER typed has to reach the
 * CUSTOMER, and the boundary that serves them is this one.
 *
 * What makes it defensible is that it is read-only, it carries nothing else, and
 * it is reachable only by holding a 256-bit token for that one payment. A figure
 * reaching a domain type, an event, a failure or a log line would not be.
 */
export interface CustomerPaymentStatusView {
  /** Whether the payment was collected, failed, is pending, or is not yet known. */
  status: CustomerPaymentStatus;
  /** The gateway TransactionId — the reference support can search on. */
  reference: string | null;
  /**
   * The gateway's own failure text, verbatim-ish. `null` when it declined without
   * saying why, and when there is nothing to decline.
   *
   * This is the USER'S OWN WORDS COMING BACK TO THEM — a decline reason from an
   * issuer, quoted so the page can say why rather than shrug. It is not a
   * payment instrument detail, which is the whole reason `Amount`, `CurrencyCode`
   * and every card field on the wire are dropped at the schema: a decline reason
   * is about the transaction, and a card token is about the instrument.
   */
  reason: string | null;
  /** MAJOR units, as the string the operator typed. NEVER a JS number. */
  amount: string | null;
  /** The gateway's three-letter code, opened from the same sealed value. */
  currency: string | null;
}

/** What a token that resolves to nothing looks like. Nulls, and `unknown`. */
const NOTHING: CustomerPaymentStatusView = {
  status: 'unknown',
  reference: null,
  reason: null,
  amount: null,
  currency: null,
};

export class PaymentStatusService {
  constructor(private readonly store: PaymentStatusStore) {}

  /**
   * What the page should say about the payment this token names.
   *
   * A token that is not the SHAPE of one we mint is refused with a 400, and a
   * token that is well formed but names nothing answers `unknown`. Both are
   * deliberate: a malformed token is a client's bug worth telling it about, and
   * an unresolvable one is not distinguishable from "not processed yet" — so
   * guessing which one it was would be a guess about a customer's money.
   *
   * ★ SIDE-EFFECT FREE. No write, no status transition, no `settled_at` stamp.
   * A customer refreshing a page must not be able to move the payment's state,
   * and a GET that could be made to do so would be a GET that could be replayed
   * into one.
   */
  async lookup(token: string): Promise<CustomerPaymentStatusView> {
    if (!isStatusToken(token)) {
      throw new ValidationError('Invalid payment status token');
    }
    const row = await this.store.findByStatusToken(token);
    // The store filters on the expiry itself, so an expired token arrives here as
    // "no row" and is reported as `unknown` rather than as an error.
    if (row === undefined) return { ...NOTHING };

    return {
      status: row.outcome ?? 'unknown',
      reference: row.transactionId,
      // Only ever shown alongside a failure. A success carrying a stale reason
      // would read as the gateway's verdict on a payment that actually cleared.
      reason: row.outcome === 'failed' ? row.failureReason : null,
      ...this.expected(row.expectedSealed),
    };
  }

  /**
   * Open the sealed figure to show the customer what they were charged.
   *
   * A FAILURE HERE IS NOT PROPAGATED, and that is the point: the figure is
   * decoration on a page whose real content is the verdict. If the deployment's
   * encryption key is missing, every customer would see an error page about a
   * payment that went through perfectly well — trading a correct, slightly less
   * informative answer for a wrong and alarming one. Null figures render as "not
   * available", which is true.
   */
  private expected(sealed: Buffer): Pick<CustomerPaymentStatusView, 'amount' | 'currency'> {
    try {
      const { amount, currency } = openExpectedCharge(sealed);
      return { amount, currency };
    } catch (err) {
      logger.warn({ err }, 'Stored payment figure could not be opened for the status page');
      return { amount: null, currency: null };
    }
  }
}