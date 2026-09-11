import type { PolicyAttribute } from '../auth/types.js';
import type { PolicyScope } from '../domain/types.js';

/**
 * Build the caller's policy scopes for display (S3). Derived from the verified
 * token policy (operational metadata only, no PII).
 *
 * `readOnly` reflects the actual granted actions: a scope is read-only only
 * when the policy grants no `write` or `admin` action for it.
 */
export function policyScopesOf(policy: PolicyAttribute[]): PolicyScope[] {
  return policy.map((attribute, index) => {
    const hasWriteOrAdmin = attribute.actions.some(
      (action) => action === 'write' || action === 'admin',
    );
    const isSuperAdmin = attribute.scope === '*' && attribute.organizationId === '*';
    let label: string;
    if (isSuperAdmin) {
      label = 'Super Admin';
    } else if (attribute.scope === '*') {
      label = `All scopes · ${attribute.organizationId}`;
    } else if (attribute.organizationId === '*') {
      label = `${attribute.scope} · All organizations`;
    } else {
      label = `${attribute.scope} · ${attribute.organizationId}`;
    }
    return {
      id: isSuperAdmin ? 'super-admin' : `${attribute.organizationId}:${attribute.scope}:${index}`,
      label,
      attributes: {
        scope: attribute.scope,
        organizationId: attribute.organizationId,
        actions: attribute.actions.join(','),
      },
      readOnly: !hasWriteOrAdmin,
    };
  });
}