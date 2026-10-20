/**
 * The refund dialog's decisions, kept pure so they can be tested.
 *
 * `web/` has no jsdom and deliberately does not test components, so the two
 * things that must not be wrong — what counts as a valid partial amount, and
 * how a refusal is read — live here rather than inside the dialog.
 *
 * The second one carries real money. A 502 from the refund endpoint has two
 * meanings that call for opposite actions:
 *
 *   - the gateway refused the refund        → nothing moved; try again or not;
 *   - the money moved but the books failed  → it is REFUNDED, and somebody must
 *                                             fix the accounting system by hand.
 *
 * Presenting the second as an error, or as a toast that disappears, invites an
 * operator to press the button again on a transaction the provider already
 * refunded. So the distinction is decided once, here, and the view is required
 * to hold the warning on the page.
 */

/** A decimal figure with at most two fraction digits. */
export const REFUND_DECIMAL = /^\d+(?:\.\d{1,2})?$/;

const MINOR_UNITS = /^(\d+)(?:\.(\d{1,2}))?$/;

/** MAJOR units ("10.5") → integer minor units (1050), or null when malformed. */
export function toMinorUnits(amount: string): number | null {
  const match = MINOR_UNITS.exec(amount.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isFinite(whole) || !Number.isFinite(fraction)) return null;
  return whole * 100 + fraction;
}

/**
 * Normalise a typed figure to the two-decimal form the API expects.
 *
 * "10" and "10.5" become "10.00" and "10.50"; anything malformed is null, so a
 * caller cannot accidentally send a value that passed no check.
 */
export function normalizeRefundAmount(amount: string): string | null {
  const minor = toMinorUnits(amount);
  if (minor === null) return null;
  const whole = Math.floor(minor / 100);
  const fraction = minor % 100;
  return `${whole}.${String(fraction).padStart(2, "0")}`;
}

export interface RefundAmountCheck {
  /** A sentence for the field, or null when the figure is usable. */
  error: string | null;
  /** The normalised figure to send, or null when there is nothing usable. */
  amount: string | null;
}

/**
 * Validate a partial refund against the original amount.
 *
 * Both bounds matter and neither is cosmetic: a zero refund is a request the
 * gateway refuses, and a figure above the original is one it may partially
 * honour or refuse with a message nobody can act on. Comparing in minor units
 * avoids the float comparison that would call 0.1 + 0.2 larger than 0.3.
 */
export function checkRefundAmount(raw: string, original: string | null): RefundAmountCheck {
  const value = raw.trim();
  if (!value) {
    return { error: "Enter the amount to refund.", amount: null };
  }
  if (!REFUND_DECIMAL.test(value)) {
    return {
      error: "Use digits with up to two decimal places — for example 25.00.",
      amount: null,
    };
  }
  const minor = toMinorUnits(value);
  if (minor === null || minor <= 0) {
    return { error: "The amount must be more than 0.", amount: null };
  }
  /*
    WITHOUT THE ORIGINAL, THE CEILING CANNOT BE CHECKED HERE — but the amount is
    still usable. The server verifies it against the sealed charge BEFORE asking
    the gateway for anything, so an over-large figure is refused with nothing
    moved; forbidding partial entry entirely would take a working operation away
    from a deployment that simply does not publish the figure.
  */
  if (original === null) {
    return { error: null, amount: normalizeRefundAmount(value) };
  }
  const originalMinor = toMinorUnits(original);
  if (originalMinor === null) {
    return { error: null, amount: normalizeRefundAmount(value) };
  }
  if (minor > originalMinor) {
    return {
      error: `The amount cannot be more than the original ${original}.`,
      amount: null,
    };
  }
  return { error: null, amount: normalizeRefundAmount(value) };
}

/* ------------------------------------------------------------- refusals */

export interface RefundRejection {
  /** HTTP status, or 0 for a transport failure where there was no answer. */
  status: number;
  code?: string;
  message?: string;
}

export type RefundFailureTone = "error" | "warning";

export interface RefundFailure {
  tone: RefundFailureTone;
  /** The dialog's / banner's heading. */
  heading: string;
  /** The server's own words where it sent any, otherwise a stated fallback. */
  message: string;
}

/**
 * Codes that mean the refund completed and only the books failed.
 *
 * The server's message is the contract the console reads, but the code is the
 * durable half of it: a message can be reworded without anybody thinking about
 * this branch, whereas a code is an identifier. Both are checked, and the
 * message check is deliberately narrow — it needs "refund", an accounting
 * target, and a failure word — so an ordinary gateway refusal containing one of
 * those words cannot be misfiled as "money moved".
 */
const BOOKS_CODES = new Set([
  "REFUND_BOOKS_FAILED",
  "REFUND_BOOKS_UPDATE_FAILED",
  "BOOKS_UPDATE_FAILED",
]);

function saysMoneyMovedButBooksFailed(code: string | undefined, message: string): boolean {
  if (code && BOOKS_CODES.has(code)) return true;
  return (
    /refund/i.test(message) &&
    /quickbooks|books|ledger|accounting/i.test(message) &&
    /could not|unable|not updated|failed|fail|still shows|must be (adjusted|reversed)|by hand/i.test(
      message,
    )
  );
}

/**
 * Read a refund refusal into the treatment the operator must see.
 *
 * The server's message is preserved verbatim wherever it exists: it is the only
 * text that can name the actual problem ("This payment was already refunded",
 * "No open invoice for STU0026"), and replacing it with "Request failed" is how
 * an operator ends up guessing.
 */
export function classifyRefundRejection(rejection: RefundRejection): RefundFailure {
  const message = (rejection.message ?? "").trim();
  const code = rejection.code;
  if (rejection.status === 502 && saysMoneyMovedButBooksFailed(code, message)) {
    return {
      tone: "warning",
      heading: "Refunded, but the books were not updated",
      message:
        message ||
        "The payment was refunded at the provider, but the accounting system could not be updated. Do not retry the refund — update the books by hand.",
    };
  }

  const fallback =
    rejection.status === 400
      ? "The amount or confirmation was not accepted. Check the figure and the transaction ID, then try again."
      : rejection.status === 404
        ? "That payment no longer exists."
        : rejection.status === 409
          ? "This payment cannot be refunded — it may already be refunded, or it was never collected."
          : rejection.status === 502
            ? "The provider refused the refund. Nothing has been reversed."
            : "The refund could not be confirmed. Check the payment's status before trying again.";

  const heading =
    rejection.status === 400
      ? "The refund was not accepted"
      : rejection.status === 404
        ? "Payment not found"
        : rejection.status === 409
          ? "This payment cannot be refunded"
          : rejection.status === 502
            ? "The provider refused the refund"
            : "The refund could not be completed";

  return { tone: "error", heading, message: message || fallback };
}
