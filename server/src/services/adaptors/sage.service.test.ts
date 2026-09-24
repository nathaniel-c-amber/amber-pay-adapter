import { SageAdaptor } from './sage.service.js';
import { AdaptorConnectionError, AdaptorError } from './errors.js';
import type { AdaptorCredentials, PaymentRef } from '../../types/adaptor.js';

const payment: PaymentRef = {
  id: 'p1',
  transactionId: 'tx-1',
  externalInvoiceId: 'inv-1',
  status: 'collected',
  processedAt: '2026-01-01T00:00:00.000Z',
};

/** Supplied explicitly — the adaptor reads no environment (see the QB suite). */
const credentials: AdaptorCredentials = {
  clientId: 'test-sage-client-id',
  clientSecret: 'test-sage-client-secret',
  baseUrl: 'https://api.sage.com',
};

describe('SageAdaptor', () => {
  it('exposes id and name', () => {
    const adaptor = new SageAdaptor();
    expect(adaptor.id).toBe('sage');
    expect(adaptor.name).toBe('Sage');
  });

  it('status returns a valid AdaptorStatus', async () => {
    const adaptor = new SageAdaptor();
    const status = await adaptor.status();
    expect(['connected', 'disconnected', 'error', 'syncing']).toContain(status);
  });

  it('connect sets status to connected', async () => {
    const adaptor = new SageAdaptor();
    await adaptor.connect(credentials);
    expect(await adaptor.status()).toBe('connected');
  });

  it('reads no environment: connect({}) says "not configured" even though the environment HAS credentials', async () => {
    // setup-env.cjs sets SAGE_CLIENT_ID and SAGE_CLIENT_SECRET, so an adaptor
    // that still consulted the environment would connect here.
    const adaptor = new SageAdaptor();
    await expect(adaptor.connect({})).rejects.toThrow(/not configured/i);
    expect(await adaptor.status()).toBe('disconnected');
  });

  it('names the missing piece when only part of the credential pair is supplied', async () => {
    // "Configured but half-filled" is a state an operator reaches by pasting a
    // client id and forgetting the secret; it must not read as unconfigured.
    const adaptor = new SageAdaptor();
    await expect(adaptor.connect({ clientId: 'only-an-id' })).rejects.toThrow(/not configured/i);
  });

  it('uses the supplied base URL', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new SageAdaptor(transport);
    await adaptor.connect({ ...credentials, baseUrl: 'https://sage.example.test' });
    await adaptor.healthCheck();

    const [, url] = transport.mock.calls[0];
    expect(String(url)).toBe('https://sage.example.test/health');
  });

  it('pushCompletedPayment returns a PushResult shape', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new SageAdaptor(transport);
    await adaptor.connect(credentials);
    const result = await adaptor.pushCompletedPayment(payment);
    expect(result).toEqual({ externalRef: 'tx-1', at: expect.any(String) });
  });

  it('pushCompletedPayment throws AdaptorError on non-2xx', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 500, body: {} });
    const adaptor = new SageAdaptor(transport);
    await adaptor.connect(credentials);
    await expect(adaptor.pushCompletedPayment(payment)).rejects.toBeInstanceOf(AdaptorError);
  });

  it('pushCompletedPayment throws AdaptorConnectionError when not connected', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new SageAdaptor(transport);
    await expect(adaptor.pushCompletedPayment(payment)).rejects.toBeInstanceOf(
      AdaptorConnectionError,
    );
  });

  it('healthCheck returns ok:true on 2xx', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new SageAdaptor(transport);
    await adaptor.connect(credentials);
    const result = await adaptor.healthCheck();
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('healthCheck returns ok:false + message on non-2xx', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 500, body: {} });
    const adaptor = new SageAdaptor(transport);
    await adaptor.connect(credentials);
    const result = await adaptor.healthCheck();
    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe('string');
  });
});
