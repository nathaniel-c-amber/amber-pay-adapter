import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { adaptorErrorForStatus } from '../adaptors/errors.js';
import { httpTransport } from '../adaptors/httpTransport.js';
import { MATCH_VALUE, OPAQUE_REFERENCE } from '../adaptors/quickbooksWire.js';
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
 * The reference patterns now live in `quickbooksWire.ts`, beside the query they
 * guard, and are imported rather than re-declared here.
 *
 * This copy claimed to protect `WebhookEvent.reference`, but the value it was
 * actually applied to was the gateway's own `OrderId` — a timestamp plus random
 * characters, which cannot contain customer PII because it is not derived from
 * the customer at all. It was protecting nothing, while the field that genuinely
 * does carry an identifier (`StudentID`) was unguarded and seven characters long,
 * which the 8+ floor here would have rejected.
 */

/**
 * Amber Pay's webhook wire payload.
 *
 * The shapes here are taken from a REAL callback response (supplied 2026-10-06),
 * not from the PDF — and the two disagree in ways that matter.
 *
 * WHAT IS DECLARED, AND WHY IT IS SO NARROW. The live payload also carries
 * `AmountCharged`, `CurrencyCode`, `CardHolderName`, `PaddedCardNo` ("4012XXXX…"),
 * `BillingEmail`, `BillingPhone`, `AuthCode`, `CardType` and `CardToken`. Not
 * declaring them means zod drops them during parse, so financial data and
 * card-adjacent identifiers cannot travel past this boundary into the event
 * log, the adaptor push, or a log line (FR-2.3 / FR-5.2). That decision is now
 * evidence-backed rather than theoretical — the PII really is on the wire.
 *
 * `StudentID` is the ONE identity field declared, because it is the whole
 * point of the pipeline: an opaque organization identifier, not personal data
 * like the fields beside it.
 *
 * `OrderId` is parsed ONLY so a malformed payload is rejected loudly. It is
 * never used as an identity — see the note on `reference` below.
 */
const webhookSchema = z.object({
  ClientId: z.string().min(1),
  /**
   * OURS. Generated before checkout and echoed back unchanged (a real response
   * shows a 12-character value). It is the delivery's identity: the dedup key,
   * and the value we must use to correlate a callback with our own record.
   */
  TransactionId: z.string().regex(OPAQUE_REFERENCE),
  /**
   * NOT OURS. A real response shows `OrderId = "17906110924250WKjMPE0MR0u3"` —
   * a timestamp the gateway generated, concatenated with OUR `TransactionId`.
   * The gateway builds it; we never send it. It is validated purely so a
   * malformed payload fails loudly instead of half-parsing, and it MUST NOT be
   * used as a match value: it is a timestamp plus randomness and can never
   * identify a customer.
   */
  OrderId: z.string().min(1),
  /**
   * The customer this payment was FOR. An opaque organization identifier, e.g.
   * `STU0026` — which is SEVEN characters, and would be rejected by the 8+
   * floor `OPAQUE_REFERENCE` enforces. Hence `MATCH_VALUE`.
   *
   * Optional, and that is deliberate rather than lax: a callback with no
   * StudentID still means money arrived, so rejecting it would lose a real
   * payment and retry it forever. It is recorded as collected and the push is
   * REFUSED with a reason — see `webhookProcessor`.
   */
  StudentID: z.string().regex(MATCH_VALUE).optional(),
  /**
   * The callback only ever reports Success or Failure. `Canceled` and `Pending`
   * come from the status API, never from here, so they are NOT members of this
   * enum — a payload carrying one is not a callback and is rejected rather than
   * quietly mapped onto a state it does not mean.
   *
   * `Refunded` was once here and never should have been: a refund is an API
   * call plus a terminal state, not a status the gateway reports.
   */
  PaymentStatus: z.enum(['Success', 'Failed']),
  /**
   * The event time, when the gateway supplies one.
   *
   * NAMED `TransactionDate`, because that is what the live payload calls it.
   * An earlier `EventTimestamp` field was invented here, matched nothing, and
   * so was silently absent from every real delivery.
   *
   * The value is MALFORMED — a real response reads `"2026-09-28T15: 58: 15Z"`,
   * with spaces after the time separators, which `Date` refuses. It is
   * therefore parsed leniently by `parseWireDate` rather than by `.datetime()`;
   * validating it strictly would reject every real callback.
   */
  TransactionDate: z.string().optional(),
});

/**
 * Read the gateway's event time, tolerating its formatting.
 *
 * The live payload separates the time components with a SPACE
 * (`15: 58: 15`), which neither `Date.parse` nor zod's `.datetime()` accepts.
 * The spaces are collapsed and the result is normalised to ISO, so the value
 * that reaches the lifecycle log is a real instant rather than whatever the
 * gateway wrote. Anything still unreadable returns null, and the caller falls
 * back to arrival time — a wrong timestamp is worse than a late one.
 */
export function parseWireDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const collapsed = value.replace(/(\d{2}):\s+(\d{2}):\s+(\d{2})/, '$1:$2:$3');
  const parsed = Date.parse(collapsed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

type WirePaymentStatus = z.infer<typeof webhookSchema>['PaymentStatus'];

/** Wire status -> the pipeline's event type. */
const EVENT_TYPE_OF_STATUS: Record<WirePaymentStatus, WebhookEventType> = {
  Success: 'payment.collected',
  Failed: 'payment.failed',
};

/** Wire status -> the domain payment status carried to the adaptor. */
const PAYMENT_STATUS_OF_STATUS: Record<WirePaymentStatus, PaymentStatus> = {
  Success: 'collected',
  Failed: 'failed',
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
/**
 * ★ THE REAL TRANSPORT. It was missing entirely until a live call found it.
 *
 * This function used to have two outcomes: the dev fabricator, or a transport
 * that THREW. There was no third option, so a deployment with the dev transport
 * off — which is every real one — could not reach the gateway at all, and said
 * so with "stubbed pending credentials", a message that had been true when it
 * was written and stopped being true the moment credentials arrived.
 *
 * No unit test found it because every gateway test injects its own transport,
 * and every one of those was a fake. The defect was only visible by turning the
 * dev transport off and asking for a real signature.
 *
 * It REUSES `httpTransport` rather than adding a second fetch client. That seam
 * already exists, already encodes the timeout and the JSON/form encoding rules,
 * and already converts a network failure into an `AdaptorConnectionError` —
 * duplicating it would mean two places to keep a timeout honest. The gateway's
 * bodies are JSON, and `httpTransport` JSON-encodes anything that is not
 * form-encoded, so nothing else is needed here.
 */
function realGatewayTransport(): GatewayTransport {
  const base = env.AMBER_PAY_BASE_URL.replace(/\/+$/, '');
  return (method, path, body, headers) =>
    httpTransport(method, `${base}${path}`, body, {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    });
}

/**
 * The transport a gateway uses when a caller injects none.
 *
 * Stated once, here, rather than inside the constructor: the choice between the
 * real client and the fabricator is the whole security surface of this file, and
 * a test should be able to assert it directly instead of inferring it from a
 * thrown error.
 */
export function defaultGatewayTransport(): GatewayTransport {
  if (env.NODE_ENV !== 'production' && env.AMBER_PAY_DEV_TRANSPORT) {
    // Loud on purpose. A fabricated payment response is exactly the kind of thing
    // that must never be discovered by surprise in a log nobody reads.
    logger.warn(
      { baseUrl: env.AMBER_PAY_BASE_URL },
      'Amber Pay DEV transport active — gateway responses are fabricated locally, not issued by a gateway',
    );
    return createDevGatewayTransport(env.AMBER_PAY_BASE_URL);
  }
  return realGatewayTransport();
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
      // ★ THE MATCH VALUE IS `StudentID`, NOT `OrderId`.
      // A real callback (2026-10-06) carries three ids: `TransactionId` (ours,
      // echoed back), `StudentID` (the customer) and `OrderId` (NOT ours — the
      // gateway builds it as a timestamp plus our TransactionId appended). This
      // returned `OrderId`, which flows into the accounting customer's NAME, so
      // the matcher had been searching for a timestamp-plus-random string that
      // no customer could ever be named and every payment failed to match.
      reference: wire.StudentID ?? null,
      status: PAYMENT_STATUS_OF_STATUS[wire.PaymentStatus],
      at: parseWireDate(wire.TransactionDate) ?? new Date().toISOString(),
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
