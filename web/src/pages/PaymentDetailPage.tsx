/**
 * One payment, and the one irreversible action the console offers on it.
 *
 * The route's parameter is the GATEWAY'S transaction reference, not our payment
 * uuid: a reference is what the lifecycle events carry and what an operator can
 * actually see, whereas the uuid is minted here and never leaves the API. The
 * page resolves the reference through the authorized lookup, then uses the
 * resolved payment's own id for the refund — the two are never conflated.
 *
 * Refund eligibility is DERIVED, not a flag on the payload: only a payment whose
 * status is `collected` may be refunded. A refunded payment says so and offers
 * nothing further, because the provider allows exactly one refund per
 * transaction.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiPayment, ApiRefund } from "@/types/api";
import {
  ApiRequestError,
  getPaymentByTransaction,
  refundPayment,
  UnauthorizedError,
} from "@/services/client";
import {
  BTN,
  BTN_DANGER,
  Card,
  ErrorState,
  LoadingState,
  PageHeader,
  PaymentStatusBadge,
} from "@/components/ui";
import { Can, Cannot } from "@/components/Can";
import { IconAlert, IconCheck, IconChevronRight } from "@/components/icons";
import { RefundDialog } from "@/components/RefundDialog";
import type { RefundRequest } from "@/components/RefundDialog";
import { ABILITY } from "@/utils/permissions";
import { formatDateTime } from "@/utils/datetime";
import { classifyRefundRejection } from "@/utils/refund";
import type { RefundFailure } from "@/utils/refund";
import { formatAmount } from "@/utils/paymentReturn";

export function PaymentDetailPage({
  transactionId,
  token,
  onBack,
  onRequireSignIn,
}: {
  /** The gateway transaction reference from the route. */
  transactionId: string;
  /** Null in a demo/guest session, where there is no API record to read. */
  token: string | null;
  onBack: () => void;
  onRequireSignIn?: () => void;
}) {
  const [payment, setPayment] = useState<ApiPayment | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [loadFailure, setLoadFailure] = useState<{ status: number; message: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  /* A ref as well as the state flag: two clicks in the same tick both see the
     pre-render `busy`, and the second must not become a second refund request. */
  const submitting = useRef(false);
  const [refundError, setRefundError] = useState<RefundFailure | null>(null);
  /**
   * The "money moved, books did not" warning. It lives at PAGE level and is
   * never a toast: it needs somebody to finish the job by hand, so closing the
   * dialog or looking away must not erase it.
   */
  const [followUp, setFollowUp] = useState<RefundFailure | null>(null);
  const [lastRefund, setLastRefund] = useState<ApiRefund | null>(null);
  /** The figure this request sent, so a partial refund can be stated even when
   *  the payment read carries no amount. */
  const [lastRefundAmount, setLastRefundAmount] = useState<string | null>(null);
  /* The control that opened the dialog disappears on success, so focus cannot
     return to it. This moves it to the new refunded state instead of dropping
     it on <body>. */
  const [justRefunded, setJustRefunded] = useState(false);
  const refundedHeadingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (!justRefunded) return;
    refundedHeadingRef.current?.focus();
    setJustRefunded(false);
  }, [justRefunded]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setPayment(null);
      setLoadFailure(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadFailure(null);
    getPaymentByTransaction(token, transactionId).then(
      (found) => {
        if (cancelled) return;
        setPayment(found);
        setLoading(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) {
          onRequireSignIn?.();
          return;
        }
        setLoadFailure({
          status: error instanceof ApiRequestError ? error.status : 0,
          message:
            error instanceof Error && error.message
              ? error.message
              : "The payment could not be read.",
        });
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, transactionId, reloadKey, onRequireSignIn]);

  /**
   * Re-read the payment after a refund, so the status on screen is the server's
   * rather than the one this request happened to return. Best-effort: the refund
   * already succeeded and a failed refresh must not turn that into an error.
   */
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setPayment(await getPaymentByTransaction(token, transactionId));
    } catch {
      // Keep the response's own record; the next visit re-reads it.
    }
  }, [token, transactionId]);

  const submitRefund = useCallback(
    async (input: RefundRequest) => {
      if (!token || !payment || busy || submitting.current) return;
      submitting.current = true;
      setBusy(true);
      setRefundError(null);
      try {
        const result = await refundPayment(token, payment.id, input);
        setPayment(result.payment);
        setLastRefund(result.refund ?? null);
        setLastRefundAmount(input.amount ?? null);
        setConfirming(false);
        setJustRefunded(true);
        /*
          The API may answer 200 and still report that the books were not
          reversed — the money HAS moved by then, so that is a follow-up
          warning, never an error and never a reason to offer the button again.
        */
        if (
          result.refund?.accountingReversal === "failed" ||
          result.refund?.accountingReversal === "manual-adjustment-required"
        ) {
          setFollowUp({
            tone: "warning",
            heading:
              result.refund.accountingReversal === "manual-adjustment-required"
                ? "Refunded, but the books need adjusting"
                : "Refunded, but the books were not updated",
            message:
              result.refund.message ||
              "The payment was refunded at the provider, but the accounting record still shows it. Correct it by hand.",
          });
        }
        void refresh();
      } catch (error: unknown) {
        if (error instanceof UnauthorizedError) {
          onRequireSignIn?.();
          return;
        }
        const failure = classifyRefundRejection({
          status: error instanceof ApiRequestError ? error.status : 0,
          code: error instanceof ApiRequestError ? error.code : undefined,
          message: error instanceof Error ? error.message : undefined,
        });
        if (failure.tone === "warning") {
          /*
            The refund HAPPENED. Close the dialog and leave a durable warning on
            the page: this is not an error to retry, it is work for a person.
          */
          setFollowUp(failure);
          setLastRefundAmount(input.amount ?? null);
          setConfirming(false);
          setJustRefunded(true);
          void refresh();
        } else {
          // Keep the dialog open, the typed confirmation intact, and the
          // server's words in front of the operator so they can correct it.
          setRefundError(failure);
        }
      } finally {
        submitting.current = false;
        setBusy(false);
      }
    },
    [token, payment, busy, refresh, onRequireSignIn],
  );

  const originalDisplay = payment
    ? formatAmount(payment.amount ?? payment.originalAmount ?? null, payment.currency ?? null)
    : null;
  const refundedDisplay = payment
    ? formatAmount(
        lastRefundAmount ?? lastRefund?.amount ?? payment.refundAmount ?? null,
        lastRefund?.currency ?? payment.currency ?? null,
      )
    : null;
  const refundedAt = lastRefund?.refundedAt ?? payment?.refundedAt ?? null;
  const refundedScope = lastRefund?.scope ?? null;

  const header = (
    <PageHeader
      title="Payment detail"
      lead="One payment, resolved from its gateway reference. It shows the record's own status and references — never the customer's details."
      actions={
        <button type="button" className={BTN} onClick={onBack}>
          <IconChevronRight className="rotate-180" />
          Back to payments
        </button>
      }
    />
  );

  if (!token) {
    return (
      <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
        {header}
        <Card title="No live payment record">
          <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-2">
            This console is in demonstration mode, so there is no API record behind reference{" "}
            <span className="mono text-ink-1">{transactionId}</span> — and a demonstration must
            never offer a button that appears to move real money. Sign in to a live deployment to
            read payments and request refunds.
          </p>
        </Card>
      </div>
    );
  }

  if (loading && !payment) {
    return (
      <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
        {header}
        <LoadingState label="Loading the payment…" />
      </div>
    );
  }

  if (!payment) {
    return (
      <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
        {header}
        {loadFailure?.status === 404 ? (
          <Card title="No payment with that reference">
            <div className="flex flex-col items-start gap-3">
              <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-2">
                Nothing in this organization&apos;s payments matches{" "}
                <span className="mono text-ink-1">{transactionId}</span>. It may belong to
                another organization, or the reference may have been copied incompletely.
              </p>
              <button type="button" className={BTN} onClick={onBack}>
                Back to payments
              </button>
            </div>
          </Card>
        ) : (
          <ErrorState
            title="Can't load this payment"
            lead={loadFailure?.message ?? "The payment could not be read."}
            retryLabel="Try again"
            onRetry={() => setReloadKey((key) => key + 1)}
          />
        )}
      </div>
    );
  }

  const collected = payment.status === "collected";
  const refunded = payment.status === "refunded";

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      {header}

      {/*
        THE FOLLOW-UP BANNER. Warning tone, a worded heading, and instructions —
        not colour alone. It stays for as long as this page is mounted, because
        the accounting system still disagrees with the provider.
      */}
      {followUp && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-panel border border-[rgb(251_191_36/0.4)] bg-state-tint-delayed px-3 py-2"
        >
          <span className="mt-0.5 flex-none text-text-delayed" aria-hidden>
            <IconAlert />
          </span>
          <div className="flex flex-col gap-1">
            <p className="m-0 text-sm font-semibold text-text-delayed">{followUp.heading}</p>
            <p className="m-0 text-sm leading-prose text-ink-1">{followUp.message}</p>
            <p className="m-0 text-sm leading-prose text-ink-2">
              The money has already been returned. Do not retry this refund — correct the
              accounting record for transaction{" "}
              <span className="mono text-ink-1">{payment.transactionId}</span> by hand.
            </p>
          </div>
        </div>
      )}

      <Card title="Payment" meta={<span className="mono">{payment.transactionId}</span>}>
        <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-5 gap-y-4">
          <div className="flex flex-col gap-1.5">
            <dt className="mono text-micro uppercase tracking-label text-ink-3">Status</dt>
            <dd className="m-0">
              <PaymentStatusBadge status={payment.status} />
            </dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="mono text-micro uppercase tracking-label text-ink-3">Transaction ID</dt>
            <dd className="m-0 mono text-md text-ink-1 wrap-anywhere">{payment.transactionId}</dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="mono text-micro uppercase tracking-label text-ink-3">Payment ID</dt>
            <dd className="m-0 mono text-md text-ink-1 wrap-anywhere">{payment.id}</dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="mono text-micro uppercase tracking-label text-ink-3">Processed</dt>
            <dd className="m-0 text-md text-ink-1">{formatDateTime(payment.processedAt)}</dd>
          </div>
          {originalDisplay && (
            <div className="flex flex-col gap-1.5">
              <dt className="mono text-micro uppercase tracking-label text-ink-3">Original amount</dt>
              <dd className="m-0 mono text-md font-semibold text-ink-1">{originalDisplay}</dd>
            </div>
          )}
        </dl>
      </Card>

      <Card title="Refund">
        {refunded ? (
          <div className="flex items-start gap-2.5" role="status">
            <span className="mt-0.5 flex-none text-line-green" aria-hidden>
              <IconCheck />
            </span>
            <div className="flex flex-col gap-1">
              <h3
                ref={refundedHeadingRef}
                tabIndex={-1}
                className="m-0 text-md font-semibold text-ink-1 focus-visible:outline-none"
              >
                This payment has been refunded.
              </h3>
              <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-2">
                The provider allows one refund per transaction, so no further refund can be
                requested from this console. The reversal is reflected in the accounting system
                unless a follow-up is shown above.
              </p>
              {(refundedDisplay || refundedAt || refundedScope) && (
                <p className="m-0 mono text-sm text-ink-3">
                  {refundedScope === "partial" ? "Partially refunded" : "Refunded"}
                  {refundedDisplay ? <> · {refundedDisplay}</> : null}
                  {refundedAt ? <> · {formatDateTime(refundedAt)}</> : null}
                </p>
              )}
            </div>
          </div>
        ) : collected && followUp ? (
          /*
            The refresh after the warning failed, so the record still says
            `collected` while the banner says the money moved. The button must
            NOT come back: the one-refund rule makes a second attempt both
            futile and alarming.
          */
          <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-2">
            A refund has already been attempted for this payment. Do not submit another one —
            follow the instructions in the warning above.
          </p>
        ) : collected ? (
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-2">
              This payment was collected and can be refunded once, in full or in part. A refund
              returns money at the provider and cannot be undone here.
            </p>
            <Can ability={ABILITY.paymentsWrite}>
              <div>
                <button
                  type="button"
                  className={BTN_DANGER}
                  onClick={() => {
                    setRefundError(null);
                    setConfirming(true);
                  }}
                >
                  Refund payment…
                </button>
              </div>
            </Can>
            <Cannot ability={ABILITY.paymentsWrite}>
              <p className="m-0 mono text-xs text-ink-3">
                Refunding requires write access on the payments scope.
              </p>
            </Cannot>
          </div>
        ) : (
          <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-2">
            {payment.status === "initiated"
              ? "This payment has not been collected yet. Only a collected payment can be refunded."
              : "This payment was not collected, so there is no money to return. Only a collected payment can be refunded."}
          </p>
        )}
      </Card>

      {confirming && collected && !followUp && (
        <RefundDialog
          payment={payment}
          busy={busy}
          error={refundError}
          onSubmit={(input) => void submitRefund(input)}
          onClose={() => {
            if (busy) return;
            setConfirming(false);
            setRefundError(null);
          }}
        />
      )}
    </div>
  );
}
