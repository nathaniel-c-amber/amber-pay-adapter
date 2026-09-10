import type { Request } from 'express';
import type { PolicyAttribute } from '../auth/types.js';

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
 */
export function authorizedOrganizationIds(
  policy: PolicyAttribute[],
  scope: string,
): string[] {
  return [
    ...new Set(
      policy
        .filter((attribute) => attribute.scope === scope && attribute.actions.includes('read'))
        .map((attribute) => attribute.organizationId),
    ),
  ];
}
