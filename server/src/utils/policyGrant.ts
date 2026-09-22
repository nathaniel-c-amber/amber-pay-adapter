import { ForbiddenError } from './errors.js';
import type { PolicyAttribute } from '../types/auth.js';

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
 */
export function assertGrantableByAdmin(
  requested: PolicyAttribute[],
  adminPolicy: PolicyAttribute[],
): void {
  for (const attribute of requested) {
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
