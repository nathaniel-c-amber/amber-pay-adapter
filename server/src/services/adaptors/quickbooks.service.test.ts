import { QuickBooksAdaptor } from './quickbooks.service.js';
import { AdaptorConnectionError, AdaptorError } from './errors.js';
import type {
  AdaptorCredentials,
  CustomerMatchConfig,
  PaymentRef,
} from '../../types/adaptor.js';

const payment: PaymentRef = {
  id: 'p1',
  transactionId: 'tx-1',
  matchValue: 'S1234567',
  status: 'collected',
  processedAt: '2026-01-01T00:00:00.000Z',
};

const match: CustomerMatchConfig = {
  strategy: 'customField',
  mode: 'exact',
  fieldName: 'Student ID',
  depositAccountId: null,
};

/**
 * A scripted QuickBooks, keyed on what the call IS rather than on call order.
 *
 * Order-keyed mocks are the reason a pipeline test stops testing anything the
 * moment a step is added: insert a call and every later expectation describes
 * the wrong request. Matching on the decoded query statement means a step can
 * appear or be removed and the remaining expectations still describe what they
 * meant.
 */
function quickBooks(script: {
  customers?: unknown[];
  invoices?: unknown[];
  existingPayments?: unknown[];
  createdPayment?: { Id: string; UnappliedAmt?: number };
  balanceAfterPayment?: number;
}) {
  const calls: { url: string; body: unknown }[] = [];
  const transport = jest.fn(async (_method: string, url: string, body?: unknown) => {
    calls.push({ url: String(url), body });
    const statement = decodeURIComponent(String(url).split('query=')[1]?.split('&')[0] ?? '');

    if (statement.includes('from Customer')) {
      return { status: 200, body: { QueryResponse: { Customer: script.customers ?? [] } } };
    }
    if (statement.includes('from Invoice where CustomerRef')) {
      return { status: 200, body: { QueryResponse: { Invoice: script.invoices ?? [] } } };
    }
    if (statement.includes('from Payment')) {
      return {
        status: 200,
        body: { QueryResponse: { Payment: script.existingPayments ?? [] } },
      };
    }
    if (String(url).endsWith('/payment')) {
      return { status: 200, body: { Payment: script.createdPayment ?? { Id: 'pay-1' } } };
    }
    if (String(url).includes('/invoice/')) {
      return {
        status: 200,
        body: { Invoice: { Id: 'inv-1', Balance: script.balanceAfterPayment ?? 0 } },
      };
    }
    return { status: 200, body: {} };
  });
  return { transport, calls };
}

const oneCustomer = [{ Id: 'cust-1', DisplayName: 'Amber Student', CustomField: [{ Name: 'Student ID', StringValue: 'S1234567' }] }];
const oneOpenInvoice = [
  { Id: 'inv-1', DocNumber: '1042', DueDate: '2026-01-31', TxnDate: '2026-01-01', Balance: 250 },
];

/*
  Credentials are supplied EXPLICITLY, never read from the environment.

  That is the whole point of the injected-credentials change, so a suite that
  relied on `setup-env.cjs` would now be testing the test setup. The values match
  what the environment happens to provide, which keeps the bearer-token assertion
  below meaningful while making the adaptor's behaviour independent of it.
*/
const credentials: AdaptorCredentials = {
  clientId: 'test-qb-client-id',
  clientSecret: 'test-qb-client-secret',
  baseUrl: 'https://quickbooks.api.intuit.com',
  realmId: '9341457936805547',
  accessToken: 'test-qb-access-token',
  refreshToken: 'test-qb-refresh-token',
};

describe('QuickBooksAdaptor', () => {
  it('exposes id and name', () => {
    const adaptor = new QuickBooksAdaptor();
    expect(adaptor.id).toBe('quickbooks');
    expect(adaptor.name).toBe('QuickBooks Online');
  });

  it('status returns a valid AdaptorStatus', async () => {
    const adaptor = new QuickBooksAdaptor();
    const status = await adaptor.status();
    expect(['connected', 'disconnected', 'error', 'syncing']).toContain(status);
  });

  it('connect sets status to connected', async () => {
    const adaptor = new QuickBooksAdaptor();
    await adaptor.connect(credentials);
    expect(await adaptor.status()).toBe('connected');
  });

  it('reads no environment: connect({}) fails even though the environment HAS credentials', async () => {
    /*
      The regression test for the injected-credentials change. `setup-env.cjs`
      sets QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET, so an adaptor that
      still consulted the environment would connect here. It must not.
    */
    const adaptor = new QuickBooksAdaptor();
    await expect(adaptor.connect({})).rejects.toThrow(/not configured/i);
    expect(await adaptor.status()).toBe('disconnected');
  });

  it('uses the supplied base URL and realm', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect({
      ...credentials,
      baseUrl: 'https://sandbox.example.test',
      realmId: 'realm-from-settings',
    });
    await adaptor.healthCheck();

    const [, url] = transport.mock.calls[0];
    // Both segments come from the credentials, and the base URL's trailing slash
    // is normalised so the path cannot double up.
    expect(String(url)).toBe(
      'https://sandbox.example.test/v3/company/realm-from-settings/companyinfo/realm-from-settings',
    );
  });

  it('applies a payment to the discovered invoice and confirms it cleared', async () => {
    const { transport } = quickBooks({
      customers: oneCustomer,
      invoices: oneOpenInvoice,
      createdPayment: { Id: 'pay-1' },
      balanceAfterPayment: 0,
    });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);

    const result = await adaptor.pushCompletedPayment(payment, match);

    expect(result).toEqual({
      externalRef: 'pay-1',
      at: expect.any(String),
      invoiceRef: 'inv-1',
      matchedBy: 'customField',
      alreadyApplied: false,
      verified: true,
    });
  });

  it('sends the invoice balance as the payment total, and links the line to the invoice', async () => {
    /*
      The figures are read from the INVOICE, never from the gateway. That is the
      only number that can be right, and asserting the body is the only place
      this can be proved — a payment for a different figure would satisfy every
      other test in this file.
    */
    const { transport, calls } = quickBooks({
      customers: oneCustomer,
      invoices: oneOpenInvoice,
      balanceAfterPayment: 0,
    });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);
    await adaptor.pushCompletedPayment(payment, match);

    const create = calls.find((call) => call.url.endsWith('/payment'));
    expect(create?.body).toMatchObject({
      TotalAmt: 250,
      CustomerRef: { value: 'cust-1' },
      PaymentRefNum: 'p1',
      Line: [{ Amount: 250, LinkedTxn: [{ TxnId: 'inv-1', TxnType: 'Invoice' }] }],
    });
  });

  it('does not write when this reference was already paid upstream', async () => {
    /*
      THE RETRY SAFETY TEST. A first delivery whose create is accepted but whose
      response is lost looks exactly like one that was never sent, and the
      processor RELEASES its dedup claim on failure precisely so a retry can
      happen. Nothing local would stop that retry paying twice; the payment's
      own reference number is the only durable record, so it is what is asked.
    */
    const { transport, calls } = quickBooks({
      customers: oneCustomer,
      invoices: oneOpenInvoice,
      existingPayments: [{ Id: 'pay-already' }],
      balanceAfterPayment: 0,
    });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);

    const result = await adaptor.pushCompletedPayment(payment, match);

    expect(result.alreadyApplied).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/payment'))).toBe(false);
  });

  it('reports a match that found nobody, and writes nothing', async () => {
    const { transport, calls } = quickBooks({ customers: [], invoices: oneOpenInvoice });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);

    await expect(adaptor.pushCompletedPayment(payment, match)).rejects.toMatchObject({
      reason: 'customer-not-found',
    });
    expect(calls.some((call) => call.url.endsWith('/payment'))).toBe(false);
  });

  it('refuses to choose between two matching customers', async () => {
    const { transport, calls } = quickBooks({
      customers: [
        { Id: 'cust-1', CustomField: [{ Name: 'Student ID', StringValue: 'S1234567' }] },
        { Id: 'cust-2', CustomField: [{ Name: 'Student ID', StringValue: 'S1234567' }] },
      ],
      invoices: oneOpenInvoice,
    });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);

    await expect(adaptor.pushCompletedPayment(payment, match)).rejects.toMatchObject({
      reason: 'customer-ambiguous',
      matches: 2,
    });
    expect(calls.some((call) => call.url.endsWith('/payment'))).toBe(false);
  });

  it('reports a matched customer with nothing outstanding', async () => {
    const { transport } = quickBooks({ customers: oneCustomer, invoices: [] });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);

    await expect(adaptor.pushCompletedPayment(payment, match)).rejects.toMatchObject({
      reason: 'invoice-not-found',
    });
  });

  it('fails when the invoice did not clear, even though the payment was accepted', async () => {
    /*
      The 200 is not the claim. A payment can be created and the invoice still
      be outstanding, and reporting success there is how "posted" becomes a word
      the console says without meaning.
    */
    const { transport } = quickBooks({
      customers: oneCustomer,
      invoices: oneOpenInvoice,
      createdPayment: { Id: 'pay-1' },
      balanceAfterPayment: 250,
    });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);

    await expect(adaptor.pushCompletedPayment(payment, match)).rejects.toMatchObject({
      reason: 'invoice-not-cleared',
    });
  });

  it('refuses a reference that could be interpolated into a query', async () => {
    const { transport } = quickBooks({ customers: oneCustomer });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);

    await expect(
      adaptor.pushCompletedPayment(
        { ...payment, matchValue: "x' OR '1'='1" },
        match,
      ),
    ).rejects.toBeInstanceOf(AdaptorError);
    // The pattern is what refuses it, so nothing reached the network at all.
    expect(transport).not.toHaveBeenCalled();
  });

  it('throws AdaptorConnectionError when not connected', async () => {
    const { transport } = quickBooks({});
    const adaptor = new QuickBooksAdaptor(transport);
    await expect(adaptor.pushCompletedPayment(payment, match)).rejects.toBeInstanceOf(
      AdaptorConnectionError,
    );
  });

  /*
    THE LOST RESPONSE, WHICH IS THE WHOLE REASON THE UPSTREAM PROBE EXISTS.

    A payment the accounting system ACCEPTED, whose response never arrived, is
    indistinguishable from one that was never sent. Our own webhook dedup cannot
    tell them apart either: it deliberately RELEASES the claim on failure so a
    payment can be retried, which is correct and is precisely what makes this
    dangerous — the retry finds no local record of a write that in fact
    happened, and pays the invoice a second time.

    So the sequence below is modelled end to end, not asserted about: the first
    delivery is accepted upstream and then fails locally, exactly as a dropped
    connection presents it. The retry must find the payment by its reference and
    write nothing. The assertion is the COUNT of payment writes across both
    deliveries, because that is the only number that distinguishes "idempotent"
    from "retries quietly duplicate the ledger" — and a test that only checked
    the retry's return value would pass against an implementation that double
    paid.
  */
  describe('a retry after a lost response', () => {
    it('writes the payment exactly once across both deliveries', async () => {
      const recorded: {
        Id: string;
        PaymentRefNum: string;
        Line: { Amount: number; LinkedTxn: { TxnId: string; TxnType: string }[] }[];
      }[] = [];
      let balance = 250;
      let loseTheFirstResponse = true;

      const transport = jest.fn(async (_method: string, url: string, body?: unknown) => {
        const statement = decodeURIComponent(String(url).split('query=')[1]?.split('&')[0] ?? '');
        if (statement.includes('from Customer')) {
          return { status: 200, body: { QueryResponse: { Customer: oneCustomer } } };
        }
        if (statement.includes('from Invoice where CustomerRef')) {
          return {
            status: 200,
            body: {
              QueryResponse: {
                Invoice: balance > 0 ? oneOpenInvoice : [{ ...oneOpenInvoice[0], Balance: 0 }],
              },
            },
          };
        }
        if (statement.includes('from Payment')) {
          return { status: 200, body: { QueryResponse: { Payment: recorded } } };
        }
        if (String(url).endsWith('/payment')) {
          const sent = body as { PaymentRefNum: string; Line: { Amount: number; LinkedTxn: { TxnId: string; TxnType: string }[] }[] };
          recorded.push({ Id: 'pay-1', PaymentRefNum: sent.PaymentRefNum, Line: sent.Line });
          balance = 0;
          if (loseTheFirstResponse) {
            /*
              Accepted, then the connection dies. The money moved; the caller
              learns nothing. This is the case a local-only guard cannot cover.
            */
            loseTheFirstResponse = false;
            throw new Error('socket hang up');
          }
          return { status: 200, body: { Payment: { Id: 'pay-1', Line: sent.Line } } };
        }
        if (String(url).includes('/invoice/')) {
          return { status: 200, body: { Invoice: { Id: 'inv-1', Balance: balance } } };
        }
        return { status: 200, body: {} };
      });

      const adaptor = new QuickBooksAdaptor(transport);
      await adaptor.connect(credentials);

      // Delivery one: the write is accepted upstream, then fails on the way back.
      await expect(adaptor.pushCompletedPayment(payment, match)).rejects.toThrow(/socket hang up/);

      // Delivery two: the retry. It must be a no-op, and it must know it is one.
      const result = await adaptor.pushCompletedPayment(payment, match);
      expect(result.alreadyApplied).toBe(true);
      expect(result.verified).toBe(true);
      /*
        And it must still KNOW which invoice the first delivery settled, read from
        the payment's own linked transaction. That is the whole reason the probe
        runs before the outstanding-invoice lookup: the invoice is settled now, so
        it cannot be found again by asking what is owed.
      */
      expect(result.invoiceRef).toBe('inv-1');

      // THE ASSERTION. One upstream write across two deliveries, and the one
      // that happened is the first — not a second payment against the same
      // invoice, which is how a customer's fee gets charged twice.
      const writes = transport.mock.calls.filter((call) => String(call[1]).endsWith('/payment'));
      expect(writes).toHaveLength(1);
      expect(recorded).toHaveLength(1);
    });

    it('still reports the invoice when the retry finds the payment', async () => {
      /*
        The idempotent path must not return a hollow result. An operator looking
        at this payment later needs to know which invoice it landed on, and the
        early return is the one place that could quietly return a bare
        `alreadyApplied` with no invoice attached.
      */
      const { transport } = quickBooks({
        customers: oneCustomer,
        invoices: oneOpenInvoice,
        existingPayments: [
          {
            Id: 'pay-1',
            PaymentRefNum: payment.id,
            Line: [
              { Amount: 250, LinkedTxn: [{ TxnId: 'inv-1', TxnType: 'Invoice' }] },
            ],
          },
        ],
        balanceAfterPayment: 0,
      });
      const adaptor = new QuickBooksAdaptor(transport);
      await adaptor.connect(credentials);

      const result = await adaptor.pushCompletedPayment(payment, match);
      expect(result).toMatchObject({
        alreadyApplied: true,
        invoiceRef: 'inv-1',
        verified: true,
      });
      // And it wrote nothing.
      expect(
        transport.mock.calls.filter((call) => String(call[1]).endsWith('/payment')),
      ).toHaveLength(0);
    });

    it('does not claim an invoice when the earlier payment named none', async () => {
      /*
        A payment recorded without a linked invoice — a credit sitting unapplied,
        say. There is then nothing to verify, and saying so is the point: a
        `verified: true` here would be asserting a re-read that never happened.
      */
      const { transport } = quickBooks({
        customers: oneCustomer,
        invoices: oneOpenInvoice,
        existingPayments: [{ Id: 'pay-1', PaymentRefNum: payment.id }],
        balanceAfterPayment: 0,
      });
      const adaptor = new QuickBooksAdaptor(transport);
      await adaptor.connect(credentials);

      const result = await adaptor.pushCompletedPayment(payment, match);
      expect(result.alreadyApplied).toBe(true);
      expect(result.invoiceRef).toBeNull();
      expect(result.verified).toBe(false);
    });
  });

  it('healthCheck returns ok:true on 2xx', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);
    const result = await adaptor.healthCheck();
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
  });

  /*
    ★ THE WRITE PATH SENT NO CONTENT TYPE, and this is the test that should have
    existed. The payment write went out with a JSON body and no `Content-Type`,
    and the company answered

      400 — "Operation Cannot consume content type is not supported."

    (verified 2026-09-28 against realm 9341457936805547). Every read succeeded —
    a GET has no body — so the connection probed healthy, the credentials
    verified, and the console reported a working integration right up until the
    first payment was placed. No test caught it because every adaptor test
    injects a transport, and the fault is in a header this adaptor omits rather
    than in anything the fake can be asked about.

    So the assertion is on the HEADERS the transport was handed, which is the only
    place the omission was ever observable.
  */
  describe('the content type of a write', () => {
    it('declares JSON on a request that carries a body', async () => {
      /*
        The real payment write, not a health check — a GET has no body, so
        asserting a content type there would pass for the wrong reason.

        Typed as a 4-argument mock so the HEADERS are reachable: the injected
        transport receives `(method, url, body, headers)`, and the omission being
        pinned lives entirely in the fourth argument. A three-parameter fake would
        make this assertion a compile error rather than a test.
      */
      const transport = jest.fn(
        async (
          _method: string,
          url: string,
          _body?: unknown,
          _headers?: Record<string, string>,
        ) => {
          // Decoded, as the shared harness does — the raw URL carries
          // `%20from%20Customer`, so matching on 'from Customer' without
          // decoding silently falls through to the catch-all.
          const statement = decodeURIComponent(
            String(url).split('query=')[1]?.split('&')[0] ?? '',
          );
          if (statement.includes('from Customer')) {
            return { status: 200, body: { QueryResponse: { Customer: oneCustomer } } };
          }
          if (statement.includes('from Invoice')) {
            return { status: 200, body: { QueryResponse: { Invoice: oneOpenInvoice } } };
          }
          if (statement.includes('from Payment')) {
            return { status: 200, body: { QueryResponse: { Payment: [] } } };
          }
          if (String(url).endsWith('/payment')) {
            return { status: 200, body: { Payment: { Id: 'pay-1' } } };
          }
          return { status: 200, body: { Invoice: { Id: 'inv-1', Balance: 0 } } };
        },
      );
      const adaptor = new QuickBooksAdaptor(transport);
      await adaptor.connect(credentials);
      await adaptor.pushCompletedPayment(payment, match);

      const write = transport.mock.calls.find((call) => String(call[1]).endsWith('/payment'));
      expect(write).toBeDefined();
      expect(write?.[3]?.['Content-Type']).toBe('application/json');
      // And the credential still rides along.
      expect(write?.[3]?.['Authorization']).toBe('Bearer test-qb-access-token');
    });

    it('sends no content type on a read, which has no body to describe', async () => {
      const transport = jest.fn(
        async (
          _method: string,
          _url: string,
          _body?: unknown,
          _headers?: Record<string, string>,
        ) => ({ status: 200, body: {} }),
      );
      const adaptor = new QuickBooksAdaptor(transport);
      await adaptor.connect(credentials);
      await adaptor.healthCheck();

      const headers = transport.mock.calls[0]?.[3];
      expect(headers?.['Content-Type']).toBeUndefined();
      expect(headers?.['Authorization']).toBe('Bearer test-qb-access-token');
    });
  });

  it('healthCheck returns ok:false + message on non-2xx', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 500, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);
    const result = await adaptor.healthCheck();
    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe('string');
  });

  it('healthCheck asks the realm company record, with the bearer token', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);
    await adaptor.healthCheck();
    const [method, url, , headers] = transport.mock.calls[0];
    expect(method).toBe('GET');
    expect(url).toContain('/v3/company/');
    expect(url).toContain('/companyinfo/');
    expect(headers).toMatchObject({ Authorization: 'Bearer test-qb-access-token' });
  });

  it('healthCheck surfaces the upstream reason instead of a bare status', async () => {
    const transport = jest.fn().mockResolvedValue({
      status: 401,
      body: { Fault: { Error: [{ Message: 'AuthenticationFailed' }] } },
    });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);
    const result = await adaptor.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('AuthenticationFailed');
  });

  it('healthCheck re-mints the token and retries once after a 401', async () => {
    // Happy path is the second call only, so a retry is the difference between
    // ok:true and ok:false here.
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 401, body: {} })
      .mockResolvedValue({ status: 200, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);
    const result = await adaptor.healthCheck();
    expect(result.ok).toBe(true);
    const companyInfoCalls = transport.mock.calls.filter(([, url]) =>
      String(url).includes('/companyinfo/'),
    );
    expect(companyInfoCalls).toHaveLength(2);
  });

  /*
    THE OUTAGE THIS REPRESENTS WAS REAL.

    `healthCheck` re-mints on a 401, and Intuit INVALIDATES the refresh token
    it just spent. This method used to call `connect()` purely for that side
    effect and threw away what it returned, so the replacement token lived only
    in the running process. The deployment reported healthy, kept working, and
    then could not connect AT ALL on its next restart — "Incorrect or invalid
    refresh token" — with no configuration change to explain it. The stored
    credential was not expired; it was spent, by our own health check.

    The assertion is that the rotation is HANDED OVER. A test asserting only
    `ok:true` passed throughout that outage, because the outage was invisible
    until a restart nobody had simulated.
  */
  describe('a health check that re-mints', () => {
    /*
      NO `accessToken` HERE, and that is the point rather than an omission.
      `resolveAccessToken` returns a supplied access token as-is and never
      touches the network, so a fixture carrying one cannot rotate anything — the
      health check would find no rotation to report and the test would pass while
      proving nothing. A deployment living on a refresh token is the case that
      breaks, because only that path reaches the exchange and therefore spends
      the token.
    */
    const refreshOnly: AdaptorCredentials = {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      baseUrl: credentials.baseUrl,
      realmId: credentials.realmId,
      refreshToken: 'first-refresh',
    };

    const rotatingTransport = () => {
      let exchanges = 0;
      let probe = 0;
      return jest.fn(async (_method: string, url: string) => {
        if (String(url).includes('oauth2/v1/tokens/bearer')) {
          exchanges += 1;
          return {
            status: 200,
            body: { access_token: `access-${exchanges}`, refresh_token: `refresh-${exchanges + 1}` },
          };
        }
        probe += 1;
        // The first probe is refused, as an expired access token is; the retry
        // after re-minting succeeds.
        return { status: probe === 1 ? 401 : 200, body: {} };
      });
    };

    it('hands the rotated credential to the caller so it can be persisted', async () => {
      const onRotation = jest.fn().mockResolvedValue(undefined);
      const adaptor = new QuickBooksAdaptor(rotatingTransport(), onRotation);
      await adaptor.connect(refreshOnly);

      await adaptor.healthCheck();

      /*
        The refresh token is the whole point. Asserting that SOME rotation was
        reported would pass while the field that matters went unmentioned.
      */
      expect(onRotation).toHaveBeenCalledTimes(1);
      /*
        `refresh-3`, not `refresh-2`: `connect()` already exchanged once at boot
        (issuing refresh-2), and the 401 re-mint is the SECOND exchange. That
        ordering is the bug's shape — by the time the health check runs, the
        boot token has already been spent, so the value that must reach the
        settings row is whichever the re-mint produced, not the one the process
        started with.
      */
      expect(onRotation).toHaveBeenCalledWith({ rotated: { refreshToken: 'refresh-3' } });
    });

    it('still works when nothing is listening for the rotation', async () => {
      // A test or a transient verifier can build the adaptor with no sink. That
      // must degrade the persistence, not the health check itself.
      const adaptor = new QuickBooksAdaptor(rotatingTransport());
      await adaptor.connect(refreshOnly);
      await expect(adaptor.healthCheck()).resolves.toMatchObject({ ok: true });
    });

    it('does not report a rotation when there was no re-mint', async () => {
      const onRotation = jest.fn().mockResolvedValue(undefined);
      const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
      const adaptor = new QuickBooksAdaptor(transport, onRotation);
      await adaptor.connect(credentials);

      await adaptor.healthCheck();

      // A healthy first probe mints nothing, so a rotation report here would be
      // inventing one — and a caller that persists on every call would then
      // write a credential the upstream never issued.
      expect(onRotation).not.toHaveBeenCalled();
    });
  });


  it('does not retry after a 401 when no refresh token was supplied', async () => {
    /*
      The retry exists to mint a new access token, which needs a refresh token.
      Retrying without one would present the same expired token again and report
      a second 401 as though it were fresh information.
    */
    const transport = jest.fn().mockResolvedValue({ status: 401, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    const { refreshToken: _omitted, ...noRefresh } = credentials;
    await adaptor.connect(noRefresh);
    const result = await adaptor.healthCheck();

    expect(result.ok).toBe(false);
    const companyInfoCalls = transport.mock.calls.filter(([, url]) =>
      String(url).includes('/companyinfo/'),
    );
    expect(companyInfoCalls).toHaveLength(1);
  });
});
