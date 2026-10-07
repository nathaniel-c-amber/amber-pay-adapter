/* Creating a checkout: generate our id, record the intent, ask Amber to sign it.
 *
 * ★ THE ORDER IN `create` IS THE DESIGN AND IS NOT INTERCHANGEABLE.
 *
 *   1. GENERATE a transaction id          (ours, 12 chars, never reused)
 *   2. PERSIST the intent                  (amount SEALED, student, currency)
 *   3. SIGN                               (a real call to Amber)
 *
 * Step 2 precedes step 3 deliberately. The gateway echoes the transaction id back
 * on the callback, and that echo is the only thing tying an incoming payment to
 * our record. If we signed first and the process died, or the write failed, we
 * would hold a signature for an id we never stored — and a customer could
 * complete a payment we could not attribute. Recording first means the failure
 * mode is a useless signature rather than an unattributable payment.
 *
 * It also means an intent can exist with no completed payment, which is the
 * harmless direction: a customer abandoned checkout. The reverse — a completed
 * payment with no intent — is money we cannot explain.
 */

import {
  AMBER_PAY_GATEWAY_PATH,
  buildCheckoutUrl,
  buildSignaturePath,
} from './gatewayEndpoints.js';
import { defaultGatewayTransport } from './amberpay.service.js';
import { generateTransactionId, isTransactionId, sealExpectedCharge } from './amberPayWire.js';
import { AdaptorConnectionError, AdaptorError } from '../adaptors/errors.js';
import { ValidationError } from '../../utils/errors.js';
import { env } from '../../config/env.js';
import type { GatewayTransport } from '../../types/gateway.js';
import type {
  CheckoutSession,
  GatewayCurrency,
  StandardCheckoutParams,
} from './amberPayWire.js';

/**
 * The storage this service needs.
 *
 * Declared here rather than importing the repository singleton, so the ordering
 * guarantee can be TESTED: the whole point of the sequence above is that the
 * write happens first, and a test that cannot intercept the storage cannot
 * observe it.
 */
export interface CheckoutIntentStore {
  /**
   * Record a new intent.
   *
   * MUST reject a repeated `(organizationId, transactionId)` rather than
   * overwriting — that is the uniqueness guarantee the flow's idempotency rests
   * on, and a store that silently replaced would make a duplicate id look like a
   * fresh payment.
   */
  create(input: {
    organizationId: string;
    transactionId: string;
    studentId: string;
    /** The expected figure AND its currency, sealed together. */
    expectedSealed: Buffer;
  }): Promise<void>;

/** Find an intent by the id the gateway echoed, so a callback can be attributed. */
findByTransactionId(
    organizationId: string,
    transactionId: string,
  ): Promise<{ studentId: string } | undefined>;
}

/** How many times to regenerate an id the store says is already taken. */
const ID_COLLISION_RETRIES = 3;

export interface CreateCheckoutInput {
  organizationId: string;
  /** The customer this payment is for. Validated against the opaque-id charset. */
  studentId: string;
  /** MAJOR units, verbatim — "250.00". See `DECIMAL_AMOUNT` for why a string. */
  amount: string;
  currency: GatewayCurrency;
  clientId: string;
}

export class CheckoutService {
  constructor(
    private readonly intents: CheckoutIntentStore,
    private readonly transport: GatewayTransport = defaultGatewayTransport(),
    private readonly newId: () => string = generateTransactionId,
  ) {}

  /**
   * Mint an id and persist the intent, retrying only on a genuine collision.
   *
   * The retry is narrow on purpose: it fires when the STORE says the id is
   * taken, and for nothing else. A validation failure, a database outage or a
   * missing encryption key must surface immediately — retrying those would hide
   * a real fault behind three identical failures.
   */
  private async persistWithFreshId(input: CreateCheckoutInput): Promise<string> {
    for (let attempt = 1; attempt <= ID_COLLISION_RETRIES; attempt += 1) {
      const transactionId = this.newId();
      if (!isTransactionId(transactionId)) {
        // A generator that returns the wrong SHAPE would silently produce ids the
        // gateway rejects. Refused before anything is stored.
        throw new ValidationError(
          'The configured transaction id generator did not produce a valid identifier',
        );
      }
      try {
        await this.intents.create({
          organizationId: input.organizationId,
          transactionId,
          studentId: input.studentId,
          expectedSealed: sealExpectedCharge(input.amount, input.currency),
        });
        return transactionId;
      } catch (err) {
        if (!(err instanceof DuplicateTransactionIdError) || attempt === ID_COLLISION_RETRIES) {
          throw err;
        }
      }
    }
    /* istanbul ignore next -- unreachable: the loop returns or throws on the last attempt */
    throw new AdaptorConnectionError('Could not allocate a unique transaction id');
  }

  /**
   * Ask Amber to sign the transaction, then describe the checkout to the browser.
   *
   * The signature is NOT computed locally. The documentation provides a
   * dedicated API for it and says the secret is generated in the back end with no
   * client access, so there is nothing for us to compute one with — and an
   * attempt to invent the algorithm would be exactly the kind of guess this
   * codebase has already been bitten by.
   */
  async create(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const transactionId = await this.persistWithFreshId(input);

    const signature = await this.requestSignature({
      ClientId: input.clientId,
      TransactionId: transactionId,
      CurrencyCode: input.currency,
      Amount: input.amount,
      SignType: 1,
    });

    const params: StandardCheckoutParams = {
      ClientId: input.clientId,
      TransactionId: transactionId,
      CurrencyCode: input.currency,
      Amount: input.amount,
      Signature: signature,
      CustomerReference: input.studentId,
      // We render the receipt ourselves, so the gateway is not asked to email
      // one: `CustomerInvoice: N` is what stops a billing email being sent from
      // a system that deliberately holds no billing addresses.
      CustomerInvoice: 'N',
      ReturnToMerchant: 'Y',
      AutoRedirect: 'Y',
    };

    return {
      checkoutUrl: buildCheckoutUrl(),
      params,
      transactionId,
    };
  }

  /**
 * One call to `/generatesignature`, and its response read strictly.
 *
 * ★ THE BEARER TOKEN GOES HERE, AND ONLY HERE.
 *
 * `generatesignature` is a SERVER-TO-SERVER call: our API asks the gateway to
 * sign a transaction. That is authenticated with `Authorization: Bearer …`.
 *
 * It is deliberately NOT sent to the browser. The checkout form is submitted by
 * the BROWSER directly to the gateway, so anything we put in it would be a live
 * credential living in the page, in the DOM, in a screenshot and in every
 * support log since. The `Signature` field is what proves the checkout; the
 * bearer token proves us, and we are the only ones making this call.
 */
private async requestSignature(body: {
    ClientId: string;
    TransactionId: string;
    CurrencyCode: GatewayCurrency;
    Amount: string;
    SignType: 1;
  }): Promise<string> {
    const response = await this.transport(
      'POST',
      buildSignaturePath(),
      body,
      bearerAuth(env.AMBER_PAY_API_TOKEN),
    );
    if (response.status < 200 || response.status >= 300) {
      throw new AdaptorError(
        502,
        'GATEWAY_SIGNATURE_ERROR',
        `Amber Pay could not sign this transaction (status ${response.status})`,
      );
    }
    return readSignature(response.body);
  }
}

/**
 * `Authorization` for an outbound gateway call.
 *
 * A NAMED helper rather than an object literal at each call site, because the
 * thing that must never happen is for one of these calls to quietly omit the
 * header — and a header that is absent from a type-checked literal is invisible,
 * while a call to this function cannot be made without it.
 *
 * The token is never logged, never included in an error, and never reaches the
 * browser. `httpTransport` passes headers through untouched and does not log
 * them, so the credential's exposure is bounded by this one call site.
 */
export function bearerAuth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Read the signature out of the gateway's response.
 *
 * ★ THE FLAG IS `Success`, NOT `success` — verified against the live gateway.
 *
 * The documentation's example reads `{"success": "Y", …}` in lower case, and
 * that is what this checked, so EVERY valid response looked like a refusal: the
 * first real call to `staging-payment.myamberpay.com` returned 200 with a
 * genuine 64-byte signature and was reported as "the gateway declined to sign".
 *
 * Both spellings are accepted, and the reason is not hedging. Accepting the
 * documented one means this keeps working if the gateway ever normalises to it;
 * accepting the observed one is what makes it work now. Refusing to accept a
 * signature that is demonstrably valid, on the strength of a capital letter in
 * a documentation example, is the failure mode worth avoiding.
 *
 * WHAT IS NOT RELAXED: the value must be the STRING "Y", and the signature must
 * be a non-empty string. A JSON `true` here — a plausible mistake for anyone
 * implementing against the doc — still reads as a refusal.
 */
function readSignature(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw new AdaptorConnectionError('Amber Pay returned no signature for this transaction');
  }
  const payload = body as Record<string, unknown>;
  const flag = payload['Success'] ?? payload['success'];
  if (flag !== 'Y') {
    throw new AdaptorConnectionError('Amber Pay declined to sign this transaction');
  }
  const signature = payload['Signature'];
  if (typeof signature !== 'string' || signature.trim() === '') {
    throw new AdaptorConnectionError('Amber Pay returned an empty signature for this transaction');
  }
  return signature;
}

/**
 * A transaction id the store already holds.
 *
 * A distinct TYPE, not a message, so the retry path can tell a collision from
 * every other failure without matching on a string the database might word
 * differently on the next version.
 */
export class DuplicateTransactionIdError extends Error {
  constructor(transactionId: string) {
    super(`A checkout with transaction id ${transactionId} already exists`);
    this.name = 'DuplicateTransactionIdError';
  }
}

/** Re-exported so the route can build the checkout path from one place. */
export { AMBER_PAY_GATEWAY_PATH };