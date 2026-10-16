import { describe, it, expect } from "vitest";
import {
  ABILITY,
  POLICY_SCOPES,
  SYSTEM_MANAGE,
  accessFor,
  can,
  canAny,
  cannot,
  capabilityFor,
  isAdminCapability,
  isBroadest,
  parseAbility,
  parseAttributes,
} from "@/utils/permissions";
import type { PolicyScope } from "@/types/domain";

/** A policy carrying the given raw attribute string, the way the API sends it. */
const policy = (attributes: string, readOnly = false): PolicyScope => ({
  id: "p",
  label: "p",
  attributes,
  readOnly,
});

const SUPER = "scope:*|organizationId:*|actions:read,ack,write,admin";

describe("parseAttributes", () => {
  it("reads the wire dialect the server emits", () => {
    const c = parseAttributes("scope:payments|organizationId:default|actions:read,ack");
    expect(c.scope).toBe("payments");
    expect(c.org).toBe("default");
    expect([...c.actions].sort()).toEqual(["ack", "read"]);
  });

  it("reads the legacy short dialect too (fixtures still carry it)", () => {
    const c = parseAttributes("sc:ams|org:acme|act:read|act:ack");
    expect(c.scope).toBe("ams");
    expect(c.org).toBe("acme");
    expect([...c.actions].sort()).toEqual(["ack", "read"]);
  });

  it("treats an empty value as the wildcard, not as a blank", () => {
    expect(parseAttributes("scope:|organizationId:|actions:").scope).toBe("*");
    expect(parseAttributes("scope:|organizationId:|actions:").org).toBe("*");
  });

  it("ignores unparseable segments rather than throwing", () => {
    expect(parseAttributes("nonsense|scope:payments").scope).toBe("payments");
  });

  it("grants nothing on an empty attribute string", () => {
    expect(parseAttributes("").actions.size).toBe(0);
  });
});

describe("the authorization gate", () => {
  it("grants an ability a concrete attribute names", () => {
    expect(can(policy("scope:payments|organizationId:default|actions:read"), ABILITY.paymentsRead)).toBe(
      true,
    );
  });

  /*
    THE INVARIANT THAT HAS ALREADY BEEN WRONG TWICE.

    A wildcard `scope` is NOT a blanket grant: it still has to NAME the action.
    The gate used to read `cap.scope === "*" ? true`, which offered controls the
    API then refused with a 403. A super admin holding only `admin` must not be
    able to acknowledge a finding.
  */
  it("does not let a wildcard scope grant an unnamed action", () => {
    const adminOnly = policy("scope:*|organizationId:*|actions:admin");
    expect(can(adminOnly, ABILITY.findingAck)).toBe(false);
    expect(can(adminOnly, ABILITY.paymentsRead)).toBe(false);
    expect(can(adminOnly, ABILITY.usersManage)).toBe(true);
  });

  it("grants nothing readable to a null policy... deliberately", () => {
    // A null policy is the WIDEST capability on purpose: demo mode must show
    // every surface, and the pre-load window must not blank a console. This is
    // asserted so the deliberate choice cannot be "corrected" by accident.
    expect(capabilityFor(null).actions.has("read")).toBe(true);
    expect(can(null, ABILITY.usersManage)).toBe(true);
  });

  it("is the exact inverse of cannot()", () => {
    const p = policy("scope:dashboard|organizationId:default|actions:read,ack");
    for (const ability of [ABILITY.dashboardRead, ABILITY.paymentsWrite, ABILITY.systemAdmin]) {
      expect(cannot(p, ability)).toBe(!can(p, ability));
    }
  });

  it("canAny is an OR, not an AND (Laravel's canany)", () => {
    const p = policy("scope:dashboard|organizationId:default|actions:read");
    expect(canAny(p, [ABILITY.paymentsRead, ABILITY.dashboardRead])).toBe(true);
    expect(canAny(p, [ABILITY.paymentsRead, ABILITY.systemAdmin])).toBe(false);
  });

  it("unlocks System configuration on EITHER system action, never only on both", () => {
    const writer = policy("scope:system|organizationId:default|actions:write");
    const admin = policy("scope:system|organizationId:default|actions:admin");
    expect(can(writer, ABILITY.systemWrite)).toBe(true);
    expect(canAny(writer, SYSTEM_MANAGE)).toBe(true);
    expect(canAny(admin, SYSTEM_MANAGE)).toBe(true);
  });
});

describe("parseAbility", () => {
  it("splits a resource/action pair", () => {
    expect(parseAbility("payments.write")).toEqual({ resource: "payments", action: "write" });
  });

  it("names every ability as a pair the policy grammar can express", () => {
    for (const ability of Object.values(ABILITY)) {
      const { resource, action } = parseAbility(ability);
      expect(POLICY_SCOPES).toContain(resource);
      expect(["read", "ack", "write", "admin"]).toContain(action);
    }
  });
});

describe("accessFor", () => {
  it("hides the monitoring surfaces from an operations-only policy", () => {
    const p = policy("scope:payments|organizationId:default|actions:read");
    const access = accessFor(p);
    expect(access.overview.visible).toBe(false);
    expect(access.payments.visible).toBe(true);
    expect(access.payments.canEdit).toBe(false);
  });

  it("lets dashboard read carry the operations surfaces, but not their writes", () => {
    const p = policy("scope:dashboard|organizationId:default|actions:read,ack");
    const access = accessFor(p);
    expect(access.overview.visible).toBe(true);
    expect(access.synchronization.visible).toBe(true);
    expect(access.payments.canEdit).toBe(false);
    expect(access.findings.canEdit).toBe(true);
  });

  it("keeps administration off a policy that is not admin", () => {
    const p = policy("scope:dashboard|organizationId:default|actions:read,write");
    const access = accessFor(p);
    expect(access.users.visible).toBe(false);
    expect(access.settings.visible).toBe(false);
    // Profile is always reachable: it is the page you sign out from.
    expect(access.profile.visible).toBe(true);
  });

  it("gives a super admin every surface", () => {
    const access = accessFor(policy(SUPER));
    for (const [page, entry] of Object.entries(access)) {
      expect(entry.visible, `${page} should be visible`).toBe(true);
    }
    expect(access.findings.canEdit).toBe(true);
    expect(access.payments.canEdit).toBe(true);
    expect(access.synchronization.canEdit).toBe(true);
    expect(access.users.canEdit).toBe(true);
    expect(access.settings.canEdit).toBe(true);
  });

  /*
    READ-ONLY SURFACES ARE READ-ONLY FOR EVERYONE.

    Overview, connections, event log, reconciliation and profile are hardcoded
    `canEdit: false` — they are observations, not controls, and no policy makes
    them editable. Asserted against the SUPER ADMIN specifically: it is the one
    policy that would otherwise satisfy any "does X have write" question, so a
    later change that wired `canEdit` to an ability would pass every other test
    here while quietly turning a read-only page into a control.
  */
  it("keeps the observation surfaces non-editable even for a super admin", () => {
    const access = accessFor(policy(SUPER));
    for (const page of ["overview", "connections", "events", "reconciliation", "profile"] as const) {
      expect(access[page].canEdit, `${page} must stay read-only`).toBe(false);
    }
  });

  it("reaches reconciliation on reports read alone, with no dashboard grant", () => {
    const access = accessFor(policy("scope:reports|organizationId:default|actions:read"));
    expect(access.reconciliation.visible).toBe(true);
    expect(access.overview.visible).toBe(false);
  });
});

describe("isAdminCapability / isBroadest", () => {
  it("recognises admin only on a wildcard scope", () => {
    expect(isAdminCapability(parseAttributes(SUPER))).toBe(true);
    expect(isAdminCapability(parseAttributes("scope:users|organizationId:default|actions:admin"))).toBe(
      false,
    );
  });

  /*
    `isBroadest` drives `pickDefaultPolicy`, so it decides WHICH SCOPE THE WHOLE
    CONSOLE RUNS UNDER. It must read `attributes`, never `label`: the labels were
    reworked (scope-only) and a gate that keyed off them would silently change
    navigation.
  */
  it("selects the broadest from attributes, not from the label", () => {
    const mislabelled: PolicyScope = {
      id: "x",
      label: "zzz not a real scope name",
      attributes: SUPER,
      readOnly: false,
    };
    expect(isBroadest(mislabelled)).toBe(true);
  });

  it("treats a read-only policy as not broadest", () => {
    expect(isBroadest(policy("scope:dashboard|organizationId:default|actions:read", true))).toBe(
      false,
    );
  });
});
