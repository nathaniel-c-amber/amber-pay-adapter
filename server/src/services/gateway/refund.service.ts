/* Refunding a transaction at Amber Pay.
 *
 * A refund is not a negative checkout: the gateway documents a separate call
 * whose signature is computed over the ORIGINAL amount, not the amount being
 * returned. Signing over the refund figure would produce a signature the
 * gateway cannot verify, and the mistake would only appear against a live host.
 *
 * ★ THE FIELD MAPPING LIVES IN ONE FUNCTION. `ClientId`, `TransactionId`,
 * `CurrencyCode`, `Amount` (the original), `Signature` and the literal key
 * `"Refund Amount"` are the whole wire contract. Building it at a second call
 * site is how a field gets renamed on one path and not the other, and the
 * gateway answers that with a refusal that names nothing useful.
 *
 * ★ THE RESPONSE IS NEVER LOGGED OR ECHOED. It describes a refunded card
 * transaction and can carry instrument-adjacent data; the only fact callers
 * need is that the provider accepted the request, which the status code says.
 */

import { env } from '../../config/env.js';
import { AdaptorConnectionError } from '../adaptors/errors.js';
import { defaultGatewayTransport } from './amberpay.service.js';
import { bearerAuth, requestTransactionSignature } from './checkout.service.js';
import { buildRefundPath } from './gatewayEndpoints.js';
import type { GatewayCurrency } from './amberPayWire.js';
import type { GatewayTransport } from '../../types/gateway.js';

export interface GatewayRefundInput {
  transactionId: string;
  /** The original charge, in major units, verbatim. Also what gets signed. */
  originalAmount: string;
  currency: GatewayCurrency;
  /** How much to return, in major units, verbatim. */
  refundAmount: string;
}

/**
 * The gateway's refund body.
 *
 * `Amount` is the ORIGINAL transaction amount; `"Refund Amount"` is the part to
 * return. They are separate on purpose — the provider needs both to identify the
 * transaction and to know how much of it is being returned.
 */
export interface RefundWireRequest {
  ClientId: string;
  TransactionId: string;
  CurrencyCode: GatewayCurrency;
  Amount: string;
  Signature: string;
  /** The literal wire key, including the space. */
  'Refund Amount': string;
}

/**
 * Build the body, and nothing else.
 *
 * Kept as its own exported function so the one place the mapping exists can be
 * asserted directly, without a transport.
 */
export function buildRefundRequest(
  input: GatewayRefundInput,
  signature: string,
  clientId: string = env.AMBER_PAY_CLIENT_ID,
): RefundWireRequest {
  return {
    ClientId: clientId,
    TransactionId: input.transactionId,
    CurrencyCode: input.currency,
    Amount: input.originalAmount,
    Signature: signature,
    'Refund Amount': input.refundAmount,
  };
}

/**
 * Ask the gateway to refund, exactly once.
 *
 * THROWS on any non-2xx, and deliberately does not distinguish a refusal from an
 * outage: the caller must not retry a refund, because the provider permits one
 * per transaction and a second attempt after an ambiguous failure could return
 * money twice. The status is all that is surfaced; the body is not read.
 */
export async function requestGatewayRefund(
  transport: GatewayTransport,
  input: GatewayRefundInput,
): Promise<void> {
  const signature = await requestTransactionSignature(transport, {
    ClientId: env.AMBER_PAY_CLIENT_ID,
    TransactionId: input.transactionId,
    CurrencyCode: input.currency,
    Amount: input.originalAmount,
    SignType: 1,
  });

  const response = await transport(
    'POST',
    buildRefundPath(),
    buildRefundRequest(input, signature),
    bearerAuth(env.AMBER_PAY_API_TOKEN),
  );
  if (response.status < 200 || response.status >= 300) {
    throw new AdaptorConnectionError(
      `Amber Pay could not refund this transaction (status ${response.status})`,
    );
  }
}

/** The production wiring: a real transport, resolved once per call site. */
export function defaultGatewayRefund(input: GatewayRefundInput): Promise<void> {
  return requestGatewayRefund(defaultGatewayTransport(), input);
}
