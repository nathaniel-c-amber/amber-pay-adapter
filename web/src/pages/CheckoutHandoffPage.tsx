import { useEffect, useRef, useState } from "react";
import { BTN, BTN_PRIMARY, Card } from "@/components/ui";
import type { ApiCheckoutSession } from "@/types/api";

/**
 * Hands the customer over to the payment gateway.
 *
 * ★ WHY THIS PAGE EXISTS AT ALL: THE BROWSER POSTS TO THE GATEWAY, NOT TO US.
 *
 * There is no "pay here" form. This page builds a `<form>` carrying the
 * gateway's own parameters, points it at the gateway's checkout endpoint, and
 * submits it. The customer never enters a card number into anything this
 * application renders, and the request never touches this origin — which is the
 * reason the CSP names the gateway in `form-action`, and the reason that is the
 * one deliberate widening in the security headers.
 *
 * IT SUBMITS AUTOMATICALLY, and that is a decision with a cost worth naming: an
 * automatic cross-origin POST can be blocked (a CSP, an extension, a browser
 * setting), and the person who is blocked is a customer who has been told they
 * are being taken to pay. So the automatic submission is treated as an
 * enhancement rather than the only route — there is a real button beneath it,
 * and if the form has not submitted within a moment the page says so plainly
 * rather than appearing to hang.
 *
 * EVERYTHING IS RENDERED FROM THE SESSION WE WERE GIVEN, never from props this
 * page can be navigated to. A checkout page reachable by URL with a query
 * string could be pointed at a destination of somebody else's choosing, so the
 * session is passed in memory and the page holds no address it can be reloaded
 * from.
 */
export function CheckoutHandoffPage({
  checkout,
  onCancelled,
}: {
  /** The signed parameters, held in memory by the caller. */
  checkout: ApiCheckoutSession;
  onCancelled: () => void;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    // The form is in the document by the time this runs; `requestSubmit` rather
    // than `submit` so the submit event fires and a blocked post is observable
    // rather than silent.
    const timer = window.setTimeout(() => {
      formRef.current?.requestSubmit();
    }, 50);

    // If the form is STILL here after this long, the navigation was blocked —
    // by a policy, an extension, or a browser that refused the cross-origin
    // post. Say so, and show the button.
    const giveUp = window.setTimeout(() => setBlocked(true), 1200);

    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(giveUp);
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-midnight px-4">
      <Card title="Taking you to secure payment">
        <div className="flex max-w-[62ch] flex-col gap-4">
          {checkout.simulated === true && (
            <div className="rounded-panel border border-state-delayed bg-midnight-2 px-4 py-3">
              <p className="m-0 text-md font-semibold text-state-delayed">
                This is a test checkout
              </p>
              <p className="m-0 mt-1 text-sm leading-prose text-ink-2">
                No payment was requested from the gateway. The form below was built locally, so
                submitting it will not complete a payment.
              </p>
            </div>
          )}

          <p className="m-0 text-sm leading-prose text-ink-2">
            Your card details are entered on the payment provider's own page. This application
            never sees or stores them.
          </p>

          {/*
            Rendered rather than submitted from JavaScript with a `fetch`: the
            gateway expects a real browser form POST, and a fetch would arrive
            without the navigation their page is built around.

            NO `key`/`defaultValue` CONTROLLED-INPUT TRAP HERE: these are hidden
            inputs carrying values we were handed, not fields a person edits, so
            `defaultValue` is correct and a controlled `value` would be a
            read-only field fighting React.
          */}
          <form
            ref={formRef}
            method="POST"
            action={checkout.checkoutUrl}
            className="contents"
          >
            {Object.entries(checkout.params).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={String(value)} readOnly />
            ))}
            <noscript>
              <button type="submit" className={BTN_PRIMARY}>
                Continue to payment
              </button>
            </noscript>
          </form>

          {blocked ? (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-sm leading-prose text-text-suspended" role="alert">
                Your browser did not continue automatically. This can happen when an extension or a
                privacy setting blocks cross-site redirects. Use the button to continue.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  onClick={() => formRef.current?.requestSubmit()}
                >
                  Continue to payment
                </button>
                <button type="button" className={BTN} onClick={onCancelled}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="m-0 text-sm text-ink-3" role="status" aria-live="polite">
              Redirecting to secure payment…
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}