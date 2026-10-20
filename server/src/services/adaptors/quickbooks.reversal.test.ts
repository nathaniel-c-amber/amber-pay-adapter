import { QuickBooksAdaptor } from './quickbooks.service.js';
import { AdaptorApplyError, AdaptorError } from './errors.js';
import type { AdaptorCredentials } from '../../types/adaptor.js';

const credentials: AdaptorCredentials = {
  clientId: 'test-qb-client-id',
  clientSecret: 'test-qb-client-secret',
  baseUrl: 'https://quickbooks.api.intuit.com',
  realmId: '9341457936805547',
  accessToken: 'test-qb-access-token',
};

function reversalTransport(options: {
  payments?: unknown[];
  syncToken?: string;
  paymentRead?: unknown;
  deleteStatus?: number;
}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const transport = jest.fn(async (method: string, url: string, body?: unknown) => {
    calls.push({ method, url: String(url), body });
    if (String(url).includes('/query?')) {
      return {
        status: 200,
        body: { QueryResponse: { Payment: options.payments ?? [] } },
      };
    }
    if (method === 'GET' && String(url).includes('/payment/')) {
      return { status: 200, body: options.paymentRead ?? {} };
    }
    if (String(url).includes('/payment?operation=delete')) {
      return { status: options.deleteStatus ?? 200, body: {} };
    }
    return { status: 200, body: {} };
  });
  return { transport, calls };
}

async function adaptorFor(options: Parameters<typeof reversalTransport>[0]) {
  const { transport, calls } = reversalTransport(options);
  const adaptor = new QuickBooksAdaptor(transport);
  await adaptor.connect(credentials);
  return { adaptor, calls };
}

const input = {
  transactionId: 'ABCDEFGH1234',
  originalAmount: '250.00',
  refundAmount: '250.00',
};

describe('QuickBooks reversal', () => {
  it('deletes the payment for a FULL refund, using its Id and SyncToken', async () => {
    const { adaptor, calls } = await adaptorFor({
      payments: [{ Id: 'pay-1', SyncToken: '7', PaymentRefNum: 'ABCDEFGH1234' }],
    });

    await expect(adaptor.reverseCompletedPayment!(input)).resolves.toEqual({
      status: 'reversed',
    });

    const del = calls.find((call) => call.url.includes('/payment?operation=delete'));
    expect(del?.method).toBe('POST');
    expect(del?.body).toEqual({ Id: 'pay-1', SyncToken: '7' });
  });

  it('reads the SyncToken when the lookup row did not carry one', async () => {
    const { adaptor, calls } = await adaptorFor({
      payments: [{ Id: 'pay-1', PaymentRefNum: 'ABCDEFGH1234' }],
      paymentRead: { Payment: { Id: 'pay-1', SyncToken: '9' } },
    });

    await expect(adaptor.reverseCompletedPayment!(input)).resolves.toEqual({
      status: 'reversed',
    });
    expect(calls.some((call) => call.url.endsWith('/payment/pay-1'))).toBe(true);
    const del = calls.find((call) => call.url.includes('/payment?operation=delete'));
    expect(del?.body).toEqual({ Id: 'pay-1', SyncToken: '9' });
  });

  it('does NOT delete for a PARTIAL refund', async () => {
    const { adaptor, calls } = await adaptorFor({
      payments: [{ Id: 'pay-1', SyncToken: '7', PaymentRefNum: 'ABCDEFGH1234' }],
    });

    await expect(
      adaptor.reverseCompletedPayment!({ ...input, refundAmount: '100.00' }),
    ).resolves.toEqual({ status: 'manual-adjustment-required' });
    expect(calls.some((call) => call.url.includes('operation=delete'))).toBe(false);
  });

  it('fails when no payment carries the reference', async () => {
    const { adaptor, calls } = await adaptorFor({ payments: [] });

    await expect(adaptor.reverseCompletedPayment!(input)).rejects.toMatchObject({
      reason: 'payment-not-found',
    });
    expect(calls.some((call) => call.url.includes('operation=delete'))).toBe(false);
  });

  it('fails when the provider has no SyncToken to delete with', async () => {
    const { adaptor } = await adaptorFor({
      payments: [{ Id: 'pay-1', PaymentRefNum: 'ABCDEFGH1234' }],
      paymentRead: {},
    });

    await expect(adaptor.reverseCompletedPayment!(input)).rejects.toBeInstanceOf(
      AdaptorApplyError,
    );
  });

  it('throws when the delete is refused, so the caller can report the books', async () => {
    const { adaptor } = await adaptorFor({
      payments: [{ Id: 'pay-1', SyncToken: '7', PaymentRefNum: 'ABCDEFGH1234' }],
      deleteStatus: 400,
    });

    await expect(adaptor.reverseCompletedPayment!(input)).rejects.toBeInstanceOf(
      AdaptorError,
    );
  });
});
