import { z } from 'zod';
import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { UnauthorizedError, ValidationError } from '../utils/errors.js';
import { policyAttributesSchema } from '../utils/policyAttributes.js';
import type { UsersService } from '../services/auth/users.service.js';

const updatePermissionsBodySchema = z.object({
  policyAttributes: policyAttributesSchema,
});

export interface UsersControllerDeps {
  usersService: UsersService;
}

export interface UsersController {
  /** GET /api/v1/users — the admin user directory. */
  list: RequestHandler;
  /** PATCH /api/v1/users/:id — replace an account's PBAC attributes. */
  updatePermissions: RequestHandler;
  /** POST /api/v1/users/:id/resend-invite — re-issue a pending invite link. */
  resendInvite: RequestHandler;
}

/**
 * User directory and permission management.
 *
 * Authorization is enforced in the route (the caller must hold `admin` on the
 * `users` scope for some organization) and again per record inside
 * `UsersService`, which is what stops an administrator from reaching an account
 * in an organization they do not administer by naming its id directly.
 */
export function createUsersController(deps: UsersControllerDeps): UsersController {
  return {
    list: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const users = await deps.usersService.listDirectory(auth.policy);
      res.status(200).json({ users, generatedAt: new Date().toISOString() });
    }),

    updatePermissions: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const parsed = updatePermissionsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid permission update payload');
      }
      const user = await deps.usersService.updatePermissions(
        req.params['id'] ?? '',
        parsed.data.policyAttributes,
        auth.policy,
      );
      res.status(200).json({ user });
    }),

    /*
      A DELIBERATE EXCEPTION to the "a token is never in a response" rule the
      invite-creation route keeps. Like an invite, only the token's HASH is
      stored, so a fresh link can never be read back — returning it on re-issue is
      the only way the console can offer `Copy invitation link` at all. The
      disclosure is bounded by the same authorization as the write: `requireAuth`
      plus `admin` on `users` (route), then `withinAdministration` and
      `assertGrantableByAdmin` on the invite itself (service). The token therefore
      reaches the one party who could already issue an invite for this address.
    */
    resendInvite: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const { invite, token } = await deps.usersService.resendInvite(
        req.params['id'] ?? '',
        auth.policy,
      );
      res.status(202).json({
        status: 'resent',
        invite: { id: invite.id, email: invite.email, expiresAt: invite.expiresAt },
        token,
      });
    }),
  };
}
