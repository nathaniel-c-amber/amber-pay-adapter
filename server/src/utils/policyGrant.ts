import { ForbiddenError, ValidationError } from './errors.js';
import { env } from '../config/env.js';
import type { PolicyAttribute } from '../types/auth.js';

/**
 * The only organization ids a grant may name.
 *
 * `'*'` is allowed because it is a POLICY wildcard, and a holder of it may
 * legitimately create another. Any other concrete id is refused: this deployment
 * serves exactly one organization, so a grant for a second one would produce an
 * account that can read nothing — its policy names an organization no row
 * carries — while looking, from the administrator's side, like it succeeded.
 */
function assertKnownOrganization(attribute: PolicyAttribute): void {
  const { organizationId } = attribute;
  if (organizationId === '*' || organizationId === env.ORGANIZATION_ID) {
    return;
  }
  throw new ValidationError(
    `This deployment serves a single organization ('${env.ORGANIZATION_ID}'); cannot grant access to '${organizationId}'`,
  );
}

/**
 * Privilege-escalation guard (M2/S2).
 *
 * An administrator may only grant policy they themselves hold. The allowed set
 * is always derived from the caller's VERIFIED token policy, never from a
 * request body — otherwise an admin scoped to one organization could plant an
 * account in another, grant a scope they do not hold, or hand out actions they
 * do not hold.
 *
 * For each requested attribute the admin must hold a covering attribute with
 * the same scope (or wildcard scope) and the same organization (or wildcard
 * organization) whose actions include every requested action.
 *
 * Shared by `InviteService` (creating an account) and the user directory
 * (editing an existing account's permissions) so the two paths cannot drift.
 *
 * It also pins the ORGANIZATION. This deployment serves exactly one (see
 * `env.ORGANIZATION_ID`), so a grant naming any other concrete organization is
 * refused outright. Without that rule an administrator could plant an account
 * whose policy names an organization no row uses, and the account would read an
 * empty console while the backend worked perfectly — because reads are filtered
 * by the ids in the caller's OWN policy.
 */
export function assertGrantableByAdmin(
  requested: PolicyAttribute[],
  adminPolicy: PolicyAttribute[],
): void {
  for (const attribute of requested) {
    assertKnownOrganization(attribute);

    const covering = adminPolicy.filter(
      (admin) =>
        (admin.scope === '*' || admin.scope === attribute.scope) &&
        (admin.organizationId === '*' || admin.organizationId === attribute.organizationId),
    );
    const grantedActions = new Set(covering.flatMap((admin) => admin.actions));
    const missing = attribute.actions.filter((action) => !grantedActions.has(action));
    if (missing.length > 0) {
      throw new ForbiddenError(
        `Cannot grant action '${missing[0]}' on scope '${attribute.scope}' for organization '${attribute.organizationId}'`,
      );
    }
  }
}
