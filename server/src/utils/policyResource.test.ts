import { authorizedOrganizationIds } from './policyResource.js';
import type { PolicyAttribute } from '../types/auth.js';

describe('authorizedOrganizationIds', () => {
  it('returns the concrete org list for a concrete scope', () => {
    const policy: PolicyAttribute[] = [
      { scope: 'payments', organizationId: 'org-1', actions: ['read'] },
      { scope: 'payments', organizationId: 'org-2', actions: ['read'] },
    ];
    expect(authorizedOrganizationIds(policy, 'payments')).toEqual(['org-1', 'org-2']);
  });

  it('returns null (all orgs) for a wildcard-scope + wildcard-org grant', () => {
    const policy: PolicyAttribute[] = [
      { scope: '*', organizationId: '*', actions: ['read', 'write'] },
    ];
    expect(authorizedOrganizationIds(policy, 'payments')).toBeNull();
  });

  it('returns the concrete org for a wildcard-scope + concrete-org grant (M1)', () => {
    const policy: PolicyAttribute[] = [
      { scope: '*', organizationId: 'org-1', actions: ['read'] },
    ];
    expect(authorizedOrganizationIds(policy, 'payments')).toEqual(['org-1']);
  });

  it('returns null when any read grant has a wildcard org', () => {
    const policy: PolicyAttribute[] = [
      { scope: 'payments', organizationId: 'org-1', actions: ['read'] },
      { scope: 'payments', organizationId: '*', actions: ['read'] },
    ];
    expect(authorizedOrganizationIds(policy, 'payments')).toBeNull();
  });

  it('ignores attributes without read on the scope', () => {
    const policy: PolicyAttribute[] = [
      { scope: 'payments', organizationId: 'org-1', actions: ['write'] },
      { scope: 'reports', organizationId: 'org-1', actions: ['read'] },
    ];
    expect(authorizedOrganizationIds(policy, 'payments')).toEqual([]);
  });
});