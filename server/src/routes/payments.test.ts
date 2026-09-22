import request from 'supertest';
import { createApp } from '../app.js';
import { createInMemoryRepositories } from '../repositories/inMemory.js';
import { issueAccessToken } from '../utils/tokens.js';
import { forbiddenKeysIn } from '../test/privacy.js';
import type { Repositories } from '../types/repository.js';
import type { AmberPayGateway, PaymentLinkResult } from '../types/gateway.js';
import type { PolicyAttribute } from '../types/auth.js';

function stubGateway(): AmberPayGateway {
  return {
    async createPaymentLink(): Promise<PaymentLinkResult> {
      return {
        linkUrl: 'https://amberpay.example.com/pay/ref-0001',
        reference: 'ref-0001',
        expiresAt: '2026-01-02T00:00:00.000Z',
      };
    },
    verifyWebhookSignature: () => false,
    parseWebhook: () => {
      throw new Error('not used');
    },
  };
}

function token(policy: PolicyAttribute[]): string {
  return issueAccessToken({ id: 'u1', email: 'user@example.com', policyAttributes: policy });
}

function buildApp(repositories: Repositories) {
  return createApp({ repositories, gateway: stubGateway() });
}

const writePolicy: PolicyAttribute[] = [
  { scope: 'payments', organizationId: 'org-1', actions: ['read', 'write'] },
];

describe('payments routes', () => {
  it('rejects POST /payments without a token (401)', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories))
      .post('/api/v1/payments')
      .send({ invoiceId: 'inv-1', externalInvoiceId: 'ext-1', reference: 'ref-0001', organizationId: 'org-1' });
    expect(res.status).toBe(401);
  });

  it('rejects POST /payments when PBAC denies the organization (403)', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories))
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token([{ scope: 'payments', organizationId: 'org-9', actions: ['write'] }])}`)
      .send({ invoiceId: 'inv-1', externalInvoiceId: 'ext-1', reference: 'ref-0001', organizationId: 'org-1' });
    expect(res.status).toBe(403);
  });

  it('creates a payment link and persists an operational payment (201)', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories))
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send({ invoiceId: 'inv-1', externalInvoiceId: 'ext-1', reference: 'ref-0001', organizationId: 'org-1' });

    expect(res.status).toBe(201);
    expect(typeof res.body.payment.id).toBe('string');
    expect(res.body.payment.status).toBe('initiated');
    expect(res.body.payment.transactionId).toBe('ref-0001');
    expect(typeof res.body.link.linkUrl).toBe('string');
    expect(forbiddenKeysIn(res.body)).toEqual([]);
  });

  it('accepts a non-uuid string invoiceId and round-trips it (201)', async () => {
    const repositories = createInMemoryRepositories();
    const app = buildApp(repositories);
    const auth = `Bearer ${token(writePolicy)}`;

    const created = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', auth)
      .send({ invoiceId: 'inv-abc-123', externalInvoiceId: 'ext-1', reference: 'ref-0001', organizationId: 'org-1' });

    expect(created.status).toBe(201);
    expect(created.body.payment.invoiceId).toBe('inv-abc-123');

    // Round-trip: the stored payment is retrievable with the same string id.
    const found = await request(app)
      .get(`/api/v1/payments/${created.body.payment.id}`)
      .query({ organizationId: 'org-1' })
      .set('Authorization', auth);
    expect(found.status).toBe(200);
    expect(found.body.payment.invoiceId).toBe('inv-abc-123');
  });

  it('returns an operational payment by id (200) and 404 for unknown', async () => {
    const repositories = createInMemoryRepositories();
    const payment = await repositories.payments.create({
      id: 'pay-1',
      invoiceId: 'inv-1',
      organizationId: 'org-1',
      transactionId: 'ref-0001',
      status: 'collected',
      processedAt: '2026-01-01T00:00:00.000Z',
    });
    const app = buildApp(repositories);
    const auth = `Bearer ${token(writePolicy)}`;

    const found = await request(app)
      .get(`/api/v1/payments/${payment.id}`)
      .query({ organizationId: 'org-1' })
      .set('Authorization', auth);
    expect(found.status).toBe(200);
    expect(found.body.payment.status).toBe('collected');
    expect(forbiddenKeysIn(found.body)).toEqual([]);

    const missing = await request(app)
      .get('/api/v1/payments/does-not-exist')
      .query({ organizationId: 'org-1' })
      .set('Authorization', auth);
    expect(missing.status).toBe(404);
  });

  it('returns 404 for a payment belonging to another org (C1)', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.payments.create({
      id: 'pay-org2',
      invoiceId: 'inv-2',
      organizationId: 'org-2',
      transactionId: 'ref-0002',
      status: 'collected',
      processedAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await request(buildApp(repositories))
      .get('/api/v1/payments/pay-org2')
      .query({ organizationId: 'org-1' })
      .set('Authorization', `Bearer ${token(writePolicy)}`);

    expect(res.status).toBe(404);
  });
});
