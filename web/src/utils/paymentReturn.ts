/**
 * What the payment return page is allowed to SAY, and what it offers NEXT.
 *
 * ★ THIS MODULE IS THE PAGE'S BRAIN, AND IT IS DELIBERATELY PURE.
 *
 * The page this sits behind renders whatever this returns and nothing else. It
 * has no route parameter to read, no URL to inspect and no way to name an
 * outcome on its own — because the outcome is a fact about the server's
 * records, not about the address the customer happened to arrive on.
 *
 * `…/payment-return?status=success` is the oldest payment-confirmation forgery
 * there is. Nothing in here can be pointed at by a URL: `returnView` accepts a
 * status object the API returned and a failure the API refused with, and every
 * other input it has is a boolean about the browser's own session. There is no
 * code path from a query string to a headline that says money moved.
 *
 * `web/` has no jsdom and does not test components (see vite.config.ts), so the
 * decisions worth pinning down — which headline, which facts, which CTAs, what
 * happens to a 400 — live here where they can be asserted.
 */

import type { PaymentStatus } from "@/services/client";

/**
 * The states this page can be in.
 *
 * `collected` / `pending` / `failed` / `unknown` are the four the status
 * endpoint reports. The other three are what the page can know WITHOUT an
 * answer, and they are kept apart because they are three different claims:
 *
 *   - `loading`        — nothing has been asked yet;
 *   - `nothing-to-check` — the link carries nothing we can look up, which is
 *                         true of a missing token AND of a 400. Neither is an
 *                         error page: the customer did nothing wrong, and a
 *                         scary treatment would invent an alarm that isn't there;
 *   - `unreachable`    — we ASKED and got no answer. Deliberately not the same
 *                         as `unknown`, which is a positive "the provider has
 *                         not reported an outcome yet". "We cannot tell" and
 *                         "there is nothing to tell" are different sentences and
 *                         must never share one.
 */
export type ReturnKind =
  | "loading"
  | "collected"
  | "pending"
  | "failed"
  | "unknown"
  | "nothing-to-check"
  | "unreachable";

/**
 * What has happened to the lookup.
 *
 * `status` carries the server's own report verbatim — it is never reconstructed
 * here, so the page cannot invent an outcome the API did not send.
 */
export type ReturnOutcome =
  | { kind: "loading" }
  | { kind: "nothing-to-check" }
  | { kind: "unreachable" }
  | { kind: "status"; status: PaymentStatus };

/** Which control a CTA is. The page owns the handler for each. */
export type ReturnCtaId = "check-again" | "copy-reference" | "console";

export interface ReturnCta {
  id: ReturnCtaId;
  label: string;
}

/** A quotable figure. Every value here is mono — references and amounts are
 *  data, and data is set in the mono face with tabular figures (see the `mono`
 *  utility in styles/tailwind.css). */
export interface ReturnFact {
  label: string;
  value: string;
}

export interface ReturnView {
  kind: ReturnKind;
  /**
   * The headline ink. `warn` is the amber the console uses for "delayed", which
   * is the correct register for a payment that did not complete.
   *
   * ★ COLOUR IS NEVER THE ONLY SIGNAL. Every headline carries a word, and every
   * state also draws its own glyph in the page — paid and not-paid are told
   * apart by the sentence and the mark, not by hue.
   */
  tone: "good" | "warn" | "neutral";
  headline: string;
  /**
   * Prose, one sentence per entry, kept as data so it can be asserted.
   *
   * `linesAfter` is the continuation that belongs BELOW the gateway's quoted
   * reason — "give them this reference" has to come after the reason is read,
   * not before it, and a single list cannot express that order.
   */
  lines: string[];
  linesAfter: string[];
  /**
   * The gateway's own words, capped. NEVER from the URL and never from this
   * module — it comes from the API, which captured it from the gateway's
   * callback. Rendered as text, so it cannot become markup.
   */
  gatewayReason: string | null;
  facts: ReturnFact[];
  primary: ReturnCta | null;
  secondary: ReturnCta | null;
}

/* --------------------------------------------------------------- the reason */

/**
 * Long enough for a real gateway sentence, short enough that an upstream
 * message carrying a stack trace or a URL cannot push the actions off the card.
 */
export const REASON_MAX = 180;

export function capReason(reason: string | null, max: number = REASON_MAX): string | null {
  const flat = collapse(reason);
  if (!flat) return null;
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** References are short; anything longer than this is not one. */
export const REFERENCE_MAX = 64;

export function capReference(reference: string | null): string | null {
  return capReason(reference, REFERENCE_MAX);
}

/* --------------------------------------------------------------- the amount */

/**
 * The two currencies the gateway documents. A typed lookup rather than a
 * template, so an unrecognised code falls through to "digits then the code"
 * instead of rendering an undefined symbol or a hand-built prefix.
 */
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  JMD: "J$",
};

/**
 * MAJOR units as a decimal string. Anything else is refused rather than
 * formatted — a figure we cannot read is not a figure worth showing.
 */
const DECIMAL_AMOUNT = /^\d{1,15}(?:\.\d{1,4})?$/;

/**
 * `amount` arrives as a STRING on purpose, and is formatted as one.
 *
 * ★ DO NOT `parseFloat` THIS. The server sends MAJOR units as digits because a
 * binary float cannot hold a monetary figure exactly, and re-parsing it here
 * would undo the one thing the string was for. The grouping below is done on
 * the digits themselves, the decimal part is carried through untouched, and the
 * symbol is placed in front.
 *
 * Returns null for anything unreadable, so the caller omits the fact instead of
 * printing a raw server string next to the word "Amount".
 */
export function formatAmount(amount: string | null, currency: string | null): string | null {
  const trimmed = (amount ?? "").trim();
  if (!DECIMAL_AMOUNT.test(trimmed)) return null;

  const [whole = "", fraction] = trimmed.split(".");
  const grouped = whole.replace(/\B(?=(?:\d{3})+$)/g, ",");
  const digits = fraction === undefined ? grouped : `${grouped}.${fraction}`;

  const code = (currency ?? "").trim().toUpperCase();
  if (!code) return digits;
  const symbol = CURRENCY_SYMBOL[code];
  // An unknown code is printed after the figure rather than dropped: showing
  // "JMD" is informative, showing "$" would be a guess.
  return symbol ? `${symbol}${digits}` : `${digits} ${code}`;
}

/* ------------------------------------------------------------ the failures */

/**
 * Which state a refused or unanswered lookup leaves us in.
 *
 * ONLY a 400 means "this token is not a token", and that is the one refusal the
 * customer can do nothing about — so it gets the calm "nothing to check". Every
 * other failure, including a transport error (which has no status at all) and a
 * 5xx, means we simply have no answer, which is `unreachable` and says so.
 */
export function failureOutcome(httpStatus: number | null): ReturnOutcome {
  return httpStatus === 400 ? { kind: "nothing-to-check" } : { kind: "unreachable" };
}

/* -------------------------------------------------------------- the states */

function collapse(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Reference and amount, when the API had them, in that order: the reference is
 * what an organization asks for, so it is read first.
 */
function factsOf(status: PaymentStatus): ReturnFact[] {
  const facts: ReturnFact[] = [];
  const reference = capReference(status.reference);
  if (reference) facts.push({ label: "Reference", value: reference });
  const amount = formatAmount(status.amount, status.currency);
  if (amount) facts.push({ label: "Amount", value: amount });
  return facts;
}

/** The way out of here, worded for whoever is looking at it. */
function consoleCta(signedIn: boolean): ReturnCta {
  return { id: "console", label: signedIn ? "Go to the console" : "Sign in" };
}

const CHECK_AGAIN: ReturnCta = { id: "check-again", label: "Check again" };
const COPY_REFERENCE: ReturnCta = { id: "copy-reference", label: "Copy reference" };

/*
  A CONFIRMATION MIRRORS THE FAILURE, ON PURPOSE.

  Both settled states put the REFERENCE first and the console door second, so
  the one thing worth leaving this page with is the same thing either way: proof
  of what happened, in a form you can quote.

  ★ AND THERE IS NO "SIGN IN" ON A SUCCESSFUL PAYMENT.

  The console door is offered only to somebody who already has a session, where
  "Go to the console" is a way back to work they were already doing. Telling a
  customer who has just successfully paid to SIGN IN — to an operator's
  monitoring console, with an account they do not have and were never asked to
  create — is inherited from the old page's needs-session branch and made no
  sense the moment this page stopped needing a session. Dropped rather than
  reworded: a button that leads nowhere is the dead-control class this repository
  removes, and on the screen where somebody is reading "Payment received" it
  reads as "something is still expected of you".
*/
function collectedView(status: PaymentStatus, signedIn: boolean): ReturnView {
  const facts = factsOf(status);
  const reference = capReference(status.reference);
  /* The door out, and only for somebody it is actually a door for. */
  const consoleDoor = signedIn ? consoleCta(signedIn) : null;
  return {
    kind: "collected",
    tone: "good",
    headline: "Payment received",
    lines: [
      "The payment provider confirmed this payment and we have recorded it against your record.",
      reference
        ? "Copy the reference below — it is what the organization will ask for if you need to follow up."
        : "Your receipt will arrive by email once the organization sends it.",
    ],
    linesAfter: [],
    gatewayReason: null,
    facts,
    // No reference to hand over means nothing to copy, and nobody to offer the
    // console to: an operator arriving without a session gets no control at all
    // here rather than a sign-in they have no use for.
    primary: reference ? COPY_REFERENCE : consoleDoor,
    secondary: reference ? consoleDoor : null,
  };
}

function pendingView(status: PaymentStatus, signedIn: boolean): ReturnView {
  return {
    kind: "pending",
    tone: "neutral",
    headline: "Confirming your payment",
    lines: [
      "The payment provider has not finished confirming this payment yet. That is normal for the first few seconds after paying, and nothing is wrong with it.",
      "This page does not need to stay open. You will receive a receipt once it completes, and nothing is needed from you now.",
    ],
    linesAfter: [],
    gatewayReason: null,
    facts: factsOf(status),
    primary: CHECK_AGAIN,
    secondary: consoleCta(signedIn),
  };
}

/*
  THE STATE THAT MATTERS MOST.

  There is no retry here, and that is a real gap rather than an omission: the
  only way to start a payment in this product is the operator form on the
  Payments page, which needs a console session, the `paymentsWrite` ability and a
  student id — none of which a customer carries, and the status endpoint returns
  no student id by design. A true "pay again" needs a server endpoint nobody has
  scoped, and inventing a link to a page that cannot be pre-filled would be a
  dead control wearing a promise.

  So the best real action on offer is the one that gets the person unblocked:
  the reference, in one click, to quote to the organization that CAN start a new
  payment. Secondary is the console door.
*/
function failedView(status: PaymentStatus, signedIn: boolean): ReturnView {
  const reference = capReference(status.reference);
  const reason = capReason(status.reason);
  return {
    kind: "failed",
    tone: "warn",
    headline: "Payment not completed",
    lines: [
      "The payment provider reported this payment as not completed. No receipt will be issued for it.",
      reason
        ? "This is what the payment provider said:"
        : "The payment provider did not give a reason for this payment.",
    ],
    linesAfter: [
      reference
        ? "Give the reference below to the organization — they can see the full record and start a new payment for you."
        : "Contact the organization that asked for this payment, and tell them it did not complete.",
    ],
    gatewayReason: reason,
    facts: factsOf(status),
    primary: reference ? COPY_REFERENCE : consoleCta(signedIn),
    secondary: reference ? consoleCta(signedIn) : null,
  };
}

function unknownView(status: PaymentStatus, signedIn: boolean): ReturnView {
  return {
    kind: "unknown",
    tone: "neutral",
    headline: "Nothing to confirm yet",
    lines: [
      "We can see this payment, but the payment provider has not reported an outcome for it yet. For the first few seconds after paying, that is the normal answer rather than a problem.",
      "This page does not need to stay open. If it is still unconfirmed after a little while, contact the organization that asked for it.",
    ],
    gatewayReason: null,
    facts: factsOf(status),
    linesAfter: [],
    primary: CHECK_AGAIN,
    secondary: consoleCta(signedIn),
  };
}

/**
 * The whole page, as data.
 *
 * `signedIn` is the ONLY thing the caller's own browser contributes, and it
 * decides the wording of one button. It never decides an outcome.
 */
export function returnView(outcome: ReturnOutcome, options: { signedIn: boolean }): ReturnView {
  const signedIn = options.signedIn;

  switch (outcome.kind) {
    case "loading":
      return {
        kind: "loading",
        tone: "neutral",
        headline: "Checking your payment",
        lines: ["One moment — we are asking our records what became of this payment."],
        gatewayReason: null,
        facts: [],
        linesAfter: [],
        primary: null,
        secondary: null,
      };
    case "nothing-to-check":
      return {
        kind: "nothing-to-check",
        tone: "neutral",
        headline: "Nothing to check",
        lines: [
          "This link does not carry a payment reference we can look up, so there is nothing to confirm here.",
          "If you have just paid, your receipt will arrive once the payment provider confirms it. We cannot confirm it from this page, and we will not claim that we did.",
        ],
        gatewayReason: null,
        facts: [],
        linesAfter: [],
        primary: consoleCta(signedIn),
        secondary: null,
      };
    case "unreachable":
      return {
        kind: "unreachable",
        tone: "warn",
        headline: "We could not reach the payment service",
        lines: [
          "We could not check this payment just now — the request went out and nothing came back. That is not the same as your payment having failed; it says we have no answer either way.",
          "Try again in a moment, or contact the organization that asked for this payment.",
        ],
        gatewayReason: null,
        facts: [],
        linesAfter: [],
        primary: CHECK_AGAIN,
        secondary: consoleCta(signedIn),
      };
    case "status":
      switch (outcome.status.status) {
        case "collected":
          return collectedView(outcome.status, signedIn);
        case "pending":
          return pendingView(outcome.status, signedIn);
        case "failed":
          return failedView(outcome.status, signedIn);
        // An unrecognised status is the SAME claim as `unknown`, not a guess at
        // a worse one: the endpoint is free to add a value later, and the
        // honest rendering of one we do not recognise is "we do not know yet".
        default:
          return unknownView(outcome.status, signedIn);
      }
  }
}