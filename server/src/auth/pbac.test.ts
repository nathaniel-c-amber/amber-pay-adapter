import { can, evaluatePolicy } from './pbac.js';
import type { PolicyAttribute, PolicyResource } from './types.js';

const policy: PolicyAttribute[] = [
  { scope: 'payments', organizationId: 'org-1', actions: ['read', 'write'] },
  { scope: 'users', organizationId: 'org-1', actions: ['admin'] },
];

function resource(overrides: Partial<PolicyResource> = {}): PolicyResource {
  return { scope: 'payments', organizationId: 'org-1', action: 'read', ...overrides };
}

describe('evaluatePolicy (PBAC)', () => {
  it('allows when scope, organization and action all match', () => {
    expect(evaluatePolicy(policy, resource()).allowed).toBe(true);
  });

  it('denies on a mismatched scope', () => {
    expect(evaluatePolicy(policy, resource({ scope: 'invoices' })).allowed).toBe(false);
  });

  it('denies on a mismatched organization', () => {
    expect(evaluatePolicy(policy, resource({ organizationId: 'org-2' })).allowed).toBe(false);
  });

  it('denies on a mismatched action', () => {
    expect(evaluatePolicy(policy, resource({ action: 'ack' })).allowed).toBe(false);
  });

  it('denies for an empty policy', () => {
    expect(evaluatePolicy([], resource()).allowed).toBe(false);
  });

  it('does not grant an action that is not explicitly listed (no static-role bypass)', () => {
    const adminOnly: PolicyAttribute[] = [
      { scope: 'users', organizationId: 'org-1', actions: ['admin'] },
    ];
    // Holding `admin` must NOT implicitly grant `write`.
    expect(can(adminOnly, { scope: 'users', organizationId: 'org-1', action: 'write' })).toBe(false);
    expect(can(adminOnly, { scope: 'users', organizationId: 'org-1', action: 'admin' })).toBe(true);
  });

  it('allows a wildcard scope and organization (super admin)', () => {
    const superAdmin: PolicyAttribute[] = [
      { scope: '*', organizationId: '*', actions: ['read', 'ack', 'write', 'admin'] },
    ];
    expect(can(superAdmin, { scope: 'payments', organizationId: 'org-1', action: 'read' })).toBe(true);
    expect(can(superAdmin, { scope: 'users', organizationId: 'org-2', action: 'admin' })).toBe(true);
  });

  it('allows a wildcard scope with a specific organization', () => {
    const policy: PolicyAttribute[] = [
      { scope: '*', organizationId: 'org-1', actions: ['read'] },
    ];
    expect(can(policy, { scope: 'payments', organizationId: 'org-1', action: 'read' })).toBe(true);
    expect(can(policy, { scope: 'reports', organizationId: 'org-1', action: 'read' })).toBe(true);
  });

  it('allows a specific scope with a wildcard organization', () => {
    const policy: PolicyAttribute[] = [
      { scope: 'payments', organizationId: '*', actions: ['read'] },
    ];
    expect(can(policy, { scope: 'payments', organizationId: 'org-1', action: 'read' })).toBe(true);
    expect(can(policy, { scope: 'payments', organizationId: 'org-2', action: 'read' })).toBe(true);
  });

  it('denies a wildcard attribute when the action is missing', () => {
    const superAdmin: PolicyAttribute[] = [
      { scope: '*', organizationId: '*', actions: ['read', 'write'] },
    ];
    // `admin` is not listed, so it must NOT be granted even with wildcards.
    expect(can(superAdmin, { scope: 'users', organizationId: 'org-1', action: 'admin' })).toBe(false);
  });
});
