/* Authorization, asked one way (FR-1.4).
 *
 * Every gated surface in the console — a navigation item, a route, a button, a
 * toggle, an input — asks the SAME question through the same operator:
 *
 *     can(policy, ABILITY.paymentsWrite)      // data layer
 *     <Can ability={ABILITY.paymentsWrite}>   // component layer
 *     const can = useCan(); can(...)          // hook layer
 *
 * That is Laravel's Gate, transposed: a policy attribute grants `actions` on a
 * `scope`, so an ability is written `"<scope>.<action>"` and the gate resolves
 * once, in one place. Before this, each surface re-derived its own boolean
 * (`canEdit`, `canWrite`, `canAck`, an inline `isAdminCapability` check), which
 * is how the same rule can drift into three slightly different answers.
 *
 * `accessFor` below is the page-level roll-up of the same abilities — the
 * vocabulary is defined once, never restated.
 *
 * The API exposes scopes as a flat "key:value|key:value" string (see
 * mapPolicy in services/map.service.ts). We parse it defensively to support both the
 * live backend shape and the synthetic demo fixtures. */

import type { PolicyScope } from "@/types/domain";

/** The console's authenticated surfaces — the unit of access.
 *
 *  Deliberately an explicit union rather than an alias of RouteName: the router
 *  also carries unauthenticated routes (signin, invite), and those are not
 *  things a policy grants or withholds. Aliasing them into the access map would
 *  ask "may this user read the sign-in page?", which has no answer. */
export type PageId =
  | "overview"
  | "connections"
  | "findings"
  | "events"
  | "payments"
  | "synchronization"
  | "reconciliation"
  | "users"
  | "settings"
  | "profile";

/**
 * The resource scopes PBAC evaluates against, mirroring the `scope` values the
 * server checks (`authorizedOrganizationIds(policy, 'dashboard')`,
 * `requirePolicy('admin', { scope: 'users' })`, and so on).
 *
 * Kept as data rather than prose because the permission editor needs to offer
 * them: an administrator holding a wildcard scope may grant ANY scope, and a
 * control cannot list "any" without a vocabulary to draw from.
 */
export const POLICY_SCOPES = ["dashboard", "payments", "reports", "users", "system"] as const;

/**
 * The console's abilities: every operation the UI is allowed to offer.
 *
 * Named rather than written inline so a call site reads as intent
 * (`ABILITY.findingAck`) and a typo is a compile error instead of a surface
 * that silently never appears. The value is `<scope>.<action>`, exactly the
 * pair a policy attribute grants.
 */
export const ABILITY = {
  /** Read the monitoring surfaces: Overview, Connections, Findings, Event log. */
  dashboardRead: "dashboard.read",
  /** Acknowledge a finding (the `ack` action on the dashboard scope). */
  findingAck: "dashboard.ack",
  /** Read the payment lifecycle. */
  paymentsRead: "payments.read",
  /** Create a payment and run a manual synchronisation. */
  paymentsWrite: "payments.write",
  /** Read the reconciliation report on its own grant. */
  reportsRead: "reports.read",
  /** Invite, edit, and re-invite accounts. */
  usersManage: "users.admin",
  /** Edit the accounting adaptors, webhook pipeline, and sync cadence. */
  systemWrite: "system.write",
  systemAdmin: "system.admin",
} as const;

export type Ability = (typeof ABILITY)[keyof typeof ABILITY];

/** One ability, or several satisfied by ANY of them (Laravel's `canany`). */
export type AbilitySet = Ability | readonly Ability[];

/** The ability set that unlocks System configuration. */
export const SYSTEM_MANAGE: readonly Ability[] = [ABILITY.systemWrite, ABILITY.systemAdmin];

/** The ability set that unlocks a page with two route grants. */
const OPERATIONS_READ: readonly Ability[] = [ABILITY.paymentsRead, ABILITY.reportsRead];

export interface Capability {
  scope: string;
  org: string;
  actions: Set<string>;
}

export interface PageAccess {
  visible: boolean;
  canEdit: boolean;
}

/** Parse a "scope:x|organizationId:y|actions:read,ack" string into a capability. */
export function parseAttributes(raw: string): Capability {
  const cap: Capability = { scope: "*", org: "*", actions: new Set() };
  for (const part of raw.split("|")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "scope" || k === "sc") cap.scope = v || "*";
    else if (k === "organizationId" || k === "org") cap.org = v || "*";
    else if (k === "actions" || k === "act")
      v.split(",").forEach((a) => a && cap.actions.add(a.trim()));
  }
  return cap;
}

export function isAdminCapability(cap: Capability): boolean {
  return cap.scope === "*" && cap.actions.has("admin");
}

/* Mirrors the server's engine (server/src/utils/pbac.ts): a wildcard `scope`
   matches any resource, but the action still has to be named. The previous
   shortcut returned true for ANY action on a `scope: *` attribute, so the UI
   offered controls the API then refused with a 403 — the gate must not be more
   generous than the thing it is gating. */
const has = (cap: Capability, scope: string, action: string): boolean =>
  (cap.scope === "*" || cap.scope === scope) && cap.actions.has(action);

/**
 * The capability a policy is judged by.
 *
 * A null policy is the console's widest capability, and that is deliberate.
 * Two states reach it — the demo console, which is meant to show every surface
 * (the DemoTag says the data is synthetic), and the window before the first
 * policy loads, where failing closed would blank a console the caller may well
 * have full rights to. The UI is not the security boundary: the API evaluates
 * every request against the caller's real attributes, so an over-generous gate
 * can only offer a control that the server then refuses.
 */
export function capabilityFor(policy: PolicyScope | null | undefined): Capability {
  return policy
    ? parseAttributes(policy.attributes)
    : { scope: "*", org: "*", actions: new Set(["read", "ack", "write", "admin"]) };
}

/** Split `"payments.write"` into the resource/action pair a policy grants. */
export function parseAbility(ability: Ability): { resource: string; action: string } {
  const idx = ability.indexOf(".");
  return { resource: ability.slice(0, idx), action: ability.slice(idx + 1) };
}

/**
 * The gate: does this policy grant the ability?
 *
 * `admin` on a wildcard scope supersedes every other grant, so a super-admin
 * policy answers true without enumerating actions.
 */
export function can(policy: PolicyScope | null | undefined, ability: Ability): boolean {
  const { resource, action } = parseAbility(ability);
  return has(capabilityFor(policy), resource, action);
}

/** The inverse, for the "state why it is absent" branch of a surface. */
export function cannot(policy: PolicyScope | null | undefined, ability: Ability): boolean {
  return !can(policy, ability);
}

/** True when the policy grants ANY of the abilities (Laravel's `canany`). */
export function canAny(
  policy: PolicyScope | null | undefined,
  abilities: AbilitySet,
): boolean {
  const list = typeof abilities === "string" ? [abilities] : abilities;
  return list.some((ability) => can(policy, ability));
}

/** Access map for every route under a given active policy scope.
 *
 *  Monitor routes (overview/connections/findings/events) read from the
 *  dashboard scope; operations routes are reachable with payments or reports
 *  read and mutable with payments write; administration is admin-only.
 *
 *  Every entry is a roll-up of the abilities above, so a page and the controls
 *  inside it cannot disagree about what the policy grants. */
export function accessFor(policy: PolicyScope | null | undefined): Record<PageId, PageAccess> {
  const dashboardRead = can(policy, ABILITY.dashboardRead);
  const operationsRead = dashboardRead || canAny(policy, OPERATIONS_READ);
  const paymentsWrite = can(policy, ABILITY.paymentsWrite);
  const systemManage = canAny(policy, SYSTEM_MANAGE);
  const usersManage = can(policy, ABILITY.usersManage);

  return {
    overview: { visible: dashboardRead, canEdit: false },
    connections: { visible: dashboardRead, canEdit: false },
    findings: { visible: dashboardRead, canEdit: can(policy, ABILITY.findingAck) },
    events: { visible: dashboardRead, canEdit: false },
    payments: { visible: operationsRead, canEdit: paymentsWrite },
    synchronization: { visible: operationsRead, canEdit: paymentsWrite },
    reconciliation: {
      visible: dashboardRead || can(policy, ABILITY.reportsRead),
      canEdit: false,
    },
    users: { visible: usersManage, canEdit: usersManage },
    settings: { visible: systemManage, canEdit: systemManage },
    profile: { visible: true, canEdit: false },
  };
}


/** Is this the broadest available scope (drives the default selection)? */
export function isBroadest(policy: PolicyScope): boolean {
  return isAdminCapability(parseAttributes(policy.attributes)) || policy.readOnly === false;
}