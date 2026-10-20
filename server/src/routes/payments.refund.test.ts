import express from 'express';
import request from 'supertest';
import { createPaymentRouter } from './payments.js';
import { errorHandler, notFoundHandler } from '../middleware/errorHandler.js';
import { createInMemoryRepositories } from '../repositories/inMemory.js';
import { issueAccessToken } from '../utils/tokens.js';
import { forbiddenKeysIn } from '../test/privacy.js';
import { ConflictError } from '../utils/errors.js';
import { RefundService } from '../services/payments/refund.service.js';
import type { Repositories } from '../types/repository.js';
import type { PolicyAttribute } from '../types/auth.js';
import type { Payment } from '../models/domain.js';

const PAYMENT: Payment = {
  id: 'pay-1',
  invoiceId: 'inv-1',
  organizationId: 'org-1',
  transactionId: 'ABCDEFGH1234',
  status: 'collected',
  processedAt: '2026-01-01T00:00:00.000Z',
};

const writePolicy: PolicyAttribute[] = [
  { scope: 'payments', organizationId: 'org-1', actions: ['read', 'write'] },
];
const readPolicy: PolicyAttribute[] = [
  { scope: 'payments', organizationId: 'org-1', actions: ['read'] },
];

function token(policy: PolicyAttribute[]): string {
  return issueAccessToken({ id: 'u1', email: 'user@example.com', policyAttributes: policy });
}

function appWith(repositories: Repositories, refund: RefundService): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createPaymentRouter({ payments: repositories.payments, refund }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function fakeRefund(result: unknown = {
  payment: { ...PAYMENT, status: 'refunded' },
  refund: { scope: 'full', accountingReversal: 'reversed' },
}) {
  return { refundPayment: jest.fn().mockResolvedValue(result) } as unknown as RefundService & {
    refundPayment: jest.Mock;
  };
}

describe('POST /payments/:id/refund', () => {
  it('requires a session', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(appWith(repositories, fakeRefund()))
      .post('/api/v1/payments/pay-1/refund')
      .send({ confirmation: PAYMENT.transactionId });
    expect(res.status).toBe(401);
  });

  it('requires WRITE, not merely read', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(appWith(repositories, fakeRefund()))
      .post('/api/v1/payments/pay-1/refund')
      .set('Authorization', `Bearer ${token(readPolicy)}`)
      .send({ confirmation: PAYMENT.transactionId });
    expect(res.status).toBe(403);
  });

  it('refuses a caller whose policy names another organization', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(appWith(repositories, fakeRefund()))
      .post('/api/v1/payments/pay-1/refund')
      .set(
        'Authorization',
        `Bearer ${token([{ scope: 'payments', organizationId: 'org-2', actions: ['write'] }])}`,
      )
      .send({ confirmation: PAYMENT.transactionId });
    expect(res.status).toBe(403);
  });

  it('answers 404 for a payment in another organization (C1)', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.payments.create({ ...PAYMENT, organizationId: 'org-2' });

    const service = new RefundService({
      payments: repositories.payments,
      gateway: jest.fn(),
      resolveAdaptorId: async () => null,
    });
    const res = await request(appWith(repositories, service))
      .post('/api/v1/payments/pay-1/refund')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send({ confirmation: PAYMENT.transactionId });

    expect(res.status).toBe(404);
  });

  it('returns the refunded payment and the reversal outcome, with no figure', async () => {
    const repositories = createInMemoryRepositories();
    const refund = fakeRefund({
      payment: { ...PAYMENT, status: 'refunded' },
      refund: {
        scope: 'full',
        accountingReversal: 'reversed',
      },
    });
    const res = await request(appWith(repositories, refund))
      .post('/api/v1/payments/pay-1/refund')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send({ confirmation: PAYMENT.transactionId });

    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('refunded');
    expect(res.body.refund).toEqual({ scope: 'full', accountingReversal: 'reversed' });
    expect(JSON.stringify(res.body)).not.toContain('250');
    expect(forbiddenKeysIn(res.body)).toEqual([]);
    expect(refund.refundPayment).toHaveBeenCalledWith(
      'pay-1',
      { confirmation: PAYMENT.transactionId },
      ['org-1'],
    );
  });

  it('passes a partial amount through', async () => {
    const repositories = createInMemoryRepositories();
    const refund = fakeRefund();
    const res = await request(appWith(repositories, refund))
      .post('/api/v1/payments/pay-1/refund')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send({ confirmation: PAYMENT.transactionId, amount: '100.00' });

    expect(res.status).toBe(200);
    expect(refund.refundPayment).toHaveBeenCalledWith(
      'pay-1',
      { confirmation: PAYMENT.transactionId, amount: '100.00' },
      ['org-1'],
    );
  });

  it('rejects a missing confirmation and a malformed amount', async () => {
    const repositories = createInMemoryRepositories();
    const app = appWith(repositories, fakeRefund());

    const missing = await request(app)
      .post('/api/v1/payments/pay-1/refund')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send({});
    expect(missing.status).toBe(400);

    const malformed = await request(app)
      .post('/api/v1/payments/pay-1/refund')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send({ confirmation: PAYMENT.transactionId, amount: '1.234' });
    expect(malformed.status).toBe(400);
  });

  it('surfaces a conflict as 409', async () => {
    const repositories = createInMemoryRepositories();
    const refund = {
      refundPayment: jest.fn().mockRejectedValue(new ConflictError('already refunded')),
    } as unknown as RefundService;
    const res = await request(appWith(repositories, refund))
      .post('/api/v1/payments/pay-1/refund')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send({ confirmation: PAYMENT.transactionId });
    expect(res.status).toBe(409);
  });
});
