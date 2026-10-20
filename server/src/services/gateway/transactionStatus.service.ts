/* Ask the gateway what it thinks happened to a payment it did not describe.
 *
 * ★ WHY THIS EXISTS. The gateway's callback carries a `StudentID` only when the
 * browser supplied one, and a real delivery does not always: a card payment
 * made on the gateway's own page arrives with `ErrorCode=` empty and no
 * customer named. The money still moved, so the payment is real — but with no
 * customer it cannot be applied to an invoice, and the pipeline correctly
 * refuses to guess one.
 *
 * The gateway already knows. `POST /gateway/v1/transactionstatus` answers with
 * `CustomerReference`, and it is the SAME value we sent as the checkout's
 * customer, so it is our own identifier coming back — not a guess and not a
 * third party's inference.
 *
 * ★ THE SIGNATURE IS NOT BURNED BY THE PAYMENT. It was verified against the
 * live gateway that `/generatesignature` returns a byte-identical signature for
 * a transaction id that has already been paid: the signature is deterministic
 * over the five signed fields, and the single-use rule is enforced at
 * `/standard-checkout` only. So asking afterwards is possible, and it is why a
 * status lookup is not a receipt request we would have to refuse.
 *
 * ★ THE FIGURE COMES FROM OUR OWN SEALED RECORD, NEVER FROM THE CALLBACK. The
 * signature needs `CurrencyCode` and `Amount`, and the only trustworthy source
 * for either is `expected_sealed` — which exists precisely so this comparison
 * is possible and so nothing on the wire can decide what a payment was worth.
 * A callback is unverified input from a party we do not control; signing over a
 * figure it supplied would let the delivery choose the signature.
 *
 * ★ THE RESPONSE IS NEVER LOGGED, and never surfaces in an error. It carries
 * `CardHolderName`, `PaddedCardNo`, `BillingEmail` and `BillingPhone` — the
 * same PII the webhook schema drops at the boundary. Only identity and reason
 * codes leave this file; see `readStatus`, which is the only thing that reads
 * the body, and the tests that assert on what is logged.
 */

import { buildStatusPath } from './gatewayEndpoints.js';
import { defaultGatewayTransport } from './amberpay.service.js';
import { bearerAuth, requestTransactionSignature } from './checkout.service.js';
import { openExpectedCharge } from './amberPayWire.js';
import { MATCH_VALUE } from '../adaptors/quickbooksWire.js';
import { AdaptorConnectionError } from '../adaptors/errors.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import type { GatewayTransport } from '../../types/gateway.js';
import type { ExpectedCharge } from './amberPayWire.js';

/**
 * The one read this service needs, and deliberately NOT `findByTransactionId`.
 *
 * That one returns the student and the status token and has a comment saying
 * the expected charge does not come back "deliberately" — a routine lookup must
 * not unseal a figure. This is a separate, single-purpose read for the one call
 * that genuinely needs it, so that rule stays true for everything else, and so
 * nothing else acquires a path to a stored figure by widening an existing one.
 *
 * The value is returned SEALED. Only this file opens it, through
 * `openExpectedCharge`, and only to sign a request the gateway requires one for.
 */
export interface GatewayStatusStore {
  findExpectedChargeByTransactionId(
    organizationId: string,
    transactionId: string,
  ): Promise<{ expectedSealed: Buffer } | undefined>;
}

/**
 * What the gateway says about one transaction.
 *
 * ★ FIVE FIELDS OUT OF TWENTY, AND THE OMISSION IS THE POINT. The live response
 * also carries `AmountCharged`, `CardHolderName`, `PaddedCardNo`,
 * `BillingEmail`, `BillingPhone`, `CardToken`, `AuthCode` and `CustomMessage`.
 * Nothing here declares them, so they cannot be logged, recorded, or reach an
 * event or a failure by accident — the same narrowing the webhook schema makes,
 * for the same reason.
 *
 * `transactionStatus` and `paymentStatus` are read NOT AT ALL, deliberately.
 * The callback's own verdict is the one this pipeline acts on, and this service
 * is asked a narrower question: which customer was this for, and why did it not
 * say. Mapping a status API state onto a payment outcome would widen the
 * `PaymentStatus` vocabulary on the strength of a field nobody asked about.
 */
export interface GatewayTransactionStatus {
  /** `CustomerReference` — the opaque identifier WE sent, echoed back. */
  customerReference: string | null;
  /** The gateway's own decline code, which a callback's `ErrorCode` is empty of. */
  reasonCode: string | null;
  /** The response code, which is a separate field and not always the same value. */
  responseCode: string | null;
  /** The gateway's words for the code. The customer's own payment coming back. */
  reasonDescription: string | null;
  /** The gateway's own handle on the transaction, for support and reconciliation. */
  transactionIdentifier: string | null;
}

/**
 * The longest text kept from the status response.
 *
 * The same cap the callback's failure reason uses, for the same reason: this is
 * third-party text heading for a stored column and a customer's status page, and
 * an unbounded string is an unbounded row.
 */
const MAX_STATUS_TEXT = 200;

/**
 * Read one string field, cleaned.
 *
 * THE SAME FOUR THINGS `failureReasonFrom` does in `amberpay.service.ts`, and
 * they are load-bearing rather than cosmetic:
 *   - CONTROL CHARACTERS ARE STRIPPED, because the wire is a party we do not
 *     control and this is rendered in a browser tab.
 *   - WHITESPACE IS COLLAPSED, because a mis-encoding sender sends `Invalid+code`
 *     with a literal plus.
 *   - IT IS CAPPED, because this is third-party text into a stored column.
 *   - THE LITERAL STRINGS `null` and `undefined` ARE TREATED AS ABSENT. The
 *     gateway sends the STRING "null" for a field it has no value for — a real
 *     callback carries `StoreVerifyFlag=null` and `CustomMessage=null` as text —
 *     so a naive read would tell a customer their payment failed with the
 *     reason "null".
 */
function readText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value !== 'string') return null;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '' || cleaned.toLowerCase() === 'null' || cleaned.toLowerCase() === 'undefined') {
    return null;
  }
  return cleaned.slice(0, MAX_STATUS_TEXT);
}

/**
 * The customer, or null.
 *
 * ★ VALIDATED AGAINST `MATCH_VALUE` BEFORE IT IS BELIEVED, and this is the one
 * place that is not optional. This value lands in `WebhookEvent.reference`,
 * which becomes the QuickBooks `matchValue` and is interpolated into a query
 * string against the company's own books. `assertMatchValue` refuses a bad one
 * there, but a lookup that produced it has no business producing it: the
 * callback schema validates `StudentID` against the same pattern, and a
 * reference arriving by a different door gets the same door's rules.
 */
function readCustomerReference(payload: Record<string, unknown>): string | null {
  const value = readText(payload, 'CustomerReference');
  return value !== null && MATCH_VALUE.test(value) ? value : null;
}

/**
 * Read the status out of the gateway's response, or `undefined` for "unknown".
 *
 * ★ `Results` IS AN ARRAY AND MAY BE EMPTY, so both the flag and the array are
 * checked. `Results[0]` on a missing key would throw on a delivery we were only
 * trying to learn something about, and the caller's fallback for "we do not
 * know" is far better than the caller's fallback for "this threw".
 *
 * ★ `Success` IS CAPITALISED HERE, AND BOTH SPELLINGS ARE ACCEPTED — the same
 * convention, and for the same evidence, as `readSignature` in
 * `checkout.service.ts`: the documentation's example is lower case, the live
 * gateway is not, and accepting only the documented spelling made every valid
 * answer read as a refusal. What is NOT relaxed is the VALUE: it must be the
 * string "Y", because a JSON `true` is a plausible mistake for anyone
 * implementing against the documentation and still reads as a refusal.
 *
 * A body of the wrong SHAPE is "unknown" rather than an exception. This is a
 * best-effort enrichment on the webhook's own path: every caller must be able
 * to carry on without it, so anything that is not a clear answer is not an
 * answer and must not be turned into a fault.
 */
function readStatus(body: unknown): GatewayTransactionStatus | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const payload = body as Record<string, unknown>;
  const flag = payload['Success'] ?? payload['success'];
  if (flag !== 'Y') return undefined;
  const results = payload['Results'];
  if (!Array.isArray(results)) return undefined;
  const first = results[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const row = first as Record<string, unknown>;
  return {
    customerReference: readCustomerReference(row),
    reasonCode: readText(row, 'ReasonCode'),
    responseCode: readText(row, 'ResponseCode'),
    reasonDescription: readText(row, 'ReasonCodeDesc'),
    transactionIdentifier: readText(row, 'TransactionIdentifier'),
  };
}

/**
 * The gateway's reason, as ONE string, for a customer page and a stored column.
 *
 * A code alone is meaningless to whoever just had a payment declined, and a
 * description alone is the bare message the callback already gave — which is why
 * the two are composed rather than chosen between. `ReasonCode` is preferred to
 * `ResponseCode` because they are usually the same value and the reason code is
 * the one the gateway documents as the decline reason.
 *
 * Exported so the composition is the service's, not the webhook's: the caller
 * decides whether it has a reason, this decides what the gateway's is.
 */
export function gatewayFailureReason(status: GatewayTransactionStatus): string | null {
  const code = status.reasonCode ?? status.responseCode;
  const description = status.reasonDescription;
  if (code === null) return description;
  if (description === null) return code;
  return `${code}: ${description}`.slice(0, MAX_STATUS_TEXT);
}

/**
 * The gateway's own account of one transaction.
 *
 * NEVER THROWS FOR A BAD ANSWER, and may throw for a fault. "The gateway does
 * not know this transaction" is `undefined`; "we could not reach the gateway"
 * is an `AdaptorConnectionError` from the transport. Collapsing the two would
 * make an outage indistinguishable from an absent record, which is the opposite
 * of what an operator reading a log needs.
 */
export class GatewayStatusService {
  constructor(
    private readonly intents: GatewayStatusStore,
    private readonly transport: GatewayTransport = defaultGatewayTransport(),
  ) {}

  /**
   * Sign the sealed figure and ask the gateway what it knows.
   *
   * TWO CALLS, and both are server-to-server authenticated exactly as
   * `generatesignature` already is — the signature is the gateway's, the bearer
   * token is ours, and the token appears in neither response, in neither error,
   * nor in any log line this file writes.
   *
   * THE ORDER IS LOAD-BEARING IN ONE DIRECTION ONLY: the sealed figure has to be
   * read BEFORE the signature exists, because the signature is computed over it.
   * Everything else here is best-effort enrichment, and the caller is expected
   * to treat a throw as "carry on without it".
   */
  async lookup(
    organizationId: string,
    transactionId: string,
  ): Promise<GatewayTransactionStatus | undefined> {
    const expected = await this.expectedCharge(organizationId, transactionId);
    // No intent means no sealed figure means no signature, so there is no request
    // to make. Saying so is worth a line: it is the difference between "the
    // gateway does not know this payment" and "we never recorded it".
    if (expected === undefined) return undefined;

    const clientId = env.AMBER_PAY_CLIENT_ID;
    const signature = await requestTransactionSignature(this.transport, {
      ClientId: clientId,
      TransactionId: transactionId,
      CurrencyCode: expected.currency,
      Amount: expected.amount,
      SignType: 1,
    });

    const response = await this.transport(
      'POST',
      buildStatusPath(),
      {
        ClientId: clientId,
        TransactionId: transactionId,
        CurrencyCode: expected.currency,
        Amount: expected.amount,
        Signature: signature,
      },
      bearerAuth(env.AMBER_PAY_API_TOKEN),
    );
    if (response.status < 200 || response.status >= 300) {
      /*
        ★ THE UPSTREAM'S OWN TEXT IS NOT REPEATED, only its status.

        `checkout.service.ts` documents the rule for the signature call and it
        applies identically here: a gateway fault can quote the customer, the
        figure or a card field, and this message reaches a failure tracker and
        a log file. The status code is the whole of what is safe to say.
      */
      throw new AdaptorConnectionError(
        `Amber Pay could not report the status of this transaction (status ${response.status})`,
      );
    }

    /*
      ★ NOTHING IS LOGGED HERE.

      The body is the most PII-dense thing this system receives — a cardholder
      name, a padded card number, a billing email and a billing phone — and the
      one thing the codebase insists on for the callback (`webhooks.controller.ts`
      logs the identity, never the payload) is that it never gets logged here
      either. The caller logs the identity and the reason codes it decided to
      use, which is the only part of this answer that is safe to write down.
    */
    return readStatus(response.body);
  }

  /**
   * The figure the gateway's signature has to be computed over.
   *
   * Opened here, once, and returned as the two strings the wire needs. A
   * `ValidationError` from a sealed value that will not open — a missing key, a
   * row written by a different scheme — propagates: it is a real fault about our
   * own storage, not an absence of gateway knowledge, and the caller logs it
   * apart from an outage.
   */
  private async expectedCharge(
    organizationId: string,
    transactionId: string,
  ): Promise<ExpectedCharge | undefined> {
    const row = await this.intents.findExpectedChargeByTransactionId(
      organizationId,
      transactionId,
    );
    if (row === undefined) {
      // Identity only. Never the transaction's expected figure, which is in the
      // sealed value this row does not have.
      logger.warn(
        { webhookId: transactionId },
        'No checkout intent to sign an Amber Pay status request from — the gateway was not asked',
      );
      return undefined;
    }
    return openExpectedCharge(row.expectedSealed);
  }
}
