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
 *   customField  one upstream query, against a field name the operator typed.
 *   notes        A SCAN. QuickBooks does not mark `Customer.Notes` filterable,
 *                so there is no query for it; the only way to find a match is
 *                to page every customer and compare in memory. Bounded, and it
 *                says so when it runs out of pages rather than reporting
 *                "no match" for a customer it never looked at.
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
  sqlIdentifier,
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

/** The one query that resolves a customer by name or by custom field. */
function buildMatchQuery(config: CustomerMatchConfig, value: string): string {
  if (config.strategy === 'customField') {
    /*
      A custom field is addressed by the NAME the operator sees in QuickBooks,
      not by its numeric definition id — the query language has no other way to
      name it. So the name is the one piece of configuration a user types
      freely, and it is validated to a set that cannot break out of its own
      quoted identifier before it gets here.
    */
    if (!config.fieldName || !CUSTOM_FIELD_NAME.test(config.fieldName)) {
      throw new AdaptorApplyError(
        'customer-not-found',
        'This deployment matches on a QuickBooks custom field but has not set which field',
      );
    }
    return `select * from Customer where ${sqlIdentifier(config.fieldName)} = ${sqlLiteral(value)}`;
  }
  if (config.mode === 'contains') {
    return `select * from Customer where DisplayName like '%${value}%'`;
  }
  return `select * from Customer where DisplayName = ${sqlLiteral(value)}`;
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

  if (config.strategy === 'notes') {
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
    `Scanned ${scanned} QuickBooks customers without a unique match. Match on a custom field or the customer name instead of notes.`,
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
    note: 'One lookup. Matches the customer name QuickBooks already shows.',
  },
  {
    strategy: 'customField',
    label: 'Customer custom field',
    expensive: false,
    needsFieldName: true,
    note: 'One lookup against the field you name, such as Student ID.',
  },
  {
    strategy: 'notes',
    label: 'Customer notes',
    expensive: true,
    needsFieldName: false,
    note: 'QuickBooks cannot search notes, so every customer is read in turn. Slow, and stops after a fixed number.',
  },
];
