/* Users — the administrator's directory and the only place permissions change.
 *
 * The page previously rendered `DEMO_USERS` unconditionally: it showed four
 * invented accounts even in a live session, and its Invite/Edit/Resend controls
 * were permanently `disabled`. A screen that looks like user management but can
 * never change anything is worse than no screen, because it hides the fact that
 * access is being managed somewhere else.
 *
 * What it does now:
 *  - Lists the REAL directory from `GET /users` (accounts + outstanding invites)
 *    and says plainly when it is showing synthetic demo data instead.
 *  - Invites, edits permissions and re-sends invites, each against the API, with
 *    the outcome reported per action.
 *
 * The two claims a directory must never get wrong are "who has access" and "what
 * that access is". So: a pending invite is labelled as an account that does not
 * exist yet, the edit panel shows the full attribute set rather than a summary,
 * and every mutation re-reads the directory rather than assuming it worked.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPlus, IconRefresh, IconSearch } from "@/components/icons";
import {
  BTN,
  BTN_PRIMARY,
  Card,
  DemoTag,
  INPUT,
  LINK_BTN,
  PageHeader,
  cx,
} from "@/components/ui";
import { PolicyAttributeEditor } from "@/components/PolicyAttributeEditor";
import { Can, Cannot, useCan } from "@/components/Can";
import { ABILITY } from "@/utils/permissions";
import { formatDateTime } from "@/utils/datetime";
import {
  inviteUser,
  listUsers,
  resendInvite,
  updateUserPermissions,
  UnauthorizedError,
} from "@/services/client";
import { DEMO_ENABLED, DEMO_USERS } from "@/utils/fixtures";
import type { DemoUser } from "@/utils/fixtures";
import type { ApiDirectoryUser, ApiIdentity, ApiPolicyAttribute } from "@/types/api";

/** One directory row, whichever source it came from. */
interface DirectoryRow {
  id: string;
  email: string;
  status: "active" | "invite pending";
  /** Empty string when the entry has no attribute at all (never expected). */
  scope: string;
  organizations: string;
  actions: string;
  meta: string;
  /** Present only for live rows — the editor needs the real attribute set. */
  policyAttributes: ApiPolicyAttribute[] | null;
}

function actionsOf(attributes: ApiPolicyAttribute[]): string {
  const all = [...new Set(attributes.flatMap((a) => a.actions))];
  return all.length > 0 ? all.join(", ") : "—";
}

function scopesOf(attributes: ApiPolicyAttribute[]): string {
  const all = [...new Set(attributes.map((a) => a.scope))];
  return all.length > 0 ? all.join(", ") : "—";
}

function toLiveRow(user: ApiDirectoryUser): DirectoryRow {
  return {
    id: user.id,
    email: user.email,
    status: user.status === "active" ? "active" : "invite pending",
    scope: scopesOf(user.policyAttributes),
    organizations: user.organizations.join(", ") || "—",
    actions: actionsOf(user.policyAttributes),
    meta:
      user.status === "active"
        ? `updated ${formatDateTime(user.updatedAt)}`
        : `invite expires ${formatDateTime(user.inviteExpiresAt)}`,
    policyAttributes: user.policyAttributes,
  };
}

function toDemoRow(user: DemoUser): DirectoryRow {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    scope: user.scope,
    organizations: user.organizationId,
    actions: user.actions,
    meta: user.lastSeenAt ? `last seen ${formatDateTime(user.lastSeenAt)}` : "never seen",
    policyAttributes: null,
  };
}

/* The old sheet paired `.amb-action-tag` with `.read` / `.write` / `.admin` and
   `.amb-status-text` with `.active` / `.pending` — selectors that had to be kept
   in sync by hand. These lookups make a value with no treatment a type error. */
const ACTION_TAG: Record<"read" | "write" | "admin", string> = {
  read: "text-secondary-ink bg-secondary-soft",
  write: "text-line-green bg-state-tint-arriving",
  admin: "text-text-suspended bg-state-tint-suspended",
};

const STATUS_TEXT: Record<"active" | "invite pending", string> = {
  active: "text-line-green",
  "invite pending": "text-state-delayed",
};

function actionTone(actions: string): "read" | "write" | "admin" {
  if (actions.includes("admin")) return "admin";
  if (actions.includes("write")) return "write";
  return "read";
}

export function UsersPage({
  identity,
  token,
  mode,
  onRequireSignIn,
}: {
  identity: ApiIdentity | null;
  token: string | null;
  mode: "demo" | "live";
  /** Called when the session turns out to be dead, so the shell can say so. */
  onRequireSignIn: () => void;
}) {
  const [rows, setRows] = useState<DirectoryRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  /** Which panel is open: none, invite, or the row being edited. */
  const [panel, setPanel] = useState<{ kind: "none" } | { kind: "invite" } | { kind: "edit"; id: string }>(
    { kind: "none" },
  );
  const [draft, setDraft] = useState<ApiPolicyAttribute[]>([]);
  /*
    The attributes as loaded from the directory. The editor needs them for two
    reasons, and both are correctness rather than polish: its option lists must
    include what is already granted (a wildcard admin's own attributes are not a
    superset of the vocabulary), and an action already on the row must stay
    selectable even when the admin cannot re-create it. Without a baseline,
    opening the panel and saving could silently rewrite or strip a grant.
  */
  const [baseline, setBaseline] = useState<ApiPolicyAttribute[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");

  const live = mode === "live" && Boolean(token);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setLoadError(null);
    try {
      const users = await listUsers(token);
      setRows(users.map(toLiveRow));
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onRequireSignIn();
        return;
      }
      setLoadError(err instanceof Error ? err.message : "The directory could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [token, onRequireSignIn]);

  useEffect(() => {
    if (live) void load();
    /* The synthetic directory is a development affordance — outside it, an
       unauthenticated or un-loaded directory is empty, not invented. */
    else setRows(DEMO_ENABLED ? DEMO_USERS.map(toDemoRow) : []);
  }, [live, load]);

  // A confirmation is announced politely and then cleared, so repeating the
  // same action announces again instead of silently reusing a stale message.
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(id);
  }, [notice]);

  const directory = rows ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return directory;
    /*
      EVERY FIELD THE TABLE SHOWS IS SEARCHABLE.

      This filtered on three of the seven columns a row renders, so a value the
      operator could plainly read was not findable — the account id being the one
      that matters, because it is the only stable handle on a person: the email
      changes if somebody is renamed, and the id is what a support ticket, an audit
      row or a bug report will quote. Searching it was the difference between
      finding a user and scrolling the whole directory.

      `actions` and `status` join it because "who can write?" and "whose invite is
      still pending?" are the other two questions an administrator arrives with,
      and both columns were on screen while being unsearchable.
    */
    return directory.filter((row) =>
      [
        row.id,
        row.email,
        row.scope,
        row.organizations,
        row.actions,
        row.status,
      ].some((field) => field.toLowerCase().includes(q)),
    );
  }, [directory, query]);

  const grantable = identity?.policyAttributes ?? [];
  const pendingCount = directory.filter((r) => r.status === "invite pending").length;

  const runAction = async (id: string, action: () => Promise<void>, confirmation: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
      setNotice(confirmation);
      setPanel({ kind: "none" });
      await load();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onRequireSignIn();
        return;
      }
      setActionError(err instanceof Error ? err.message : "The action could not be completed.");
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = (row: DirectoryRow) => {
    setActionError(null);
    setNotice(null);
    const loaded = row.policyAttributes ? row.policyAttributes.map((a) => ({ ...a, actions: [...a.actions] })) : [];
    setDraft(loaded.map((a) => ({ ...a, actions: [...a.actions] })));
    setBaseline(loaded);
    setPanel({ kind: "edit", id: row.id });
  };

  const openInvite = () => {
    setActionError(null);
    setNotice(null);
    setInviteEmail("");
    /*
      SEEDED LEAST-PRIVILEGE, and this replaces a deliberate earlier choice that
      has now turned out to be the wrong one.

      It used to seed from `grantable[0]` — "the broadest grant the administrator
      holds, so the common case is one click" — which meant a super administrator's
      invite arrived with ALL SCOPES, ALL ORGANIZATIONS and ALL FOUR ACTIONS already
      ticked, and one click from granting a new person super-admin access. The old
      row editor buried that in two dropdowns; the matrix puts it in plain sight,
      which is how it got noticed.

      So: the narrowest scope, the narrowest action, and the narrowest organization
      the caller can actually grant. `read` on `dashboard` is the smallest grant
      that makes an account useful, and everything else is now a deliberate tick
      rather than a default somebody has to notice and un-tick.

      An attribute is still required — the wire schema rejects an empty list — so
      the seed cannot be "nothing", only "least".
    */
    const narrowestOrg =
      directory
        .flatMap((row) => row.policyAttributes?.map((a) => a.organizationId) ?? [])
        .find((org) => org !== '*') ?? grantable.find((a) => a.organizationId !== '*')?.organizationId ?? '*';
    setDraft([{ scope: 'dashboard', organizationId: narrowestOrg, actions: ['read'] }]);
    setBaseline([]);
    setPanel({ kind: "invite" });
  };

  /** Organizations already in use, offered as options in the editor. */
  const knownOrganizations = useMemo(
    () =>
      [
        ...new Set(
          directory.flatMap((row) => row.policyAttributes?.map((a) => a.organizationId) ?? []),
        ),
      ].sort(),
    [directory],
  );

  const editingRow = panel.kind === "edit" ? directory.find((r) => r.id === panel.id) : undefined;
  /* The two administration panels are gated in place as well as at their
     triggers: the active policy can change while a panel is open. */
  const can = useCan();
  const mayManage = can(ABILITY.usersManage);

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="Users"
        lead="Invite-only access, governed by policy-based access control. Emails are auth identity only — no other customer data is held."
        actions={
          <>
            {mode === "demo" && <DemoTag />}
            <button type="button" className={BTN} onClick={() => void load()} disabled={!live || loading}>
              <IconRefresh />
              {loading ? "Refreshing" : "Refresh"}
            </button>
            <Can ability={ABILITY.usersManage}>
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={!live}
                title={live ? "Invite a user" : "Sign in to invite users"}
                onClick={openInvite}
              >
                <IconPlus /> Invite user
              </button>
            </Can>
          </>
        }
      />

      <Cannot ability={ABILITY.usersManage}>
        <div className="flex items-center gap-2 rounded-panel border border-[rgb(230_161_42/0.4)] bg-state-tint-delayed px-3 py-2 text-sm text-text-delayed [&_svg]:animate-warn">
          Managing users requires the <code>admin</code> action. Your active scope can view this
          directory but not modify it.
        </div>
      </Cannot>

      {mode === "demo" && (
        <div className="rounded-panel border border-[rgb(230_161_42/0.4)] bg-state-tint-delayed px-3 py-2 text-sm text-text-delayed">
          Showing the synthetic demo directory. Inviting, editing and re-sending all require a
          signed-in session — sign in to manage real accounts.
        </div>
      )}

      {loadError && (
        <div className="rounded-panel border border-[rgb(248_113_113/0.4)] bg-state-tint-suspended px-3 py-2 text-sm text-text-suspended" role="alert">
          {loadError}
        </div>
      )}

      {actionError && (
        <div className="rounded-panel border border-[rgb(248_113_113/0.4)] bg-state-tint-suspended px-3 py-2 text-sm text-text-suspended" role="alert">
          {actionError}
        </div>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {notice ?? ""}
      </p>

      {mayManage && panel.kind === "invite" && (
        <Card
          title={inviteEmail.trim() ? `Invite ${inviteEmail.trim()}` : "Invite a user"}
          meta="The invited account receives the policy attributes below"
          actions={
            <button type="button" className={LINK_BTN} onClick={() => setPanel({ kind: "none" })}>
              Cancel
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            <label className="flex max-w-[420px] flex-col gap-1">
              <span className="mono text-micro uppercase tracking-label text-ink-3">Work email</span>
              <input
                /* The INPUT control, not a fourth hand-written copy of it. This one
                   had drifted: it was missing the aria-invalid treatment and carried
                   its own placeholder utility, which is how a field ends up the one
                   place in the console where the placeholder colour is wrong. */
                className={INPUT}
                type="email"
                value={inviteEmail}
                placeholder="name@organisation.com"
                onChange={(e) => setInviteEmail(e.target.value)}
              />
              <span className="text-xs text-ink-3">
                An invited user never chooses their own scope — this invite decides it.
              </span>
            </label>

            <PolicyAttributeEditor
              value={draft}
              onChange={setDraft}
              grantable={grantable}
              knownOrganizations={knownOrganizations}
              idPrefix="invite"
            />

            <div className="flex items-center gap-3 border-t border-rule-enamel pt-3">
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={
                  busyId === "invite" ||
                  !inviteEmail.trim() ||
                  draft.length === 0 ||
                  draft.some((a) => a.actions.length === 0)
                }
                onClick={() =>
                  void runAction(
                    "invite",
                    async () => {
                      await inviteUser(token ?? "", {
                        email: inviteEmail.trim(),
                        // The route evaluates PBAC against this organization, so
                        // it must be one the invite actually targets — the first
                        // attribute's organization is what the inviter chose.
                        organizationId: draft[0]?.organizationId ?? "",
                        policyAttributes: draft,
                      });
                    },
                    `Invitation sent to ${inviteEmail.trim()}.`,
                  )
                }
              >
                {busyId === "invite" ? "Sending…" : "Send invitation"}
              </button>
              <span className="text-xs text-ink-3">
                The link is single-use and time-limited; it can be re-sent from this page.
              </span>
            </div>
          </div>
        </Card>
      )}

      {/*
        THE PERMISSIONS MATRIX IS INLINE, not a dialog.

        A dialog was tried and reversed: it put a matrix — which needs width to
        read at all — behind a modal, so the operator compared ticks in a narrow
        box and referred back to the list constantly. Inline, the scopes and their
        actions are visible together with the directory they belong to, and
        "cancel" means leaving the row unchanged rather than dismissing a layer.

        The editor is a matrix for the reason given in PolicyAttributeEditor: a
        permission set is a set of pairs, and a list of rows each containing its
        own four checkboxes makes you count rather than look.
      */}
      {mayManage && panel.kind === "edit" && editingRow && (
        <Card
          title={`Permissions · ${editingRow.email}`}
          meta={
            editingRow.policyAttributes?.length
              ? `${editingRow.policyAttributes.length} attribute${editingRow.policyAttributes.length === 1 ? "" : "s"}`
              : "no attributes"
          }
          actions={
            <button type="button" className={LINK_BTN} onClick={() => setPanel({ kind: "none" })}>
              Cancel
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-[70ch] text-sm leading-prose text-ink-2">
              You can only grant what you yourself hold — anything else is refused by the server.
              Changes take effect the next time this account signs in, because the access token
              carries the policy it was issued with.
            </p>

            <PolicyAttributeEditor
              value={draft}
              onChange={setDraft}
              grantable={grantable}
              baseline={baseline}
              idPrefix="edit"
            />

            <div className="flex items-center gap-3 border-t border-rule-enamel pt-3">
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={
                  !live ||
                  busyId === editingRow.id ||
                  draft.length === 0 ||
                  draft.some((a) => a.actions.length === 0)
                }
                onClick={() =>
                  void runAction(
                    editingRow.id,
                    async () => {
                      await updateUserPermissions(token ?? "", editingRow.id, draft);
                    },
                    `Permissions updated for ${editingRow.email}.`,
                  )
                }
              >
                {busyId === editingRow.id ? "Saving…" : "Save permissions"}
              </button>
            </div>

            {/*
              WHY SAVE IS OFF, when the reason is the edit itself.

              An empty draft is refused by the SERVER, not by taste:
              `policyAttributesSchema` is `z.array(...).min(1)` and
              `users.service.updatePermissions` throws `At least one policy
              attribute is required` — a deliberate pair, so an account cannot be
              stranded with no access at all. Now that a row can genuinely be
              cleared, that state is reachable, so it is STATED rather than left
              as a dead button: a disabled control with no reason is the thing
              this console's own rules ("hidden, not disabled", "one line states
              the reason") are written against.
            */}
            {draft.length === 0 && (
              <p className="m-0 max-w-[70ch] text-sm leading-prose text-ink-2" role="status">
                Every grant is unticked. This account must keep at least one — an account with no
                access cannot be recovered from here. Tick a permission to re-enable saving, or{" "}
                <button
                  type="button"
                  className={LINK_BTN}
                  onClick={() => setDraft(baseline.map((a) => ({ ...a, actions: [...a.actions] })))}
                >
                  restore its current permissions
                </button>
                .
              </p>
            )}
          </div>
        </Card>
      )}

      <Card
        title="Directory"
        meta={
          <span className="mono">
            {filtered.length} {live ? "entries" : "demo accounts"}
            {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
          </span>
        }
        className="users-table"
        actions={
          <div
            className="flex items-center gap-2 rounded-panel border border-rule-enamel bg-midnight-2 px-2 py-1.5 [&_svg]:text-ink-3"
            role="search"
          >
            <IconSearch />
            <input
              type="search"
              className="border-0 bg-transparent text-sm text-ink-1 outline-none"
              placeholder="Search email, account id, scope or access"
              aria-label="Search users"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        }
      >
        {/* Seven columns of identities do not compress into a phone width, and
            squeezing them clips the fields that matter. The table keeps its
            real geometry and the frame scrolls instead. */}
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="w-full border-collapse text-md [&_th]:border-b [&_th]:border-rule-enamel [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-micro [&_th]:font-medium [&_th]:tracking-label [&_th]:text-ink-3 [&_th]:uppercase [&_th]:whitespace-nowrap [&_td]:border-b [&_td]:border-rule-enamel-soft [&_td]:px-3 [&_td]:py-3 [&_td]:align-middle [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:hover]:bg-midnight-3">
            <thead>
              <tr>
                <th className="mono">Email</th>
                <th className="mono">Scope</th>
                <th className="mono">Organization</th>
                <th className="mono">Actions</th>
                <th className="mono">Status</th>
                <th className="mono">Detail</th>
                <th aria-hidden />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className="mono block font-medium text-ink-1">{row.email}</span>
                    <span className="mono block text-xs text-ink-3">{row.id}</span>
                  </td>
                  <td>
                    <span className="mono">{row.scope}</span>
                  </td>
                  <td>
                    <span className="mono">{row.organizations}</span>
                  </td>
                  <td>
                    <span
                      className={cx(
                        "mono rounded-chip px-2 py-0.5 text-micro",
                        ACTION_TAG[actionTone(row.actions)],
                      )}
                    >
                      {row.actions}
                    </span>
                  </td>
                  <td>
                    <span className={cx("mono text-xs", STATUS_TEXT[row.status])}>{row.status}</span>
                  </td>
                  <td>
                    <span className="mono text-xs text-ink-3">{row.meta}</span>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <Can ability={ABILITY.usersManage}>
                      {row.status === "invite pending" ? (
                        <button
                          type="button"
                          className={LINK_BTN}
                          disabled={!live || busyId === row.id}
                          title={live ? "Issue a fresh invite link" : "Sign in to manage accounts"}
                          onClick={() =>
                            void runAction(
                              row.id,
                              async () => {
                                await resendInvite(token ?? "", row.id);
                              },
                              `A fresh invite link was sent to ${row.email}.`,
                            )
                          }
                        >
                          {busyId === row.id ? "Sending…" : "Resend invite"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={LINK_BTN}
                          disabled={!live}
                          title={live ? "Edit access" : "Sign in to manage accounts"}
                          onClick={() => openEdit(row)}
                        >
                          Edit
                        </button>
                      )}
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && directory.length === 0 && (
          <p className="m-0 py-4 text-sm text-ink-3">Loading the directory…</p>
        )}
        {!loading && filtered.length === 0 && (
          <div className="rounded-panel border border-dashed border-rule-enamel px-4 py-6">
            <div className="font-semibold text-ink-1">
              {query.trim() ? "No matching users" : "This directory is empty"}
            </div>
            <p className="mt-1.5 text-md text-ink-2">
              {directory.length === 0
                ? "Nobody has been invited yet. Invite someone to create the first account."
                : `Nothing here matches “${query.trim()}”. The search covers the email, the account id, the scope, the organization, the granted actions and the status.`}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
