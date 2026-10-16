import type { PolicyAttribute } from '../types/auth.js';
import type { PolicyScope } from '../models/domain.js';

/** The wildcard scope, in words. The wildcard ORGANIZATION has no label: there
 * is only ever one organization, so there is nothing for a label to say. */
const scopeLabel = (scope: string): string => (scope === '*' ? 'All scopes' : scope);

/**
 * Build the caller's policy scopes for display (S3). Derived from the verified
 * token policy (operational metadata only, no PII).
 *
 * THE LABEL NAMES THE SCOPE AND NOT THE ORGANIZATION. A deployment serves
 * exactly one organization — `utils/policyGrant.ts` rejects any grant naming
 * another — so the organization is a deployment-wide constant that is identical
 * on every row. Printing it per row ("payments · All organizations") therefore
 * carries no information about the row it is printed on; it only makes every
 * label longer and implies a multi-tenant product this is not. The console
 * names the organization once, in the Profile page's organization row, using
 * the human-chosen name rather than an id.
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
    const label = isSuperAdmin ? 'Super Admin' : scopeLabel(attribute.scope);
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