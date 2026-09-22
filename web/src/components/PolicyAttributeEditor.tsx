/* Policy attribute editor — the one control that grants access.
 *
 * Authorization in this product is a set of attributes, each naming a `scope`,
 * an `organizationId` and the `actions` granted on them. Editing that by hand
 * as free text invites exactly the mistakes PBAC exists to prevent, so this is
 * a structured editor: pick a scope, pick an organization, tick actions.
 *
 * WHERE THE OPTIONS COME FROM — this is the part that has to be right.
 *
 * An administrator can only hand out what they hold; the server enforces that
 * with `assertGrantableByAdmin`. But "what they hold" is not the same as "the
 * set of options", because a wildcard covers everything. A super admin holds a
 * single attribute (`scope: '*'`, `organizationId: '*'`), and if the option list
 * were built naively from their attributes alone it would contain only `*` —
 * so a select bound to a user's real `dashboard / acme` grant would fall back to
 * its first option and silently rewrite that grant into an all-scopes,
 * all-organizations one on save. That is a privilege escalation caused entirely
 * by a dropdown's default, and it is why the option lists below are unions:
 *
 *   options = (what the caller may grant, wildcards expanded)
 *           ∪ (what is already granted on this account, so nothing is lost)
 *           ∪ (what already exists elsewhere in the directory)
 *
 * The second and third terms are what make the editor SAFE TO OPEN AND SAVE
 * WITHOUT EDITING: an untouched row round-trips unchanged. A permission editor
 * that alters permissions simply by being opened is worse than none at all.
 *
 * An action is permitted when the caller holds it, OR when the row already
 * carried it (so an administrator can preserve a grant they cannot re-create,
 * but can never widen one).
 */

import { useMemo } from "react";
import { IconPlus } from "@/components/icons";
import { BTN, LINK_BTN, cx } from "@/components/ui";
import { POLICY_SCOPES } from "@/utils/permissions";
import type { ApiPolicyAttribute, PolicyAction } from "@/types/api";

const ALL_ACTIONS: PolicyAction[] = ["read", "ack", "write", "admin"];

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

const SELECT =
  "cursor-pointer rounded-panel border border-rule-enamel bg-midnight-3 px-2 py-1.5 font-sans text-sm text-ink-1 transition-colors hover:border-ink-4 disabled:cursor-not-allowed disabled:opacity-50";

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
  /** Organizations seen in the directory, offered as a convenience. */
  knownOrganizations?: string[];
  disabled?: boolean;
  /** Distinguishes the label ids when two editors share a page. */
  idPrefix: string;
}) {
  const scopes = useMemo(() => {
    const wildcard = grantable.some((a) => a.scope === "*");
    return sortScopes([
      // Wildcards first: a wildcard grant covers every scope, so every scope is
      // grantable — the vocabulary below stands in for "all of them".
      ...(wildcard ? ["*", ...POLICY_SCOPES] : []),
      ...grantable.map((a) => a.scope),
      ...baseline.map((a) => a.scope),
      ...value.map((a) => a.scope),
    ]);
  }, [grantable, baseline, value]);

  const organizationsFor = (scope: string): string[] => {
    const wildcard = grantable.some((a) => a.organizationId === "*" && covers(a, scope, "*"));
    return sortScopes([
      ...(wildcard ? ["*"] : []),
      ...grantable.filter((a) => a.scope === "*" || a.scope === scope).map((a) => a.organizationId),
      ...baseline.filter((a) => a.scope === scope).map((a) => a.organizationId),
      ...value.filter((a) => a.scope === scope).map((a) => a.organizationId),
      ...knownOrganizations,
    ]);
  };

  const replace = (index: number, next: ApiPolicyAttribute) => {
    onChange(value.map((attribute, i) => (i === index ? next : attribute)));
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const add = () => {
    const scope = scopes[0] ?? "";
    const organizationId = organizationsFor(scope)[0] ?? "";
    const actions = [...grantableActions(grantable, scope, organizationId)];
    onChange([
      ...value,
      { scope, organizationId, actions: actions.length > 0 ? [actions[0]!] : [] },
    ]);
  };

  return (
    <div className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {value.map((attribute, index) => {
          const organizations = organizationsFor(attribute.scope);
          const allowed = grantableActions(grantable, attribute.scope, attribute.organizationId);
          /*
            An action already present on the UNCHANGED row stays available even
            when the caller does not hold it: removing it would otherwise be
            forced on anyone who merely opened the panel.
          */
          const preserved = baseline.filter((a) =>
            covers(a, attribute.scope, attribute.organizationId),
          );
          const permittedFor = (action: PolicyAction): boolean =>
            allowed.has(action) ||
            (preserved.length > 0 &&
              attribute.actions.includes(action) &&
              baseline.some(
                (a) =>
                  a.scope === attribute.scope &&
                  a.organizationId === attribute.organizationId &&
                  a.actions.includes(action),
              ));

          return (
            <li
              className="flex flex-col gap-2 rounded-panel border border-rule-enamel bg-midnight px-3 py-2.5"
              key={`${idPrefix}-${index}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2">
                  <span className="mono text-micro uppercase tracking-label text-ink-3">Scope</span>
                  <select
                    className={SELECT}
                    value={attribute.scope}
                    disabled={disabled}
                    onChange={(e) => {
                      // Changing scope can invalidate the organization and the
                      // actions (the caller may not hold them on the new scope),
                      // so the row is rebased on what is still grantable.
                      const scope = e.target.value;
                      const organizationId =
                        organizationsFor(scope)[0] ?? attribute.organizationId;
                      const permitted = grantableActions(grantable, scope, organizationId);
                      replace(index, {
                        scope,
                        organizationId,
                        actions: attribute.actions.filter((a) => permitted.has(a)),
                      });
                    }}
                  >
                    {scopes.map((scope) => (
                      <option key={scope} value={scope}>
                        {scope === "*" ? "all scopes" : scope}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-2">
                  <span className="mono text-micro uppercase tracking-label text-ink-3">
                    Organization
                  </span>
                  <select
                    className={SELECT}
                    value={attribute.organizationId}
                    disabled={disabled}
                    onChange={(e) => {
                      const organizationId = e.target.value;
                      const permitted = grantableActions(grantable, attribute.scope, organizationId);
                      replace(index, {
                        scope: attribute.scope,
                        organizationId,
                        actions: attribute.actions.filter((a) => permitted.has(a)),
                      });
                    }}
                  >
                    {organizations.map((org) => (
                      <option key={org} value={org}>
                        {org === "*" ? "all organizations" : org}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className={cx(LINK_BTN, "ml-auto")}
                  disabled={disabled || value.length <= 1}
                  title={
                    value.length <= 1 ? "At least one attribute is required" : "Remove this attribute"
                  }
                  onClick={() => remove(index)}
                >
                  Remove
                </button>
              </div>

              <fieldset className="m-0 flex flex-wrap items-center gap-3 border-0 p-0">
                <legend className="mono mb-1 text-micro uppercase tracking-label text-ink-3">
                  Actions
                </legend>
                {ALL_ACTIONS.map((action) => {
                  const permitted = permittedFor(action);
                  const checked = attribute.actions.includes(action);
                  return (
                    <label
                      className={cx(
                        "flex items-center gap-2 text-sm",
                        permitted ? "cursor-pointer text-ink-1" : "cursor-not-allowed text-ink-4",
                      )}
                      key={action}
                      title={
                        permitted
                          ? undefined
                          : "You do not hold this action, so you cannot grant it"
                      }
                    >
                      <input
                        type="checkbox"
                        className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                        checked={checked}
                        disabled={disabled || !permitted}
                        onChange={(e) =>
                          replace(index, {
                            ...attribute,
                            actions: e.target.checked
                              ? [...attribute.actions, action]
                              : attribute.actions.filter((a) => a !== action),
                          })
                        }
                      />
                      <span className="mono">{action}</span>
                    </label>
                  );
                })}
              </fieldset>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2">
        <button type="button" className={BTN} onClick={add} disabled={disabled || scopes.length === 0}>
          <IconPlus />
          Add attribute
        </button>
        {scopes.length === 0 && (
          <span className="text-xs text-ink-3">Your policy grants nothing you could pass on.</span>
        )}
      </div>
    </div>
  );
}
