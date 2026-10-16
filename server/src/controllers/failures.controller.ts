import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors.js';
import type { FailureRepository } from '../types/repository.js';
import type { PolicyAttribute } from '../types/auth.js';

/**
 * Derive the organization ids the caller is authorized to ACK for the
 * dashboard scope, from the token policy (C1). Never trusts the request body
 * or query for the authorized set — the repository enforces org-scoping.
 *
 * Mirrors the canonical engine in `utils/pbac.ts`: a wildcard `scope` or
 * `organizationId` matches, and the action must still be named explicitly
 * (`admin` does not imply `ack`).
 *
 * Returns `null` for an unrestricted caller, which the repository reads as
 * "no organization filter". The previous exact-match version returned `[]` for
 * a super admin holding `{scope:'*', organizationId:'*'}`, so the
 * highest-privilege account in the system could not acknowledge anything; and
 * when the scope did match, a literal `'*'` organization was passed to
 * `WHERE organization_id = ANY($3)`, where it matched no row.
 */
function ackOrganizationIds(policy: PolicyAttribute[]): string[] | null {
  const grants = policy.filter(
    (attribute) =>
      (attribute.scope === 'dashboard' || attribute.scope === '*') &&
      attribute.actions.includes('ack'),
  );
  if (grants.length === 0) {
    return [];
  }
  if (grants.some((attribute) => attribute.organizationId === '*')) {
    return null;
  }
  return [...new Set(grants.map((attribute) => attribute.organizationId))];
}

export interface FailuresControllerDeps {
  failures: FailureRepository;
}

export interface FailuresController {
  /** POST /api/v1/failures/:id/acknowledge */
  acknowledgeFailure: RequestHandler;
  /** POST /api/v1/failures/acknowledge */
  acknowledgeFailures: RequestHandler;
}

/**
 * The batch ceiling. `FailureRepository.list` already returns at most 500
 * findings, so no legitimate "acknowledge everything" request can exceed it,
 * and the cap keeps an arbitrary array from reaching `WHERE id = ANY($1)`.
 * Exceeding it is a client bug, not a real workload, so it is rejected rather
 * than silently truncated: a caller told "you acknowledged 500" when it sent
 * 900 would believe the queue is clear when it is not.
 */
const MAX_BATCH = 500;

/**
 * Validate the `ids` array from the batch body.
 *
 * Returns the deduplicated ids, or throws. Note what is NOT accepted: there is
 * no organization field, no timestamp, and no actor. An acknowledgement asserts
 * who acted, so `acknowledgedBy` comes from the access token — see
 * `createFailuresController`. A body that is not a plain array of non-empty
 * strings is rejected outright rather than coerced, because `coercion` here
 * would mean guessing at which of the caller's values were ids.
 */
function batchIds(body: unknown): string[] {
  const ids = (body as { ids?: unknown } | undefined)?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError('ids must be a non-empty array of finding ids');
  }
  if (ids.length > MAX_BATCH) {
    throw new ValidationError(`ids must contain at most ${MAX_BATCH} finding ids`);
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ValidationError('ids must contain only non-empty strings');
    }
    seen.add(id);
  }
  return [...seen];
}

/**
 * Failure acknowledgement.
 *
 * Authorization is decoupled from any request-supplied organization: the caller
 * must hold the `ack` action on the `dashboard` scope for at least one
 * organization (checked below), and the repository enforces org-scoping by
 * only acknowledging failures in the caller's authorized orgs (404 otherwise).
 *
 * The actor is likewise taken from the token rather than the request: the
 * recorded `acknowledgedBy` is `req.auth.email`, which the client cannot
 * assert on its own behalf.
 */
export function createFailuresController(deps: FailuresControllerDeps): FailuresController {
  return {
    acknowledgeFailure: asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const organizationIds = ackOrganizationIds(req.auth.policy);
      if (organizationIds !== null && organizationIds.length === 0) {
        throw new ForbiddenError('No policy grants ack on scope dashboard');
      }
      const failureId = req.params.id;
      if (!failureId) {
        throw new NotFoundError('Failure not found');
      }
      const acknowledged = await deps.failures.acknowledge(
        failureId,
        new Date().toISOString(),
        organizationIds,
        req.auth.email,
      );
      if (!acknowledged) {
        throw new NotFoundError('Failure not found');
      }
      res.status(200).json(acknowledged);
    }),

    /**
     * Acknowledge many findings as one operator action.
     *
     * 200 even when nothing matched: a batch that overlaps findings the caller
     * cannot see is a normal outcome of an out-of-date console, and failing it
     * would make "Acknowledge all" unreliable for the common case where the
     * page is slightly stale. The response reports what was actually
     * acknowledged, so the client reconciles against that rather than assuming
     * the whole list cleared.
     */
    acknowledgeFailures: asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const organizationIds = ackOrganizationIds(req.auth.policy);
      if (organizationIds !== null && organizationIds.length === 0) {
        throw new ForbiddenError('No policy grants ack on scope dashboard');
      }
      const ids = batchIds(req.body);
      const failures = await deps.failures.acknowledgeMany(
        ids,
        new Date().toISOString(),
        organizationIds,
        req.auth.email,
      );
      res.status(200).json({ acknowledged: failures.length, failures });
    }),
  };
}
