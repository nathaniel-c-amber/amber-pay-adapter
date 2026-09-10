import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../app.js';

const SECRET = 'test-webhook-secret-placeholder';

const payload = {
  id: 'w1',
  type: 'payment.collected',
  reference: 'ref-0001',
  status: 'collected',
  at: '2026-01-01T00:00:00.000Z',
};

const rawBody = JSON.stringify(payload);

function sign(value: string): string {
  return createHmac('sha256', SECRET).update(value).digest('hex');
}

describe('webhooks route', () => {
  const app = createApp();

  it('returns 202 for a valid signature (raw body)', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/json')
      .set('x-amber-pay-signature', sign(rawBody))
      .send(rawBody);
    expect(res.status).toBe(202);
  });

  it('returns 401 for an invalid signature', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/json')
      .set('x-amber-pay-signature', 'invalid')
      .send(rawBody);
    expect(res.status).toBe(401);
  });
});
