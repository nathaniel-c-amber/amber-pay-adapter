import { QuickBooksAdaptor } from './quickbooks.service.js';
import { AdaptorConnectionError, AdaptorError } from './errors.js';
import type { AdaptorCredentials, PaymentRef } from '../../types/adaptor.js';

const payment: PaymentRef = {
  id: 'p1',
  transactionId: 'tx-1',
  externalInvoiceId: 'inv-1',
  status: 'collected',
  processedAt: '2026-01-01T00:00:00.000Z',
};

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

  it('pushCompletedPayment returns a PushResult shape', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);
    const result = await adaptor.pushCompletedPayment(payment);
    expect(result).toEqual({ externalRef: 'tx-1', at: expect.any(String) });
  });

  it('pushCompletedPayment throws AdaptorError on non-2xx', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 500, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);
    await expect(adaptor.pushCompletedPayment(payment)).rejects.toBeInstanceOf(AdaptorError);
  });

  it('pushCompletedPayment throws AdaptorConnectionError when not connected', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await expect(adaptor.pushCompletedPayment(payment)).rejects.toBeInstanceOf(
      AdaptorConnectionError,
    );
  });

  it('healthCheck returns ok:true on 2xx', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect(credentials);
    const result = await adaptor.healthCheck();
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
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
