/* Invite acceptance — the product's only account-creation path.
 *
 * Reached from an emailed link (`#/invite/<token>`), so it must work with no
 * session at all. Three things this screen owes the user that a bare form does
 * not:
 *
 *  1. What the invite grants. Policy attributes are the product's real access
 *     model, so the page says plainly what the account will be able to read and
 *     act on — before the password is chosen, not after.
 *  2. The real password rule, shown as requirements that resolve as you type.
 *     The server enforces 12+ characters with mixed case and a digit; hiding
 *     that until submit is a punishment, not a security measure.
 *  3. A truthful outcome. Accepting an invite creates the account but issues no
 *     token, so the success state says "sign in", not "welcome aboard".
 */

import { useState } from "react";
import type { FormEvent } from "react";
import { AuthField, AuthShell } from "@/components/auth/AuthShell";
import { PasswordRequirements } from "@/components/auth/PasswordRequirements";
import { acceptInvite } from "@/services/client";
import { meetsPasswordRules } from "@/utils/passwordRules";
import { IconVerified, IconWarn } from "@/components/auth/authIcons";

export function InvitePage({
  token,
  onGoToSignIn,
  onCancel,
}: {
  token: string | null;
  onGoToSignIn: (email?: string) => void;
  onCancel?: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const allMet = meetsPasswordRules(password);
  const matches = confirm.length > 0 && confirm === password;

  if (!token) {
    return (
      <AuthShell
        title="This invite link is incomplete"
        lead="The link is missing its token. Invite links are single-use and time-limited, so a link copied by hand often loses the part that matters."
        footer={
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
            onClick={() => onGoToSignIn()}
          >
            Go to sign in
          </button>
        }
      >
        <div className="flex items-start gap-3 rounded-panel border border-[rgb(251_191_36/0.34)] bg-midnight-2 px-4 py-3">
          <span className="grid flex-none place-items-center text-text-delayed" aria-hidden>
            <IconWarn />
          </span>
          <p className="m-0 text-md leading-prose text-ink-2">
            Ask your administrator to resend the invitation and open the link directly from that
            email rather than copying it.
          </p>
        </div>
      </AuthShell>
    );
  }

  if (accepted) {
    return (
      <AuthShell
        title="Account created"
        lead="Your account is ready and your access is governed by the policy attributes the invite carried. Signing in still requires a second factor by email."
        footer={
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
            onClick={() => onGoToSignIn(email.trim())}
          >
            Continue to sign in
          </button>
        }
      >
        <div className="flex items-start gap-3 rounded-panel border border-rule-enamel bg-midnight-2 px-4 py-3">
          <span className="grid flex-none place-items-center text-line-green" aria-hidden>
            <IconVerified />
          </span>
          <p className="m-0 text-md leading-prose text-ink-2">
            <b className="text-ink-1">{email.trim()}</b> was created. No access token has been issued yet — the invite
            created the account, it did not start a session.
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
      await acceptInvite(token, password);
      // No focus choreography needed here: the success state mounts a fresh
      // AuthShell, which moves focus to its own heading on mount.
      setAccepted(true);
    } catch (err) {
      setError(
        err instanceof Error && /expired|used|invalid/i.test(err.message)
          ? "This invite is no longer valid. It may have expired or already been used."
          : err instanceof Error
            ? err.message
            : "The invite could not be accepted.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Set up your account"
      lead="You have been invited to the Amber Pay operations console. Choose a password to activate your access."
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <AuthField
          id="invite-email"
          label="Work email"
          hint="The address the invitation was sent to."
        >
          <input
            id="invite-email"
            className="field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2 text-md text-ink-1 placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </AuthField>

        <AuthField id="invite-password" label="Password" error={error}>
          <input
            id="invite-password"
            className="field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2 text-md text-ink-1 placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            aria-describedby="invite-rules"
          />
        </AuthField>

        {/* Requirements resolve as you type, rather than appearing as a wall of
            red after a failed submit. */}
        <PasswordRequirements value={password} id="invite-rules" />

        <AuthField id="invite-confirm" label="Confirm password">
          <input
            id="invite-confirm"
            className="field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2 text-md text-ink-1 placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended"
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
          disabled={busy || !email.trim() || !allMet}
        >
          {busy ? "Creating account…" : "Create account"}
        </button>

        {onCancel && (
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
            onClick={onCancel}
          >
            Back to the console
          </button>
        )}
      </form>
    </AuthShell>
  );
}
