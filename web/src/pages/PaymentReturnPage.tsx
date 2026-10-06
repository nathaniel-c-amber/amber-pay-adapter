import { useEffect, useState } from "react";
import { BTN, Card } from "@/components/ui";
import { ApiRequestError, getPaymentByTransaction } from "@/services/client";

/**
 * Where the customer arrives after the gateway has taken their payment.
 *
 * ★ THIS PAGE IS A DESTINATION, NOT A PROOF, and it must never imply otherwise.
 *
 * It is reached by a browser redirect, and a redirect can be typed. Nothing on
 * this page is derived from the gateway's own response — it reports what OUR
 * database knows about the transaction, and that is a *pending* answer until the
 * gateway's callback has been processed. The customer who has just paid does not
 * need to be told their payment may have failed; they need to be told it is
 * being confirmed, and then not to be left guessing.
 *
 * So there are three states, and the middle one is the common one:
 *   - we know nothing about this transaction yet → say so, and say why;
 *   - we know it, and it is collected → confirm plainly;
 *   - we know it, and it did not complete → say that, with the gateway's own
 *     reason when there is one.
 *
 * NEVER a success message derived from the URL. A link reading
 * `…/payment-return?status=success` is the oldest payment-confirmation forgery
 * there is, and honouring it would tell a customer a payment succeeded when no
 * money moved.
 */

/** What our database can say about a transaction. */
type PaymentState =
  | { kind: "unknown" }
  | { kind: "needs-session" }
  | { kind: "pending" }
  | { kind: "paid"; reference: string }
  | { kind: "not-paid"; reference: string; reason: string | null };

export function PaymentReturnPage({
  token,
  transactionId,
  onGoToConsole,
}: {
  /**
   * A session, when there is one.
   *
   * The lookup is authorized, so a customer with no console session cannot
   * resolve their own payment — and that is the correct trade: a public
   * endpoint keyed on a guessable transaction id is a payment-status oracle for
   * anyone who can type. The page still renders, and says what it can honestly
   * say, without one.
   */
  token: string | null;
  /** From the redirect, when the gateway supplied one. */
  transactionId: string | null;
  onGoToConsole: () => void;
}) {
  const [state, setState] = useState<PaymentState>({ kind: "unknown" });

  useEffect(() => {
    if (!transactionId) {
      setState({ kind: "unknown" });
      return;
    }
    if (!token) {
      // Not an error, and not "unknown": there is nothing to confirm BECAUSE we
      // are not allowed to look. Saying "nothing to confirm" would be a lie.
      setState({ kind: "needs-session" });
      return;
    }
    setState({ kind: "pending" });
    // Deliberately a one-shot read with no retry loop. A customer watching a
    // spinner while a backend catches up is a worse experience than an honest
    // "we are confirming this" and a way to come back.
    void getPaymentByTransaction(token, transactionId).then(
      (payment) => {
        setState(
          payment.status === "collected"
            ? { kind: "paid", reference: payment.transactionId }
            : { kind: "not-paid", reference: payment.transactionId, reason: null },
        );
      },
      (err: unknown) => {
        // A 404 here is the NORMAL case for a callback that has not landed yet,
        // not an error worth showing: the transaction was created before the
        // customer was redirected, so its absence means "not reported yet".
        if (err instanceof ApiRequestError && err.status === 404) {
          setState({ kind: "pending" });
          return;
        }
        setState({ kind: "unknown" });
      },
    );
  }, [token, transactionId]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-midnight px-4">
      <Card title="Your payment">
        <div className="flex max-w-[62ch] flex-col gap-4">
          {state.kind === 'paid' && (
            <>
              <p className="m-0 text-md font-semibold text-line-green" role="status">
                Payment received
              </p>
              <p className="m-0 text-sm leading-prose text-ink-2">
                Thank you. Your payment has been received and recorded.
              </p>
            </>
          )}

          {state.kind === 'pending' && (
            <>
              <p className="m-0 text-md font-semibold text-ink-1" role="status">
                Confirming your payment
              </p>
              <p className="m-0 text-sm leading-prose text-ink-2">
                Your bank has been told about the payment and we are waiting for confirmation. This
                page does not need to stay open — you will receive a receipt once it completes, and
                nothing more is needed from you.
              </p>
            </>
          )}

          {state.kind === 'not-paid' && (
            <>
              <p className="m-0 text-md font-semibold text-state-delayed" role="status">
                Payment not completed
              </p>
              <p className="m-0 text-sm leading-prose text-ink-2">
                {state.reason ?? 'The payment provider did not confirm this payment.'} If you were
                charged, contact the organization with the reference{' '}
                <span className="mono text-ink-1">{state.reference}</span>.
              </p>
            </>
          )}

          {state.kind === 'unknown' && (
            <>
              <p className="m-0 text-md font-semibold text-ink-1" role="status">
                Nothing to confirm
              </p>
              <p className="m-0 text-sm leading-prose text-ink-2">
                There is no payment reference on this link, so there is nothing to check. If you
                have just paid, your receipt will arrive by email once the payment provider confirms
                it.
              </p>
            </>
          )}

          {state.kind === "needs-session" && (
            <>
              <p className="m-0 text-md font-semibold text-ink-1" role="status">
                Sign in to check this payment
              </p>
              <p className="m-0 text-sm leading-prose text-ink-2">
                Confirming a payment requires a session, so nobody else can look up a payment using
                a reference they guessed. Your receipt will still arrive by email once the payment
                provider confirms it.
              </p>
            </>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={BTN} onClick={onGoToConsole}>
              {state.kind === "needs-session" ? "Sign in" : "Go to the console"}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}