/* Finding the accounting customer a completed payment was made for.
 *
 * A payment arrives as ONE opaque reference. Turning it into a ledger entry
 * needs a `Customer` first, and the field that carries the identifier differs
 * per deployment — a name, a custom field, a note. So the strategy is
 * deployment configuration rather than a decision baked into an adaptor, and
 * all three live behind `findCustomerByIdentifier`.
 *
 * THE THREE STRATEGIES ARE NOT EQUALLY GOOD, and the difference is structural
 * rather than a matter of taste:
 *
 *   displayName  one upstream query. `DisplayName` is documented filterable.
 *   customField  A SCAN. A custom field is returned on the customer but is NOT
 *                queryable — the provider rejects `where "Field" = …` — so the
 *                value is read off each row as the scan passes. VERIFIED against
 *                a live company on 2026-09-28, not assumed.
 *   notes        A SCAN. QuickBooks does not mark `Customer.Notes` filterable,
 *                so a `Notes like` filter is refused as an invalid query — also
 *                verified, not assumed. There is no query for it; the only way
 *                to find a match is to page every customer and compare in
 *                memory. Bounded, and it says so when it runs out of pages
 *                rather than reporting "no match" for a customer it never
 *                looked at.
 *
 * SO ONLY `displayName` IS A SINGLE CALL. The other two page through customers,
 * which costs several requests against a rate-limited provider — a real cost of
 * the operator's choice of where the identifier lives, and stated in the console
 * rather than discovered in production.
 *
 * A MATCH IS NEVER GUESSED. Zero matches and several matches are both
 * failures, and they are different failures: "we found nobody" and "we found
 * three and picked one" must never look alike, because the second is how money
 * lands on the wrong ledger.
 */

import { AdaptorApplyError } from './errors.js';
import {
  CUSTOM_FIELD_NAME,
  OPAQUE_REFERENCE,
  assertQboOk,
  queryReturned,
  queryRows,
  queryPath,
  sqlLiteral,
} from './quickbooksWire.js';
import type {
  CustomerMatchConfig,
  CustomerMatchMode,
  CustomerMatchStrategy,
} from '../../types/adaptor.js';
import type { QboCustomer, QboRequest } from './quickbooksWire.js';

/** How many customers one page of a scan asks for. */
export const SCAN_PAGE_SIZE = 200;

/**
 * How many pages a bounded scan will fetch before giving up.
 *
 * A CAP, not a target. Without one, a `notes` match against a company of any
 * size becomes an unbounded crawl of a rate-limited API inside a request that
 * is supposed to finish inside five seconds. 2,000 customers is a ceiling that
 * is reached in about ten calls and is reported as its own failure, so the
 * operator is told to pick a queryable field rather than left waiting.
 */
export const SCAN_MAX_PAGES = 10;

/** The value we need downstream: an opaque id, never a name. */
export interface MatchedCustomer {
  id: string;
}

export type CustomerLookupOutcome =
  | { ok: true; customer: MatchedCustomer; scanned: number }
  | { ok: false; reason: 'customer-not-found' | 'customer-ambiguous'; matches: number };

/**
 * Compare one upstream value against the identifier we are matching.
 *
 * `contains` is case-insensitive because a name typed by a human is not a
 * token; `exact` is case-sensitive, so an identifier that differs only in case
 * is reported as no match rather than quietly accepted. Both trim, since
 * upstream values carry trailing spaces more often than anyone would like.
 */
function valueMatches(candidate: string | undefined, needle: string, mode: CustomerMatchMode): boolean {
  if (typeof candidate !== 'string') return false;
  const left = candidate.trim();
  const right = needle.trim();
  if (mode === 'exact') return left === right;
  return left.toLowerCase().includes(right.toLowerCase());
}

/** Read a custom field's value, whether it was written back as a string or a value. */
function customFieldValue(customer: QboCustomer, name: string): string | undefined {
  const fields = customer.CustomField;
  if (!Array.isArray(fields)) return undefined;
  const field = fields.find((entry) => entry?.Name === name);
  if (!field) return undefined;
  if (typeof field.StringValue === 'string') return field.StringValue;
  if (typeof field.Value === 'string') return field.Value;
  return undefined;
}

/**
 * Refuse an identifier that could not be safely interpolated.
 *
 * Deliberately the FIRST thing this module does. Everything downstream builds a
 * query string containing this value, so a caller that reaches the network
 * without passing here has turned a payment into an injection against the
 * company's own books. Throwing here means the controller's check is a
 * convenience rather than the boundary.
 */
export function assertMatchValue(value: string): void {
  if (!OPAQUE_REFERENCE.test(value)) {
    throw new AdaptorApplyError(
      'customer-not-found',
      'The payment reference is not in the format this accounting connection can match on',
    );
  }
}

/**
 * The one query that resolves a customer by name.
 *
 * CUSTOM FIELDS ARE NOT ADDRESSED HERE ANY MORE, and that is a verified fact
 * rather than a preference: the accounting query language rejects
 * `where "Field" = '…'` with HTTP 400 "Error parsing query". `rowMatches` reads
 * a custom field off each row instead, which is what the scan does.
 */
function buildMatchQuery(config: CustomerMatchConfig, value: string): string {
  if (config.mode === 'contains') {
    return `select * from Customer where DisplayName like '%${value}%'`;
  }
  return `select * from Customer where DisplayName = ${sqlLiteral(value)}`;
}

/**
 * Refuse a custom-field rule that names no field.
 *
 * Checked before any request rather than inside the comparison, because the
 * comparison would simply match nothing — and "no field configured" would then
 * be reported as "no such customer", sending an operator to check their student
 * identifiers instead of their own settings. Both are true; only one is worth
 * their time right now.
 */
function assertCustomFieldNamed(config: CustomerMatchConfig): void {
  if (config.strategy !== 'customField') return;
  if (!config.fieldName || !CUSTOM_FIELD_NAME.test(config.fieldName)) {
    throw new AdaptorApplyError(
      'customer-not-found',
      'This deployment matches on a QuickBooks custom field but has not set which field',
    );
  }
}

/** Does this customer satisfy the configured strategy, given a row? */
function rowMatches(row: QboCustomer, config: CustomerMatchConfig, value: string): boolean {
  if (config.strategy === 'customField') {
    return valueMatches(customFieldValue(row, config.fieldName ?? ''), value, 'exact');
  }
  if (config.strategy === 'notes') {
    return valueMatches(row.Notes, value, config.mode);
  }
  return valueMatches(row.DisplayName, value, config.mode);
}

/**
 * Resolve a payment's identifier to exactly one customer.
 *
 * Collects every match rather than returning the first, so "several" is
 * detected instead of resolved. Returning after the second match is
 * deliberate: a third does not change the answer, and the caller only needs to
 * know it cannot choose.
 */
export async function findCustomerByIdentifier(
  request: QboRequest,
  config: CustomerMatchConfig,
  value: string,
): Promise<CustomerLookupOutcome> {
  assertMatchValue(value);
  assertCustomFieldNamed(config);

  /*
    ★ `customField` SCANS, and this was verified against a real company rather
    than assumed. The plan said a custom field is addressed by name in the
    accounting query language; that is WRONG. Asking a live QuickBooks company

      select * from Customer where "Student ID" = 'S1234567'

    is answered with HTTP 400 "Error parsing query", and the single-quoted
    spelling is rejected too. A custom field is returned on the Customer object
    but is not a queryable field in the dialect. So a rule that looks configured
    would have failed EVERY payment with an upstream parse error — worse than no
    rule at all, because the configuration screen showed it as set.

    The scan is the only way to read one, and `rowMatches` already knows how,
    so the fix is to route the strategy to the same bounded scan `notes` uses.
    It costs the same several paged calls, and `rowMatches` still compares the
    field client-side. `displayName` remains the one single-call strategy:
    `DisplayName = …` and `DisplayName like …` were both accepted.
  */
  if (config.strategy === 'customField' || config.strategy === 'notes') {
    return scanForCustomer(request, config, value);
  }

  const response = await request(queryPath(buildMatchQuery(config, value)));
  assertQboOk(response, 'QuickBooks customer lookup');
  const rows = queryRows<QboCustomer>(response.body, 'Customer');
  return outcomeFromRows(
    rows.filter((row) => rowMatches(row, config, value)),
    rows.length,
  );
}

/**
 * The paged scan the `notes` strategy requires.
 *
 * STOPS EARLY on a second match, because a scan that keeps paging after it
 * already knows the answer is ambiguous spends the customer's rate limit to
 * learn nothing.
 */
async function scanForCustomer(
  request: QboRequest,
  config: CustomerMatchConfig,
  value: string,
): Promise<CustomerLookupOutcome> {
  const matches: QboCustomer[] = [];
  let scanned = 0;

  for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
    const response = await request(
      queryPath(
        `select * from Customer startPosition ${(page - 1) * SCAN_PAGE_SIZE + 1} maxResults ${SCAN_PAGE_SIZE}`,
      ),
    );
    assertQboOk(response, 'QuickBooks customer scan');
    const rows = queryRows<QboCustomer>(response.body, 'Customer');
    scanned += rows.length;

    for (const row of rows) {
      if (rowMatches(row, config, value)) {
        matches.push(row);
        if (matches.length > 1) {
          return outcomeFromRows(matches, scanned);
        }
      }
    }

    // A short page is the last page. `maxResults` is the upstream's own count
    // of what it returned, so a partial page is a complete answer, not a gap.
    if (rows.length < SCAN_PAGE_SIZE || queryReturned(response.body) < SCAN_PAGE_SIZE) {
      return outcomeFromRows(matches, scanned);
    }
  }

  /*
    Out of pages, and we never found a unique match. Reported as its OWN
    failure rather than as `customer-not-found`, because the two call for
    opposite responses: one means check the identifier, the other means the
    customer may well exist past the ceiling this scan was given.
  */
  throw new AdaptorApplyError(
    'scan-limit-reached',
    `Scanned ${scanned} QuickBooks customers without a unique match. Match on the customer name instead, or lower the number of customers to search.`,
  );
}

/** Turn a set of matching rows into an outcome, refusing to choose between several. */
function outcomeFromRows(matches: QboCustomer[], scanned: number): CustomerLookupOutcome {
  const first = matches[0];
  if (!first) {
    return { ok: false, reason: 'customer-not-found', matches: 0 };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'customer-ambiguous', matches: matches.length };
  }
  return { ok: true, customer: { id: first.Id }, scanned };
}

/**
 * Strategies a console should offer, and what each costs.
 *
 * A data answer to a question the ConfigPage otherwise has to answer in prose:
 * an operator choosing between a lookup and a crawl should not have to know
 * that one of them is a crawl.
 */
export const MATCH_STRATEGY_INFO: ReadonlyArray<{
  strategy: CustomerMatchStrategy;
  label: string;
  /** True when the strategy needs more than one upstream call. */
  expensive: boolean;
  needsFieldName: boolean;
  note: string;
}> = [
  {
    strategy: 'displayName',
    label: 'Customer name',
    expensive: false,
    needsFieldName: false,
    /*
      "Exactly the customer's name" IS the honest label, and it is narrower than
      it sounds. The value that arrives is the gateway's transaction reference,
      which the webhook parser holds to `^[A-Za-z0-9_-]{8,64}$` — so it contains
      no spaces and no apostrophes. This strategy therefore matches a customer
      whose QuickBooks name IS that identifier (a school whose DisplayName is the
      student ID), and cannot match "Samantha O'Brien". Verified live
      2026-09-28: a real customer name is REFUSED by the pattern before any
      request is made.

      The pattern is left strict rather than widened to accept human names.
      Widening it would permit nothing real — the value can never contain a
      space — while weakening the guarantee that keeps an unvalidated string out
      of a query against the company's books.
    */
    note: 'One lookup, but only where the customer name is the identifier itself. The reference the gateway sends contains no spaces, so this cannot match a name like "Samantha OBrien".',
  },
  {
    strategy: 'customField',
    label: 'Customer custom field',
    /*
      `expensive: true` CHANGED, and it is the honest answer now. This was
      described as a single lookup, on the belief that the accounting query
      language could filter on a field by name. It cannot: a live company
      answers that query with HTTP 400 "Error parsing query" (verified
      2026-09-28). The value is read off each customer as the scan passes, so
      the cost is the same as `notes` — and telling an operator otherwise would
      have them choose a field expecting one call and get a crawl.
    */
    expensive: true,
    needsFieldName: true,
    note: 'QuickBooks cannot search a custom field either, so customers are read one by one until the value is found. Slow, and stops after a fixed number.',
  },
  {
    strategy: 'notes',
    label: 'Customer notes',
    expensive: true,
    needsFieldName: false,
    note: 'QuickBooks cannot search notes, so every customer is read in turn. Slow, and stops after a fixed number.',
  },
];
