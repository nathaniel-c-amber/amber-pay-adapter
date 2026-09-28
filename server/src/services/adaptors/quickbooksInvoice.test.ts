import {
  createPaymentForInvoice,
  findOpenInvoices,
  findPaymentByReference,
  isMeaningfulRemainder,
  selectInvoiceToPay,
  unappliedRemainder,
  verifyInvoiceCleared,
} from './quickbooksInvoice.js';
import { AdaptorApplyError } from './errors.js';
import type { AdaptorResponse, CustomerMatchConfig } from '../../types/adaptor.js';
import type { QboInvoice } from './quickbooksWire.js';

const match: CustomerMatchConfig = {
  strategy: 'displayName',
  mode: 'exact',
  fieldName: null,
  depositAccountId: null,
};

function responder(body: unknown, status = 200) {
  const seen: { url: string; body: unknown }[] = [];
  const request = async (url: string, requestBody?: unknown): Promise<AdaptorResponse> => {
    seen.push({ url: decodeURIComponent(url), body: requestBody });
    return { status, body };
  };
  return { request, seen };
}

const invoice = (over: Partial<QboInvoice> = {}): QboInvoice => ({
  Id: 'inv-1',
  DocNumber: '1042',
  DueDate: '2026-01-31',
  TxnDate: '2026-01-01',
  Balance: 250,
  ...over,
});

describe('the invoice check', () => {
  it('asks for this customer, and only what is still owed', async () => {
    const { request, seen } = responder({ QueryResponse: { Invoice: [invoice()] } });
    const found = await findOpenInvoices(request, 'cust-1');

    expect(seen[0]?.url).toContain('from Invoice where CustomerRef =');
    expect(seen[0]?.url).toContain("'cust-1'");
    expect(seen[0]?.url).toContain('Balance > 0');
    expect(found.invoices).toHaveLength(1);
  });

  it('refuses when the customer has nothing outstanding', () => {
    expect(() => selectInvoiceToPay([])).toThrow(
      expect.objectContaining({ reason: 'invoice-not-found' }),
    );
  });

  it('pays the oldest due date, not the first row returned', () => {
    /*
      Order from an upstream is not a business rule. A customer with two open
      invoices is ordinary, and refusing would mean the pipeline silently does
      nothing for exactly the people it exists for — so the rule is written
      down and applied every time instead of being left to the row order.
    */
    const chosen = selectInvoiceToPay([
      invoice({ Id: 'inv-newer', DueDate: '2026-06-01' }),
      invoice({ Id: 'inv-older', DueDate: '2026-01-31' }),
    ]);
    expect(chosen.Id).toBe('inv-older');
  });

  it('breaks a due-date tie on the transaction date, then on the id', () => {
    expect(
      selectInvoiceToPay([
        invoice({ Id: 'b', DueDate: '2026-01-31', TxnDate: '2026-01-10' }),
        invoice({ Id: 'a', DueDate: '2026-01-31', TxnDate: '2026-01-10' }),
      ]).Id,
    ).toBe('a');
    expect(
      selectInvoiceToPay([
        invoice({ Id: 'a', DueDate: '2026-01-31', TxnDate: '2026-02-01' }),
        invoice({ Id: 'z', DueDate: '2026-01-31', TxnDate: '2026-01-05' }),
      ]).Id,
    ).toBe('z');
  });

  it('sorts an undated invoice last — it is not "oldest"', () => {
    expect(
      selectInvoiceToPay([
        invoice({ Id: 'undated' }),
        invoice({ Id: 'dated', DueDate: '2026-01-31' }),
      ]).Id,
    ).toBe('dated');
  });

  it('chooses the same invoice however the rows arrive', () => {
    const rows = [
      invoice({ Id: 'x', DueDate: '2026-03-01' }),
      invoice({ Id: 'y', DueDate: '2026-02-01' }),
    ];
    expect(selectInvoiceToPay(rows).Id).toBe(selectInvoiceToPay([...rows].reverse()).Id);
  });
});

describe('the idempotency probe', () => {
  it('looks the payment up by the reference it wrote', async () => {
    const { request, seen } = responder({ QueryResponse: { Payment: [] } });
    const seenAlready = await findPaymentByReference(request, 'p1');

    expect(seen[0]?.url).toContain('from Payment where PaymentRefNum =');
    expect(seen[0]?.url).toContain("'p1'");
    expect(seenAlready.found).toBe(false);
  });

  it('reports a hit', async () => {
    const { request } = responder({ QueryResponse: { Payment: [{ Id: 'pay-1' }] } });
    expect((await findPaymentByReference(request, 'p1')).found).toBe(true);
  });
});

describe('applying the payment', () => {
  it('sends the invoice balance and links the line to the invoice', async () => {
    const { request, seen } = responder({ Payment: { Id: 'pay-1' } });
    const created = await createPaymentForInvoice(request, invoice(), {
      customerId: 'cust-1',
      reference: 'p1',
      match,
    });

    expect(seen[0]?.url).toBe('/payment');
    expect(seen[0]?.body).toEqual({
      TotalAmt: 250,
      CustomerRef: { value: 'cust-1' },
      Line: [{ Amount: 250, LinkedTxn: [{ TxnId: 'inv-1', TxnType: 'Invoice' }] }],
      PaymentRefNum: 'p1',
    });
    expect(created.Id).toBe('pay-1');
  });

  it('names the deposit account only when one is configured', async () => {
    const { request, seen } = responder({ Payment: { Id: 'pay-1' } });
    await createPaymentForInvoice(request, invoice(), {
      customerId: 'cust-1',
      reference: 'p1',
      match: { ...match, depositAccountId: '35' },
    });

    expect(seen[0]?.body).toMatchObject({ DepositToAccountRef: { value: '35' } });
  });

  it('omits the deposit account by default, so the money lands in undeposited funds', async () => {
    const { request, seen } = responder({ Payment: { Id: 'pay-1' } });
    await createPaymentForInvoice(request, invoice(), {
      customerId: 'cust-1',
      reference: 'p1',
      match,
    });

    expect(seen[0]?.body).not.toHaveProperty('DepositToAccountRef');
  });

  it('fails when the upstream accepts the write but names no payment', async () => {
    /*
      A 2xx with nothing in it is not a payment. Reporting success there would
      leave the console saying "posted" about a transaction that has no id, and
      the idempotency probe would never find it on a retry.
    */
    const { request } = responder({});
    await expect(
      createPaymentForInvoice(request, invoice(), {
        customerId: 'cust-1',
        reference: 'p1',
        match,
      }),
    ).rejects.toBeInstanceOf(AdaptorApplyError);
  });

  it('surfaces a rejected write rather than treating it as done', async () => {
    const { request } = responder({}, 400);
    await expect(
      createPaymentForInvoice(request, invoice(), {
        customerId: 'cust-1',
        reference: 'p1',
        match,
      }),
    ).rejects.toMatchObject({ code: 'ADAPTOR_ERROR' });
  });
});

describe('confirming the invoice cleared', () => {
  it('is confirmed by a re-read, not by the write succeeding', async () => {
    const cleared = responder({ Invoice: { Id: 'inv-1', Balance: 0 } });
    await expect(verifyInvoiceCleared(cleared.request, 'inv-1')).resolves.toEqual({
      verified: true,
      calls: 1,
    });
    expect(cleared.seen[0]?.url).toBe('/invoice/inv-1');
  });

  it('is not confirmed when the balance is still there', async () => {
    const still = responder({ Invoice: { Id: 'inv-1', Balance: 250 } });
    await expect(verifyInvoiceCleared(still.request, 'inv-1')).resolves.toEqual({
      verified: false,
      calls: 1,
    });
  });

  it('is not confirmed when the upstream returns nothing to check', async () => {
    const blank = responder({});
    await expect(verifyInvoiceCleared(blank.request, 'inv-1')).rejects.toMatchObject({
      reason: 'invoice-not-cleared',
    });
  });
});

describe('an unapplied remainder', () => {
  it('is reported when it is large enough to be a real disagreement', () => {
    expect(unappliedRemainder({ Id: 'pay-1', UnappliedAmt: 12.5 })).toBe(12.5);
  });

  it('is ignored when it is rounding rather than money', () => {
    expect(unappliedRemainder({ Id: 'pay-1', UnappliedAmt: 0.0000001 })).toBe(0);
    expect(unappliedRemainder({ Id: 'pay-1' })).toBe(0);
  });

  it('treats a cent as meaningful — it is the smallest thing an accountant cares about', () => {
    expect(isMeaningfulRemainder(0.01)).toBe(true);
    expect(isMeaningfulRemainder(0.001)).toBe(false);
  });
});
