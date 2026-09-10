import type { PaymentStatus } from '../domain/types.js';
import type { AdaptorResponse, HttpMethod } from '../adaptors/types.js';

/**
 * Webhook event types emitted by the Amber Pay gateway.
 *
 * NOTE: `payment.declined` and `payment.failed` are distinct upstream states
 * (declined by issuer vs. failed processing) but currently map to the same
 * pipeline handling. Kept separate for future differentiation.
 */
export type WebhookEventType =
  | 'payment.collected'
  | 'payment.declined'
  | 'payment.initiated'
  | 'payment.failed';

/**
 * Input for creating a payment link. Privacy-safe: NO amount, NO PII — only
 * reference hashes and operational status.
 */
export interface PaymentLinkInput {
  invoiceId: string;
  externalInvoiceId: string;
  reference: string;
  status: PaymentStatus;
  // NOTE: no amount per privacy constraint.
}

export interface PaymentLinkResult {
  linkUrl: string;
  reference: string;
  expiresAt: string; // ISO 8601
}

/**
 * Parsed webhook event. NO amount, NO PII — only operational status and
 * reference hashes. `reference` is constrained by `parseWebhook` to a safe
 * opaque id pattern (`^[A-Za-z0-9_-]{8,64}$`).
 */
export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  reference: string;
  status: PaymentStatus;
  at: string; // ISO 8601
  // NOTE: no amount, no PII per privacy constraint.
}

/**
 * Thin transport seam used by the gateway to make HTTP calls. Real
 * implementations are stubbed pending credentials; tests inject a mock.
 */
export type GatewayTransport = (
  method: HttpMethod,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<AdaptorResponse>;

/**
 * The Amber Pay gateway contract.
 */
export interface AmberPayGateway {
  createPaymentLink(input: PaymentLinkInput): Promise<PaymentLinkResult>;
  /**
   * Verify an Amber Pay webhook signature. The HMAC is computed over the RAW
   * request body bytes (string or Buffer) — never over re-serialized JSON.
   */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean;
  parseWebhook(payload: unknown): WebhookEvent;
}
