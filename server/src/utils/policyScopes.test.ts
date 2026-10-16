import { policyScopesOf } from './policyScopes.js';
import type { PolicyScope } from '../models/domain.js';
import type { PolicyAttribute } from '../types/auth.js';

const attr = (overrides: Partial<PolicyAttribute>): PolicyAttribute => ({
  scope: 'payments',
  organizationId: 'org-1',
  actions: ['read'],
  ...overrides,
});

/**
 * `noUncheckedIndexedAccess` is on, so indexing an array yields `T | undefined`
 * and every `[0].label` would need a non-null assertion. Narrowing once here
 * keeps the assertions below about the CONTENT, which is what they are for.
 */
function only(attribute: PolicyAttribute): PolicyScope {
  const scopes = policyScopesOf([attribute]);
  expect(scopes).toHaveLength(1);
  const [scope] = scopes;
  if (!scope) throw new Error('expected exactly one policy scope');
  return scope;
}

describe('policyScopesOf', () => {
  it('names a concrete scope plainly', () => {
    expect(only(attr({ scope: 'payments' })).label).toBe('payments');
  });

  it('labels a wildcard scope in words, not as a character', () => {
    expect(only(attr({ scope: '*', organizationId: 'org-1' })).label).toBe('All scopes');
  });

  it('keeps the super admin label for the wildcard pair', () => {
    expect(only(attr({ scope: '*', organizationId: '*', actions: ['admin'] })).label).toBe(
      'Super Admin',
    );
  });

  /*
    THE INVARIANT THIS FILE EXISTS TO PROTECT.

    A deployment serves exactly one organization (`utils/policyGrant.ts` rejects
    any grant naming another), so the organization is identical on every row and
    carries no per-row information. The old labels printed it anyway —
    "payments · All organizations" — which asserted a plurality that does not
    exist. Asserted over EVERY shape below rather than per-case, so adding a new
    label branch cannot quietly reintroduce an organization.
  */
  it('never puts an organization in a label, in any shape', () => {
    const labels = policyScopesOf([
      attr({ scope: 'payments', organizationId: 'org-1' }),
      attr({ scope: 'dashboard', organizationId: '*' }),
      attr({ scope: '*', organizationId: 'org-1' }),
      attr({ scope: 'users', organizationId: 'acme', actions: ['admin'] }),
      attr({ scope: '*', organizationId: '*', actions: ['admin'] }),
    ]).map((scope) => scope.label);

    for (const label of labels) {
      expect(label).not.toMatch(/org/i);
      expect(label).not.toContain('*');
      expect(label).not.toContain('org-1');
      expect(label).not.toContain('acme');
      expect(label).not.toContain('·');
    }
  });

  it('still keeps the organization in `attributes` for the authorization engine', () => {
    // Display-only change: the raw attribute must survive, because `pbac.ts`
    // evaluates the org and the Profile page's raw readout quotes it.
    expect(only(attr({ scope: 'payments', organizationId: 'org-1' })).attributes).toEqual({
      scope: 'payments',
      organizationId: 'org-1',
      actions: 'read',
    });
  });

  it('marks a scope read-only only when it grants no write or admin', () => {
    const scopes = policyScopesOf([
      attr({ actions: ['read', 'ack'] }),
      attr({ actions: ['read', 'write'] }),
      attr({ actions: ['read', 'admin'] }),
    ]);
    expect(scopes.map((s) => s.readOnly)).toEqual([true, false, false]);
  });

  it('gives two attributes on the same scope distinct ids', () => {
    const ids = policyScopesOf([
      attr({ scope: 'payments', actions: ['read'] }),
      attr({ scope: 'payments', actions: ['write'] }),
    ]).map((s) => s.id);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
