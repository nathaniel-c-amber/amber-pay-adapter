import { useRef, useState } from "react";
import type { ApiPayment } from "@/types/api";
import { Modal } from "./Modal";
import { BTN, BTN_DANGER, INPUT, cx } from "./ui";
import { IconAlert, IconCheck, IconRefresh } from "./icons";
import { checkRefundAmount } from "@/utils/refund";
import type { RefundFailure } from "@/utils/refund";
import { formatAmount } from "@/utils/paymentReturn";

/**
 * The deliberate confirmation in front of an irreversible refund.
 *
 * WHY THE OPERATOR TYPES THE TRANSACTION ID. A "Are you sure?" dialog is a
 * reflex: it is dismissed by the same muscle that opened it, and on a page
 * where the button sits beside ordinary controls it is dismissed by accident.
 * Copying a specific reference cannot be done by reflex, and the server checks
 * the same value — so this is not theatrical friction, it is the same safety
 * catch the API enforces, surfaced where the operator can get it right.
 *
 * The safe action has initial focus (see `initialFocusRef`), Escape cancels,
 * and focus returns to the page control that opened it. None of that is left to
 * the browser's default dialog behaviour because this overlay is the console's
 * own `Modal`.
 */

type RefundMode = "full" | "partial";
type CopyState = "idle" | "copied" | "manual";

export interface RefundRequest {
  confirmation: string;
  /** Present only for a partial refund. Normalised to two decimals. */
  amount?: string;
}

export function RefundDialog({
  payment,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  payment: ApiPayment;
  busy: boolean;
  /** A refusal from the server, already classified by the page. */
  error: RefundFailure | null;
  onSubmit: (input: RefundRequest) => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [mode, setMode] = useState<RefundMode>("full");
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [copyState, setCopyState] = useState<CopyState>("idle");

  const original = (payment.amount ?? payment.originalAmount ?? "").trim() || null;
  const originalDisplay = formatAmount(original, payment.currency ?? null);
  const partial = mode === "partial" ? checkRefundAmount(amount, original) : null;
  const amountError =
    mode === "partial" && (amountTouched || amount.trim().length > 0)
      ? partial?.error ?? null
      : null;

  /*
     EXACT MATCH, comparing the trimmed input. Trimming is the one concession:
     a pasted reference that carried a trailing newline is still the same
     reference, and the trimmed value is what is sent, so client and server
     compare the same string.
  */
  const confirmationValue = confirmation.trim();
  const matches = confirmationValue === payment.transactionId;
  const canSubmit =
    !busy &&
    matches &&
    (mode === "full" || Boolean(partial && partial.amount && !partial.error));

  const copyId = async () => {
    let next: CopyState = "copied";
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(payment.transactionId);
    } catch {
      // The id is on screen and selectable; an instruction is a real fallback.
      next = "manual";
    }
    setCopyState(next);
  };

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      confirmation: confirmationValue,
      ...(mode === "partial" && partial?.amount ? { amount: partial.amount } : {}),
    });
  };

  return (
    <Modal
      title="Refund this payment?"
      eyebrow="Confirm refund"
      initialFocusRef={cancelRef}
      description={
        <>
          This reverses money at the payment provider for transaction{" "}
          <span className="mono text-ink-1">{payment.transactionId}</span>. It is not a
          status change you can undo from this console.
        </>
      }
      onClose={() => {
        // In flight, closing would hide the only place the outcome can appear
        // while the request is already moving money. Escape and the close
        // control stay inert until it settles.
        if (!busy) onClose();
      }}
      footer={
        <>
          <button ref={cancelRef} type="button" className={BTN} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={BTN_DANGER} onClick={submit} disabled={!canSubmit}>
            {busy ? (
              <>
                <IconRefresh className="animate-spin-slow" />
                Refunding…
              </>
            ) : (
              "Refund payment"
            )}
          </button>
        </>
      }
    >
      <div aria-busy={busy} className="flex flex-col gap-4">
        {/* The rule that makes a retry dangerous, stated BEFORE the commit. */}
        <div className="flex items-start gap-2 rounded-panel border border-[rgb(251_191_36/0.4)] bg-state-tint-delayed px-3 py-2">
          <span className="mt-0.5 flex-none text-text-delayed" aria-hidden>
            <IconAlert />
          </span>
          <div className="flex flex-col gap-1">
            <p className="m-0 text-sm font-semibold text-text-delayed">One refund only</p>
            <p className="m-0 text-sm leading-prose text-ink-2">
              The provider allows exactly one refund per transaction. It cannot be undone or
              retried from this console, and a second attempt will be refused. If this is the
              wrong payment or the wrong amount, stop and take it up with the provider instead.
            </p>
          </div>
        </div>

        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mono mb-1 text-micro uppercase tracking-label text-ink-3">
            Amount to refund
          </legend>

          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-1">
            <input
              type="radio"
              name="refund-mode"
              value="full"
              checked={mode === "full"}
              onChange={() => setMode("full")}
              className="mt-0.5 size-4 flex-none cursor-pointer accent-primary"
            />
            <span>
              Refund the full amount
              {originalDisplay ? (
                <span className="mono ml-1 text-ink-2">({originalDisplay})</span>
              ) : null}
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-1">
            <input
              type="radio"
              name="refund-mode"
              value="partial"
              checked={mode === "partial"}
              onChange={() => setMode("partial")}
              className="mt-0.5 size-4 flex-none cursor-pointer accent-primary"
            />
            <span>Refund part of it</span>
          </label>

          {mode === "partial" && (
            <div className="mt-1 ml-6 flex max-w-[26rem] flex-col gap-1">
              <label className="flex flex-col gap-1">
                <span className="mono text-micro uppercase tracking-label text-ink-3">
                  Amount to refund
                </span>
                <input
                  className={cx(INPUT, amountError && "border-text-suspended")}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  onBlur={() => setAmountTouched(true)}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="25.00"
                  aria-invalid={Boolean(amountError)}
                  aria-describedby="refund-amount-help refund-amount-error"
                />
              </label>
              <p id="refund-amount-help" className="m-0 text-xs leading-snug text-ink-3">
                {original ? (
                  <>
                    Original amount {originalDisplay ?? original}. More than 0, no more than the
                    original, and at most two decimal places.
                  </>
                ) : (
                  <>
                    More than 0, at most two decimal places. This deployment does not report the
                    original amount, so the console cannot check the ceiling — the server refuses
                    an amount above the original before anything moves.
                  </>
                )}
              </p>
              {amountError && (
                <p id="refund-amount-error" className="m-0 text-xs leading-snug text-text-suspended" role="alert">
                  {amountError}
                </p>
              )}
            </div>
          )}
        </fieldset>

        <div className="flex flex-col gap-2 border-t border-rule-enamel pt-3">
          <p className="m-0 text-sm leading-prose text-ink-2">
            To confirm, type or paste the transaction ID. The server checks it character for
            character, so a copied value is safer than a remembered one.
          </p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-rule-enamel bg-midnight-3 px-3 py-2">
            <span className="mono text-micro uppercase tracking-label text-ink-3">
              Transaction ID
            </span>
            <code className="mono min-w-0 text-sm font-semibold text-ink-1 wrap-anywhere">
              {payment.transactionId}
            </code>
            <button type="button" className={BTN} onClick={() => void copyId()} disabled={busy}>
              {copyState === "copied" ? "Copied" : "Copy"}
            </button>
          </div>

          {copyState !== "idle" && (
            <p className="m-0 text-xs leading-snug text-ink-3" role="status">
              {copyState === "copied"
                ? "Transaction ID copied. Paste it below."
                : "This browser would not copy it automatically — select the ID above and copy it."}
            </p>
          )}

          <label className="flex flex-col gap-1">
            <span className="mono text-micro uppercase tracking-label text-ink-3">
              Type the transaction ID to confirm
            </span>
            <input
              className={cx(INPUT, confirmationValue.length > 0 && !matches && "border-text-suspended")}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={confirmationValue.length > 0 && !matches}
              aria-describedby="refund-confirm-hint"
            />
          </label>
          <p
            id="refund-confirm-hint"
            className={cx(
              "m-0 flex items-center gap-1.5 text-xs leading-snug",
              matches ? "text-line-green" : "text-ink-3",
            )}
          >
            {matches ? (
              <>
                <IconCheck size={12} className="flex-none" aria-hidden />
                The ID matches. Refund payment is now available.
              </>
            ) : (
              "Refund payment stays unavailable until this matches the ID above exactly."
            )}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className={cx(
              "flex items-start gap-2 rounded-panel border px-3 py-2",
              error.tone === "warning"
                ? "border-[rgb(251_191_36/0.4)] bg-state-tint-delayed"
                : "border-[rgb(248_113_113/0.3)] bg-state-tint-suspended",
            )}
          >
            <span
              className={cx(
                "mt-0.5 flex-none",
                error.tone === "warning" ? "text-text-delayed" : "text-text-suspended",
              )}
              aria-hidden
            >
              <IconAlert />
            </span>
            <div className="flex flex-col gap-1">
              <p
                className={cx(
                  "m-0 text-sm font-semibold",
                  error.tone === "warning" ? "text-text-delayed" : "text-text-suspended",
                )}
              >
                {error.heading}
              </p>
              <p className="m-0 text-sm leading-prose text-ink-1">{error.message}</p>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
