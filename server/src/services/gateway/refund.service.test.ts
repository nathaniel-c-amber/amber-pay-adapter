import {
  buildRefundRequest,
  requestGatewayRefund,
} from './refund.service.js';
import { AdaptorConnectionError } from '../adaptors/errors.js';
import type { GatewayTransport } from '../../types/gateway.js';

const input = {
  transactionId: 'ABCDEFGH1234',
  originalAmount: '250.00',
  currency: 'JMD' as const,
  refundAmount: '100.00',
};

function transportWith(refundStatus = 200): {
  transport: GatewayTransport;
  calls: { method: string; url: string; body: unknown; headers?: Record<string, string> }[];
} {
  const calls: { method: string; url: string; body: unknown; headers?: Record<string, string> }[] = [];
  const transport = (async (
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => {
    calls.push({ method, url, body, headers });
    if (url.includes('generatesignature')) {
      return { status: 200, body: { Success: 'Y', Signature: 'signed-value' } };
    }
    return { status: refundStatus, body: { anything: 'the response must not be read' } };
  }) as unknown as GatewayTransport;
  return { transport, calls };
}

describe('gateway refund', () => {
  it('signs the ORIGINAL amount and sends the documented refund fields', async () => {
    const { transport, calls } = transportWith();

    await requestGatewayRefund(transport, input);

    const [signatureCall, refundCall] = calls;
    expect(signatureCall?.url).toMatch(/generatesignature$/);
    expect(signatureCall?.body).toEqual({
      ClientId: 'test-amber-client-id',
      TransactionId: 'ABCDEFGH1234',
      CurrencyCode: 'JMD',
      Amount: '250.00',
      SignType: 1,
    });

    expect(refundCall?.url).toMatch(/\/gateway\/v1\/refund$/);
    expect(refundCall?.body).toEqual({
      ClientId: 'test-amber-client-id',
      TransactionId: 'ABCDEFGH1234',
      CurrencyCode: 'JMD',
      Amount: '250.00',
      Signature: 'signed-value',
      'Refund Amount': '100.00',
    });
    expect(refundCall?.headers?.Authorization).toBe('Bearer test-amber-api-token');
  });

  it('keeps the literal "Refund Amount" key, including the space', () => {
    const body = buildRefundRequest(input, 'sig');
    expect(Object.keys(body)).toEqual([
      'ClientId',
      'TransactionId',
      'CurrencyCode',
      'Amount',
      'Signature',
      'Refund Amount',
    ]);
    expect(body['Refund Amount']).toBe('100.00');
  });

  it('throws on a refused refund without repeating the response body', async () => {
    const { transport } = transportWith(400);

    await expect(requestGatewayRefund(transport, input)).rejects.toBeInstanceOf(
      AdaptorConnectionError,
    );
    await expect(requestGatewayRefund(transport, input)).rejects.toThrow(
      /could not refund this transaction \(status 400\)/,
    );
  });
});
