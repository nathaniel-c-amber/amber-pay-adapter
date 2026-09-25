/* Reset password — redeem the emailed token for a new password.
 *
 * Reached from `#/reset/<token>`, so it must work with no session and survive
 * a page reload (the token lives in the URL, not in component state).
 *
 * The page is honest about the two failure modes a reset link actually has —
 * expired, or already used. They need different advice ("request a new link" vs
 * "sign in with the password you already set"), so the server's message is
 * surfaced rather than flattened into "something went wrong". A dead token also
 * offers the way out: a fresh link request, right there.
 */

import { useState } from "react";
import type { FormEvent } from "react";
import { AuthField, AuthShell } from "@/components/auth/AuthShell";
import { PasswordRequirements } from "@/components/auth/PasswordRequirements";
import { resetPassword } from "@/services/client";
import { meetsPasswordRules } from "@/utils/passwordRules";
import { IconShield, IconVerified, IconWarn } from "@/components/auth/authIcons";

export function ResetPasswordPage({
  token,
  onGoToSignIn,
  onRequestNewLink,
}: {
  token: string | null;
  onGoToSignIn: () => void;
  onRequestNewLink: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [deadLink, setDeadLink] = useState(false);

  const allMet = meetsPasswordRules(password);
  const matches = confirm.length > 0 && confirm === password;

  const signInLink = (
    <button
      type="button"
      className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
      onClick={onGoToSignIn}
    >
      Go to sign in
    </button>
  );

  if (!token) {
    return (
      <AuthShell
        title="This reset link is incomplete"
        lead="The link is missing its token. Reset links are single-use and time-limited, so a link copied or forwarded by hand often loses the part that matters."
        footer={signInLink}
      >
        <div className="flex items-start gap-3 rounded-panel border border-[rgb(251_191_36/0.34)] bg-midnight-2 px-4 py-3">
          <span className="grid flex-none place-items-center text-text-delayed" aria-hidden>
            <IconWarn />
          </span>
          <p className="m-0 text-md leading-prose text-ink-2">
            Open the link directly from the email rather than copying it, or request a new one.
          </p>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell
        title="Password updated"
        lead="Your new password is in effect and the reset link has been used up. Signing in still requires a second factor by email."
        footer={signInLink}
      >
        <div className="flex items-start gap-3 rounded-panel border border-rule-enamel bg-midnight-2 px-4 py-3">
          <span className="grid flex-none place-items-center text-line-green" aria-hidden>
            <IconVerified />
          </span>
          <p className="m-0 text-md leading-prose text-ink-2">
            No session was started by the reset — it changed the credential, nothing more.
          </p>
        </div>
      </AuthShell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!allMet) {
      setError("The password does not yet meet every requirement below.");
      return;
    }
    if (!matches) {
      setError("The two passwords do not match.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The password could not be reset.";
      // A used or expired token cannot be retried — retrying the same form
      // would fail forever, so the dead-link state replaces it.
      if (/expired|already been used/i.test(message)) {
        setDeadLink(true);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  if (deadLink) {
    return (
      <AuthShell
        title="This reset link no longer works"
        lead="It has either expired or already been used. Only the most recent link is valid, and each one works exactly once."
        footer={signInLink}
      >
        <div className="flex items-start gap-3 rounded-panel border border-[rgb(251_191_36/0.34)] bg-midnight-2 px-4 py-3">
          <span className="grid flex-none place-items-center text-text-delayed" aria-hidden>
            <IconWarn />
          </span>
          <p className="m-0 text-md leading-prose text-ink-2">
            If you already set a new password, sign in with it. Otherwise request a fresh link — it
            will replace this one.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-panel border border-primary bg-primary px-4 py-3 text-md font-semibold text-on-primary hover:border-primary-hover hover:bg-primary-hover"
          onClick={onRequestNewLink}
        >
          Request a new link
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      lead="Pick a password you have not used here before. The requirements below resolve as you type."
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <AuthField id="reset-password" label="New password" error={error}>
          <input
            id="reset-password"
            className="field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2 text-md text-ink-1 hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            aria-describedby="reset-rules"
          />
        </AuthField>

        <PasswordRequirements value={password} id="reset-rules" />

        <AuthField id="reset-confirm" label="Confirm new password">
          <input
            id="reset-confirm"
            className="field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2 text-md text-ink-1 hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
            aria-invalid={confirm.length > 0 && !matches ? true : undefined}
          />
        </AuthField>

        <button
          type="submit"
          className="inline-flex w-full cursor-pointer items-center gap-2 rounded-panel border border-primary bg-primary px-4 py-3 text-md font-semibold text-on-primary hover:not-disabled:border-primary-hover hover:not-disabled:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
          disabled={busy || !allMet || !matches}
        >
          <span className="grid flex-none place-items-center" aria-hidden>
            <IconShield />
          </span>
          {busy ? "Saving…" : "Set new password"}
        </button>
      </form>
    </AuthShell>
  );
}
