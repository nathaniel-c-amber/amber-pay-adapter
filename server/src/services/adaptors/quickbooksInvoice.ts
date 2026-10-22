/* Placing a completed payment on invoices, and proving it landed.
 *
 * Four steps, in this order, and the order is the design:
 *
 *   1. CHECK        which invoices are outstanding for this customer
 *   2. IDEMPOTENCY  has this reference already been paid — UPSTREAM
 *   3. APPLY        allocate the charged amount, oldest created first, and
 *                   write ONE payment that names every invoice it touched
 *   4. VERIFY       read each invoice back and confirm it moved by our share
 *
 * THE AMOUNT IS THE ONE THE GATEWAY CHARGED, NOT THE INVOICE BALANCE. This used
 * to read the customer's oldest invoice and pay its whole outstanding balance,
 * which meant a partial payment (a customer paying part of a term's fee) was
 * recorded as if they had paid the lot. The figure the customer was charged is
 * the only number that belongs in the ledger; the balance is what the invoice
 * still owes afterwards.
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
import { minorUnitsFromNumber } from '../../utils/money.js';
import type {
  QboInvoice,
  QboPaymentCreated,
  QboPaymentDelete,
  QboPaymentRequest,
  QboRequest,
} from './quickbooksWire.js';

/**
 * What a touched invoice's balance is compared against.
 *
 * QuickBooks returns money as a JSON number. Both sides of the comparison are
 * converted to integer minor units, so the tolerance exists only for the
 * representation error the provider's own two-place figures can carry. A cent
 * is the smallest difference that can mean anything to an accountant.
 */
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
  /** The invoices the payment was applied to, oldest created first. */
  invoiceIds: string[];
  /** True when a prior payment already covered this reference. */
  alreadyApplied: boolean;
  /** The post-write re-read confirmed every allocated invoice moved as expected. */
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

/** One invoice and the share of the payment allocated to it. */
export type InvoiceAllocation = {
  invoice: QboInvoice;
  /** MAJOR units, for the wire. Derived from integer minor units, never summed by float. */
  amount: number;
};

/**
 * Allocate a charged amount across the customer's outstanding invoices, oldest
 * created first.
 *
 * A DETERMINISTIC RULE, not a first-row pick, and not a refusal. A customer
 * with two open invoices is ordinary — a student with a term's fee and a
 * material charge, say — and refusing would mean the pipeline silently does
 * nothing for exactly the people it exists for. The rule is therefore written
 * down and applied every time: earliest `TxnDate`, then the lowest `Id`, and an
 * undated invoice last. `DueDate` is NOT used: it is a due-by date, not an age,
 * and a long-overdue invoice would otherwise be paid ahead of an older one.
 *
 * THE ARITHMETIC IS IN INTEGER MINOR UNITS. `Balance` arrives as a JSON number;
 * multiplying and subtracting those directly produces values like
 * `250.00000000000003`, and an accountant will not accept a comparison that is
 * "nearly" right. Every figure is converted once, allocated as whole cents, and
 * converted back only when the body is built.
 *
 * The allocation stops when the money runs out, so the sum NEVER exceeds what
 * was charged. A remainder is not invented here: if the invoices cannot absorb
 * the whole amount, that is the caller's refusal to make (the balance moved
 * since it was read), not a credit line this function could justify.
 */
export function allocatePayment(
  invoices: QboInvoice[],
  paidMinorUnits: number,
): InvoiceAllocation[] {
  const ordered = [...invoices].sort(compareInvoices);
  const allocations: InvoiceAllocation[] = [];
  let remaining = paidMinorUnits;

  for (const invoice of ordered) {
    if (remaining <= 0) break;
    const balance = minorUnitsFromNumber(invoice.Balance);
    // A missing balance cannot be judged, and a settled one has nothing to give.
    // Skipping is the only safe reading: treating either as payable would mean
    // inventing a figure to apply money against.
    if (balance === null || balance <= 0) continue;
    const amount = Math.min(remaining, balance);
    allocations.push({ invoice, amount: amount / 100 });
    remaining -= amount;
  }

  if (allocations.length === 0) {
    throw new AdaptorApplyError(
      'invoice-not-found',
      'The matched QuickBooks customer has no outstanding invoice',
    );
  }
  return allocations;
}

/** Earliest transaction date, then lowest id. Undated sorts last. */
function compareInvoices(a: QboInvoice, b: QboInvoice): number {
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
 * Record ONE payment that names every invoice it was allocated to.
 *
 * `TotalAmt` is the sum of the allocations, which is the amount actually
 * charged (or the part of it the invoices could absorb). Each line carries its
 * share and links to the invoice, which is what actually reduces it. QuickBooks
 * requires both `TotalAmt` and a per-line `Amount`; the line amounts are the
 * source of truth and the total is derived from them, so the two cannot
 * disagree.
 *
 * ONE PAYMENT RATHER THAN ONE PER INVOICE, deliberately: the gateway charged
 * one amount under one transaction reference, and the idempotency probe finds
 * a payment BY that reference. Several payments would each carry a reference
 * QuickBooks expects to be unique, and a retry would have to decide which of
 * them it had already written.
 */
export async function createPaymentForInvoices(
  request: QboRequest,
  allocations: InvoiceAllocation[],
  options: ApplyOptions,
): Promise<QboPaymentCreated> {
  const total = majorUnitsFrom(allocations.reduce((sum, a) => sum + a.amount, 0));
  const body: QboPaymentRequest = {
    TotalAmt: total,
    CustomerRef: { value: options.customerId },
    Line: allocations.map((allocation) => ({
      Amount: allocation.amount,
      LinkedTxn: [{ TxnId: allocation.invoice.Id, TxnType: 'Invoice' }],
    })),
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

/**
 * Round a float sum back to the two-place figure the wire understands.
 *
 * The operands are already exact cents expressed as major units, so this only
 * removes the representation error introduced by adding them (`0.1 + 0.2`).
 */
function majorUnitsFrom(value: number): number {
  return Math.round(value * 100) / 100;
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
 * Re-read every touched invoice and report how it moved.
 *
 * The claim is not "the payment was created" but "each invoice moved by the
 * share this payment gave it". `expected = read-time balance - allocation`, and
 * the comparison is in integer minor units:
 *
 *   - ABOVE expected → our line did not land, so `verified` is false. This is
 *     the failure the console must not paper over.
 *   - BELOW expected → our line landed and something ELSE also paid. The money
 *     is not lost, so this is not a verification failure; it is a ledger
 *     disagreement a person has to reconcile, reported as
 *     `reconciliationRequired`.
 *
 * A missing balance on either side is a fault in the answer, not a passing
 * verification, so it throws exactly as it did before.
 */
export async function verifyInvoicesApplied(
  request: QboRequest,
  allocations: InvoiceAllocation[],
): Promise<{ verified: boolean; reconciliationRequired: boolean; calls: number }> {
  let verified = true;
  let reconciliationRequired = false;
  let calls = 0;

  for (const allocation of allocations) {
    const invoiceId = allocation.invoice.Id;
    const before = minorUnitsFromNumber(allocation.invoice.Balance);
    const share = minorUnitsFromNumber(allocation.amount);
    if (before === null || share === null) {
      throw new AdaptorApplyError(
        'invoice-not-cleared',
        `QuickBooks returned a balance for invoice ${invoiceId} that could not be compared`,
      );
    }
    const expected = before - share;

    const response = await request(`/invoice/${invoiceId}`);
    calls += 1;
    assertQboOk(response, 'QuickBooks invoice verify');
    const refreshed = readInvoice(response.body);
    if (!refreshed) {
      throw new AdaptorApplyError(
        'invoice-not-cleared',
        `QuickBooks did not return invoice ${invoiceId} when asked to confirm the payment`,
      );
    }
    const actual = minorUnitsFromNumber(refreshed.Balance);
    if (actual === null) {
      throw new AdaptorApplyError(
        'invoice-not-cleared',
        `QuickBooks returned a balance for invoice ${invoiceId} that could not be compared`,
      );
    }

    const difference = actual - expected;
    const tolerance = LEAST_MEANINGFUL_AMOUNT * 100;
    if (difference > tolerance) {
      verified = false;
    } else if (difference < -tolerance) {
      reconciliationRequired = true;
    }
  }

  return { verified, reconciliationRequired, calls };
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
