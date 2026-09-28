/* QuickBooks Online wire shapes, and the query seam.
 *
 * ★ THIS IS THE ONLY FILE IN THE REPOSITORY WHERE A MONEY FIELD IS ALLOWED TO
 * EXIST. QuickBooks requires `TotalAmt` on a payment write and returns
 * `Balance` on an invoice read; there is no way to apply a payment to an
 * invoice without them. Everything else in this codebase is held to FR-2.3 /
 * FR-5.2 — no amounts, no customer data, in domain types, event details,
 * failure text, log lines or the database.
 *
 * So the boundary is drawn here and tested. These types are deliberately NOT
 * exported from any barrel, are never persisted, and are never widened: a
 * caller receives a `PushResult`, which is built from these values and carries
 * none of them. `models/privacy.test.ts` reads this file and fails if a money
 * field ever appears on a type that is not one of the interfaces below.
 *
 * NAMES ARE NOT NORMALISED. QuickBooks' own field names are kept exactly,
 * including the capitalisation (`TotalAmt`, `Line`, `LinkedTxn`), because a
 * mapped alias is one more place for a read to quietly return `undefined` — the
 * failure mode this codebase has already paid for once, when a webhook parser
 * cast instead of mapping and every downstream field read `undefined`.
 */

import { adaptorErrorForStatus } from './errors.js';
import type { AdaptorResponse } from '../../types/adaptor.js';

/**
 * The one seam the pipeline needs. Takes a PATH RELATIVE to
 * `/v3/company/{realm}`, plus an optional body, and returns the raw transport
 * response.
 *
 * The URL shape — the part that was once wrong and 404'd on the first real
 * call — stays in the adaptor that owns it. The method is inferred from the
 * body rather than passed, because every call in the pipeline is either a read
 * or a create; an inferred method cannot be half-specified.
 */
export type QboRequest = (path: string, body?: unknown) => Promise<AdaptorResponse>;

/* --- custom fields ------------------------------------------------------- */

export interface QboCustomField {
  DefinitionId?: string;
  Name?: string;
  StringValue?: string;
  Value?: string;
}

/* --- Customer ------------------------------------------------------------ */

export interface QboCustomer {
  Id: string;
  DisplayName?: string;
  /** NOT queryable upstream — see the `notes` strategy. */
  Notes?: string;
  Active?: boolean;
  CustomField?: QboCustomField[];
}

/* --- Invoice ------------------------------------------------------------- */

export interface QboInvoice {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  Balance: number;
  TotalAmt?: number;
  CustomerRef?: { value: string; name?: string };
}

/* --- Payment ------------------------------------------------------------- */

export interface QboLinkedTxn {
  TxnId: string;
  TxnType: 'Invoice' | 'CreditMemo';
}

export interface QboPaymentLine {
  Amount: number;
  LinkedTxn: QboLinkedTxn[];
}

/**
 * The request body that applies money to an invoice.
 *
 * `TotalAmt` and `Line[].Amount` are REQUIRED by QuickBooks; the invoice
 * balance is the only correct value for either, so a caller cannot invent a
 * figure. `PaymentRefNum` carries the gateway's transaction id, which is what
 * makes a retried delivery recognisable as one already done.
 */
export interface QboPaymentRequest {
  TotalAmt: number;
  CustomerRef: { value: string };
  Line: QboPaymentLine[];
  PaymentRefNum: string;
  TxnDate?: string;
  DepositToAccountRef?: { value: string };
}

/**
 * The upstream id of a created payment, and the invoices it was applied to.
 *
 * `Line[].LinkedTxn` is read on the IDEMPOTENCY path only — a payment that
 * already exists is the one place the invoices it settled can be named. On the
 * create path the invoice is known already, so nothing here needs it.
 *
 * No other field is ever read back. In particular not the amounts, which
 * `QboPaymentLine` and `QboPaymentRequest` exist to write and never to surface.
 */
export interface QboPaymentCreated {
  Id: string;
  UnappliedAmt?: number;
  Line?: QboPaymentLine[];
}

/* --- query --------------------------------------------------------------- */

/** Read a single-entity array out of a query response, tolerating an empty body. */
export function queryRows<TRow>(body: unknown, key: string): TRow[] {
  if (typeof body !== 'object' || body === null) return [];
  const response = (body as { QueryResponse?: Record<string, unknown> }).QueryResponse;
  if (typeof response !== 'object' || response === null) return [];
  const rows = response[key];
  return Array.isArray(rows) ? (rows as TRow[]) : [];
}

/** Rows the previous page returned, which is how the paged scan knows to stop. */
export function queryReturned(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0;
  const response = (body as { QueryResponse?: { maxResults?: number } }).QueryResponse;
  return typeof response?.maxResults === 'number' ? response.maxResults : 0;
}

/**
 * URL-encode a query statement.
 *
 * The statement is built from validated fragments and a value that has already
 * been pattern-checked (see `assertMatchValue`), so encoding is here to keep a
 * space in a field name or a `%` out of breaking the URL — not as the thing
 * standing between a caller and injection. That check is the load-bearing one.
 */
export function queryPath(statement: string): string {
  return `/query?query=${encodeURIComponent(statement)}&minorversion=73`;
}

/**
 * Single-quote a value for a QBO SQL literal.
 *
 * Only ever reached with a value that already passed `OPAQUE_REFERENCE`, which
 * admits no quote at all. The doubling is belt-and-braces: a query string is
 * the one place where a missing check is a company-wide disclosure, so the
 * escape is present even though the pattern currently makes it unreachable —
 * and a test proves the pattern, not the escape, is what is doing the work.
 */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The only pattern a matched value may take.
 *
 * Enforced HERE, at the adaptor boundary, and not only in the controller. The
 * value is interpolated into an upstream query string; if the only check were
 * on an HTTP route, then any future caller — a background job, a script, a
 * second route — would interpolate an unvalidated string into a query against
 * the company's books. `OPAQUE_REFERENCE` admits no quote, no backslash and no
 * space, so there is nothing here to escape.
 */
export const OPAQUE_REFERENCE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A custom field name, as the operator sees it in QuickBooks.
 *
 * Spaces are allowed because that is how people actually name these — "Student
 * ID" is the obvious one — and the name is emitted double-quoted, which is the
 * SQL-standard form and the one QuickBooks' dialect accepts. A double quote
 * itself is NOT allowed, which is what makes the quoting safe: the name cannot
 * terminate its own literal. No `*`, no comma, no bracket.
 */
export const CUSTOM_FIELD_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$/;

/*
  `sqlIdentifier` — which used to render a custom field as a quoted SQL
  identifier — IS GONE, and deliberately not left behind.

  It existed for one caller: `select * from Customer where "Field" = '…'`. A live
  company answers that with HTTP 400 "Error parsing query", so the call is
  unreachable and the helper with it. Keeping it would have been worse than dead
  code: it reads as a security control guarding a query that no longer exists,
  and a future change reaching for it would rebuild exactly the query the
  provider rejects. `CUSTOM_FIELD_NAME` remains, because the field name is still
  validated — as configuration, by the settings service and again before a scan.
*/

/**
 * Turn a transport response into a parsed body, or throw the classified error.
 *
 * The MESSAGE is deliberately the status code and nothing else. A QuickBooks
 * `Fault` names the entity it refused and frequently quotes the entity's own
 * text back — a customer's name, a line description — and this message
 * travels to log lines and the console. The upstream's own text is not
 * reproduced anywhere on the apply path; only the code, which is what callers
 * actually act on, is.
 */
export function assertQboOk(response: AdaptorResponse, what: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw adaptorErrorForStatus(response.status, `${what} failed (status ${response.status})`);
  }
}
