import { logger } from '../../utils/logger.js';
import type {
  AccountingAdaptor,
  AdaptorCredentials,
  AdaptorId,
  AdaptorResponse,
  AdaptorStatus,
  AdaptorTransport,
  ConnectResult,
  CustomerMatchConfig,
  HealthCheckResult,
  HttpMethod,
  PaymentRef,
  PreflightOutcome,
  PreflightPaymentInput,
  PushResult,
  ReversalOutcome,
  ReversalPaymentInput,
  SyncResult,
} from '../../types/adaptor.js';
import {
  AdaptorApplyError,
  AdaptorConnectionError,
  adaptorErrorForStatus,
  failureReasonForError,
  failureReasonForStatus,
} from './errors.js';
import { findCustomerByIdentifier } from './quickbooksCustomer.js';
import {
  allocatePayment,
  createPaymentForInvoices,
  deletePayment,
  findOpenInvoices,
  findPaymentByReference,
  readPaymentSyncToken,
  unappliedRemainder,
  verifyInvoicesApplied,
} from './quickbooksInvoice.js';
import { httpTransport } from './httpTransport.js';
import { INTUIT_TOKEN_URL, resolveAccessToken } from './oauth.js';
import { minorUnitsFromNumber, toMinorUnits } from '../../utils/money.js';
import type { QboRequest } from './quickbooksWire.js';

/**
 * QuickBooks Online adaptor.
 *
 * THE CONNECTION IS REAL NOW. Two things used to make "connected" impossible
 * even with correct credentials:
 *   1. `connect()` checked only that a client id/secret were present, then set
 *      the token to the literal `'stub-token'` — an unusable placeholder
 *      reported as success.
 *   2. The default transport threw (`... stubbed pending credentials`), so no
 *      probe could ever reach Intuit.
 * The transport is now `fetch` (see `httpTransport`), the token comes from
 * supplied credentials or a refresh-token exchange (`oauth.ts`), and the
 * health probe asks Intuit for the company record of the configured realm —
 * the cheapest call that proves realm, token and network together.
 *
 * THE PAYMENT PATH IS REAL NOW TOO. It used to be one call to
 * `/invoice/{id}/payment`, which is not a QuickBooks endpoint. Applying a
 * payment now means matching a customer, finding their outstanding invoice,
 * creating a `Payment` linked to it, and re-reading the invoice to confirm it
 * cleared — see `pushCompletedPayment`, `quickbooksCustomer` and
 * `quickbooksInvoice`.
 *
 * WHAT REMAINS APPROXIMATE: `pullSyncStatus` still returns fixed zeroes. It
 * reports that a sync ran rather than what it found, and the reconciliation
 * figures the console shows come from local state, not from a comparison
 * against QuickBooks. That is separate work, and it is called out here rather
 * than left to look finished.
 */
export class QuickBooksAdaptor implements AccountingAdaptor {
  readonly id: AdaptorId = 'quickbooks';
  readonly name = 'QuickBooks Online';

  private connected = false;
  private oauthToken: string | null = null;
  /**
   * The CURRENT refresh token. Intuit rotates it on every exchange, so the token
   * minted at connect time replaces the supplied one for the life of the
   * process — otherwise the second exchange (after an access token expires) would
   * present a spent token and fail. It is also handed back through
   * `ConnectResult.rotated` so the caller can persist it: with credentials stored
   * rather than in `.env`, a restart would otherwise have nothing but the old
   * value to present.
   */
  private refreshToken: string | undefined;
  /** Credentials most recently supplied to `connect`. Never read from the environment. */
  private credentials: AdaptorCredentials = {};
  private readonly transport: AdaptorTransport;
  /**
   * Told about a credential the upstream rotated OUTSIDE an explicit
   * `connect()` call, so the caller can persist it.
   *
   * Intuition says this is unnecessary — `connect()` already returns its
   * rotation, and every boot path goes through `connectAdaptor`, which
   * persists it. It is not unnecessary, because `healthCheck` also mints: it
   * re-mints on a 401 to keep a long-running process alive, and that mint
   * spends the refresh token just as thoroughly. A rotation nobody is told
   * about is a deployment that reconnects until it does not. See the call site.
   *
   * Optional so a test can construct the adaptor without one; production
   * supplies it. `undefined` means "nobody is listening", not "nothing rotates".
   */
  private readonly onRotation?: (result: ConnectResult | void) => Promise<void>;

  constructor(
    transport?: AdaptorTransport,
    onRotation?: (result: ConnectResult | void) => Promise<void>,
  ) {
    this.transport = transport ?? httpTransport;
    if (onRotation) this.onRotation = onRotation;
  }

  async connect(credentials: AdaptorCredentials): Promise<ConnectResult | void> {
    const token = await resolveAccessToken(this.transport, {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      accessToken: credentials.accessToken,
      // The rotated value wins over the supplied one, for the reason above.
      refreshToken: this.refreshToken ?? credentials.refreshToken,
      tokenUrl: INTUIT_TOKEN_URL,
    });
    this.connected = true;
    this.credentials = credentials;
    this.oauthToken = token.accessToken;
    this.refreshToken = token.refreshToken;
    logger.info(
      { adaptor: this.id, realm: credentials.realmId ?? null },
      'QuickBooks adaptor connected',
    );
    return token.refreshToken && token.refreshToken !== credentials.refreshToken
      ? { rotated: { refreshToken: token.refreshToken } }
      : undefined;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.oauthToken = null;
    this.refreshToken = undefined;
    this.credentials = {};
    logger.info({ adaptor: this.id }, 'QuickBooks adaptor disconnected');
  }

  async status(): Promise<AdaptorStatus> {
    return this.connected ? 'connected' : 'disconnected';
  }

  /**
   * Apply a completed payment across the customer's outstanding invoices,
   * oldest created first, using the amount the gateway actually charged.
   *
   * WHAT THIS REPLACED: a single `POST /invoice/{id}/payment`, which is not a
   * QuickBooks URL, and later a version that paid the whole balance of one
   * invoice regardless of what the customer was charged. A partial payment was
   * therefore recorded as if it were the full amount. The charged figure now
   * arrives as `amount` and is allocated across invoices; the invoice balance
   * is only ever what the money is applied AGAINST.
   *
   * The order below is the whole design and is not incidental: match, check,
   * confirm-not-already-done, look up what is owed, allocate, write, re-read.
   * The re-read is what lets the caller report "posted" truthfully; the
   * already-done check is what makes a retry safe. Both live here rather than in
   * the caller because both need the adaptor's connection, and a caller that
   * could skip them would eventually skip them.
   */
  async pushCompletedPayment(
    payment: PaymentRef,
    match: CustomerMatchConfig,
    amount: string,
  ): Promise<PushResult> {
    this.assertConnected();
    const request = this.qboRequest;
    const started = Date.now();

    /*
      THE CHARGED FIGURE IS PARSED BEFORE ANY UPSTREAM CALL. It comes from the
      sealed checkout record, which is the figure the gateway signed, so a value
      that cannot be read as money is OUR fault — and refusing before matching
      means no ledger call is spent on a payment that could never be placed.
    */
    const paidMinor = toMinorUnits(amount);
    if (paidMinor === null || paidMinor <= 0) {
      throw new AdaptorApplyError(
        'amount-invalid',
        'The amount this payment was charged is not a usable figure, so it cannot be applied to an invoice',
      );
    }

    const lookup = await findCustomerByIdentifier(request, match, payment.matchValue);
    if (!lookup.ok) {
      throw new AdaptorApplyError(
        lookup.reason,
        lookup.reason === 'customer-ambiguous'
          ? `${lookup.matches} QuickBooks customers match this payment. The payment was not applied to any of them.`
          : 'No QuickBooks customer matches this payment',
        lookup.matches,
      );
    }

    /*
      THE ALREADY-DONE CHECK COMES BEFORE THE INVOICE LOOKUP, and the order is
      not incidental.

      It used to come after, which was wrong in a way only a real run exposed.
      By the time a retry arrives the first attempt's payment has SETTLED the
      invoice, so "the customer's outstanding invoices" is empty — and selecting
      one threw `invoice-not-found` BEFORE the idempotency probe was ever
      reached. A payment that had been applied exactly once, correctly, was
      reported as a failure: a spurious critical finding, a webhook stuck
      retrying, and an operator told to chase a payment that was already paid.

      The customer is still resolved first, because a reference that matches
      nobody must not be quietly treated as already done.
    */
    const seen = await findPaymentByReference(request, payment.id);
    if (seen.found) {
      /*
        ★ THE DURABLE PAYMENT ROW IS THE EVIDENCE, NOT THE BALANCE.

        This used to re-read the invoice the original payment named and treat a
        zero balance as proof. That is no longer a valid test: a payment may
        deliberately leave an invoice PARTLY paid, and after the fact a settled
        balance and a partially-paid one cannot be told apart — both are just
        "some money is owed" or "none is". The payment row carrying our
        reference is the thing that proves the write happened, and its own
        `LinkedTxn` says which invoices it touched. Re-reading would therefore
        invent a conclusion the data cannot support, so it is not done.
      */
      logger.info(
        { adaptor: this.id, invoices: seen.invoiceIds, ms: Date.now() - started },
        'Payment reference already recorded upstream; nothing written',
      );
      return {
        externalRef: payment.transactionId,
        at: new Date().toISOString(),
        invoiceRefs: seen.invoiceIds,
        reconciliationRequired: false,
        matchedBy: match.strategy,
        alreadyApplied: true,
        verified: seen.invoiceIds.length > 0,
      };
    }

    const { invoices } = await findOpenInvoices(request, lookup.customer.id);
    const allocations = allocatePayment(invoices, paidMinor);

    /*
      THE BALANCE CAN MOVE BETWEEN THE READ AND THE WRITE. `allocatePayment`
      stops when the money or the invoices run out, so a short allocation means
      the customer's total outstanding balance is now less than what was
      charged. Nothing is written in that case: writing the shortfall would
      either overpay an invoice or create an unlinked credit line, and neither
      is a decision this adaptor can make on the customer's behalf. A person
      has to reconcile it.
    */
    const allocatedMinor = allocations.reduce(
      (sum, allocation) => sum + (minorUnitsFromNumber(allocation.amount) ?? 0),
      0,
    );
    if (allocatedMinor < paidMinor) {
      throw new AdaptorApplyError(
        'amount-exceeds-balance',
        'The customer\'s total outstanding balance is now less than the amount charged, so no payment was written',
      );
    }

    const created = await createPaymentForInvoices(request, allocations, {
      customerId: lookup.customer.id,
      reference: payment.id,
      match,
    });

    const remainder = unappliedRemainder(created);
    const verification = await verifyInvoicesApplied(request, allocations);
    const reconciliationRequired = remainder > 0 || verification.reconciliationRequired;

    if (reconciliationRequired) {
      /*
        The invoices moved but the ledger and the payment do not quite agree:
        either upstream left part of the payment unapplied, or an invoice was
        reduced by more than our share. Reported, never swallowed — the money
        is safe, and only a person can reconcile the difference.
      */
      logger.warn(
        { adaptor: this.id, invoices: allocations.map((a) => a.invoice.Id) },
        'Payment applied with an unapplied remainder or a concurrent balance change; reconciliation required',
      );
    }

    if (!verification.verified) {
      throw new AdaptorApplyError(
        'invoice-not-cleared',
        `QuickBooks recorded payment ${created.Id} but ${allocations
          .map((allocation) => allocation.invoice.Id)
          .join(', ')} did not move by the amount applied`,
      );
    }

    const invoiceRefs = allocations.map((allocation) => allocation.invoice.Id);
    logger.info(
      { adaptor: this.id, invoices: invoiceRefs, strategy: match.strategy, ms: Date.now() - started },
      'QuickBooks invoices paid',
    );
    return {
      externalRef: created.Id,
      at: new Date().toISOString(),
      invoiceRefs,
      reconciliationRequired,
      matchedBy: match.strategy,
      alreadyApplied: false,
      verified: true,
    };
  }

  /**
   * Check whether a payment COULD be placed, without writing anything.
   *
   * The same three questions `pushCompletedPayment` asks before its first
   * write — who is this, what is outstanding, and does the figure fit — so a
   * customer is refused at checkout for the reason the ledger push would later
   * fail, rather than after their card has been charged.
   *
   * Each refusal is a DEFINITIVE data answer. A fault is thrown instead, because
   * the caller must let the payment through when the provider is merely
   * unreachable; making an outage look like a rejection would stop every
   * customer from paying during it.
   */
  async preflightPayment(input: PreflightPaymentInput): Promise<PreflightOutcome> {
    this.assertConnected();
    const request = this.qboRequest;

    const lookup = await findCustomerByIdentifier(request, input.match, input.matchValue);
    if (!lookup.ok) {
      return { ok: false, reason: lookup.reason };
    }

    const { invoices } = await findOpenInvoices(request, lookup.customer.id);
    if (invoices.length === 0) {
      return { ok: false, reason: 'invoice-not-found' };
    }

    const requested = toMinorUnits(input.amount);
    if (requested === null || requested <= 0) {
      return { ok: false, reason: 'amount-invalid' };
    }

    /*
      THE CEILING IS THE CUSTOMER'S TOTAL OUTSTANDING, not one invoice's balance.
      A payment that spans several invoices is legitimate — and the push applies
      the same charged figure across them oldest-first — so checking a single
      invoice would refuse payments the ledger would happily accept.

      An unreadable balance is a FAULT, not a refusal: the provider returned an
      answer this process cannot compare, and the caller's rule is to let the
      customer pay when the accounting side is merely broken.
    */
    let total = 0;
    for (const invoice of invoices) {
      const balance = minorUnitsFromNumber(invoice.Balance);
      if (balance === null) {
        throw new AdaptorConnectionError(
          'QuickBooks returned an invoice balance that could not be compared',
        );
      }
      total += balance;
    }
    if (requested > total) {
      return { ok: false, reason: 'amount-exceeds-balance' };
    }

    /*
      EVERY invoice must agree on the currency, not just the one that would be
      paid first — the payment can span them. Absence means the company's home
      currency — a real state, not missing data — so only a PRESENT and
      different currency is a mismatch.
    */
    for (const invoice of invoices) {
      const invoiceCurrency = invoice.CurrencyRef?.value;
      if (invoiceCurrency !== undefined && invoiceCurrency !== input.currency) {
        return { ok: false, reason: 'currency-mismatch' };
      }
    }

    return { ok: true };
  }

  /**
   * Correct the ledger after the gateway has already refunded.
   *
   * A FULL refund is the only case that can be undone automatically, and it is
   * undone by DELETING the payment: the provider re-opens the invoice, which is
   * exactly what a full refund means. A PARTIAL refund must not delete it —
   * removing the whole payment would restore the whole balance — so the adaptor
   * reports that a person has to make the adjustment.
   */
  async reverseCompletedPayment(input: ReversalPaymentInput): Promise<ReversalOutcome> {
    this.assertConnected();
    const request = this.qboRequest;

    const original = toMinorUnits(input.originalAmount);
    const refund = toMinorUnits(input.refundAmount);
    if (original === null || refund === null) {
      throw new AdaptorApplyError(
        'refund-reversal-failed',
        'The refund figures could not be compared, so the accounting record was left untouched',
      );
    }
    if (refund !== original) {
      return { status: 'manual-adjustment-required' };
    }

    const seen = await findPaymentByReference(request, input.transactionId);
    if (!seen.found || seen.paymentId === null) {
      throw new AdaptorApplyError(
        'payment-not-found',
        'No QuickBooks payment carries this transaction reference, so there is nothing to reverse',
      );
    }

    const syncToken = seen.syncToken ?? (await readPaymentSyncToken(request, seen.paymentId));
    if (syncToken === null) {
      throw new AdaptorApplyError(
        'refund-reversal-failed',
        'QuickBooks did not report a version for the payment, so it could not be deleted',
      );
    }

    await deletePayment(request, seen.paymentId, syncToken);
    logger.info(
      { adaptor: this.id, payment: seen.paymentId },
      'QuickBooks payment reversed after a full refund',
    );
    return { status: 'reversed' };
  }

  async pullSyncStatus(): Promise<SyncResult> {
    this.assertConnected();
    const response = await this.request('GET', '/query?query=select%20count(*)%20from%20Invoice');
    this.assertOk(response, 'QuickBooks sync failed');
    return {
      status: 'ok',
      ranAt: new Date().toISOString(),
      matched: 0,
      unmatched: 0,
      anomalies: 0,
    };
  }

  /**
   * Health probe against the realm's company record.
   *
   * Reports rather than throws (the contract for `healthCheck`), including on a
   * transport failure: the console's service panel reads this, and throwing
   * would only collapse into the same "unreachable" it already shows — without
   * the reason.
   *
   * A 401 means the access token expired (they last about an hour). With a
   * refresh token configured the adaptor mints a new one and retries once, so a
   * long-running container does not silently go dark mid-shift.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    this.assertConnected();
    const started = Date.now();
    try {
      let response = await this.probe();
      if (response.status === 401 && this.credentials.refreshToken) {
        /*
          Re-mint and retry ONCE.

          ★ THE ROTATION IS HANDED BACK, NOT DISCARDED — this was a live outage.
          `connect()` re-mints the refresh token, and Intuit INVALIDATES the one
          it just spent. This method used to call `connect()` for its side effect
          and ignore what it returned, so the new token lived only in this
          process. It worked right up to the next restart, which presented the
          spent token and failed with "Incorrect or invalid refresh token" —
          leaving a deployment that connected fine until it was redeployed and
          then could not connect at all. The service went red on its own and no
          configuration change had caused it.

          The re-mint is reported so the CALLER persists it, exactly as
          `connectAdaptor` does for the boot path. The rule that every connect
          goes through the provider exists for this reason; a health check is
          still a connect.
        */
        const reminted = await this.connect(this.credentials);
        await this.onRotation?.(reminted);
        response = await this.probe();
      }
      const latencyMs = Date.now() - started;
      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          latencyMs,
          message: `QuickBooks answered ${response.status}${describeResponseError(response)}`,
          // The status code is the authoritative signal for "the token is no
          // good", and it is what the event log classifies on — see
          // `failureReasonForStatus`.
          reason: failureReasonForStatus(response.status),
        };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: err instanceof Error ? err.message : 'QuickBooks health check failed',
        reason: failureReasonForError(err),
      };
    }
  }

  private probe(): Promise<AdaptorResponse> {
    const realm = this.credentials.realmId ?? '';
    return this.request('GET', `/companyinfo/${realm}`);
  }

  /**
   * The pipeline's view of this adaptor's connection.
   *
   * A bound field rather than a method reference so `findCustomerByIdentifier`
   * and friends can be handed it without every one of them re-deriving the URL
   * and the bearer token. It is private because handing it out is how the URL
   * shape would end up duplicated somewhere that does not own it — which is how
   * `{base}/realm/{realm}/...` survived as long as it did.
   */
  private qboRequest: QboRequest = (path: string, body?: unknown): Promise<AdaptorResponse> =>
    body === undefined ? this.request('GET', path) : this.request('POST', path, body);

  private assertConnected(): void {
    if (!this.connected) {
      throw new AdaptorConnectionError(`${this.name} adaptor is not connected`);
    }
  }

  private assertOk(response: AdaptorResponse, message: string): void {
    if (response.status < 200 || response.status >= 300) {
      throw adaptorErrorForStatus(response.status, `${message} (status ${response.status})`);
    }
  }

  /**
   * Build and send a QuickBooks REST call.
   *
   * QuickBooks addresses every resource through the company (realm) it belongs
   * to: `{base}/v3/company/{realm}/{resource}`. The previous version emitted
   * `{base}/realm/{realm}/...`, which is not a QuickBooks URL at all — it would
   * have 404'd on the first real call.
   */
  private async request(method: HttpMethod, path: string, body?: unknown): Promise<AdaptorResponse> {
    const base = (this.credentials.baseUrl ?? '').replace(/\/+$/, '');
    const realm = this.credentials.realmId ?? '';
    const fullUrl = `${base}/v3/company/${realm}${path}`;
    const headers: Record<string, string> = {};
    if (this.oauthToken) {
      headers['Authorization'] = `Bearer ${this.oauthToken}`;
    }
    /*
      ★ THE WRITE PATH NEVER SET A CONTENT TYPE, so it could never have worked.

      `httpTransport` picks its body encoding from the caller's `Content-Type`:
      form-encoding when it says so, JSON otherwise. It JSON-encodes in that
      branch, but the header is the CALLER's to set — and this one did not, so a
      payment POST went out with a JSON body and no content type. Every read
      succeeded (a GET has no body), which is why the connection looked healthy
      and the probes passed; the first real write came back

        400 — "Operation Cannot consume content type is not supported."

      Verified against the live company 2026-09-28. There is no unit test that
      could have caught it: the transport is injected in every adaptor test, and
      the fault is in the header this method omits.
    */
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return this.transport(method, fullUrl, body, headers);
  }
}

/** Pull a short reason out of an error body, when the upstream sent one. */
function describeResponseError(response: AdaptorResponse): string {
  const body = response.body;
  if (body && typeof body === 'object') {
    const fault = (body as Record<string, unknown>)['Fault'];
    if (fault && typeof fault === 'object') {
      const errors = (fault as Record<string, unknown>)['Error'];
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0] as Record<string, unknown>;
        const message = first['Message'] ?? first['Detail'];
        if (typeof message === 'string' && message.trim() !== '') return `: ${message}`;
      }
    }
  }
  return '';
}
