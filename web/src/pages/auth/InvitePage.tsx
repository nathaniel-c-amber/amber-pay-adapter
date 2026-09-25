/* Invite acceptance — the product's only account-creation path.
 *
 * Reached from an emailed link (`/accept-invite?token=…`, which the router
 * adopts into `#/invite/<token>`), so it must work with no session at all and
 * survive a reload. The token lives in the URL, never in component state.
 *
 * The page opens by reading the invite, which buys three things a bare form
 * cannot:
 *
 *  1. It names the account. The address comes from the invite itself, so the
 *     invitee never retypes — and cannot mistype — the address that was invited.
 *  2. It states what the invite grants, before the password is chosen. Policy
 *     attributes ARE the product's access model; finding out afterwards what you
 *     agreed to is not consent.
 *  3. It fails early and specifically. Expired, used and unrecognised links are
 *     told apart here, rather than after a password has been typed into a form
 *     that was never going to submit.
 *
 * Accepting creates the account but issues no token, so the success state says
 * "sign in", not "welcome aboard".
 */

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AuthField, AuthShell } from "@/components/auth/AuthShell";
import { PasswordRequirements } from "@/components/auth/PasswordRequirements";
import { acceptInvite, getInvite } from "@/services/client";
import { meetsPasswordRules } from "@/utils/passwordRules";
import { formatDateTime } from "@/utils/datetime";
import { IconShield, IconVerified, IconWarn } from "@/components/auth/authIcons";
import type { ApiInviteDetail, ApiPolicyAttribute } from "@/types/api";

/** "read, ack on the dashboard scope for org-1" — a grant, in words. */
function describeAttribute(attribute: ApiPolicyAttribute): string {
  const scope = attribute.scope === "*" ? "every scope" : `the ${attribute.scope} scope`;
  const org =
    attribute.organizationId === "*" ? "every organisation" : attribute.organizationId;
  const actions = attribute.actions.length > 0 ? attribute.actions.join(", ") : "no actions";
  return `${actions} on ${scope} for ${org}`;
}

/* The shared formatter returns an em dash for an unusable stamp; on an invite
   screen "shortly" is the honest reading, since the link's own verification is
   what decides whether it still works. */
function formatExpiry(iso: string): string {
  const formatted = formatDateTime(iso);
  return formatted === "—" ? "shortly" : formatted;
}

/** Why a link is dead, said specifically enough to act on. */
function deadLinkFor(error: unknown): { title: string; lead: string } {
  const message = error instanceof Error ? error.message : "";
  if (/expired/i.test(message)) {
    return {
      title: "This invite link has expired",
      lead: "Invitations are time-limited as well as single-use, so this one stopped working on its own. A new link has to come from an administrator.",
    };
  }
  if (/already been accepted|already used/i.test(message)) {
    return {
      title: "This invite has already been used",
      lead: "The account exists and this link has done its job. Each invitation works exactly once.",
    };
  }
  return {
    title: "This invite link is not valid",
    lead: "It may have been replaced by a newer invitation, or part of it was lost on the way here.",
  };
}

const LINK_ROW = "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5";
const LINK_KEY = "mono text-micro uppercase tracking-label text-ink-3";
const LINK_VALUE = "m-0 text-md text-ink-1";
/* An email address has no spaces to break at, so it needs its own utility. */
const LINK_VALUE_WRAP = "m-0 text-md text-ink-1 break-all";

/** The shared footer escape hatch. */
function signInFooter(onGoToSignIn: (email?: string) => void, email?: string) {
  return (
    <button
      type="button"
      className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
      onClick={() => onGoToSignIn(email)}
    >
      Go to sign in
    </button>
  );
}

export function InvitePage({
  token,
  onGoToSignIn,
  onCancel,
}: {
  token: string | null;
  onGoToSignIn: (email?: string) => void;
  onCancel?: () => void;
}) {
  const [detail, setDetail] = useState<ApiInviteDetail | null>(null);
  const [linkState, setLinkState] = useState<"checking" | "ready" | "dead">("checking");
  const [deadLink, setDeadLink] = useState<{ title: string; lead: string } | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const allMet = meetsPasswordRules(password);
  const matches = confirm.length > 0 && confirm === password;
  const email = detail?.email ?? "";

  /* Read the invite once per token. The guard keeps a slow response for a token
     the user has already navigated away from overwriting the new one. */
  useEffect(() => {
    if (!token) return;
    let live = true;
    setLinkState("checking");
    void getInvite(token).then(
      (invite) => {
        if (!live) return;
        setDetail(invite);
        setLinkState("ready");
      },
      (err: unknown) => {
        if (!live) return;
        setDeadLink(deadLinkFor(err));
        setLinkState("dead");
      },
    );
    return () => {
      live = false;
    };
  }, [token]);

  if (!token) {
    return (
      <AuthShell
        title="This invite link is incomplete"
        lead="The link is missing its token. Invite links are single-use and time-limited, so a link copied by hand often loses the part that matters."
        footer={signInFooter(onGoToSignIn)}
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
        footer={signInFooter(onGoToSignIn, email)}
      >
        <div className="flex items-start gap-3 rounded-panel border border-rule-enamel bg-midnight-2 px-4 py-3">
          <span className="grid flex-none place-items-center text-line-green" aria-hidden>
            <IconVerified />
          </span>
          <p className="m-0 text-md leading-prose text-ink-2">
            <b className="text-ink-1">{email}</b> was created.
          </p>
        </div>
      </AuthShell>
    );
  }

  if (linkState === "dead" && deadLink) {
    return (
      <AuthShell title={deadLink.title} lead={deadLink.lead} footer={signInFooter(onGoToSignIn)}>
        <div className="flex items-start gap-3 rounded-panel border border-[rgb(251_191_36/0.34)] bg-midnight-2 px-4 py-3">
          <span className="grid flex-none place-items-center text-text-delayed" aria-hidden>
            <IconWarn />
          </span>
          <p className="m-0 text-md leading-prose text-ink-2">
            An administrator can send a fresh invitation from the console&rsquo;s Users page. It will
            replace this link, and the new one is the only one that will work.
          </p>
        </div>
      </AuthShell>
    );
  }

  /* Nothing is claimed until the invite is confirmed: rendering the form over an
     unverified token would invite the invitee to choose a password for an
     account that cannot be created. */
  if (linkState === "checking" || !detail) {
    return (
      <AuthShell
        title="Checking this invitation"
        lead="Confirming the link is still valid before you choose a password. This takes a moment."
      >
        <p className="m-0 text-md text-ink-3" role="status">
          Checking the invite…
        </p>
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
      // A link that died between the check and the submit cannot be fixed by
      // editing the form, so it gets the dead-link state rather than an error
      // the invitee would keep re-submitting against.
      const message = err instanceof Error ? err.message : "The invite could not be accepted.";
      if (/expired|already been accepted|already used|invalid invite token/i.test(message)) {
        setDeadLink(deadLinkFor(err));
        setLinkState("dead");
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Set your password"
      lead="You have been invited to the Amber Pay Ledger operations console. Choose a password to activate the account — it is the only credential you set for yourself."
    >
      <section
        className="flex flex-col gap-2 rounded-panel border border-rule-enamel bg-midnight-2 px-4 py-3"
        aria-label="What this invitation grants"
      >
        <div className={LINK_ROW}>
          <span className={LINK_KEY}>Invited address</span>
          <span className={LINK_VALUE_WRAP}>{detail.email}</span>
        </div>
        <div className={LINK_ROW}>
          <span className={LINK_KEY}>Link expires</span>
          <span className={LINK_VALUE}>{formatExpiry(detail.expiresAt)}</span>
        </div>
        <div className="flex flex-col gap-1 border-t border-rule-enamel pt-2">
          <span className={LINK_KEY}>Access granted</span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {detail.policyAttributes.map((attribute) => (
              <li
                key={`${attribute.scope}|${attribute.organizationId}|${attribute.actions.join(",")}`}
                /* Same bullet anatomy as the AuthShell list, so the two lists a
                   visitor sees in one flow do not drift apart. */
                className="relative max-w-none pl-4 text-sm leading-prose text-ink-2 before:absolute before:top-[0.5em] before:left-0 before:size-1.5 before:rounded-[1px] before:bg-line-green before:content-['']"
              >
                {describeAttribute(attribute)}
              </li>
            ))}
          </ul>
          <span className="text-xs text-ink-3">
            The invite decides this. It is not editable here, and no session starts until you sign in
            and pass the emailed second factor.
          </span>
        </div>
      </section>

      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <AuthField id="invite-password" label="Password" error={error}>
          <input
            id="invite-password"
            className="field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2 text-md text-ink-1 hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended"
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
          className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-panel border border-primary bg-primary px-4 py-3 text-md font-semibold text-on-primary hover:not-disabled:border-primary-hover hover:not-disabled:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
          disabled={busy || !allMet || !matches}
        >
          <span className="grid flex-none place-items-center" aria-hidden>
            <IconShield />
          </span>
          {busy ? "Creating account…" : "Set password and create account"}
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
