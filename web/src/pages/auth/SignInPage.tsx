/* Sign-in: credentials → second factor.
 *
 * Two ordered stages, one surface. The password step always ends in a 2FA
 * challenge (the backend issues no token without one), so the flow is honest
 * about being two steps from the start rather than surprising the user with a
 * second screen.
 *
 * Errors are deliberately not specific: the backend answers "Invalid
 * credentials" for both an unknown email and a wrong password, because a
 * distinguishable response would enumerate accounts. The UI must not undo that
 * by guessing which one it was.
 */

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AuthField, AuthShell } from "@/components/auth/AuthShell";
import { login, verifyTwoFactor } from "@/services/client";
import { setToken } from "@/services/auth.service";
import { IconArrowRight, IconLock, IconShield } from "@/components/auth/authIcons";

type Stage = "credentials" | "second-factor";

export function SignInPage({
  onAuthenticated,
  onCancel,
  onExploreDemo,
  onForgotPassword,
  expired,
  initialEmail,
}: {
  onAuthenticated: (token: string) => void;
  /** Present when a console is already open behind this page. */
  onCancel?: () => void;
  /**
   * Present only when there is no session at all. Entering demo mode is an
   * explicit choice, never a default: a monitoring console must not present
   * fabricated figures to someone who opened it expecting their own.
   */
  onExploreDemo?: () => void;
  /** Opens credential recovery. Always available — a forgotten password is not
   *  something only signed-out visitors experience. */
  onForgotPassword: () => void;
  /** True when the session ended on its own rather than by choice. */
  expired?: boolean;
  /** Prefilled address, e.g. after accepting an invite or completing a reset. */
  initialEmail?: string;
}) {
  const [stage, setStage] = useState<Stage>("credentials");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement | null>(null);

  // In dev the backend returns the code so the flow can be exercised without a
  // mailbox. Auto-filling it is a convenience for that case only.
  const [devCode, setDevCode] = useState<string | null>(null);

  useEffect(() => {
    if (stage === "second-factor") codeRef.current?.focus();
  }, [stage]);

  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await login(email.trim(), password);
      setChallengeId(res.challengeId);
      if (res.code) {
        setDevCode(res.code);
        setCode(res.code);
      }
      setStage("second-factor");
    } catch (err) {
      setError(
        err instanceof Error && /credential|unauthor/i.test(err.message)
          ? "That email and password combination was not recognised."
          : err instanceof Error
            ? err.message
            : "Sign-in could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !challengeId) return;
    setError(null);
    setBusy(true);
    try {
      const { accessToken } = await verifyTwoFactor(challengeId, code.trim());
      setToken(accessToken);
      onAuthenticated(accessToken);
    } catch (err) {
      setError(
        err instanceof Error && /expired|challenge/i.test(err.message)
          ? "That code has expired. Start again to receive a new one."
          : "That code was not correct. Check the message and try again.",
      );
      // A rejected code is most often a typo: clear it and return focus so the
      // user can retype without reaching for the field.
      setCode("");
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (stage === "second-factor") {
    return (
      <AuthShell
        step={2}
        totalSteps={2}
        title="Enter your code"
        lead={`We sent a 6-digit code to ${email.trim()}. It expires shortly, so enter it now.`}
      >
        <form className="flex flex-col gap-4" onSubmit={submitCode} noValidate>
          <AuthField
            id="auth-code"
            label="6-digit code"
            error={error}
            hint={
              devCode ? (
                <>
                  Development build returned the code directly:{" "}
                  <b className="mono">{devCode}</b>
                </>
              ) : (
                "Nothing arrived? Start again — the previous code is replaced, not extended."
              )
            }
          >
            <input
              id="auth-code"
              ref={codeRef}
              className="mono field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-3 text-center text-2xl tracking-[0.32em] text-ink-1 placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              aria-invalid={error ? true : undefined}
            />
          </AuthField>

          <button
            type="submit"
            className="inline-flex w-full cursor-pointer items-center gap-2 rounded-panel border border-primary bg-primary px-4 py-3 text-md font-semibold text-on-primary hover:not-disabled:border-primary-hover hover:not-disabled:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
            disabled={busy || code.length !== 6}
          >
            <span className="grid flex-none place-items-center" aria-hidden>
              <IconShield />
            </span>
            {busy ? "Verifying…" : "Verify and sign in"}
          </button>

          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
            onClick={() => {
              setStage("credentials");
              setCode("");
              setDevCode(null);
              setChallengeId(null);
              setError(null);
            }}
          >
            Back to login
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      step={1}
      totalSteps={2}
      title={expired ? "Your session ended" : "Sign in"}
      lead={
        expired
          ? "The console stopped receiving data because your access token expired. Sign in again to resume live monitoring."
          : "Invite-only access. Your email and password are followed by a code sent to that address."
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submitCredentials} noValidate>
        <AuthField id="auth-email" label="Work email">
          <input
            id="auth-email"
            className="field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2 text-md text-ink-1 placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            aria-invalid={error ? true : undefined}
          />
        </AuthField>

        <AuthField
          id="auth-password"
          label="Password"
          error={error}
          hint="At least 12 characters, with upper and lower case and a digit."
        >          <input
            id="auth-password"
            className="field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2 text-md text-ink-1 placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            aria-invalid={error ? true : undefined}
          />
        </AuthField>

        <button
          type="submit"
          className="inline-flex w-full cursor-pointer items-center gap-2 rounded-panel border border-primary bg-primary px-4 py-3 text-md font-semibold text-on-primary hover:not-disabled:border-primary-hover hover:not-disabled:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
          disabled={busy || !email.trim() || !password}
        >
          <span className="grid flex-none place-items-center" aria-hidden>
            <IconLock />
          </span>
          {busy ? "Checking…" : "Continue"}
          {!busy && (
            <span className="ml-auto grid place-items-center" aria-hidden>
              <IconArrowRight />
            </span>
          )}
        </button>

        <button
          type="button"
          className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
          onClick={() => {
            onForgotPassword();
            setError(null);
          }}
        >
          Forgot your password?
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

        {onExploreDemo && (
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
            onClick={onExploreDemo}
          >
            Explore with demo data instead
          </button>
        )}
      </form>

      <p className="m-0 max-w-[48ch] text-xs leading-prose text-ink-3">
        Access is granted by invitation — ask an administrator at your organisation to send an
        invite if you have never had an account here.
      </p>
    </AuthShell>
  );
}
