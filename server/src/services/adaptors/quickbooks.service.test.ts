import { QuickBooksAdaptor } from './quickbooks.service.js';
import { AdaptorConnectionError, AdaptorError } from './errors.js';
import type { PaymentRef } from '../../types/adaptor.js';

const payment: PaymentRef = {
  id: 'p1',
  transactionId: 'tx-1',
  externalInvoiceId: 'inv-1',
  status: 'collected',
  processedAt: '2026-01-01T00:00:00.000Z',
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
    await adaptor.connect();
    expect(await adaptor.status()).toBe('connected');
  });

  it('pushCompletedPayment returns a PushResult shape', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect();
    const result = await adaptor.pushCompletedPayment(payment);
    expect(result).toEqual({ externalRef: 'tx-1', at: expect.any(String) });
  });

  it('pushCompletedPayment throws AdaptorError on non-2xx', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 500, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect();
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
    await adaptor.connect();
    const result = await adaptor.healthCheck();
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('healthCheck returns ok:false + message on non-2xx', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 500, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect();
    const result = await adaptor.healthCheck();
    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe('string');
  });

  it('healthCheck asks the realm company record, with the bearer token', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    await adaptor.connect();
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
    await adaptor.connect();
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
    await adaptor.connect();
    const result = await adaptor.healthCheck();
    expect(result.ok).toBe(true);
    const companyInfoCalls = transport.mock.calls.filter(([, url]) =>
      String(url).includes('/companyinfo/'),
    );
    expect(companyInfoCalls).toHaveLength(2);
  });
});
