import { createHmac } from 'node:crypto';
import { AmberPayGatewayImpl } from './amberpay.service.js';
import { ValidationError } from '../../utils/errors.js';

const SECRET = 'test-webhook-secret-placeholder';

/** Amber Pay's WIRE payload (the gateway's own field names and vocabulary). */
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

  it('parseWebhook maps a Success payload to a collected event', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.parseWebhook(payload)).toEqual({
      id: 'txn_000000000001',
      type: 'payment.collected',
      reference: 'ord_000000000001',
      status: 'collected',
      at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('parseWebhook maps the Failed and Refunded statuses to their own types', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.parseWebhook({ ...payload, PaymentStatus: 'Failed' })).toMatchObject({
      type: 'payment.failed',
      status: 'failed',
    });
    expect(gateway.parseWebhook({ ...payload, PaymentStatus: 'Refunded' })).toMatchObject({
      type: 'payment.refunded',
      status: 'refunded',
    });
  });

  it('parseWebhook returns exactly the five contract fields — no amount, no card, no PII', () => {
    const gateway = new AmberPayGatewayImpl();
    const event = gateway.parseWebhook({
      ...payload,
      Amount: '1250.00',
      CurrencyCode: 'USD',
      CustomerReference: 'cust_abc123',
      CardToken: 'tok_visa_4242',
    });
    expect(Object.keys(event).sort()).toEqual(['at', 'id', 'reference', 'status', 'type']);
    expect(JSON.stringify(event)).not.toMatch(/1250|USD|cust_abc123|tok_visa/i);
  });

  it('parseWebhook falls back to arrival time when the wire omits a timestamp', () => {
    const gateway = new AmberPayGatewayImpl();
    const { EventTimestamp: _omitted, ...withoutTimestamp } = payload;
    const event = gateway.parseWebhook(withoutTimestamp);
    expect(Number.isNaN(new Date(event.at).getTime())).toBe(false);
  });

  it('parseWebhook throws ValidationError for an invalid payload', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(() => gateway.parseWebhook({ TransactionId: 'txn_000000000001' })).toThrow(
      ValidationError,
    );
  });

  it('parseWebhook rejects a reference that is not an opaque id', () => {
    const gateway = new AmberPayGatewayImpl();
    // An email is the canonical failure: it must never reach the event log.
    expect(() =>
      gateway.parseWebhook({ ...payload, OrderId: 'customer@example.com' }),
    ).toThrow(ValidationError);
    expect(() => gateway.parseWebhook({ ...payload, OrderId: 'short' })).toThrow(ValidationError);
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
