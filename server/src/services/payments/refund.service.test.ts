import { RefundService } from './refund.service.js';
import {
  InMemoryPaymentRepository,
} from '../../repositories/inMemory.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { sealExpectedCharge } from '../gateway/amberPayWire.js';
import type { AccountingAdaptor } from '../../types/adaptor.js';
import type { Payment } from '../../models/domain.js';
import type { RefundChargeStore } from './refund.service.js';

const PAYMENT: Payment = {
  id: 'pay-1',
  invoiceId: 'inv-1',
  organizationId: 'org-1',
  transactionId: 'ABCDEFGH1234',
  status: 'collected',
  processedAt: '2026-01-01T00:00:00.000Z',
};

function harness(options: {
  payment?: Payment;
  charge?: RefundChargeStore;
  reversal?: 'reversed' | 'manual-adjustment-required' | 'throws' | 'absent';
  adaptorId?: string | null;
  gatewayRejects?: boolean;
} = {}) {
  const payments = new InMemoryPaymentRepository();
  const payment = options.payment ?? PAYMENT;
  void payments.create(payment);

  const recordEvent = jest.fn(async (input: object) => ({
    ...input,
    id: 'e1',
    at: '2026-01-01T00:00:00.000Z',
  }));
  const recordFailure = jest.fn(async (input: object) => ({
    ...input,
    id: 'f1',
    since: '2026-01-01T00:00:00.000Z',
  }));
  const gateway = options.gatewayRejects
    ? jest.fn().mockRejectedValue(new Error('gateway said no'))
    : jest.fn().mockResolvedValue(undefined);

  const reverseCompletedPayment = jest.fn();
  if (options.reversal === 'throws') {
    reverseCompletedPayment.mockRejectedValue(new Error('upstream refused'));
  } else if (options.reversal !== 'absent') {
    reverseCompletedPayment.mockResolvedValue({
      status: options.reversal ?? 'reversed',
    });
  }
  const adaptor = {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    status: async () => 'connected',
    ...(options.reversal === 'absent' ? {} : { reverseCompletedPayment }),
  } as unknown as AccountingAdaptor;

  const charge: RefundChargeStore =
    options.charge === undefined
      ? {
          findExpectedChargeByTransactionId: jest.fn(async () => ({
            expectedSealed: sealExpectedCharge('250.00', 'JMD'),
          })),
        }
      : options.charge;

  const service = new RefundService({
    payments,
    intents: charge,
    gateway,
    events: { recordEvent } as never,
    failures: { recordFailure } as never,
    resolveAdaptorId: async () =>
      (options.adaptorId === undefined ? 'quickbooks' : options.adaptorId) as never,
    adaptors: { get: () => adaptor },
    connect: async () => undefined,
  });

  return { service, payments, payment, gateway, recordEvent, recordFailure, reverseCompletedPayment };
}

const confirmation = PAYMENT.transactionId;

describe('RefundService', () => {
  it('refunds the full original amount by default and reverses the books', async () => {
    const { service, gateway, recordEvent, reverseCompletedPayment } = harness();

    const result = await service.refundPayment(PAYMENT.id, { confirmation }, ['org-1']);

    expect(gateway).toHaveBeenCalledWith({
      transactionId: PAYMENT.transactionId,
      originalAmount: '250.00',
      currency: 'JMD',
      refundAmount: '250.00',
    });
    expect(result.payment.status).toBe('refunded');
    expect(result.refund).toEqual({ scope: 'full', accountingReversal: 'reversed' });
    expect(reverseCompletedPayment).toHaveBeenCalledWith({
      transactionId: PAYMENT.transactionId,
      originalAmount: '250.00',
      refundAmount: '250.00',
    });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent.mock.calls[0]?.[0]).toMatchObject({
      type: 'payment-refunded',
      channel: 'payment',
      ref: PAYMENT.transactionId,
    });
  });

  it('keeps a figure out of the response and the lifecycle event', async () => {
    const { service, recordEvent } = harness();
    const result = await service.refundPayment(PAYMENT.id, { confirmation }, ['org-1']);

    expect(JSON.stringify(result)).not.toContain('250');
    expect(JSON.stringify(recordEvent.mock.calls[0]?.[0])).not.toContain('250');
  });

  it('supports a partial refund, and records a manual-adjustment finding', async () => {
    const { service, gateway, reverseCompletedPayment, recordFailure } = harness({
      reversal: 'manual-adjustment-required',
    });

    const result = await service.refundPayment(
      PAYMENT.id,
      { confirmation, amount: '100.00' },
      ['org-1'],
    );

    expect(gateway).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmount: '100.00' }),
    );
    expect(result.refund.scope).toBe('partial');
    expect(result.refund.accountingReversal).toBe('manual-adjustment-required');
    expect(result.refund.message).toMatch(/adjusted by hand/i);
    expect(reverseCompletedPayment).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmount: '100.00' }),
    );
    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        channel: 'accounting',
        title: expect.stringMatching(/manual accounting adjustment/i),
      }),
    );
  });

  it('refuses a payment it cannot see in the caller organization', async () => {
    const { service, gateway } = harness();
    await expect(
      service.refundPayment(PAYMENT.id, { confirmation }, ['org-other']),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('refuses a payment that has already been refunded', async () => {
    const { service, gateway } = harness({
      payment: { ...PAYMENT, status: 'refunded' },
    });
    await expect(
      service.refundPayment(PAYMENT.id, { confirmation }, ['org-1']),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('refuses a payment that was never collected', async () => {
    const { service, gateway } = harness({
      payment: { ...PAYMENT, status: 'initiated' },
    });
    await expect(
      service.refundPayment(PAYMENT.id, { confirmation }, ['org-1']),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('refuses a confirmation that is not the transaction id', async () => {
    const { service, gateway } = harness();
    await expect(
      service.refundPayment(PAYMENT.id, { confirmation: 'not-the-id' }, ['org-1']),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('refuses an amount larger than the original charge', async () => {
    const { service, gateway } = harness();
    await expect(
      service.refundPayment(PAYMENT.id, { confirmation, amount: '250.01' }, ['org-1']),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each(['0', '12.345', 'not-a-number'])(
    'refuses an unusable refund amount (%s)',
    async (amount) => {
      const { service, gateway } = harness();
      await expect(
        service.refundPayment(PAYMENT.id, { confirmation, amount }, ['org-1']),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it('changes NOTHING when the gateway refuses the refund', async () => {
    const { service, payments, gateway, recordEvent, reverseCompletedPayment } = harness({
      gatewayRejects: true,
    });

    await expect(
      service.refundPayment(PAYMENT.id, { confirmation }, ['org-1']),
    ).rejects.toThrow('gateway said no');

    expect(gateway).toHaveBeenCalledTimes(1);
    expect((await payments.findById(PAYMENT.id, null))?.status).toBe('collected');
    expect(recordEvent).not.toHaveBeenCalled();
    expect(reverseCompletedPayment).not.toHaveBeenCalled();
  });

  it('still marks the payment refunded when the accounting reversal throws, and reports it', async () => {
    const { service, payments, recordEvent, recordFailure } = harness({ reversal: 'throws' });

    const result = await service.refundPayment(PAYMENT.id, { confirmation }, ['org-1']);

    expect(result.payment.status).toBe('refunded');
    expect((await payments.findById(PAYMENT.id, null))?.status).toBe('refunded');
    expect(result.refund.accountingReversal).toBe('failed');
    expect(result.refund.message).toMatch(/MONEY REFUNDED/i);
    expect(result.refund.message).toMatch(/still shows this payment/i);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        channel: 'accounting',
        detail: expect.stringMatching(/MONEY REFUNDED/i),
      }),
    );
  });

  it('reports not-configured when no accounting system is selected', async () => {
    const { service, reverseCompletedPayment } = harness({ adaptorId: null });
    const result = await service.refundPayment(PAYMENT.id, { confirmation }, ['org-1']);

    expect(result.refund.accountingReversal).toBe('not-configured');
    expect(reverseCompletedPayment).not.toHaveBeenCalled();
  });

  it('reports not-configured when the adaptor cannot reverse', async () => {
    const { service } = harness({ reversal: 'absent' });
    const result = await service.refundPayment(PAYMENT.id, { confirmation }, ['org-1']);
    expect(result.refund.accountingReversal).toBe('not-configured');
  });

  it('refuses when the original charge is not recorded', async () => {
    const { service, gateway } = harness({
      charge: { findExpectedChargeByTransactionId: async () => undefined },
    });

    await expect(
      service.refundPayment(PAYMENT.id, { confirmation }, ['org-1']),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(gateway).not.toHaveBeenCalled();
  });
});
