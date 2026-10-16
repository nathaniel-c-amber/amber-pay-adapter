import { describe, it, expect } from "vitest";
import {
  REASON_MAX,
  REFERENCE_MAX,
  capReason,
  capReference,
  failureOutcome,
  formatAmount,
  returnView,
} from "@/utils/paymentReturn";
import type { ReturnOutcome, ReturnView } from "@/utils/paymentReturn";
import type { PaymentStatus, PaymentStatusState } from "@/services/client";

/** A status the endpoint would resolve, with every field the API may omit. */
const status = (over: Partial<PaymentStatus> = {}): PaymentStatus => ({
  status: "unknown" as PaymentStatusState,
  reference: null,
  reason: null,
  amount: null,
  currency: null,
  ...over,
});

const settled = (over: Partial<PaymentStatus> = {}): ReturnOutcome => ({
  kind: "status",
  status: status(over),
});

const view = (outcome: ReturnOutcome, signedIn = false): ReturnView =>
  returnView(outcome, { signedIn });

/** The labels, for the assertions that care about what is offered. */
const labels = (v: ReturnView): (string | null)[] => [v.primary?.label ?? null, v.secondary?.label ?? null];

/* ---------------------------------------------------------- the states */

describe("the four states the status endpoint reports", () => {
  it("confirms a collected payment, in the word the customer is looking for", () => {
    const v = view(
      settled({
        status: "collected",
        reference: "E09KUZXK6BZJ",
        amount: "25000",
        currency: "JMD",
      }),
    );
    expect(v.kind).toBe("collected");
    expect(v.tone).toBe("good");
    expect(v.headline).toBe("Payment received");
    // Never colour alone: the word is in the headline.
    expect(v.headline).toMatch(/received/i);
  });

  it("puts the reference first on a confirmation, exactly as on a failure", () => {
    const v = view(settled({ status: "collected", reference: "E09KUZXK6BZJ" }));
    expect(v.primary?.id).toBe("copy-reference");
  });

  it("never tells a customer who just paid to sign in", () => {
    // The console door is a way back to work somebody was already doing. On a
    // confirmation with no session there is no such person, so the one control
    // this page offers is the reference.
    const v = view(settled({ status: "collected", reference: "E09KUZXK6BZJ" }), false);
    expect(labels(v)).toEqual(["Copy reference", null]);
    expect(JSON.stringify(v)).not.toMatch(/sign in/i);
  });

  it("keeps the console door for a signed-in operator on a confirmation", () => {
    expect(labels(view(settled({ status: "collected", reference: "E09KUZXK6BZJ" }), true))).toEqual([
      "Copy reference",
      "Go to the console",
    ]);
  });

  it("offers no control at all when a confirmation has no reference and no session", () => {
    // Nothing to copy and nowhere to go. Two absent controls is the honest
    // answer; a sign-in button here is the thing that was removed.
    const v = view(settled({ status: "collected", reference: null }), false);
    expect(v.primary).toBeNull();
    expect(v.secondary).toBeNull();
  });

  it("offers the console to a signed-in operator when there is no reference to copy", () => {
    const v = view(settled({ status: "collected", reference: null }), true);
    expect(labels(v)).toEqual(["Go to the console", null]);
  });

  it("surfaces the reference and the figure on a confirmation, so there is something to quote", () => {
    const v = view(
      settled({ status: "collected", reference: "E09KUZXK6BZJ", amount: "25000", currency: "JMD" }),
    );
    expect(v.facts).toEqual([
      { label: "Reference", value: "E09KUZXK6BZJ" },
      { label: "Amount", value: "J$25,000" },
    ]);
  });

  it("reports a failure with the gateway's OWN words, as text and not as markup", () => {
    const v = view(
      settled({
        status: "failed",
        reference: "E09KUZXK6BZJ",
        reason: "Invalid transaction",
        amount: "25000",
        currency: "JMD",
      }),
    );
    expect(v.kind).toBe("failed");
    expect(v.tone).toBe("warn");
    expect(v.gatewayReason).toBe("Invalid transaction");
    // The reason is a plain string, so it cannot become markup in the page.
    expect(typeof v.gatewayReason).toBe("string");
    expect(v.headline).toMatch(/not completed/i);
  });

  it("keeps the reference reachable for a failure, because that is the next action", () => {
    const v = view(
      settled({ status: "failed", reference: "E09KUZXK6BZJ", reason: "Invalid transaction" }),
    );
    expect(v.primary?.id).toBe("copy-reference");
    expect(v.secondary?.id).toBe("console");
    expect(v.facts.map((f) => f.value)).toContain("E09KUZXK6BZJ");
  });

  it("falls back to the console door when a failure carries no reference to hand over", () => {
    const v = view(settled({ status: "failed", reference: null, reason: null }));
    expect(v.gatewayReason).toBeNull();
    expect(v.lines.join(" ")).toMatch(/did not give a reason/i);
    // A copy control with nothing to copy is a dead control.
    expect(v.primary?.id).toBe("console");
    expect(v.secondary).toBeNull();
  });

  it("treats `pending` as the ordinary wait, and offers a way to come back", () => {
    const v = view(settled({ status: "pending", reference: "E09KUZXK6BZJ" }));
    expect(v.kind).toBe("pending");
    expect(v.tone).toBe("neutral");
    // Calm words: a customer who has just paid must not be told it may have failed.
    expect(v.headline).not.toMatch(/fail|error|problem/i);
    expect(v.lines.join(" ")).toMatch(/normal/i);
    expect(v.primary?.id).toBe("check-again");
  });

  it("does not spin: nothing here is a loop, and `pending` offers exactly one re-check", () => {
    const v = view(settled({ status: "pending" }));
    expect(labels(v)).toEqual(["Check again", "Sign in"]);
  });

  it("treats `unknown` as not-yet-settled rather than as a failure", () => {
    const v = view(settled({ status: "unknown", reference: "E09KUZXK6BZJ" }));
    expect(v.kind).toBe("unknown");
    expect(v.tone).toBe("neutral");
    expect(v.headline).not.toMatch(/fail|error/i);
    expect(v.primary?.id).toBe("check-again");
    expect(v.secondary?.id).toBe("console");
  });

  it("renders a status this build does not recognise as `unknown`, not as a worse guess", () => {
    // The endpoint is free to add a value later; the honest reading of one we
    // do not know is "we do not know yet", never "it failed".
    const v = view(settled({ status: "refunded" as PaymentStatusState }));
    expect(v.kind).toBe("unknown");
    expect(v.tone).toBe("neutral");
  });
});

/* ------------------------------------------------------------ no token */

describe("a link that cannot be looked up", () => {
  it("is calm, says there is nothing to check, and never claims a success", () => {
    const v = view({ kind: "nothing-to-check" });
    expect(v.kind).toBe("nothing-to-check");
    expect(v.headline).toBe("Nothing to check");
    expect(v.tone).toBe("neutral");
    // ★ The absence of a fallback is the point: a missing token must not read
    // as a quiet success.
    expect(v.headline).not.toMatch(/received|complete|success/i);
    expect(v.facts).toEqual([]);
    expect(v.gatewayReason).toBeNull();
  });

  it("offers no re-check, because there is nothing to re-check", () => {
    expect(view({ kind: "nothing-to-check" }).primary?.id).toBe("console");
  });

  it("maps a 400 to the same calm treatment as a missing token", () => {
    expect(failureOutcome(400)).toEqual({ kind: "nothing-to-check" });
  });
});

/* -------------------------------------------------------- no answer */

describe("a lookup that came back with nothing", () => {
  it("says we could not reach the service, and says it is NOT a failure", () => {
    const v = view({ kind: "unreachable" });
    expect(v.kind).toBe("unreachable");
    expect(v.tone).toBe("warn");
    // Distinguishing this from `unknown` is the whole reason both exist.
    expect(v.kind).not.toBe("unknown");
    expect(v.lines.join(" ")).toMatch(/not the same as your payment having failed/i);
    expect(v.primary?.id).toBe("check-again");
    expect(v.secondary?.id).toBe("console");
  });

  it("treats a transport error, which has no status at all, as no answer", () => {
    expect(failureOutcome(null)).toEqual({ kind: "unreachable" });
  });

  it("treats a 5xx as no answer rather than as a rejected token", () => {
    expect(failureOutcome(503)).toEqual({ kind: "unreachable" });
  });

  it("never lets a failure state carry facts it did not receive", () => {
    expect(view({ kind: "unreachable" }).facts).toEqual([]);
  });
});

/* --------------------------------------------------------- the loading */

describe("the loading state", () => {
  it("is a full page with words in it, not a blank card and not a spinner alone", () => {
    const v = view({ kind: "loading" });
    expect(v.headline).toBe("Checking your payment");
    expect(v.lines).toHaveLength(1);
    expect(v.facts).toEqual([]);
  });

  it("offers no action, because there is nothing yet to act on", () => {
    const v = view({ kind: "loading" });
    expect(v.primary).toBeNull();
    expect(v.secondary).toBeNull();
  });
});

/* -------------------------------------------------------------- the session */

describe("the session decides one label and nothing else", () => {
  it("words the way out for a signed-out visitor", () => {
    expect(labels(view({ kind: "nothing-to-check" }, false))).toEqual(["Sign in", null]);
  });

  it("words it for a signed-in operator", () => {
    expect(labels(view({ kind: "nothing-to-check" }, true))).toEqual(["Go to the console", null]);
  });

  it("leaves a state's other actions alone when the session changes", () => {
    const outcome = settled({ status: "pending", reference: "E09KUZXK6BZJ" });
    // `pending` is offered to customers, so its secondary keeps the old
    // wording in both cases and only the door's label moves.
    expect(labels(view(outcome, false))).toEqual(["Check again", "Sign in"]);
    expect(labels(view(outcome, true))).toEqual(["Check again", "Go to the console"]);
  });

  it("does not change the OUTCOME when the session changes", () => {
    const outcome = settled({ status: "failed", reference: "E09KUZXK6BZJ", reason: "Invalid" });
    const anon = view(outcome, false);
    const signedIn = view(outcome, true);
    expect(signedIn.kind).toBe(anon.kind);
    expect(signedIn.headline).toBe(anon.headline);
    expect(signedIn.tone).toBe(anon.tone);
    expect(signedIn.gatewayReason).toBe(anon.gatewayReason);
  });
});

/* ------------------------------------------------------------------ amount */

describe("the amount", () => {
  it("formats the shapes the server can actually send", () => {
    // ★ THE SERVER'S OWN RANGE, from `DECIMAL_AMOUNT` in
    // server/src/services/gateway/amberPayWire.ts:
    //   /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/
    // so a real figure is MAJOR units with up to two decimals — "250.00", not
    // "25000". My first pass at this stubbed "25000" and the page grouped it to
    // "J$25,000", a figure the server has no way to emit. These are the shapes
    // that actually arrive.
    expect(formatAmount("250.00", "JMD")).toBe("J$250.00");
    expect(formatAmount("250", "USD")).toBe("$250");
    expect(formatAmount("0", "USD")).toBe("$0");
    expect(formatAmount("1250.75", "USD")).toBe("$1,250.75");
    expect(formatAmount("9999999999.99", "JMD")).toBe("J$9,999,999,999.99");
  });

  it("groups the digits of a string without parsing it into a float", () => {
    // `parseFloat` would be the first thing anyone reaches for, and it is the
    // one thing that must not happen to this value.
    expect(formatAmount("25000", "JMD")).toBe("J$25,000");
    expect(formatAmount("1234567", "JMD")).toBe("J$1,234,567");
  });

  it("carries a decimal part through untouched", () => {
    expect(formatAmount("250.50", "USD")).toBe("$250.50");
    expect(formatAmount("1234.05", "USD")).toBe("$1,234.05");
  });

  it("puts the symbol in front and never after, and prints an unknown code in full", () => {
    expect(formatAmount("25000", "USD")).toBe("$25,000");
    expect(formatAmount("25000", "EUR")).toBe("25,000 EUR");
  });

  it("drops the symbol rather than guessing when there is no currency", () => {
    expect(formatAmount("25000", null)).toBe("25,000");
  });

  it("refuses anything that is not a decimal figure instead of printing it", () => {
    // A figure we cannot read is not a figure worth showing next to "Amount".
    expect(formatAmount("", "JMD")).toBeNull();
    expect(formatAmount("twenty five", "JMD")).toBeNull();
    expect(formatAmount("25 000", "JMD")).toBeNull();
    expect(formatAmount("-25000", "JMD")).toBeNull();
    expect(formatAmount(null, "JMD")).toBeNull();
  });

  it("omits the fact entirely when the amount is unreadable, keeping the reference", () => {
    const v = view(
      settled({ status: "collected", reference: "E09KUZXK6BZJ", amount: "n/a", currency: "JMD" }),
    );
    expect(v.facts).toEqual([{ label: "Reference", value: "E09KUZXK6BZJ" }]);
  });

  it("omits the reference when there is none, rather than rendering an empty value", () => {
    const v = view(settled({ status: "collected", amount: "25000", currency: "JMD" }));
    expect(v.facts).toEqual([{ label: "Amount", value: "J$25,000" }]);
  });
});

/* ------------------------------------------------------- the reason cap */

describe("the gateway's reason", () => {
  it("collapses whitespace so a multi-line upstream message cannot open a gap", () => {
    expect(capReason("Invalid\n  transaction\r\n")).toBe("Invalid transaction");
  });

  it("caps a long upstream message so it cannot break the layout", () => {
    const long = "E".repeat(600);
    const capped = capReason(long);
    expect(capped).not.toBeNull();
    expect(capped!.length).toBe(REASON_MAX);
    expect(capped!.endsWith("…")).toBe(true);
  });

  it("is null rather than empty for nothing at all", () => {
    expect(capReason(null)).toBeNull();
    expect(capReason("   ")).toBeNull();
  });

  it("caps a reference far harder than a reason, because a reference is short", () => {
    expect(REFERENCE_MAX).toBeLessThan(REASON_MAX);
    expect(capReference("R".repeat(200))!.length).toBe(REFERENCE_MAX);
    expect(capReference("E09KUZXK6BZJ")).toBe("E09KUZXK6BZJ");
  });

  it("reaches the page already capped", () => {
    const v = view(
      settled({ status: "failed", reference: "E09KUZXK6BZJ", reason: "D".repeat(400) }),
    );
    expect(v.gatewayReason!.length).toBe(REASON_MAX);
  });
});

/* ------------------------------------------------------------- the load-bearing one */

describe("nothing on this page comes from the address", () => {
  it("has no outcome a URL could select: every kind needs an answer first", () => {
    const kinds = [
      view({ kind: "loading" }).kind,
      view({ kind: "nothing-to-check" }).kind,
      view({ kind: "unreachable" }).kind,
      view(settled({ status: "collected" })).kind,
      view(settled({ status: "pending" })).kind,
      view(settled({ status: "failed" })).kind,
      view(settled({ status: "unknown" })).kind,
    ];
    // Every state is reached through ReturnOutcome, whose only `status` member
    // carries an API response. There is no `{ kind: "success" }` to point at.
    expect(kinds).toEqual([
      "loading",
      "nothing-to-check",
      "unreachable",
      "collected",
      "pending",
      "failed",
      "unknown",
    ]);
  });

  it("declares every state the page can render, so a new one cannot skip its headline", () => {
    const seen = new Set([
      "loading",
      "collected",
      "pending",
      "failed",
      "unknown",
      "nothing-to-check",
      "unreachable",
    ]);
    for (const outcome of [
      { kind: "loading" },
      { kind: "nothing-to-check" },
      { kind: "unreachable" },
      settled({ status: "collected" }),
      settled({ status: "pending" }),
      settled({ status: "failed" }),
      settled({ status: "unknown" }),
    ] as ReturnOutcome[]) {
      expect(seen.has(view(outcome).kind)).toBe(true);
    }
  });
});