import { createHmac } from 'node:crypto';
import { AmberPayGatewayImpl } from './amberpay.service.js';
import { ValidationError } from '../../utils/errors.js';

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

describe('AmberPayGatewayImpl', () => {
  it('verifyWebhookSignature returns true for a valid signature', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.verifyWebhookSignature(rawBody, sign(rawBody))).toBe(true);
  });

  it('verifyWebhookSignature returns false for an invalid signature', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.verifyWebhookSignature(rawBody, 'invalid')).toBe(false);
  });

  it('verifyWebhookSignature accepts a Buffer raw body', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.verifyWebhookSignature(Buffer.from(rawBody), sign(rawBody))).toBe(true);
  });

  it('parseWebhook returns a typed WebhookEvent for a valid payload', () => {
    const gateway = new AmberPayGatewayImpl();
    const event = gateway.parseWebhook(payload);
    expect(event).toEqual(payload);
  });

  it('parseWebhook throws ValidationError for an invalid payload', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(() => gateway.parseWebhook({ id: 'w1' })).toThrow(ValidationError);
  });

  it('parseWebhook rejects a sensitive reference', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(() =>
      gateway.parseWebhook({ ...payload, reference: 'customer@example.com' }),
    ).toThrow(ValidationError);
  });

  it('createPaymentLink returns a PaymentLinkResult shape', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const gateway = new AmberPayGatewayImpl(transport);
    const result = await gateway.createPaymentLink({
      invoiceId: 'inv-1',
      externalInvoiceId: 'ext-1',
      reference: 'ref-0001',
      status: 'initiated',
    });
    expect(typeof result.linkUrl).toBe('string');
    expect(typeof result.reference).toBe('string');
    expect(typeof result.expiresAt).toBe('string');
  });
});
