/* Where the gateway's endpoints are, built from configuration.
 *
 * ONE PLACE, because the base URL is deployment configuration and the paths are
 * documented per host. Deriving a path at two call sites is how
 * `{base}/realm/{realm}/...` survived as long as it did in the QuickBooks
 * adaptor — a shape that was never a real URL, discovered only when something
 * finally called it.
 *
 * The paths are documented under `/gateway/v1/…`, while the base URL is
 * configured as a HOST. So the prefix is part of what we build here rather than
 * something a deployment has to remember to include in its URL — getting that
 * wrong produces a 404 from a host that is otherwise perfectly correct, which is
 * a needlessly confusing failure.
 */

import { env } from '../../config/env.js';

/** The documented prefix on every gateway endpoint. */
export const AMBER_PAY_GATEWAY_PATH = '/gateway/v1';

/** Strip any trailing slash so joining a path never doubles one. */
function host(): string {
  return env.AMBER_PAY_BASE_URL.replace(/\/+$/, '');
}

export function buildSignaturePath(): string {
  return `${AMBER_PAY_GATEWAY_PATH}/generatesignature`;
}

export function buildCheckoutPath(): string {
  return `${AMBER_PAY_GATEWAY_PATH}/standard-checkout`;
}

export function buildStatusPath(): string {
  return `${AMBER_PAY_GATEWAY_PATH}/transactionstatus`;
}

export function buildRefundPath(): string {
  return `${AMBER_PAY_GATEWAY_PATH}/refund`;
}

/**
 * The absolute URL the BROWSER posts to.
 *
 * Absolute, because the customer leaves our origin entirely: their card details
 * go to the gateway, not through us. That is the point of this design rather
 * than an incidental detail — a relative URL would quietly make us a party to
 * the card path, which is the one thing worth avoiding.
 */
export function buildCheckoutUrl(): string {
  return `${host()}${buildCheckoutPath()}`;
}