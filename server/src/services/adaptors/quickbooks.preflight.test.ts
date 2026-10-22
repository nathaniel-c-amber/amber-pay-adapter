import { QuickBooksAdaptor } from './quickbooks.service.js';
import { AdaptorConnectionError } from './errors.js';
import type { AdaptorCredentials, CustomerMatchConfig } from '../../types/adaptor.js';

const match: CustomerMatchConfig = {
  strategy: 'customField',
  mode: 'exact',
  fieldName: 'Student ID',
  depositAccountId: null,
};

const credentials: AdaptorCredentials = {
  clientId: 'test-qb-client-id',
  clientSecret: 'test-qb-client-secret',
  baseUrl: 'https://quickbooks.api.intuit.com',
  realmId: '9341457936805547',
  accessToken: 'test-qb-access-token',
};

const customer = {
  Id: 'cust-1',
  DisplayName: 'Somebody',
  CustomField: [{ Name: 'Student ID', StringValue: 'S1234567' }],
};

function preflightTransport(options: {
  customers?: unknown[];
  invoices?: unknown[];
  fail?: boolean;
}) {
  const calls: { url: string; body: unknown }[] = [];
  const transport = jest.fn(async (_method: string, url: string, body?: unknown) => {
    calls.push({ url: String(url), body });
    if (options.fail) throw new AdaptorConnectionError('upstream unreachable');
    if (String(url).includes('from%20Customer') || String(url).includes('from Customer')) {
      return { status: 200, body: { QueryResponse: { Customer: options.customers ?? [] } } };
    }
    if (String(url).includes('from%20Invoice') || String(url).includes('from Invoice')) {
      return { status: 200, body: { QueryResponse: { Invoice: options.invoices ?? [] } } };
    }
    return { status: 200, body: {} };
  });
  return { transport, calls };
}

async function adaptorFor(options: Parameters<typeof preflightTransport>[0]) {
  const { transport, calls } = preflightTransport(options);
  const adaptor = new QuickBooksAdaptor(transport);
  await adaptor.connect(credentials);
  return { adaptor, calls };
}

const input = {
  matchValue: 'S1234567',
  amount: '250.00',
  currency: 'JMD',
  match,
};

describe('QuickBooks pre-flight', () => {
  it('accepts a payment that fits an outstanding invoice', async () => {
    const { adaptor } = await adaptorFor({
      customers: [customer],
      invoices: [{ Id: 'inv-1', Balance: 250, DueDate: '2026-01-01' }],
    });

    await expect(adaptor.preflightPayment!(input)).resolves.toEqual({ ok: true });
  });

  it('accepts a partial amount, and accepts an invoice with no CurrencyRef', async () => {
    const { adaptor } = await adaptorFor({
      customers: [customer],
      invoices: [{ Id: 'inv-1', Balance: 250 }],
    });

    await expect(adaptor.preflightPayment!({ ...input, amount: '50.00' })).resolves.toEqual({
      ok: true,
    });
  });

  it('rejects when no customer matches', async () => {
    const { adaptor } = await adaptorFor({ customers: [], invoices: [] });
    await expect(adaptor.preflightPayment!(input)).resolves.toEqual({
      ok: false,
      reason: 'customer-not-found',
    });
  });

  it('rejects when several customers match', async () => {
    const { adaptor } = await adaptorFor({
      customers: [customer, { ...customer, Id: 'cust-2' }],
      invoices: [],
    });
    await expect(adaptor.preflightPayment!(input)).resolves.toEqual({
      ok: false,
      reason: 'customer-ambiguous',
    });
  });

  it('rejects when the customer has no outstanding invoice', async () => {
    const { adaptor } = await adaptorFor({ customers: [customer], invoices: [] });
    await expect(adaptor.preflightPayment!(input)).resolves.toEqual({
      ok: false,
      reason: 'invoice-not-found',
    });
  });

  it('rejects a non-positive amount rather than treating it as free', async () => {
    const { adaptor } = await adaptorFor({
      customers: [customer],
      invoices: [{ Id: 'inv-1', Balance: 250 }],
    });
    await expect(adaptor.preflightPayment!({ ...input, amount: '0' })).resolves.toEqual({
      ok: false,
      reason: 'amount-invalid',
    });
  });

  it('rejects an amount strictly greater than the invoice balance', async () => {
    const { adaptor } = await adaptorFor({
      customers: [customer],
      invoices: [{ Id: 'inv-1', Balance: 249.99 }],
    });
    await expect(adaptor.preflightPayment!(input)).resolves.toEqual({
      ok: false,
      reason: 'amount-exceeds-balance',
    });
  });

  it('does not reject an amount equal to the balance', async () => {
    const { adaptor } = await adaptorFor({
      customers: [customer],
      invoices: [{ Id: 'inv-1', Balance: 250 }],
    });
    await expect(adaptor.preflightPayment!(input)).resolves.toEqual({ ok: true });
  });

  it('uses the TOTAL of all open invoices as the ceiling', async () => {
    /*
      A payment may span invoices — the push allocates it across them oldest
      first — so the pre-flight must not refuse an amount that only fits the
      total. Before this, the ceiling was one invoice's balance, and a customer
      with two open invoices could not pay the sum of them at all.
    */
    const { adaptor } = await adaptorFor({
      customers: [customer],
      invoices: [
        { Id: 'inv-1', TxnDate: '2026-01-01', Balance: 100 },
        { Id: 'inv-2', TxnDate: '2026-02-01', Balance: 150 },
      ],
    });
    await expect(adaptor.preflightPayment!(input)).resolves.toEqual({ ok: true });
  });

  it('rejects an amount above the total, even when it fits one invoice', async () => {
    const { adaptor } = await adaptorFor({
      customers: [customer],
      invoices: [
        { Id: 'inv-1', Balance: 100 },
        { Id: 'inv-2', Balance: 150 },
      ],
    });
    await expect(adaptor.preflightPayment!({ ...input, amount: '250.01' })).resolves.toEqual({
      ok: false,
      reason: 'amount-exceeds-balance',
    });
  });

  it('rejects a currency mismatch on ANY invoice the payment could span', async () => {
    /*
      Only checking the first invoice would let a multi-invoice payment touch a
      different currency later. Every present currency has to agree.
    */
    const { adaptor } = await adaptorFor({
      customers: [customer],
      invoices: [
        { Id: 'inv-1', TxnDate: '2026-01-01', Balance: 100, CurrencyRef: { value: 'JMD' } },
        { Id: 'inv-2', TxnDate: '2026-02-01', Balance: 150, CurrencyRef: { value: 'USD' } },
      ],
    });
    await expect(adaptor.preflightPayment!(input)).resolves.toEqual({
      ok: false,
      reason: 'currency-mismatch',
    });
  });

  it('rejects a currency that is present and different', async () => {
    const { adaptor } = await adaptorFor({
      customers: [customer],
      invoices: [{ Id: 'inv-1', Balance: 250, CurrencyRef: { value: 'USD' } }],
    });
    await expect(adaptor.preflightPayment!(input)).resolves.toEqual({
      ok: false,
      reason: 'currency-mismatch',
    });
  });

  it('accepts a currency that is present and equal', async () => {
    const { adaptor } = await adaptorFor({
      customers: [customer],
      invoices: [{ Id: 'inv-1', Balance: 250, CurrencyRef: { value: 'JMD' } }],
    });
    await expect(adaptor.preflightPayment!(input)).resolves.toEqual({ ok: true });
  });

  it('THROWS on an upstream fault rather than reporting a rejection', async () => {
    const { adaptor } = await adaptorFor({ fail: true });
    await expect(adaptor.preflightPayment!(input)).rejects.toBeInstanceOf(AdaptorConnectionError);
  });
});
