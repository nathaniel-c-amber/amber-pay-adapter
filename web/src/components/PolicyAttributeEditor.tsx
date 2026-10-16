/* Policy attribute editor — the one control that grants access.
 *
 * Authorization in this product is a set of attributes, each naming a `scope`, an
 * `organizationId` and the `actions` granted on them. Editing that by hand as free
 * text invites exactly the mistakes PBAC exists to prevent, so this is a
 * structured editor: a MATRIX of scopes down the side and actions across the top,
 * with a tick where a grant exists.
 *
 * WHY A MATRIX, and what it turned out to remove.
 *
 * The previous editor was a list of rows, each holding a scope select, an
 * organization select and a row of checkboxes, with "add" and "Remove" controls.
 * Both controls turned out to be REDUNDANT, which is the real argument for the
 * matrix rather than a preference for how it looks:
 *
 *   The server enforces that an administrator can only grant what they hold
 *   (`assertGrantableByAdmin`). So the set of rows that could ever legally exist
 *   is exactly `grantable ∪ baseline ∪ draft` — the union this component already
 *   builds. "Add" could only ever pick from that union, so it could only ever
 *   add a row that was already there.
 *
 * A matrix shows the COMPLETE set by construction: every row is visible, every
 * row is reachable, and a row with nothing ticked is simply not a grant. There is
 * no "is this row present?" question left to answer, and therefore no control
 * whose only job was to answer it.
 *
 * THE EMPTY-ROW RULE, which the wire format forces. `policyAttributeSchema`
 * requires `actions` to have at least one member, so a fully-unticked row CANNOT
 * be sent as an attribute with an empty array. Ticking nothing therefore means "no
 * attribute for this scope", and this component emits the row as absent rather
 * than as an empty one. An editor that let a caller save an attribute with no
 * actions would be refused by the server with a message about the wrong field.
 *
 * WHERE THE OPTIONS COME FROM — this is the part that has to be right.
 *
 * An administrator can only hand out what they hold; the server enforces that
 * with `assertGrantableByAdmin`. But "what they hold" is not the same as "the
 * set of options", because a wildcard covers everything. A super admin holds a
 * single attribute (`scope: '*'`, `organizationId: '*'`), and if the option list
 * were built naively from their attributes alone it would contain only `*` — so a
 * select bound to a user's real `dashboard / acme` grant would fall back to its
 * first option and silently rewrite that grant into an all-scopes,
 * all-organizations one on save. That is a privilege escalation caused entirely by
 * a dropdown's default, and it is why the row list below is a union:
 *
 *   rows = (what the caller may grant, wildcards expanded)
 *        ∪ (what is already granted on this account, so nothing is lost)
 *        ∪ (what is in the draft being edited)
 *
 * The second and third terms are what make the editor SAFE TO OPEN AND SAVE
 * WITHOUT EDITING: an untouched row round-trips unchanged. A permission editor
 * that alters permissions simply by being opened is worse than none at all.
 *
 * An action is enabled when the caller holds it, OR when the row already carried
 * it (so an administrator can preserve a grant they cannot re-create, but can
 * never widen one). A disabled cell is shown rather than hidden: in a matrix the
 * shape of the permission model is most of the information, and a missing cell
 * cannot be told apart from an ungranted one.
 */

import { useMemo } from "react";
import { Checkbox, cx } from "./ui";
import type { ApiPolicyAttribute, PolicyAction } from "@/types/api";

/** The action vocabulary, in the order the matrix shows them. */
const ALL_ACTIONS: readonly PolicyAction[] = ["read", "ack", "write", "admin"];

/**
 * What each action MEANS, as a column tooltip.
 *
 * A four-column matrix of one-word headers is a grid of guesses otherwise —
 * "ack" especially, since it applies to one scope only and reads as noise
 * everywhere else. These are the definitions the rest of the console already
 * works to, not new ones invented for a header.
 */
const ACTION_NOTE: Record<PolicyAction, string> = {
  read: "See this surface and its data",
  ack: "Acknowledge a finding on it",
  write: "Change records on it",
  admin: "Manage this surface: its people, its access, its configuration",
};

const HEAD_CLASS = "font-mono text-xs tracking-label uppercase text-ink-2";

/*
  Column widths, and why the heads are `whitespace-nowrap`.

  The action columns were left to shrink to fit (`w-px`), which is the right
  instinct for a checkbox cell and the wrong one for its HEADER: at 40px,
  "ADMIN" wrapped to three lines and the whole head grew to 70px, so the matrix
  read as a stack of broken words rather than a set of columns. A header that
  wraps has not merely lost its tidy row — it has moved its own content box off
  the column start, which is the same defect the event log's heads had.

  So each action column is a fixed 5rem — enough for the longest word, "ADMIN",
  in the micro mono at its tracking — and the heads cannot wrap. The scope column
  takes what is left, which is also how the reference layout reads: a wide
  label column with a tight group of permission columns beside it.
*/
const ACTION_COL = "w-20";

/** Sorted so a wildcard leads, then alphabetical — the order a reader expects. */
function sortScopes(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b)));
}

/** Does this attribute cover the given scope/organization pair? */
function covers(attribute: ApiPolicyAttribute, scope: string, organizationId: string): boolean {
  return (
    (attribute.scope === "*" || attribute.scope === scope) &&
    (attribute.organizationId === "*" || attribute.organizationId === organizationId)
  );
}

/** The actions the caller may grant on a given scope/organization pair. */
function grantableActions(
  grantable: ApiPolicyAttribute[],
  scope: string,
  organizationId: string,
): Set<PolicyAction> {
  return new Set(
    grantable.filter((a) => covers(a, scope, organizationId)).flatMap((a) => a.actions),
  );
}

/**
 * A row's identity: the scope and organization together, because that PAIR is
 * what a policy attribute is.
 *
 * The separator is U+0000, written as an escape rather than as a literal byte. It
 * is the one character that cannot occur in a scope name or an organization id,
 * which a space can — and it had to be an escape anyway: written as a literal NUL
 * this file became BINARY to grep, diff and every other text tool, which is not a
 * cost a two-line helper is worth. It stayed in the file for a while before that
 * was noticed, and the file compiled and rendered perfectly throughout, which is
 * exactly why a source file that is secretly binary is worth fixing rather than
 * ignoring.
 *
 * ONE definition. The separator was previously written out in two places, which is
 * how the two copies came to disagree about what it was.
 */
const SEP = '\u0000';
const key = (a: { scope: string; organizationId: string }): string => `${a.scope}${SEP}${a.organizationId}`;

const scopeLabel = (scope: string): string => (scope === "*" ? "all scopes" : scope);
/*
  "ANY organization", not "all organizations".

  The wording describes the GRANT ("unrestricted"), never the shape of the
  product. A deployment serves one organization, so an "all organizations"
  label states a plurality that does not exist — the same correction made to
  the policy labels in `utils/policyScopes.ts`. This text is only reached when
  more than one organization is genuinely in play, which in a one-org
  deployment means a stale grant an operator has to see.
*/
const orgLabel = (org: string): string => (org === "*" ? "any organization" : org);

interface Row {
  scope: string;
  organizationId: string;
  /** As currently drafted, or as it stands on the account. */
  actions: PolicyAction[];
  /** Actions already on the account, for the preserve-a-grant rule. */
  baselineActions: PolicyAction[];
  allowed: Set<PolicyAction>;
  /** True when this row came from the account rather than from the caller. */
  onAccount: boolean;
}

export function PolicyAttributeEditor({
  value,
  onChange,
  grantable,
  baseline = [],
  knownOrganizations = [],
  disabled = false,
  idPrefix,
}: {
  value: ApiPolicyAttribute[];
  onChange: (next: ApiPolicyAttribute[]) => void;
  /** The caller's own attributes — the ceiling on what may be granted. */
  grantable: ApiPolicyAttribute[];
  /** The attributes as loaded, so an untouched row is never rewritten. */
  baseline?: ApiPolicyAttribute[];
  /**
   * Organizations the directory already knows about, offered as rows.
   *
   * NOT a convenience. A super admin's own attributes are `*` / `*`, so without
   * this an invite would default to a grant on ALL ORGANIZATIONS — which in a
   * one-deployment-per-organization product is the wrong grant by default, and
   * one nobody would notice, because a wildcard resolves to everything and
   * therefore looks correct on screen. This is what makes the deployment's real
   * organization the obvious row to tick.
   */
  knownOrganizations?: string[];
  disabled?: boolean;
  /** Distinguishes ids when two editors share a page. */
  idPrefix: string;
}) {
  /*
    A super admin's attributes are wildcards, and the row set must still name every
    real scope. Without this the matrix would show a single row — "all scopes" —
    and the operator would be editing a grant that is not the one they think.
  */
  const scopes = useMemo(() => {
    const wildcard = grantable.some((a) => a.scope === "*");
    return sortScopes([
      ...(wildcard ? ["*", "dashboard", "payments", "reports", "users", "system"] : []),
      ...grantable.map((a) => a.scope),
      ...baseline.map((a) => a.scope),
      ...value.map((a) => a.scope),
    ]);
  }, [grantable, baseline, value]);

  const rows = useMemo<Row[]>(() => {
    const byKey = new Map<string, Row>();

    const ensure = (scope: string, organizationId: string): Row => {
      const k = key({ scope, organizationId });
      let row = byKey.get(k);
      if (!row) {
        row = {
          scope,
          organizationId,
          actions: [],
          baselineActions: [],
          allowed: grantableActions(grantable, scope, organizationId),
          onAccount: false,
        };
        byKey.set(k, row);
      }
      return row;
    };

    /*
      The account's own rows, so an untouched row round-trips unchanged.

      `baselineActions` AND `onAccount` ONLY. This loop must not touch `actions`.

      It used to set `row.actions = [...a.actions]` as well, which made clearing a
      row IMPOSSIBLE: `setRow` drops a row from `value` once its last action is
      unticked (the wire schema forbids an attribute with no actions), and on the
      next render this loop seeded the row straight back from the account — so
      unticking the final action silently re-ticked the whole row. Because every
      other row still held grants, `draft` was never empty, Save stayed enabled,
      and the operator saw a tick spring back with no error anywhere. Verified in
      the browser against a real account: unticking 3 of 4 stuck, the 4th put all
      4 back.

      `value` is the DRAFT and is therefore the only authority on what is ticked.
      The two callers both seed `value` from the account on open, so nothing that
      should render as granted renders unticked.
    */
    for (const a of baseline) {
      const row = ensure(a.scope, a.organizationId);
      row.baselineActions = [...a.actions];
      row.onAccount = true;
    }
    // The draft wins over the account, because that is what is being edited.
    for (const a of value) {
      const row = ensure(a.scope, a.organizationId);
      row.actions = [...a.actions];
      row.onAccount = row.onAccount || baseline.some((b) => key(b) === key(a));
    }
    // Then every row the caller could grant, whether or not it is in use.
    for (const a of grantable) {
      if (a.scope === "*" || a.organizationId === "*") continue;
      ensure(a.scope, a.organizationId);
    }
    /*
      And the real organizations this deployment serves, crossed with every scope,
      so a grant is never defaulted onto `*`. A super admin's own attributes are
      `*` / `*`; without this an invite would default to an unrestricted
      organization, which in a one-deployment-per-organization product is the
      wrong grant by default — and one nobody would notice, because a wildcard
      resolves to everything and so looks correct on screen.

      With nothing known, the organizations already in play are used, so an editor
      rendered without a directory still shows a coherent grid.
    */
    const orgs = knownOrganizations.length > 0
      ? knownOrganizations
      : [...new Set([...baseline, ...value].map((a) => a.organizationId))];
    for (const org of orgs) {
      for (const scope of scopes) {
        if (scope === "*") continue;
        ensure(scope, org);
      }
    }

    return [...byKey.values()].sort(
      (a, b) =>
        scopes.indexOf(a.scope) - scopes.indexOf(b.scope) ||
        a.organizationId.localeCompare(b.organizationId),
    );
  }, [grantable, baseline, value, scopes, knownOrganizations]);

  /**
   * Write a row's action set back, applying the EMPTY-ROW RULE.
   *
   * A row with nothing ticked is NOT an attribute with an empty array — it is no
   * attribute. The wire schema requires at least one action, so emitting one would
   * be refused with a message pointing at the wrong field, and storing one would
   * be a grant that grants nothing. The row stays VISIBLE in the matrix either
   * way; it simply stops being sent.
   */
  const setRow = (row: Row, actions: PolicyAction[]) => {
    onChange(
      rows
        .map((r) => (key(r) === key(row) ? { scope: r.scope, organizationId: r.organizationId, actions } : r))
        .filter((r) => r.actions.length > 0)
        .map((r) => ({ scope: r.scope, organizationId: r.organizationId, actions: r.actions })),
    );
  };

  const organizationsInPlay = new Set(rows.map((r) => r.organizationId));
  const showOrganization = organizationsInPlay.size > 1;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse">
          <caption className="sr-only">
            Access granted to this account. Each row is a scope; each column is an
            action. A ticked cell is a granted action. You can only grant actions you
            hold yourself.
          </caption>
          <thead>
            <tr>
              <th scope="col" className={cx(HEAD_CLASS, "w-10 px-2 py-2 text-left")}>
                <span title="Tick or clear every action on this scope">all</span>
              </th>
              <th scope="col" className={cx(HEAD_CLASS, "px-2 py-2 text-left")}>
                Scope
              </th>
              {ALL_ACTIONS.map((action) => (
                <th
                  scope="col"
                  key={action}
                  title={ACTION_NOTE[action]}
                  className={cx(HEAD_CLASS, ACTION_COL, "px-3 py-2 text-left whitespace-nowrap")}
                >
                  {action}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const preserved = row.baselineActions;
              const scopeName = scopeLabel(row.scope);
              const orgName = showOrganization ? orgLabel(row.organizationId) : null;

              /*
                WHAT "ALL" MEANS ON THIS ROW. Ticking it grants every action the
                CALLER HOLDS, and leaves alone anything already granted that they
                do not hold themselves — a preserved grant must not be silently
                dropped by a gesture meant to widen. Clearing it removes
                everything, because narrowing is always within the caller's power.
              */
              const grantableHere = ALL_ACTIONS.filter(
                (action) => row.allowed.has(action) || row.actions.includes(action),
              );
              const allOn = grantableHere.length > 0 && grantableHere.every((a) => row.actions.includes(a));
              const someOn = row.actions.length > 0 && !allOn;

              return (
                <tr key={`${idPrefix}-${key(row)}`} className="border-b border-rule-enamel-soft last:border-b-0">
                  <td className="px-2 py-1.5 align-middle">
                    <Checkbox
                      checked={allOn}
                      indeterminate={someOn}
                      disabled={disabled || grantableHere.length === 0}
                      label={`All actions on ${scopeName}${orgName ? `, ${orgName}` : ""}`}
                      title={`All actions on ${scopeName}`}
                      onChange={(on) => setRow(row, on ? grantableHere : [])}
                    />
                  </td>
                  <th scope="row" className="px-2 py-1.5 text-left align-middle font-regular">
                    <span className="mono block text-sm text-ink-1">{scopeName}</span>
                    {/*
                      The organization only appears when the set actually has more
                      than one. With one deployment per organization this is normally
                      hidden, and a permanent column would be noise — but a super
                      admin's `*` alongside a named one is a real state, and showing
                      the scope without it would hide which account a grant applies to.
                    */}
                    {orgName && (
                      <span className="mono block text-micro text-ink-3">{orgName}</span>
                    )}
                  </th>
                  {ALL_ACTIONS.map((action) => {
                    /*
                      Permitted when the caller holds it, OR the account already
                      carries it — so an administrator can preserve a grant they
                      cannot re-create, and can never widen one.
                    */
                    const permitted =
                      row.allowed.has(action) ||
                      (preserved.includes(action) && row.actions.includes(action));
                    const checked = row.actions.includes(action);
                    return (
                      <td key={action} className={cx(ACTION_COL, "px-3 py-1.5 align-middle")}>
                        <Checkbox
                          checked={checked}
                          disabled={disabled || !permitted}
                          label={`${scopeName}${orgName ? `, ${orgName}` : ""}: ${action}`}
                          title={
                            disabled
                              ? undefined
                              : permitted
                                ? ACTION_NOTE[action]
                                : "You do not hold this action, so you cannot grant it. It stays ticked because the account already has it."
                          }
                          onChange={(on) =>
                            setRow(
                              row,
                              on
                                ? [...new Set([...row.actions, action])]
                                : row.actions.filter((a) => a !== action),
                            )
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/*
        The row count is stated rather than implied, because a matrix that looks
        short may be complete. Where an action is greyed, that is the preserve rule
        and not a rendering fault, and saying so here is cheaper than every
        operator working it out.
      */}
      <p className="m-0 text-xs leading-prose text-ink-3">
        {rows.length} scope{rows.length === 1 ? "" : "s"} available from your own access. A greyed box is an
        action you do not hold and therefore cannot grant.
      </p>
    </div>
  );
}
