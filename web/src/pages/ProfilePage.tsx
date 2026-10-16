/* Profile — who you are signed in as, and what that session can do.
 *
 * This page used to be a policy dump with no identity at all: it could say which
 * scopes were granted but not which account held them, and its one "am I signed
 * in?" row read `token ? "yes" : "no"` — a boolean dressed up as information.
 * A profile page that cannot name the user is not a profile page.
 *
 * Three questions, in the order they get asked:
 *   1. Who am I signed in as?           → Identity
 *   2. What can this session do?        → Session + Policy scopes
 *   3. How do I change my credentials?  → Security
 *
 * Identity comes from `GET /auth/me`, read from the access token, so it reports
 * the policy the session was actually issued under rather than whatever the
 * dashboard last returned. In demo mode there is no account, and the page says
 * so rather than inventing one.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { IconPolicy, IconRefresh, IconShield, IconUser } from "@/components/icons";
import type { PolicyScope } from "@/types/domain";
import { BTN, Card, DemoTag, Field, PageHeader, cx } from "@/components/ui";
import { Can } from "@/components/Can";
import { formatDateTime } from "@/utils/datetime";
import { parseAttributes, isAdminCapability, ABILITY } from "@/utils/permissions";
import { requestPasswordReset } from "@/services/client";
import { T_ANCHOR } from "@/tour/anchors";
import type { ApiIdentity } from "@/types/api";

/** How long is left on the current access token, in words. */

/** How long is left on the current access token, in words. */
function describeExpiry(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mins = Math.round((d.getTime() - now.getTime()) / 60000);
  if (mins <= 0) return "expired";
  if (mins < 60) return `${mins} min remaining`;
  return `${Math.round(mins / 60)} h remaining`;
}

/** One label/value row, so every readout on this page has the same anatomy. */
function IdentityRow({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
      <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">{label}</dt>
      <dd className={cx("m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere", mono && "mono text-sm")}>
        {value}
      </dd>
    </div>
  );
}

export function ProfilePage({
  identity,
  policies,
  activePolicy,
  mode,
  now,
  onSignOut,
  onManageUsers,
  onReplayTour,
}: {
  identity: ApiIdentity | null;
  policies: PolicyScope[];
  activePolicy: PolicyScope | null;
  mode: "demo" | "live";
  /** The shell clock, so the token-expiry readout agrees with the rest of the app. */
  now: Date;
  onSignOut: () => void;
  onManageUsers: () => void;
  /**
   * Replay the first-run tour. Deliberately does NOT clear the completion stamp:
   * a replay is a request to see it now, not a request to be re-toured on every
   * future sign-in.
   */
  onReplayTour: () => void;
}) {
  const [resetState, setResetState] = useState<
    { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const caps = activePolicy ? parseAttributes(activePolicy.attributes) : null;
  // The display cue is derived from the address: the product holds no name
  // field, and inventing one would be worse than showing nothing.
  const initial = identity?.email.slice(0, 1).toUpperCase() ?? "";

  const sendResetLink = async () => {
    if (!identity) return;
    setResetState({ kind: "sending" });
    try {
      await requestPasswordReset(identity.email);
      setResetState({ kind: "sent" });
    } catch (err) {
      setResetState({
        kind: "error",
        message: err instanceof Error ? err.message : "The request could not be sent.",
      });
    }
  };

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="Profile"
        lead="Your session and the policy scope you act under. Access is attribute-driven — there is no static role."
        actions={mode === "demo" ? <DemoTag /> : undefined}
      />

      <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start gap-4 max-4xl:grid-cols-[minmax(0,1fr)]">
        <Card
          title="Identity"
          meta={
            <span className="mono text-xs">{mode === "demo" ? "no account" : "authenticated"}</span>
          }
          actions={
            <span
              className="grid size-8 flex-none place-items-center rounded-full border border-rule-enamel bg-midnight-3 text-md font-semibold text-ink-1"
              aria-hidden
            >
              {initial || <IconUser />}
            </span>
          }
        >
          {identity ? (
            <dl className="m-0 flex flex-col">
              <IdentityRow label="Email" value={identity.email} />
              <IdentityRow label="Account id" value={identity.id} />
              <IdentityRow label="Created" value={formatDateTime(identity.createdAt)} />
              <IdentityRow label="Credentials changed" value={formatDateTime(identity.updatedAt)} />
            </dl>
          ) : mode === "demo" ? (
            <p className="m-0 max-w-[58ch] text-md leading-prose text-ink-2">
              You are viewing the console with <b className="text-ink-1">synthetic demo data</b> and
              no account, so there is no identity to show. Sign in to see your own account here.
            </p>
          ) : (
            <p className="m-0 max-w-[58ch] text-md leading-prose text-ink-2">
              No account is loaded for this session, so there is no identity to show. Signing in
              again will reload it.
            </p>
          )}
        </Card>

        <Card title="Session" className="profile-session">
          {caps ? (
            <dl className="m-0 flex flex-col">
              <IdentityRow label="Default scope" value={activePolicy?.label ?? "—"} mono={false} />
              <IdentityRow
                label="Resource scope"
                value={caps.scope === "*" ? "all scopes" : caps.scope}
              />
              <IdentityRow
                label="Organization"
                /*
                  THE ONE PLACE THE ORGANIZATION IS NAMED.

                  A deployment serves exactly one organization, so the
                  organization is a deployment-wide constant, not a per-policy
                  variable — which is exactly why it appears HERE and nowhere
                  else. Every policy scope below names its SCOPE only; repeating
                  the organization on each of them (the old "payments · All
                  organizations") asserted a plurality this product does not
                  have, and a wildcard there is not "all of them", it is "the
                  one this deployment serves".

                  THE NAME, not the policy's raw organization id. An id like
                  "default" or "org-1" is what the API filters on and is the one
                  thing on this page nobody can read out loud in a meeting. The
                  name is the one a human chose; the id is kept underneath so
                  somebody debugging a permission problem can still see it, and so
                  the row is never blank before setup has been finished.
                */
                value={
                  identity?.organizationName ??
                  (caps.org === "*" ? "not set up yet" : caps.org)
                }
                mono={false}
              />
              <IdentityRow
                label="Granted actions"
                value={caps.actions.size === 0 ? "—" : [...caps.actions].join(", ")}
              />
              <IdentityRow
                label="Read-only"
                value={activePolicy?.readOnly ? "yes" : "no"}
                mono={false}
              />
              <IdentityRow
                label="Token"
                value={identity ? describeExpiry(identity.tokenExpiresAt, now) : "no session — guest"}
                mono={false}
              />
            </dl>
          ) : (
            <p className="m-0 text-md text-ink-2">No policy scope selected.</p>
          )}

          {/*
            Hidden in demo mode rather than disabled: there is no account to
            stamp, so offering the control would promise something the session
            cannot do. `mode` is a compile-time-gated value in production.
          */}
          {mode !== "demo" && (
            <div className="mt-3 flex justify-end border-t border-rule-enamel pt-3">
              <button
                type="button"
                className={BTN}
                data-tour={T_ANCHOR.profileReplay}
                onClick={onReplayTour}
              >
                <IconRefresh /> Replay the tour
              </button>
            </div>
          )}
        </Card>
      </div>

        <Card title="Policy scopes" className="profile-policies">
          <p className="mb-3 text-sm text-ink-2">
            Each policy attribute grants <code>actions</code> on a <code>scope</code>. This
            deployment serves one organization, so it is named once above rather than on every
            scope. Navigation follows the broadest scope you hold — chosen for you, not switched
            by hand.
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {policies.map((p) => {
              const c = parseAttributes(p.attributes);
              const isActive = activePolicy?.id === p.id;
              return (
                <li className={cx("flex items-start gap-3 rounded-panel border border-rule-enamel p-3", isActive && "border-primary bg-sel-bg")} key={p.id}>
                  <span className={cx("mt-0.5 text-ink-3", isActive && "text-primary-ink")}>
                    {isAdminCapability(c) ? <IconShield /> : <IconPolicy />}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-md font-semibold text-ink-1">
                      {p.label}
                      {isActive && <span className="mono rounded-chip border border-[rgb(57_185_138/0.4)] px-1.5 py-0.5 text-micro uppercase tracking-label text-line-green">active</span>}
                    </div>
                    <div className="mono mt-1 text-xs text-ink-2">
                      scope:{c.scope} · actions:
                      {c.actions.size === 0 ? " (read-only)" : [...c.actions].join(",")}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

      <Card title="Security" className="profile-security">
        <div className="flex flex-col gap-3">
          {/*
            NO REQUIREMENT REFERENCES. "(FR-1.1)" is an index into a document
            this person has no copy of, and it reads as an unexplained code to
            anybody who has — the label already says what the fact is. The
            substance stays; the citation does not.
          */}
          <div className="grid grid-cols-4 gap-4 max-4xl:grid-cols-2 max-sm:grid-cols-1">
            <Field label="Invite only" value="No public registration" />
            <Field label="Second factor" value="Email 2FA on every sign-in" />
            <Field label="Session lifetime" value="Access tokens last up to an hour" />
            <Field label="Authorization" value="Policy-based access control" />
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-rule-enamel pt-3">
            {identity ? (
              <>
                <button
                  type="button"
                  className={BTN}
                  onClick={sendResetLink}
                  disabled={resetState.kind === "sending" || resetState.kind === "sent"}
                >
                  {resetState.kind === "sending" ? "Sending…" : "Send password reset link"}
                </button>
                <Can ability={ABILITY.usersManage}>
                  <button type="button" className={BTN} onClick={onManageUsers}>
                    Manage users
                  </button>
                </Can>
                <button type="button" className={BTN} onClick={onSignOut}>
                  Sign out
                </button>
              </>
            ) : (
              <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-2">
                Password and session controls appear here once you sign in. Nothing on this page can
                change an account without a session.
              </p>
            )}
          </div>

          {resetState.kind === "sent" && (
            <p className="m-0 max-w-[70ch] text-xs leading-prose text-ink-2" role="status">
              A single-use reset link is on its way to{" "}
              <b className="mono text-ink-1">{identity?.email}</b>. Using it replaces your password;
              it does not end this session, so sign out separately if that is what you want.
            </p>
          )}
          {resetState.kind === "error" && (
            <p className="m-0 text-xs text-text-suspended" role="alert">
              {resetState.message}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}