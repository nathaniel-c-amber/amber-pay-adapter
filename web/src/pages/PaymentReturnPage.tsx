import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BTN, BTN_PRIMARY, Card } from "@/components/ui";
import { IconAlert, IconCheck, IconClock, IconInfo, IconRefresh } from "@/components/icons";
import { ApiRequestError, getPaymentStatus } from "@/services/client";
import { hashQueryParam } from "@/router";
import { failureOutcome, returnView } from "@/utils/paymentReturn";
import type { ReturnCta, ReturnOutcome, ReturnView } from "@/utils/paymentReturn";

/**
 * Where the customer arrives after the gateway has taken their payment.
 *
 * ★ THIS PAGE IS A DESTINATION, NOT A PROOF, and it must never imply otherwise.
 *
 * It is reached by a browser redirect, and a redirect can be typed. So the first
 * thing to be clear about the new contract: the `?token=` this page reads is a
 * LOOKUP HANDLE, not proof of anything. 256 bits of base64url, minted when the
 * payment was created, carrying no customer identity and bound to no session. It
 * answers exactly one question — what does our own record say? — and it cannot
 * answer "did money move", because it has no way to know and is not asked to.
 *
 * ★ NEVER A SUCCESS MESSAGE DERIVED FROM THE URL. `…/payment-return?status=success`
 * is the oldest payment-confirmation forgery there is. This page reads ONE query
 * parameter, `token`, and uses it for nothing but a lookup; every word on screen
 * comes from the API's response. There is no code path from the address bar to a
 * headline that says a payment was collected.
 *
 * ★ AND THE HASH IS EMPTY WHEN THE BROWSER GETS HERE, which is why the page reads
 * its own query parameter rather than expecting one. The gateway's Callback API
 * URL and its Redirect URL are the same URL, so the browser POSTs a form body to
 * the webhook; a SPA cannot read a POST body, so `document` received the JSON
 * response and there was no hash to parse. The server now answers a browser with
 * a 302 to `?token=…`, and this is the page that lands.
 *
 * NO SESSION, AND THAT IS CORRECT. The previous version demanded one, on the
 * reasoning that a public endpoint keyed on a transaction id would be a
 * payment-status oracle for anyone who can type. That reasoning was sound for
 * the old handle — a gateway reference is short and people guess them — and it
 * does not apply here: this token is 256 bits of entropy, so guessing is not a
 * threat model. The alternative was asking a customer who has just handed over
 * their card details to sign in to an operator's console to be told whether the
 * payment worked, which is a worse answer than the risk it removes.
 *
 * WHAT THE PAGE IS FOR, then, is not to certify anything. It is to tell the
 * customer where their payment got to, in the words of whoever actually knows —
 * including, when a payment did not complete, the gateway's own explanation —
 * and then to offer them the next thing they can actually do. Four states, each
 * with a real action behind it, are enumerated in `@/utils/paymentReturn`, which
 * holds every word this page shows and is where the behaviour is tested.
 */

/** The headline ink per state. A typed lookup, so a new tone is a type error
 *  rather than an unstyled heading. Colour is never the only signal: each
 *  headline also carries a word and its own glyph. */
const HEADLINE_INK: Record<ReturnView["tone"], string> = {
  good: "text-line-green",
  warn: "text-state-delayed",
  neutral: "text-ink-1",
};

/** A shape mark per state, so paid and not-paid are told apart without colour. */
const STATE_GLYPH: Record<ReturnView["kind"], ReactNode> = {
  collected: <IconCheck />,
  pending: <IconClock />,
  failed: <IconAlert />,
  unknown: <IconClock />,
  unreachable: <IconAlert />,
  "nothing-to-check": <IconInfo />,
  loading: <IconRefresh className="animate-spin-slow" />,
};

type CopyState = "idle" | "copied" | "manual";

export function PaymentReturnPage({
  signedIn,
  onGoToConsole,
}: {
  /** Only ever words one button; it never contributes to an outcome. */
  signedIn: boolean;
  /** The console door — the Overview when signed in, Sign-in when not. */
  onGoToConsole: () => void;
}) {
  /*
    Read during render rather than held in state, for the same reason
    EventsPage does it: `parse()` strips this query to find the route name and
    `hashQueryParam` reads it back from the same place, so the two agree by
    construction. A hash change re-renders this page through `useRoute` and the
    new value arrives with it.
  */
  const statusToken = hashQueryParam("token")?.trim() || null;

  const [outcome, setOutcome] = useState<ReturnOutcome>({ kind: "loading" });
  const [rechecking, setRechecking] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  /*
    A LOOKUP GENERATION, not a spinner.

    Two checks can be in flight — a customer pressing "Check again" twice, or a
    slow first answer overtaken by a later one — and the older response is the
    one that would overwrite the newer truth. Every attempt takes a number and
    only the newest is allowed to write.
  */
  const attemptRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const lookup = useCallback(() => {
    if (!statusToken) return;
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    setRechecking(true);
    void getPaymentStatus(statusToken).then(
      (status) => {
        if (attemptRef.current !== attempt) return;
        setOutcome({ kind: "status", status });
        setRechecking(false);
      },
      (error: unknown) => {
        if (attemptRef.current !== attempt) return;
        // A 400 is the server saying this is not a token. Anything else —
        // including a transport error, which has no status at all — is us
        // having no answer, and the page says exactly that.
        const httpStatus = error instanceof ApiRequestError ? error.status : null;
        setOutcome(failureOutcome(httpStatus));
        setRechecking(false);
      },
    );
  }, [statusToken]);

  useEffect(() => {
    if (!statusToken) {
      // Not an error and not a spinner: there is nothing to look up, and
      // fetching nothing would spin forever waiting for an answer to a question
      // that was never asked.
      setOutcome({ kind: "nothing-to-check" });
      return;
    }
    // Deliberately a one-shot read with NO polling loop. A customer watching a
    // spinner while a backend catches up is a worse experience than an honest
    // "we are confirming this" and a button to come back to.
    lookup();
  }, [lookup, statusToken]);

  const view = returnView(outcome, { signedIn });

  const reference = view.facts.find((fact) => fact.label === "Reference")?.value ?? null;

  const copyReference = useCallback(async () => {
    if (!reference) return;
    let next: CopyState = "copied";
    try {
      // Not available outside a secure context, and refused without a user
      // gesture in some browsers. Either way the reference is on screen, so the
      // fallback is an instruction rather than a failure.
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(reference);
    } catch {
      next = "manual";
    }
    setCopyState(next);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 4000);
  }, [reference]);

  const run = useCallback(
    (cta: ReturnCta) => {
      if (cta.id === "check-again") {
        lookup();
      } else if (cta.id === "copy-reference") {
        void copyReference();
      } else {
        onGoToConsole();
      }
    },
    [copyReference, lookup, onGoToConsole],
  );

  const primary = view.primary;
  const secondary = view.secondary;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-midnight px-4 animate-[fadeIn_0.2s_ease-out]">
      <Card title="Your payment" className="w-full max-w-measure">
        <div className="flex max-w-[62ch] flex-col gap-4">
          <p
            className={`m-0 flex items-center gap-2 text-md font-semibold ${HEADLINE_INK[view.tone]}`}
            role="status"
          >
            <span className="flex-none" aria-hidden>
              {STATE_GLYPH[view.kind]}
            </span>
            {view.headline}
          </p>

          {/* Index keys, deliberately: these lists are static and never
              reordered, and two sentences of copy one day reading the same
              would otherwise be a duplicate-key warning for no reason. */}
          {view.lines.map((line, index) => (
            <p key={index} className="m-0 text-sm leading-prose text-ink-2">
              {line}
            </p>
          ))}

          {/*
            THE GATEWAY'S OWN WORDS.

            `reason` came from the API, which captured it from the gateway's
            callback — never from this address — and it is rendered as a STRING,
            so it is text and cannot become markup. It is capped by `capReason`
            because an upstream message carrying a URL or a stack trace would
            otherwise push the actions below it off the card.
          */}
          {view.gatewayReason && (
            <blockquote className="m-0 rounded-panel border border-rule-enamel bg-midnight px-3 py-2">
              <p className="m-0 text-md leading-prose text-ink-1 wrap-anywhere">
                {view.gatewayReason}
              </p>
            </blockquote>
          )}

          {view.linesAfter.map((line, index) => (
            <p key={index} className="m-0 text-sm leading-prose text-ink-2">
              {line}
            </p>
          ))}

          {/* Reference and amount, so a customer who has to follow this up has
              something to quote. Both are mono: they are data. */}
          {view.facts.length > 0 && (
            <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-5 gap-y-3 border-t border-rule-enamel-soft pt-3">
              {view.facts.map((fact) => (
                <div key={fact.label} className="flex flex-col gap-1">
                  <dt className="mono text-micro uppercase tracking-label text-ink-3">
                    {fact.label}
                  </dt>
                  <dd className="m-0 mono text-md text-ink-1 wrap-anywhere">{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {(primary || secondary) && (
            <div className="flex flex-wrap items-center gap-3">
              {primary && (
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  onClick={() => run(primary)}
                  disabled={rechecking && primary.id === "check-again"}
                >
                  {rechecking && primary.id === "check-again" ? (
                    <>
                      <IconRefresh className="animate-spin-slow" />
                      Checking…
                    </>
                  ) : (
                    primary.label
                  )}
                </button>
              )}
              {secondary && (
                <button
                  type="button"
                  className={BTN}
                  onClick={() => run(secondary)}
                  disabled={rechecking && secondary.id === "check-again"}
                >
                  {secondary.label}
                </button>
              )}
            </div>
          )}

          {copyState !== "idle" && (
            <p className="m-0 text-sm text-ink-3" role="status">
              {copyState === "copied"
                ? "Reference copied. Quote it if you contact the organization."
                : "Your browser would not let this page copy it — copy the reference above instead."}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}