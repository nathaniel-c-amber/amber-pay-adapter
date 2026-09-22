import type { Request } from 'express';
import type { PolicyAttribute } from '../types/auth.js';

/**
 * Extract the organization a request is scoped to, for PBAC resource
 * evaluation. Read from the JSON body (`organizationId`) for POSTs, falling
 * back to the `organizationId` query param for GETs. PBAC still decides
 * whether the caller is actually authorized for that organization.
 */
export function organizationIdOf(req: Request): string {
  const body = req.body as { organizationId?: unknown } | undefined;
  if (typeof body?.organizationId === 'string') {
    return body.organizationId;
  }
  const query = req.query['organizationId'];
  return typeof query === 'string' ? query : '';
}

/**
 * Derive the organization ids the caller is authorized to READ for a given
 * scope, from the token policy (C1). Used to filter repository reads so a
 * caller can never observe rows belonging to organizations they lack `read`
 * on. Never trusts the request body/query for the authorized set.
 *
 * Returns `null` to mean "all organizations" when the caller holds a wildcard
 * attribute (`organizationId === '*'`) granting `read` on the scope (or on all
 * scopes). Otherwise returns the union of the concrete org ids granted `read`
 * on the scope (including via a wildcard `scope: '*'` attribute).
 */
export function authorizedOrganizationIds(
  policy: PolicyAttribute[],
  scope: string,
): string[] | null {
  const readAttributes = policy.filter(
    (attribute) =>
      (attribute.scope === '*' || attribute.scope === scope) &&
      attribute.actions.includes('read'),
  );
  if (readAttributes.some((attribute) => attribute.organizationId === '*')) {
    return null;
  }
  return [...new Set(readAttributes.map((attribute) => attribute.organizationId))];
}
