/* Page-level access derived from the caller's PBAC policy scope (FR-1.4).
   The console is attribute-driven, never a static role tier: a page is
   visible only when the active policy grants the resource `scope` + `action`
   it needs, and mutable only when the policy grants a write/admin action.

   The API exposes scopes as a flat "key:value|key:value" string (see
   mapPolicy in services/map.service.ts). We parse it defensively to support both the
   live backend shape and the synthetic demo fixtures. */

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

const has = (cap: Capability, scope: string, action: string): boolean =>
  cap.scope === "*" ? true : cap.scope === scope && cap.actions.has(action);

/** Access map for every route under a given active policy scope.
 *
 *  Monitor routes (overview/connections/findings/events) read from the
 *  dashboard scope; operations routes are reachable with payments or reports
 *  read and mutable with payments write; administration is admin-only. */
export function accessFor(policy: PolicyScope | null | undefined): Record<PageId, PageAccess> {
  const cap: Capability = policy ? parseAttributes(policy.attributes) : { scope: "*", org: "*", actions: new Set() };
  const admin = isAdminCapability(cap);

  const dashboardRead = has(cap, "dashboard", "read");
  const operationsRead =
    dashboardRead || has(cap, "payments", "read") || has(cap, "reports", "read");
  const operationsWrite = has(cap, "payments", "write") || has(cap, "payments", "admin");
  const systemWrite = has(cap, "system", "admin") || has(cap, "system", "write");

  return {
    overview: { visible: dashboardRead, canEdit: false },
    connections: { visible: dashboardRead, canEdit: false },
    findings: {
      visible: dashboardRead,
      // Acknowledge = the `ack` action on the dashboard scope (matches the
      // backend ack check). Admin supersedes.
      canEdit: admin || has(cap, "dashboard", "ack"),
    },
    events: { visible: dashboardRead, canEdit: false },
    payments: { visible: operationsRead, canEdit: operationsWrite },
    synchronization: { visible: operationsRead, canEdit: operationsWrite },
    reconciliation: {
      visible: dashboardRead || has(cap, "reports", "read"),
      canEdit: false,
    },
    users: { visible: admin, canEdit: admin },
    settings: { visible: admin || systemWrite, canEdit: admin || systemWrite },
    profile: { visible: true, canEdit: false },
  };
}

/** Is this the broadest available scope (drives the default selection)? */
export function isBroadest(policy: PolicyScope): boolean {
  return isAdminCapability(parseAttributes(policy.attributes)) || policy.readOnly === false;
}