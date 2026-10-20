/* Placing a completed payment on an invoice, and proving it landed.
 *
 * Four steps, in this order, and the order is the design:
 *
 *   1. CHECK        which invoice is outstanding for this customer
 *   2. IDEMPOTENCY  has this reference already been paid — UPSTREAM
 *   3. APPLY        create the payment
 *   4. VERIFY       read the invoice back and confirm it cleared
 *
 * STEP 2 IS NOT REDUNDANT WITH OUR OWN WEBHOOK DEDUP. Ours marks a webhook
 * processed only after the whole handler succeeds, and RELEASES the claim on
 * failure so the payment can be retried. That is the right behaviour, and it
 * is exactly the behaviour that makes a lost response dangerous: a payment the
 * upstream accepted, whose response never arrived, looks identical to one that
 * was never sent. Retrying it naively pays the invoice twice. So the durable
 * check has to live where the money is — the payment is written with the
 * gateway's transaction id as its reference number, and a retry finds it
 * there and stops.
 *
 * STEP 4 IS WHY ANY OF THIS IS WORTH DOING. Creating a payment and getting a
 * 200 says the upstream accepted a request, not that an invoice stopped being
 * outstanding. The console's terminal stage is "posted", and only a re-read can
 * make that claim true.
 */

import { AdaptorApplyError, AdaptorError } from './errors.js';
import {
  assertQboOk,
  queryReturned,
  queryRows,
  queryPath,
  sqlLiteral,
} from './quickbooksWire.js';
import type { CustomerMatchConfig } from '../../types/adaptor.js';
import type {
  QboInvoice,
  QboPaymentCreated,
  QboPaymentDelete,
  QboPaymentRequest,
  QboRequest,
} from './quickbooksWire.js';

/**
 * What a cleared balance is compared against.
 *
 * QuickBooks returns money as a JSON number, and a balance that has been fully
 * paid arrives as `0` rather than as some near-miss residue, so an exact zero
 * is the right test for "did this clear" and needs no tolerance. The tolerance
 * exists for the OTHER comparison, `UnappliedAmt`, which is a remainder that
 * can carry representation error in the last place. A cent is the smallest
 * difference that can mean anything to an accountant.
 */
const CLEARED_EXACTLY = 0;
const LEAST_MEANINGFUL_AMOUNT = 0.005;

export interface ApplyOptions {
  /** The upstream customer the payment belongs to. */
  customerId: string;
  /** The gateway transaction id — becomes the payment's reference number. */
  reference: string;
  /** The posting date, `yyyy-MM-dd`. Omitted upstream to use the server's. */
  txnDate?: string;
  match: CustomerMatchConfig;
}

export interface ApplyOutcome {
  /** The invoice the payment was applied to, or null when it was already done. */
  invoiceId: string | null;
  /** True when a prior payment already covered this reference. */
  alreadyApplied: boolean;
  /** The post-write re-read confirmed the invoice cleared. */
  verified: boolean;
  /** Upstream calls spent, so the caller can see the real cost of a push. */
  calls: number;
}

/* --- 1. CHECK ------------------------------------------------------------ */

/**
 * The customer's outstanding invoices.
 *
 * `Balance > 0` is the definition of "still owed" upstream: a voided invoice
 * has no balance, a paid one is zero, and an overdue one is still positive. The
 * query is the same shape for every strategy — the strategy chose the
 * CUSTOMER, never the invoice — so a deployment that matches on a custom field
 * and one that matches on a name behave identically from here.
 */
export async function findOpenInvoices(
  request: QboRequest,
  customerId: string,
): Promise<{ invoices: QboInvoice[]; calls: number }> {
  /*
    ★ THE BALANCE IS FILTERED IN MEMORY, because the provider cannot do it.

    This used to send `where CustomerRef = '…' and Balance > 0`, on the belief
    that `Balance` was a filterable field. It is not. A live company answers
    that query with HTTP 400 "Error parsing query" (verified 2026-09-28 against
    realm 9341457936805547), and the provider's own reference lists Invoice
    `Balance` as READ ONLY rather than filterable — a distinction the Customer
    object, whose `Balance` IS filterable, invites you to miss.

    The effect would have been total and silent in the worst way: every payment
    failing at the invoice check with an upstream parse error, and nothing in
    the unit tests to notice, because they assert against a fake that answers
    whatever it is asked. The `CustomerRef` half of the filter is genuine and
    stays; the balance is then dropped from the rows.
  */
  const response = await request(
    queryPath(`select * from Invoice where CustomerRef = ${sqlLiteral(customerId)}`),
  );
  assertQboOk(response, 'QuickBooks invoice lookup');
  const all = queryRows<QboInvoice>(response.body, 'Invoice');
  return {
    invoices: all.filter((invoice) => isOutstanding(invoice)),
    calls: 1,
  };
}

/**
 * Is this invoice still owed?
 *
 * A voided invoice has no balance, a paid one is zero, an overdue one is still
 * positive — so "still owed" is a positive balance. The value is required: an
 * invoice returned without one cannot be judged, and treating a missing balance
 * as zero would silently declare it paid.
 */
function isOutstanding(invoice: QboInvoice): boolean {
  return typeof invoice.Balance === 'number' && invoice.Balance > 0;
}

/**
 * Choose which outstanding invoice to pay.
 *
 * A DETERMINISTIC RULE, not a first-row pick, and not a refusal. A customer
 * with two open invoices is ordinary — a student with a term's fee and a
 * material charge, say — and refusing would mean the pipeline silently does
 * nothing for exactly the people it exists for. The rule is therefore written
 * down and applied every time: the oldest due date first, then the oldest
 * transaction date, then the lowest id, so two runs over the same data always
 * choose the same invoice.
 *
 * It is a business rule the operator can disagree with, which is why the
 * chosen id is reported in the `PushResult` rather than being an internal
 * detail — the console can show which invoice a payment landed on.
 */
export function selectInvoiceToPay(invoices: QboInvoice[]): QboInvoice {
  const first = invoices[0];
  if (!first) {
    throw new AdaptorApplyError(
      'invoice-not-found',
      'The matched QuickBooks customer has no outstanding invoice',
    );
  }
  return [...invoices].sort(compareInvoices)[0] as QboInvoice;
}

/** Oldest due date, then oldest transaction date, then lowest id. */
function compareInvoices(a: QboInvoice, b: QboInvoice): number {
  const due = compareNullable(a.DueDate, b.DueDate);
  if (due !== 0) return due;
  const txn = compareNullable(a.TxnDate, b.TxnDate);
  if (txn !== 0) return txn;
  return a.Id.localeCompare(b.Id, 'en');
}

/** Undated sorts last: an invoice with no date is not "oldest". */
function compareNullable(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a.localeCompare(b, 'en');
}

/* --- 2. IDEMPOTENCY ------------------------------------------------------ */

/**
 * Has a payment for this reference already been recorded, and against which
 * invoices?
 *
 * The payment's own `Line[].LinkedTxn` names every invoice it was applied to, so
 * a retry can be VERIFIED rather than merely recognised: the second delivery
 * re-reads the very invoice the first one named, instead of guessing which of
 * the customer's invoices it was. That matters because by the time a retry
 * arrives the invoice is settled, and a settled invoice is indistinguishable
 * from any other settled one.
 *
 * A hit is treated as SUCCESS, not as an error: the money moved, and a
 * redelivery of the same webhook is a fact about the gateway, not a fault.
 */
export async function findPaymentByReference(
  request: QboRequest,
  reference: string,
): Promise<{
  found: boolean;
  invoiceIds: string[];
  paymentId: string | null;
  syncToken: string | null;
  calls: number;
}> {
  try {
    const response = await request(
      queryPath(`select * from Payment where PaymentRefNum = ${sqlLiteral(reference)}`),
    );
    assertQboOk(response, 'QuickBooks payment lookup');
    return outcomeFromPayments(queryRows<QboPaymentCreated>(response.body, 'Payment'), 1);
  } catch (err) {
    /*
      ★ THE FILTER IS TRIED FIRST, AND THE FALLBACK IS EVIDENCE-DRIVEN.

      `PaymentRefNum` is not listed as filterable on the Payment entity, and a
      live provider is entitled to answer the filter with HTTP 400 "Error
      parsing query" — the same way it refuses `Invoice.Balance`. Because that
      has NOT been verified against the refund fixture, the filter is still
      attempted (it is one call when it works) and a 400 falls back to the
      bounded scan below. Any other fault is a real fault and is rethrown: an
      outage must not be reported as "no payment".
    */
    if (!isRefusedQuery(err)) throw err;
    return scanPaymentsByReference(request, reference);
  }
}

/** How many Payment rows one page of the fallback scan asks for. */
export const PAYMENT_SCAN_PAGE_SIZE = 200;

/**
 * The page ceiling for the fallback scan. The same bounded-crawl reasoning as
 * the customer scan: a provider that cannot filter must not turn one refund
 * into an unbounded walk of a rate-limited API.
 */
export const PAYMENT_SCAN_MAX_PAGES = 10;

/** Did the provider reject the QUERY rather than the call? */
function isRefusedQuery(err: unknown): boolean {
  return err instanceof AdaptorError && err.statusCode === 400;
}

/**
 * The documented fallback when `PaymentRefNum` is not filterable: page through
 * payments and compare the reference in memory.
 *
 * BOUNDED deliberately, and it says which limit it hit rather than reporting a
 * miss: a reference past the ceiling has not been shown to be absent.
 */
async function scanPaymentsByReference(
  request: QboRequest,
  reference: string,
): Promise<{
  found: boolean;
  invoiceIds: string[];
  paymentId: string | null;
  syncToken: string | null;
  calls: number;
}> {
  let calls = 0;
  for (let page = 1; page <= PAYMENT_SCAN_MAX_PAGES; page += 1) {
    const response = await request(
      queryPath(
        `select * from Payment startPosition ${(page - 1) * PAYMENT_SCAN_PAGE_SIZE + 1} maxResults ${PAYMENT_SCAN_PAGE_SIZE}`,
      ),
    );
    calls += 1;
    assertQboOk(response, 'QuickBooks payment scan');
    const rows = queryRows<QboPaymentCreated>(response.body, 'Payment');
    const matches = rows.filter((payment) => payment.PaymentRefNum === reference);
    if (matches.length > 0) {
      return outcomeFromPayments(matches, calls);
    }
    if (rows.length < PAYMENT_SCAN_PAGE_SIZE || queryReturned(response.body) < PAYMENT_SCAN_PAGE_SIZE) {
      return outcomeFromPayments([], calls);
    }
  }
  throw new AdaptorApplyError(
    'scan-limit-reached',
    `Scanned ${PAYMENT_SCAN_MAX_PAGES * PAYMENT_SCAN_PAGE_SIZE} QuickBooks payments without finding this transaction reference`,
  );
}

/** Reduce payment rows to the identity and linked invoices a caller needs. */
function outcomeFromPayments(
  payments: QboPaymentCreated[],
  calls: number,
): {
  found: boolean;
  invoiceIds: string[];
  paymentId: string | null;
  syncToken: string | null;
  calls: number;
} {
  const invoiceIds: string[] = [];
  for (const payment of payments) {
    for (const line of payment.Line ?? []) {
      for (const linked of line.LinkedTxn ?? []) {
        if (linked.TxnType === 'Invoice' && linked.TxnId) invoiceIds.push(linked.TxnId);
      }
    }
  }
  const first = payments[0];
  return {
    found: payments.length > 0,
    invoiceIds,
    paymentId: first?.Id ?? null,
    syncToken: first?.SyncToken ?? null,
    calls,
  };
}

/* --- 3. APPLY ------------------------------------------------------------ */

/**
 * Record the payment against the invoice.
 *
 * The amount is the INVOICE'S OWN OUTSTANDING BALANCE, read in step 1. It is
 * not taken from the gateway, not taken from a local record, and not computed:
 * the upstream already knows what is owed, and the only number that can be
 * correct here is the one it reported. QuickBooks requires `TotalAmt` and a
 * per-line `Amount`; both are set to it, and the line links to the invoice,
 * which is what actually reduces it.
 */
export async function createPaymentForInvoice(
  request: QboRequest,
  invoice: QboInvoice,
  options: ApplyOptions,
): Promise<QboPaymentCreated> {
  const body: QboPaymentRequest = {
    TotalAmt: invoice.Balance,
    CustomerRef: { value: options.customerId },
    Line: [
      {
        Amount: invoice.Balance,
        LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
      },
    ],
    PaymentRefNum: options.reference,
    ...(options.txnDate ? { TxnDate: options.txnDate } : {}),
    ...(options.match.depositAccountId
      ? { DepositToAccountRef: { value: options.match.depositAccountId } }
      : {}),
  };

  const response = await request('/payment', body);
  assertQboOk(response, 'QuickBooks payment create');

  const payment = readCreatedPayment(response.body);
  if (!payment) {
    throw new AdaptorApplyError(
      'invoice-not-cleared',
      'QuickBooks accepted the payment but returned no payment reference to confirm it',
    );
  }
  return payment;
}

/** Pull just the id and unapplied remainder out of a create response. */
function readCreatedPayment(body: unknown): QboPaymentCreated | null {
  if (typeof body !== 'object' || body === null) return null;
  const payment = (body as { Payment?: unknown }).Payment;
  if (typeof payment !== 'object' || payment === null) return null;
  const id = (payment as { Id?: unknown }).Id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const unapplied = (payment as { UnappliedAmt?: unknown }).UnappliedAmt;
  return {
    Id: id,
    ...(typeof unapplied === 'number' ? { UnappliedAmt: unapplied } : {}),
  };
}

/* --- 3b. REVERSE --------------------------------------------------------- */

/**
 * The optimistic-concurrency token a delete needs.
 *
 * Read from the payment itself rather than remembered from the original create:
 * the create response is not the thing being deleted, and a token can move
 * whenever anything else touches the record. A delete with a stale token is
 * refused by the provider, so this is the only safe source.
 */
export async function readPaymentSyncToken(
  request: QboRequest,
  paymentId: string,
): Promise<string | null> {
  const response = await request(`/payment/${paymentId}`);
  assertQboOk(response, 'QuickBooks payment read');
  const body = response.body;
  if (typeof body !== 'object' || body === null) return null;
  const payment = (body as { Payment?: unknown }).Payment;
  if (typeof payment !== 'object' || payment === null) return null;
  const syncToken = (payment as { SyncToken?: unknown }).SyncToken;
  return typeof syncToken === 'string' && syncToken.length > 0 ? syncToken : null;
}

/**
 * Remove an upstream payment, which is how QuickBooks undoes a FULL refund.
 *
 * The body is exactly `{ Id, SyncToken }`: the provider's delete operation
 * identifies the row and the version it is deleting, and nothing else.
 */
export async function deletePayment(
  request: QboRequest,
  paymentId: string,
  syncToken: string,
): Promise<void> {
  const body: QboPaymentDelete = { Id: paymentId, SyncToken: syncToken };
  const response = await request('/payment?operation=delete', body);
  assertQboOk(response, 'QuickBooks payment delete');
}

/* --- 4. VERIFY ----------------------------------------------------------- */

/**
 * Re-read the invoice and report whether it is settled.
 *
 * Only the invoice's own balance is consulted, because that is the claim the
 * console makes. A payment can be created successfully while the invoice does
 * not move — the write can be applied to a different transaction, or not at
 * all — and a 200 from the create is not evidence either way. This read is.
 */
export async function verifyInvoiceCleared(
  request: QboRequest,
  invoiceId: string,
): Promise<{ verified: boolean; calls: number }> {
  const response = await request(`/invoice/${invoiceId}`);
  assertQboOk(response, 'QuickBooks invoice verify');
  const refreshed = readInvoice(response.body);
  if (!refreshed) {
    throw new AdaptorApplyError(
      'invoice-not-cleared',
      `QuickBooks did not return invoice ${invoiceId} when asked to confirm the payment`,
    );
  }
  return { verified: refreshed.Balance === CLEARED_EXACTLY, calls: 1 };
}

/**
 * Did the payment land whole?
 *
 * A separate question from "did the invoice clear", and worth asking because
 * the two diverge under concurrency: if something else reduced the balance
 * between our read and our write, QuickBooks applies only what is left and
 * leaves the rest unapplied. The invoice then clears — so this is not a
 * failure — but the payment on file is for more than the invoice needed, and
 * someone has to reconcile that difference.
 *
 * Returns the upstream's own `UnappliedAmt` when it is large enough to matter.
 */
export function unappliedRemainder(payment: QboPaymentCreated): number {
  const unapplied = payment.UnappliedAmt ?? 0;
  return isMeaningfulRemainder(unapplied) ? unapplied : 0;
}

function readInvoice(body: unknown): QboInvoice | null {
  if (typeof body !== 'object' || body === null) return null;
  const invoice = (body as { Invoice?: unknown }).Invoice;
  if (typeof invoice !== 'object' || invoice === null) return null;
  const id = (invoice as { Id?: unknown }).Id;
  const balance = (invoice as { Balance?: unknown }).Balance;
  if (typeof id !== 'string' || typeof balance !== 'number') return null;
  return { Id: id, Balance: balance };
}

/** Is a remainder large enough to be a real disagreement rather than rounding? */
export function isMeaningfulRemainder(value: number): boolean {
  return Math.abs(value) > LEAST_MEANINGFUL_AMOUNT;
}
