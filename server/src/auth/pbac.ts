import type {
  PolicyAttribute,
  PolicyDecision,
  PolicyResource,
} from './types.js';

/**
 * PBAC policy engine (FR-1.4).
 *
 * Rule: access is ALLOWED iff some policy attribute matches the resource's
 * `scope` AND `organizationId` AND includes the requested `action`.
 *
 * Wildcards: `'*'` for `scope` or `organizationId` matches any value, enabling
 * a super admin (all privileges) to be expressed as a single attribute with
 * `scope: '*'`, `organizationId: '*'`.
 *
 * There are no static roles and no implicit escalation — e.g. holding the
 * `admin` action does NOT grant `write` unless `write` is also listed. Every
 * endpoint access is evaluated dynamically against the caller's attributes.
 */
export function evaluatePolicy(
  policy: PolicyAttribute[],
  resource: PolicyResource,
): PolicyDecision {
  if (policy.length === 0) {
    return { allowed: false, reason: 'No policy attributes granted' };
  }

  for (const attribute of policy) {
    if (attribute.scope !== '*' && attribute.scope !== resource.scope) {
      continue;
    }
    if (attribute.organizationId !== '*' && attribute.organizationId !== resource.organizationId) {
      continue;
    }
    if (!attribute.actions.includes(resource.action)) {
      continue;
    }
    return {
      allowed: true,
      reason: `Granted '${resource.action}' on scope '${resource.scope}' for organization '${resource.organizationId}'`,
    };
  }

  return {
    allowed: false,
    reason: `No policy attribute grants '${resource.action}' on scope '${resource.scope}' for organization '${resource.organizationId}'`,
  };
}

/** Convenience wrapper returning just the boolean decision. */
export function can(policy: PolicyAttribute[], resource: PolicyResource): boolean {
  return evaluatePolicy(policy, resource).allowed;
}
