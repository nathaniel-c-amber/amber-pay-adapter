import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { AdaptorConnectionError, adaptorErrorForStatus } from '../adaptors/errors.js';
import { createDevGatewayTransport } from './devTransport.js';
import type { AdaptorResponse, HttpMethod } from '../../types/adaptor.js';
import type { PaymentStatus } from '../../models/domain.js';
import type {
  AmberPayGateway,
  GatewayTransport,
  PaymentLinkInput,
  PaymentLinkResult,
  WebhookEvent,
  WebhookEventType,
} from '../../types/gateway.js';

/**
 * Opaque reference pattern promised by `WebhookEvent.reference`. It is the
 * backstop that stops customer PII (an email address, say) reaching the event
 * log, so it is enforced on every reference we accept.
 */
const OPAQUE_REFERENCE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Amber Pay's webhook wire payload.
 *
 * DELIBERATELY NARROW. The gateway also sends `Amount`, `CurrencyCode`,
 * `CustomerReference` and `CardToken`; not declaring them here means zod drops
 * them during parse, so financial data and card-adjacent identifiers cannot
 * travel past this boundary into the event log, the adaptor push, or a log
 * line (FR-2.3 / FR-5.2). Unknown extra fields are ignored rather than
 * rejected, so a gateway-side addition cannot break ingestion.
 */
const webhookSchema = z.object({
  ClientId: z.string().min(1),
  TransactionId: z.string().regex(OPAQUE_REFERENCE),
  OrderId: z.string().regex(OPAQUE_REFERENCE),
  PaymentStatus: z.enum(['Success', 'Failed', 'Refunded']),
  // Amber Pay does not document this field; when present it is the honest
  // event time, and when absent the processor falls back to arrival time.
  EventTimestamp: z.string().datetime().optional(),
});

type WirePaymentStatus = z.infer<typeof webhookSchema>['PaymentStatus'];

/** Wire status -> the pipeline's event type. */
const EVENT_TYPE_OF_STATUS: Record<WirePaymentStatus, WebhookEventType> = {
  Success: 'payment.collected',
  Failed: 'payment.failed',
  Refunded: 'payment.refunded',
};

/** Wire status -> the domain payment status carried to the adaptor. */
const PAYMENT_STATUS_OF_STATUS: Record<WirePaymentStatus, PaymentStatus> = {
  Success: 'collected',
  Failed: 'failed',
  Refunded: 'refunded',
};

/**
 * Amber Pay gateway adaptor.
 *
 * `verifyWebhookSignature` and `parseWebhook` are real and fully testable
 * without network access.
 *
 * `createPaymentLink` still has no real upstream to call, so its transport
 * defaults to one that throws — UNLESS a developer explicitly opts in with
 * `AMBER_PAY_DEV_TRANSPORT=true` outside production, which fabricates a link
 * locally. See `defaultGatewayTransport` for why that takes two gates.
 */
/**
 * The default when no transport is supplied and the dev transport is off —
 * which is always, in production.
 *
 * Throws rather than returning a 5xx body, so an unconfigured deployment says
 * WHY it could not reach the gateway instead of implying a call that never
 * happened.
 */
async function throwingTransport(_method: HttpMethod, _url: string): Promise<AdaptorResponse> {
  throw new AdaptorConnectionError('Amber Pay API calls are stubbed pending credentials');
}

/**
 * The transport a gateway uses when a caller injects none.
 *
 * Stated once, here, rather than inside the constructor: the two gates are the
 * whole security surface of this file, and a test should be able to assert the
 * choice directly instead of inferring it from a thrown error.
 */
export function defaultGatewayTransport(): GatewayTransport {
  if (env.NODE_ENV !== 'production' && env.AMBER_PAY_DEV_TRANSPORT) {
    // Loud on purpose. A fabricated payment link is exactly the kind of thing
    // that must never be discovered by surprise in a log nobody reads.
    logger.warn(
      { baseUrl: env.AMBER_PAY_BASE_URL },
      'Amber Pay DEV transport active — payment links are fabricated locally, not issued by a gateway',
    );
    return createDevGatewayTransport(env.AMBER_PAY_BASE_URL);
  }
  return throwingTransport;
}

export class AmberPayGatewayImpl implements AmberPayGateway {
  private readonly transport: GatewayTransport;

  constructor(transport?: GatewayTransport) {
    this.transport = transport ?? defaultGatewayTransport();
  }

  async createPaymentLink(input: PaymentLinkInput): Promise<PaymentLinkResult> {
    const response = await this.request('POST', '/payment-links', input);
    if (response.status < 200 || response.status >= 300) {
      throw adaptorErrorForStatus(response.status, 'Amber Pay create payment link failed');
    }
    return paymentLinkFromResponse(response.body, input);
  }

  verifyWebhookSignature(rawBody: string | Buffer, signature: string, secret?: string): boolean {
    /*
      The secret is DEPLOYMENT configuration, so the caller supplies it; the
      environment remains a fallback so a deployment that configures one there
      keeps verifying. Until the onboarding wizard can set a stored value, an
      upgrade must not quietly stop checking signatures — that is the one failure
      mode this function exists to prevent.
    */
    const key = secret ?? env.AMBER_PAY_WEBHOOK_SECRET;
    // HMAC over the RAW request bytes — never over re-serialized JSON, which
    // would be vulnerable to key-order/whitespace mismatches.
    const expected = createHmac('sha256', key).update(rawBody).digest('hex');
    return this.safeEqual(expected, signature);
  }

  /**
   * Translate an Amber Pay wire payload into the pipeline's own event shape.
   *
   * This MAPPING is the whole point: the gateway's field names and its
   * `PaymentStatus` vocabulary are not the pipeline's, and pretending otherwise
   * (a cast, or a `any` return) made every downstream field read `undefined` —
   * defeating deduplication and sending every event down the unhandled-type
   * branch. The return type is the contract; the compiler enforces it.
   */
  parseWebhook(payload: unknown): WebhookEvent {
    const parsed = webhookSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError('Invalid webhook payload');
    }
    const wire = parsed.data;
    return {
      id: wire.TransactionId,
      type: EVENT_TYPE_OF_STATUS[wire.PaymentStatus],
      reference: wire.OrderId,
      status: PAYMENT_STATUS_OF_STATUS[wire.PaymentStatus],
      at: wire.EventTimestamp ?? new Date().toISOString(),
    };
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
}

/**
 * Turn a gateway response into a link.
 *
 * The upstream is still stubbed, so there is no documented response shape to
 * parse against. Anything the body does not positively supply falls back to the
 * synthesized link this class has always returned — so a recognised body
 * improves the result and an unrecognised one changes nothing, rather than the
 * two paths being quietly different.
 */
function paymentLinkFromResponse(body: unknown, input: PaymentLinkInput): PaymentLinkResult {
  const fallback: PaymentLinkResult = {
    linkUrl: `${env.AMBER_PAY_BASE_URL}/pay/${input.externalInvoiceId}`,
    reference: input.reference,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  if (typeof body !== 'object' || body === null) return fallback;
  const candidate = body as Record<string, unknown>;
  const { linkUrl, reference, expiresAt, simulated } = candidate;
  if (typeof linkUrl !== 'string' || typeof reference !== 'string' || typeof expiresAt !== 'string') {
    return fallback;
  }
  return {
    linkUrl,
    reference,
    expiresAt,
    /*
      `simulated` has to survive the parse, not just the transport. The flag is
      set on the raw response body, so a projection that picked only the three
      original fields silently dropped it and the API reported a fabricated link
      as genuine — which is the exact confusion it exists to prevent. Carried
      only when explicitly true, so a real gateway cannot set it by accident.
    */
    ...(simulated === true ? { simulated: true } : {}),
  };
}

/**
 * Singleton gateway instance. Resolves its transport once, at module load.
 */
export const amberPayGateway = new AmberPayGatewayImpl();
