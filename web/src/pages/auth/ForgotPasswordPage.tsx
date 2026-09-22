/* Forgot password — ask for a reset link.
 *
 * The screen has one job: take an address and get out of the way. Two things it
 * must not do, and both are security requirements rather than manners:
 *
 *  1. It must not reveal whether the address is registered. The backend always
 *     answers 202, so this screen always says the same thing — "if an account
 *     exists" — and never branches its copy on the outcome.
 *  2. It must not promise an email that was not sent. The wording is honest
 *     about the possibility that nothing arrived and why that might be.
 *
 * Dev builds get the token handed back by the API (as invites and 2FA codes
 * already do) so the flow can be walked through without a mailbox.
 */

import { useState } from "react";
import type { FormEvent } from "react";
import { AuthField, AuthShell } from "@/components/auth/AuthShell";
import { requestPasswordReset } from "@/services/client";
import { IconArrowRight, IconMail } from "@/components/auth/authIcons";

export function ForgotPasswordPage({
  onGoToSignIn,
  onUseResetLink,
}: {
  onGoToSignIn: () => void;
  /** Dev-only shortcut: opens the reset screen directly when the API returns a token. */
  onUseResetLink: (token: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await requestPasswordReset(email.trim());
      setDevToken(res.token ?? null);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  const signInLink = (
    <button
      type="button"
      className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
      onClick={onGoToSignIn}
    >
      Back to sign in
    </button>
  );

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        lead={`If an account exists for ${email.trim()}, a reset link is on its way. The link is single-use and expires shortly, so an older link in your inbox will stop working as soon as a new one is requested.`}
        footer={signInLink}
      >
        <div className="flex items-start gap-3 rounded-panel border border-rule-enamel bg-midnight-2 px-4 py-3">
          <span className="grid flex-none place-items-center text-line-green" aria-hidden>
            <IconMail />
          </span>
          <p className="m-0 text-md leading-prose text-ink-2">
            Nothing arrived? Check the spam folder, and confirm the address is the one your
            invitation was sent to. Access is invite-only, so an address we have no account for will
            never receive a link — ask an administrator to check.
          </p>
        </div>

        {devToken && (
          <div className="flex flex-col gap-2 rounded-panel border border-[rgb(230_161_42/0.4)] bg-state-tint-delayed px-4 py-3">
            <p className="m-0 text-xs leading-prose text-text-delayed">
              Development build: the API returned the reset token directly, so no email was needed.
            </p>
            <button
              type="button"
              className="mono cursor-pointer self-start border-0 bg-transparent p-0 text-left text-xs text-ink-1 underline underline-offset-[0.18em] hover:text-ink-2"
              onClick={() => onUseResetLink(devToken)}
            >
              Continue to reset your password
            </button>
          </div>
        )}
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      lead="Enter the address your account uses and we will send a single-use link to set a new password."
      footer={signInLink}
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <AuthField
          id="forgot-email"
          label="Work email"
          error={error}
          hint="The address your invitation was sent to."
        >
          <input
            id="forgot-email"
            className="field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2 text-md text-ink-1 placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            aria-invalid={error ? true : undefined}
          />
        </AuthField>

        <button
          type="submit"
          className="inline-flex w-full cursor-pointer items-center gap-2 rounded-panel border border-primary bg-primary px-4 py-3 text-md font-semibold text-on-primary hover:not-disabled:border-primary-hover hover:not-disabled:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
          disabled={busy || !email.trim()}
        >
          <span className="grid flex-none place-items-center" aria-hidden>
            <IconMail />
          </span>
          {busy ? "Sending…" : "Send reset link"}
          {!busy && (
            <span className="ml-auto grid place-items-center" aria-hidden>
              <IconArrowRight />
            </span>
          )}
        </button>
      </form>
    </AuthShell>
  );
}
