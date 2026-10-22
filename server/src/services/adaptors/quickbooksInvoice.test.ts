import {
  allocatePayment,
  createPaymentForInvoices,
  findOpenInvoices,
  findPaymentByReference,
  isMeaningfulRemainder,
  unappliedRemainder,
  verifyInvoicesApplied,
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

/** Answers each invoice read by id, so a multi-invoice verification is testable. */
function invoiceResponder(balances: Record<string, number>) {
  const seen: string[] = [];
  const request = async (url: string): Promise<AdaptorResponse> => {
    const decoded = decodeURIComponent(url);
    seen.push(decoded);
    const id = decoded.split('/invoice/')[1] ?? '';
    return { status: 200, body: { Invoice: { Id: id, Balance: balances[id] ?? 0 } } };
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
  /*
    ★ THE BALANCE PREDICATE IS NOT SENT, because the provider refuses it.
    This test used to assert `Balance > 0` appeared in the statement. It does
    not, and must not: a live QuickBooks company answers that query with HTTP 400
    "Error parsing query" (verified 2026-09-28, realm 9341457936805547), and
    `Invoice.Balance` is documented READ ONLY — unlike `Customer.Balance`, which
    IS filterable, and which is what makes the two look alike in a reference.

    Sending it would have failed every payment at this step, and every test would
    have stayed green, because they all run against a fake that answers whatever
    it is asked. So the assertion is on the ABSENCE of the predicate, which is
    the only thing that could have caught it.
  */
  it('asks for this customer, and filters what is still owed itself', async () => {
    const { request, seen } = responder({ QueryResponse: { Invoice: [invoice()] } });
    const found = await findOpenInvoices(request, 'cust-1');

    expect(seen[0]?.url).toContain('from Invoice where CustomerRef =');
    expect(seen[0]?.url).toContain("'cust-1'");
    expect(seen[0]?.url).not.toContain('Balance');
    expect(found.invoices).toHaveLength(1);
  });

  it('drops invoices the customer already settled, without asking upstream to', async () => {
    const { request, seen } = responder({
      QueryResponse: {
        Invoice: [
          { ...invoice(), Id: 'inv-paid', Balance: 0 },
          { ...invoice(), Id: 'inv-void', Balance: 0 },
          { ...invoice(), Id: 'inv-open', Balance: 42 },
        ],
      },
    });
    const found = await findOpenInvoices(request, 'cust-1');

    // The upstream was never asked to do this, because it cannot.
    expect(seen[0]?.url).not.toContain('Balance');
    expect(found.invoices.map((i) => i.Id)).toEqual(['inv-open']);
  });

  it('does not treat an invoice with no balance as settled', async () => {
    const { request } = responder({
      QueryResponse: { Invoice: [{ Id: 'inv-unknown' }] },
    });
    const found = await findOpenInvoices(request, 'cust-1');

    /*
      Dropping it would be the dangerous direction: "no balance" is not "nothing
      owed", and reading it as settled would report a payment as placed against
      an invoice whose state we simply do not know.
    */
    expect(found.invoices).toHaveLength(0);
  });
});

describe('allocating the charged amount', () => {
  it('refuses when the customer has nothing outstanding', () => {
    expect(() => allocatePayment([], 25000)).toThrow(
      expect.objectContaining({ reason: 'invoice-not-found' }),
    );
  });

  it('pays one invoice in full when the charge matches its balance', () => {
    expect(allocatePayment([invoice()], 25000)).toEqual([
      { invoice: invoice(), amount: 250 },
    ]);
  });

  it('leaves a partial invoice when the charge is smaller than the balance', () => {
    const [allocation] = allocatePayment([invoice({ Balance: 250 })], 10000);
    expect(allocation?.amount).toBe(100);
  });

  it('spans two invoices, oldest first, taking only what each still owes', () => {
    const allocations = allocatePayment(
      [
        invoice({ Id: 'inv-newer', TxnDate: '2026-02-01', Balance: 250 }),
        invoice({ Id: 'inv-older', TxnDate: '2026-01-01', Balance: 100 }),
      ],
      30000,
    );

    expect(allocations.map((a) => [a.invoice.Id, a.amount])).toEqual([
      ['inv-older', 100],
      ['inv-newer', 200],
    ]);
  });

  it('stops with a partial tail rather than overpaying the third invoice', () => {
    const allocations = allocatePayment(
      [
        invoice({ Id: 'a', TxnDate: '2026-01-01', Balance: 100 }),
        invoice({ Id: 'b', TxnDate: '2026-01-02', Balance: 100 }),
        invoice({ Id: 'c', TxnDate: '2026-01-03', Balance: 100 }),
      ],
      25000,
    );

    expect(allocations.map((a) => [a.invoice.Id, a.amount])).toEqual([
      ['a', 100],
      ['b', 100],
      ['c', 50],
    ]);
  });

  it('never allocates more than the amount charged', () => {
    const allocations = allocatePayment(
      [
        invoice({ Id: 'a', Balance: 100 }),
        invoice({ Id: 'b', TxnDate: '2026-02-01', Balance: 100 }),
      ],
      12000,
    );

    const total = allocations.reduce((sum, a) => sum + a.amount, 0);
    expect(total).toBe(120);
  });

  it('skips an invoice whose balance is missing or already zero', () => {
    const allocations = allocatePayment(
      [
        invoice({ Id: 'settled', Balance: 0, TxnDate: '2026-01-01' }),
        invoice({ Id: 'unknown', Balance: undefined as unknown as number, TxnDate: '2026-01-02' }),
        invoice({ Id: 'open', Balance: 100, TxnDate: '2026-01-03' }),
      ],
      10000,
    );

    expect(allocations.map((a) => a.invoice.Id)).toEqual(['open']);
  });

  /*
    ★ THE ORDER IS EARLIEST CREATED, NOT DUE DATE.

    A due date is when money is expected, not how old the debt is: an invoice
    created in January but due in December would otherwise be paid after one
    created in March and due in April. The rule is written down and applied
    every time rather than left to the row order an upstream happened to return.
  */
  it('orders by transaction date, ignoring the due date', () => {
    const allocations = allocatePayment(
      [
        invoice({ Id: 'due-soon', TxnDate: '2026-06-01', DueDate: '2026-01-01' }),
        invoice({ Id: 'created-first', TxnDate: '2026-02-01', DueDate: '2026-12-01' }),
      ],
      100000,
    );

    expect(allocations.map((a) => a.invoice.Id)).toEqual(['created-first', 'due-soon']);
  });

  it('breaks a transaction-date tie on the lowest id', () => {
    const allocations = allocatePayment(
      [
        invoice({ Id: 'b', TxnDate: '2026-01-10' }),
        invoice({ Id: 'a', TxnDate: '2026-01-10' }),
      ],
      100000,
    );

    expect(allocations.map((a) => a.invoice.Id)).toEqual(['a', 'b']);
  });

  it('sorts an undated invoice last — it is not "oldest"', () => {
    const allocations = allocatePayment(
      [
        invoice({ Id: 'undated', TxnDate: undefined }),
        invoice({ Id: 'dated', TxnDate: '2026-01-31' }),
      ],
      100000,
    );

    expect(allocations.map((a) => a.invoice.Id)).toEqual(['dated', 'undated']);
  });

  it('allocates the same way however the rows arrive', () => {
    const rows = [
      invoice({ Id: 'x', TxnDate: '2026-03-01', Balance: 100 }),
      invoice({ Id: 'y', TxnDate: '2026-02-01', Balance: 100 }),
      invoice({ Id: 'z', TxnDate: '2026-02-01', Balance: 100 }),
    ];
    const order = (list: QboInvoice[]) =>
      allocatePayment(list, 100000).map((a) => a.invoice.Id);

    expect(order(rows)).toEqual(['y', 'z', 'x']);
    expect(order([...rows].reverse())).toEqual(order(rows));
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
  it('sends one line per allocated invoice, totalling the amount charged', async () => {
    const { request, seen } = responder({ Payment: { Id: 'pay-1' } });
    const allocations = [
      { invoice: invoice({ Id: 'inv-1', Balance: 100 }), amount: 100 },
      { invoice: invoice({ Id: 'inv-2', Balance: 250 }), amount: 200 },
    ];
    const created = await createPaymentForInvoices(request, allocations, {
      customerId: 'cust-1',
      reference: 'p1',
      match,
    });

    expect(seen[0]?.url).toBe('/payment');
    expect(seen[0]?.body).toEqual({
      TotalAmt: 300,
      CustomerRef: { value: 'cust-1' },
      Line: [
        { Amount: 100, LinkedTxn: [{ TxnId: 'inv-1', TxnType: 'Invoice' }] },
        { Amount: 200, LinkedTxn: [{ TxnId: 'inv-2', TxnType: 'Invoice' }] },
      ],
      PaymentRefNum: 'p1',
    });
    expect(created.Id).toBe('pay-1');
  });

  it('adds two-decimal shares without float residue', async () => {
    const { request, seen } = responder({ Payment: { Id: 'pay-1' } });
    await createPaymentForInvoices(
      request,
      [
        { invoice: invoice({ Id: 'inv-1' }), amount: 0.1 },
        { invoice: invoice({ Id: 'inv-2' }), amount: 0.2 },
      ],
      { customerId: 'cust-1', reference: 'p1', match },
    );

    expect(seen[0]?.body).toMatchObject({ TotalAmt: 0.3 });
  });

  it('names the deposit account only when one is configured', async () => {
    const { request, seen } = responder({ Payment: { Id: 'pay-1' } });
    await createPaymentForInvoices(request, [{ invoice: invoice(), amount: 250 }], {
      customerId: 'cust-1',
      reference: 'p1',
      match: { ...match, depositAccountId: '35' },
    });

    expect(seen[0]?.body).toMatchObject({ DepositToAccountRef: { value: '35' } });
  });

  it('omits the deposit account by default, so the money lands in undeposited funds', async () => {
    const { request, seen } = responder({ Payment: { Id: 'pay-1' } });
    await createPaymentForInvoices(request, [{ invoice: invoice(), amount: 250 }], {
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
      createPaymentForInvoices(request, [{ invoice: invoice(), amount: 250 }], {
        customerId: 'cust-1',
        reference: 'p1',
        match,
      }),
    ).rejects.toBeInstanceOf(AdaptorApplyError);
  });

  it('surfaces a rejected write rather than treating it as done', async () => {
    const { request } = responder({}, 400);
    await expect(
      createPaymentForInvoices(request, [{ invoice: invoice(), amount: 250 }], {
        customerId: 'cust-1',
        reference: 'p1',
        match,
      }),
    ).rejects.toMatchObject({ code: 'ADAPTOR_ERROR' });
  });
});

describe('confirming the invoices applied', () => {
  it('is confirmed by a re-read of the balance the payment should leave', async () => {
    const cleared = invoiceResponder({ 'inv-1': 150 });
    await expect(
      verifyInvoicesApplied(cleared.request, [
        { invoice: invoice({ Balance: 250 }), amount: 100 },
      ]),
    ).resolves.toEqual({ verified: true, reconciliationRequired: false, calls: 1 });
    expect(cleared.seen[0]).toBe('/invoice/inv-1');
  });

  it('accepts a fully settled invoice', async () => {
    const settled = invoiceResponder({ 'inv-1': 0 });
    await expect(
      verifyInvoicesApplied(settled.request, [{ invoice: invoice(), amount: 250 }]),
    ).resolves.toEqual({ verified: true, reconciliationRequired: false, calls: 1 });
  });

  it('is not confirmed when the balance did not move', async () => {
    const still = invoiceResponder({ 'inv-1': 250 });
    await expect(
      verifyInvoicesApplied(still.request, [{ invoice: invoice(), amount: 250 }]),
    ).resolves.toEqual({ verified: false, reconciliationRequired: false, calls: 1 });
  });

  it('reports a concurrent payment BELOW the expected balance as reconciliation', async () => {
    /*
      Something else also paid: the invoice moved further than our share alone.
      The money is not lost, so this is not a verification failure — but the
      ledger and the payment disagree, and a person has to look.
    */
    const moved = invoiceResponder({ 'inv-1': 100 });
    await expect(
      verifyInvoicesApplied(moved.request, [{ invoice: invoice(), amount: 100 }]),
    ).resolves.toEqual({ verified: true, reconciliationRequired: true, calls: 1 });
  });

  it('checks every invoice the payment touched', async () => {
    const both = invoiceResponder({ 'inv-1': 0, 'inv-2': 50 });
    await expect(
      verifyInvoicesApplied(both.request, [
        { invoice: invoice({ Id: 'inv-1', Balance: 100 }), amount: 100 },
        { invoice: invoice({ Id: 'inv-2', Balance: 250 }), amount: 200 },
      ]),
    ).resolves.toEqual({ verified: true, reconciliationRequired: false, calls: 2 });
    expect(both.seen).toEqual(['/invoice/inv-1', '/invoice/inv-2']);
  });

  it('fails when one of several invoices did not move', async () => {
    const partial = invoiceResponder({ 'inv-1': 0, 'inv-2': 250 });
    await expect(
      verifyInvoicesApplied(partial.request, [
        { invoice: invoice({ Id: 'inv-1', Balance: 100 }), amount: 100 },
        { invoice: invoice({ Id: 'inv-2', Balance: 250 }), amount: 100 },
      ]),
    ).resolves.toMatchObject({ verified: false });
  });

  it('is not confirmed when the upstream returns nothing to check', async () => {
    const blank = responder({});
    await expect(
      verifyInvoicesApplied(blank.request, [{ invoice: invoice(), amount: 250 }]),
    ).rejects.toMatchObject({
      reason: 'invoice-not-cleared',
    });
  });

  it('refuses to compare an invoice whose read-time balance is missing', async () => {
    await expect(
      verifyInvoicesApplied(responder({}).request, [
        { invoice: invoice({ Balance: undefined as unknown as number }), amount: 250 },
      ]),
    ).rejects.toMatchObject({ reason: 'invoice-not-cleared' });
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
