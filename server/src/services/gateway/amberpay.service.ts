import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ValidationError } from '../../utils/errors.js';
import { AdaptorConnectionError, adaptorErrorForStatus } from '../adaptors/errors.js';
import type { AdaptorResponse, HttpMethod } from '../../types/adaptor.js';
import type {
  AmberPayGateway,
  GatewayTransport,
  PaymentLinkInput,
  PaymentLinkResult,
//   WebhookEvent,
} from '../../types/gateway.js';

const webhookSchema = z.object({
  ClientId: z.string().min(1),
  TransactionId: z.string().min(1),
  OrderId: z.string().min(1),
  PaymentStatus: z.enum(['Success', 'Failed', 'Refunded']),
  Amount: z.string().regex(/^\d+(\.\d{2})?$/).transform(parseFloat).refine((v) => v > 0, 'Amount must be a positive number'),
  CurrencyCode: z.string().length(3).toUpperCase(),
  ResponseMsg: z.string().min(1).optional(),
  OrderReceiptLink: z.string().url().optional(),
  CustomMessage: z.string().min(1).optional(),
  CustomerReference: z.string().min(1),
  CardToken: z.string().min(1).optional(),
});

/**
 * Amber Pay gateway adaptor.
 *
 * NOTE: `createPaymentLink` calls the Amber Pay API via a transport seam and
 * is stubbed pending credentials. `verifyWebhookSignature` and `parseWebhook`
 * are real and fully testable without network access.
 */
export class AmberPayGatewayImpl implements AmberPayGateway {
  private readonly transport: GatewayTransport;

  constructor(transport?: GatewayTransport) {
    this.transport = transport ?? this.stubTransport;
  }

  async createPaymentLink(input: PaymentLinkInput): Promise<PaymentLinkResult> {
    const response = await this.request('POST', '/payment-links', input);
    if (response.status < 200 || response.status >= 300) {
      throw adaptorErrorForStatus(response.status, 'Amber Pay create payment link failed');
    }
    // STUB: the URL is synthesized from the external invoice id and the
    // response body is NOT parsed. Real Amber Pay response parsing (link URL,
    // reference, expiry) lands here once credentials are provisioned. Do not
    // rely on this shape; the transport seam above stays the integration point.
    return {
      linkUrl: `${env.AMBER_PAY_BASE_URL}/pay/${input.externalInvoiceId}`,
      reference: input.reference,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
    // HMAC over the RAW request bytes — never over re-serialized JSON, which
    // would be vulnerable to key-order/whitespace mismatches.
    const expected = createHmac('sha256', env.AMBER_PAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    return this.safeEqual(expected, signature);
  }

//   parseWebhook(payload: unknown): WebhookEvent {
  parseWebhook(payload: unknown): any {
    const parsed = webhookSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError('Invalid webhook payload');
    }
    return parsed.data;
  }

  private safeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) {
      return false;
    }
    return timingSafeEqual(aBuf, bBuf);
  }

  private async request(method: HttpMethod, url: string, body?: unknown): Promise<AdaptorResponse> {
    const fullUrl = `${env.AMBER_PAY_BASE_URL}${url}`;
    return this.transport(method, fullUrl, body, {});
  }

  private async stubTransport(_method: HttpMethod, _url: string): Promise<AdaptorResponse> {
    throw new AdaptorConnectionError('Amber Pay API calls are stubbed pending credentials');
  }
}

/** Singleton gateway instance. */
export const amberPayGateway = new AmberPayGatewayImpl();
