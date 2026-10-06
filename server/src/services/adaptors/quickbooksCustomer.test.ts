import {
  assertMatchValue,
  findCustomerByIdentifier,
  SCAN_MAX_PAGES,
  SCAN_PAGE_SIZE,
} from './quickbooksCustomer.js';
import { AdaptorApplyError } from './errors.js';
import type { CustomerMatchConfig } from '../../types/adaptor.js';
import type { AdaptorResponse } from '../../types/adaptor.js';

const displayName: CustomerMatchConfig = {
  strategy: 'displayName',
  mode: 'exact',
  fieldName: null,
  depositAccountId: null,
};
const customField: CustomerMatchConfig = {
  strategy: 'customField',
  mode: 'exact',
  fieldName: 'Student ID',
  depositAccountId: null,
};
const notes: CustomerMatchConfig = { ...displayName, strategy: 'notes' };

/** Answer each query by what it selects, so a test can assert on the statement. */
function responder(body: unknown) {
  const seen: string[] = [];
  const request = async (url: string): Promise<AdaptorResponse> => {
    seen.push(decodeURIComponent(url));
    return { status: 200, body };
  };
  return { request, seen };
}

const customers = (rows: unknown[]) => ({ QueryResponse: { Customer: rows } });

describe('the identifier is validated at the boundary', () => {
  /*
    These are the tests that matter most in this file. The value is
    interpolated into a statement sent to the company's own books, so the
    check cannot live in an HTTP controller — a background job, a script or a
    second route would bypass it, and by then the string is already in a query.
  */
  it.each([
    "x' OR '1'='1",
    "S1234567'; DROP TABLE Customer;--",
    'S 123 4567',
    'S1234567$',
    '',
    'abc', // below the floor
    'S'.repeat(65),
  ])('refuses %p', (value) => {
    expect(() => assertMatchValue(value)).toThrow(AdaptorApplyError);
  });

  /*
    THE FLOOR IS FOUR, not eight, and that is deliberate.

    The value being matched is the organization's student identifier, echoed back
    by the gateway. A real one is `STU0026` — SEVEN characters — which the old
    8+ floor rejected outright, so every callback would have failed at the parser
    before it could reach a customer.

    The floor dropped; the CHARACTER SET did not. It is still `[A-Za-z0-9_-]`,
    which admits no quote, no backslash and no space — and those, not the
    length, are what make the value safe to interpolate into a statement sent to
    the company's books. Every injection case above is still refused, which is
    the property that matters and the reason this was a floor change rather than
    the pattern being loosened.
  */
  it.each(['STU0026', 'short', 'abcd', 'S1234567', 'STU-2026-0042', 'a_b-C9xxxxxxx'])(
    'accepts %p',
    (value) => {
      expect(() => assertMatchValue(value)).not.toThrow();
    },
  );

  it('refuses before opening a connection', async () => {
    const { request, seen } = responder(customers([]));
    await expect(
      findCustomerByIdentifier(request, customField, "S1' OR '1'='1"),
    ).rejects.toBeInstanceOf(AdaptorApplyError);
    // Nothing reached the network: the pattern refuses it, not a failed query.
    expect(seen).toEqual([]);
  });
});

describe('matching by customer name', () => {
  it('asks for an exact name and returns the one match', async () => {
    const { request, seen } = responder(customers([{ Id: 'cust-1', DisplayName: 'S1234567' }]));
    const outcome = await findCustomerByIdentifier(request, displayName, 'S1234567');

    expect(seen[0]).toContain('where DisplayName = ');
    expect(seen[0]).toContain("'S1234567'");
    expect(outcome).toEqual({ ok: true, customer: { id: 'cust-1' }, scanned: 1 });
  });

  it('searches a substring in contains mode, and ignores case', async () => {
    const { request, seen } = responder(
      customers([{ Id: 'cust-1', DisplayName: 'Amber Student S1234567' }]),
    );
    const outcome = await findCustomerByIdentifier(
      request,
      { ...displayName, mode: 'contains' },
      'S1234567',
    );

    expect(seen[0]).toContain("like '%S1234567%'");
    expect(outcome.ok).toBe(true);
  });

  it('reports nobody rather than returning undefined', async () => {
    const { request } = responder(customers([]));
    expect(await findCustomerByIdentifier(request, displayName, 'S1234567')).toEqual({
      ok: false,
      reason: 'customer-not-found',
      matches: 0,
    });
  });

  it('refuses to choose between two names that both contain the identifier', async () => {
    const { request } = responder(
      customers([
        { Id: 'cust-1', DisplayName: 'S1234567 Adams' },
        { Id: 'cust-2', DisplayName: 'S1234567 Baker' },
      ]),
    );
    expect(
      await findCustomerByIdentifier(request, { ...displayName, mode: 'contains' }, 'S1234567'),
    ).toEqual({ ok: false, reason: 'customer-ambiguous', matches: 2 });
  });
});

describe('matching by custom field', () => {
  /*
    ★ THIS STRATEGY SCANS, and that is a VERIFIED FACT rather than a design
    choice. This test used to assert the opposite — that the field was addressed
    in the query string — and it was wrong: a live QuickBooks company answers
    `select * from Customer where "Student ID" = '…'` with HTTP 400 "Error
    parsing query", and the single-quoted spelling is refused too. Verified
    2026-09-28 against realm 9341457936805547.

    So the test now pins what the provider actually allows: a page of customers
    with NO field filter, and the comparison made in memory. It also asserts the
    field name never reaches the query, because the previous behaviour was not
    merely inefficient — it failed every payment with an upstream parse error
    while the configuration screen showed the rule as correctly set.
  */
  it('reads the field off each customer rather than filtering on it upstream', async () => {
    const { request, seen } = responder(
      customers([
        { Id: 'cust-1', CustomField: [{ Name: 'Student ID', StringValue: 'S1234567' }] },
      ]),
    );
    const outcome = await findCustomerByIdentifier(request, customField, 'S1234567');

    // The statement asks for customers, and does not mention the field at all.
    expect(seen[0]).toContain('from Customer');
    expect(seen[0]).not.toContain('Student ID');
    expect(seen[0]).not.toContain('WHERE');
    expect(outcome).toEqual({ ok: true, customer: { id: 'cust-1' }, scanned: 1 });
  });

  it('surfaces a provider that refuses the request, rather than reporting no match', async () => {
    /*
      The shape of the provider's answer, captured so the decision cannot be
      quietly reversed by someone who believes the field is filterable again.
      Every other test would still pass against a re-broken implementation,
      because they use a fake that answers whatever it is asked.

      "Refused" and "found nobody" must stay different: one means the connection
      or the company is the problem, the other means check the identifier. A
      silent "no match" here would send an operator hunting for a student who
      exists.
    */
    const rejecting = jest
      .fn()
      .mockResolvedValue({ status: 400, body: { Fault: { Error: [{ Message: 'Error parsing query' }] } } });
    await expect(
      findCustomerByIdentifier(rejecting, { ...customField }, 'S1234567'),
    ).rejects.toThrow(/customer scan failed \(status 400\)/);
  });

  it('reads a value returned in either of the two fields QuickBooks uses', async () => {
    const { request } = responder(
      customers([{ Id: 'cust-1', CustomField: [{ Name: 'Student ID', Value: 'S1234567' }] }]),
    );
    expect((await findCustomerByIdentifier(request, customField, 'S1234567')).ok).toBe(true);
  });

  it('refuses before making a request when no field name is set', async () => {
    const { request, seen } = responder(customers([]));
    await expect(
      findCustomerByIdentifier(request, { ...customField, fieldName: null }, 'S1234567'),
    ).rejects.toBeInstanceOf(AdaptorApplyError);
    expect(seen).toEqual([]);
  });

  it('refuses a field name that could break out of its own quoted identifier', async () => {
    const { request, seen } = responder(customers([]));
    await expect(
      findCustomerByIdentifier(
        request,
        { ...customField, fieldName: 'Student" OR "1' },
        'S1234567',
      ),
    ).rejects.toBeInstanceOf(AdaptorApplyError);
    expect(seen).toEqual([]);
  });

  it('does not accept a row whose OTHER field happens to hold the value', async () => {
    // The upstream query is trusted to do its job, but a row that answers for
    // some other reason must not be accepted as this customer's match.
    const { request } = responder(
      customers([{ Id: 'cust-1', CustomField: [{ Name: 'Course', StringValue: 'S1234567' }] }]),
    );
    expect(await findCustomerByIdentifier(request, customField, 'S1234567')).toEqual({
      ok: false,
      reason: 'customer-not-found',
      matches: 0,
    });
  });
});

describe('matching by notes is a scan, and says so', () => {
  it('pages until it finds a match', async () => {
    const pages = [
      {
        QueryResponse: {
          Customer: Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => ({ Id: `c${i}` })),
          maxResults: SCAN_PAGE_SIZE,
        },
      },
      { QueryResponse: { Customer: [{ Id: 'cust-9', Notes: 'S1234567' }], maxResults: 1 } },
    ];
    let call = 0;
    const request = async (): Promise<AdaptorResponse> => ({ status: 200, body: pages[call++] });

    const outcome = await findCustomerByIdentifier(request, notes, 'S1234567');

    expect(call).toBe(2);
    expect(outcome).toMatchObject({ ok: true, customer: { id: 'cust-9' } });
  });

  it('stops on a short page rather than reading one more', async () => {
    const request = async (): Promise<AdaptorResponse> => ({
      status: 200,
      body: { QueryResponse: { Customer: [{ Id: 'c1', Notes: 'nothing here' }], maxResults: 1 } },
    });

    expect(await findCustomerByIdentifier(request, notes, 'S1234567')).toEqual({
      ok: false,
      reason: 'customer-not-found',
      matches: 0,
    });
  });

  it('stops at the second match, because a third changes nothing', async () => {
    const request = async (): Promise<AdaptorResponse> => ({
      status: 200,
      body: {
        QueryResponse: {
          Customer: [
            { Id: 'c1', Notes: 'S1234567' },
            { Id: 'c2', Notes: 'S1234567' },
          ],
          maxResults: 2,
        },
      },
    });

    expect(await findCustomerByIdentifier(request, notes, 'S1234567')).toEqual({
      ok: false,
      reason: 'customer-ambiguous',
      matches: 2,
    });
  });

  it('reports the ceiling as its own failure, not as "no match"', async () => {
    /*
      The distinction is the whole point. "Nobody matches" sends an operator to
      check the identifier; "the scan ran out" sends them to choose a field that
      can be searched. Collapsing them would look like a working lookup that
      simply finds nothing.
    */
    const request = async (): Promise<AdaptorResponse> => ({
      status: 200,
      body: {
        QueryResponse: {
          Customer: Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => ({ Id: `c${i}` })),
          maxResults: SCAN_PAGE_SIZE,
        },
      },
    });

    await expect(findCustomerByIdentifier(request, notes, 'S1234567')).rejects.toMatchObject({
      reason: 'scan-limit-reached',
    });
  });

  it('bounds the crawl to a documented number of pages', async () => {
    let call = 0;
    const request = async (): Promise<AdaptorResponse> => {
      call += 1;
      return {
        status: 200,
        body: {
          QueryResponse: {
            Customer: Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => ({ Id: `c${i}` })),
            maxResults: SCAN_PAGE_SIZE,
          },
        },
      };
    };

    await expect(findCustomerByIdentifier(request, notes, 'S1234567')).rejects.toBeInstanceOf(
      AdaptorApplyError,
    );
    expect(call).toBe(SCAN_MAX_PAGES);
  });
});

describe('transport failures are not match failures', () => {
  it.each([401, 403, 429, 500, 503])('surfaces a %p as a transport error', async (status) => {
    const request = async (): Promise<AdaptorResponse> => ({ status, body: {} });
    await expect(
      findCustomerByIdentifier(request, displayName, 'S1234567'),
    ).rejects.toMatchObject({
      // A 401 belongs to the adaptor's auth taxonomy, not to "no customer
      // matched" — the two need different responses and must never be conflated.
      code: expect.stringMatching(/^ADAPTOR_/),
    });
  });

  it('does not reproduce the upstream fault text, which can name a customer', async () => {
    const request = async (): Promise<AdaptorResponse> => ({
      status: 400,
      body: { Fault: { Error: [{ Message: 'Object Not Found: Jane Doe' }] } },
    });

    await expect(
      findCustomerByIdentifier(request, displayName, 'S1234567'),
    ).rejects.not.toThrow(/Jane Doe/);
  });
});
