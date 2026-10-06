import type { ApiCheckoutSession } from "@/types/api";

/* Holding a signed checkout in module scope, deliberately.
 *
 * ★ WHY NOT IN THE URL, AND WHY NOT IN STATE.
 *
 * The signed parameters must reach the page that builds the form. Two obvious
 * carriers are both wrong:
 *
 *   THE URL — a checkout page reachable by address is a payment page any third
 *   party can point somebody at, with the destination and the signature written
 *   into the address bar. Even if the signature only ever posts to the gateway,
 *   a shared or bookmarked link would carry a live, signed transaction to
 *   whoever opened it next.
 *
 *   REACT STATE — it dies on reload, and the natural instinct is to "fix" that
 *   by putting it in sessionStorage. That reintroduces the URL's problem in a
 *   place that also survives a browser restart.
 *
 * Module scope is the one carrier that is neither addressable nor persistent: a
 * reload lands here with nothing, and `takePendingCheckout` CONSUMES it, so the
 * back button does not re-render a form that may already have been submitted.
 *
 * The consequence is stated rather than hidden: a customer who reloads mid-checkout
 * has to start again. That is a far better failure than a replayable signed link.
 */

let pending: ApiCheckoutSession | null = null;

/** Hold a checkout for the handoff page to render. */
export function setPendingCheckout(session: ApiCheckoutSession): void {
  pending = session;
}

/**
 * Take the held checkout, leaving nothing behind.
 *
 * CONSUMING, not peeking: the form this feeds submits itself, and a back-button
 * navigation that could re-render it would let one signed session be submitted
 * more than once.
 */
export function takePendingCheckout(): ApiCheckoutSession | null {
  const held = pending;
  pending = null;
  return held;
}

/** Discard it — the customer cancelled, and it should not be submittable. */
export function clearPendingCheckout(): void {
  pending = null;
}