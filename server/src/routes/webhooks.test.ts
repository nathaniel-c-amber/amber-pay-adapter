import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../app.js';

const SECRET = 'test-webhook-secret-placeholder';

/**
 * Amber Pay's WIRE payload — deliberately not the pipeline's normalised event.
 * The gateway's own field names and status vocabulary are the contract these
 * tests defend; asserting on the normalised shape here would let a mapping
 * regression pass unnoticed.
 */
const payload = {
  ClientId: 'client-0001',
  TransactionId: 'txn_000000000001',
  OrderId: 'ord_000000000001',
  PaymentStatus: 'Success',
  EventTimestamp: '2026-01-01T00:00:00.000Z',
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

  it('returns 401 when the signature header is absent', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/json')
      .send(rawBody);
    expect(res.status).toBe(401);
  });

  it('returns 401 when a signed payload carries a stale timestamp', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/json')
      .set('x-amber-pay-signature', sign(rawBody))
      .set('x-amber-pay-timestamp', String(Math.floor(Date.now() / 1000) - 3600))
      .send(rawBody);
    expect(res.status).toBe(401);
  });

  it('returns 400 for a signed body that is not valid JSON', async () => {
    const malformed = '{not json';
    const res = await request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/json')
      .set('x-amber-pay-signature', sign(malformed))
      .send(malformed);
    expect(res.status).toBe(400);
  });
});
