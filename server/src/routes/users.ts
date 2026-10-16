import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requirePolicyAnyOrganization } from '../middleware/auth.middleware.js';
import { rateLimitHandler } from '../middleware/rateLimitHandler.js';
import { createUsersController } from '../controllers/users.controller.js';
import { usersService as defaultUsersService } from '../services/auth/users.service.js';
import type { UsersService } from '../services/auth/users.service.js';

const ADMIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_MUTATION_RATE_LIMIT_MAX = 30;

export interface UsersRouteDeps {
  usersService?: UsersService;
}

/**
 * User directory routes.
 *
 * Every route requires `admin` on the `users` scope. The check is
 * "for some organization" because a listing has no single organization in the
 * request; the per-record narrowing happens in `UsersService`, which returns
 * only entries inside the caller's administered organizations.
 */
export function createUsersRouter(deps: UsersRouteDeps = {}): express.Router {
  const controller = createUsersController({
    usersService: deps.usersService ?? defaultUsersService,
  });
  const router = express.Router();

  const requireUserAdmin = requirePolicyAnyOrganization('admin', 'users');
  const mutationLimiter = rateLimit({
    windowMs: ADMIN_RATE_LIMIT_WINDOW_MS,
    max: ADMIN_MUTATION_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  const requireAdmin: express.RequestHandler[] = [requireAuth, requireUserAdmin];

  // GET /api/v1/users — the directory (accounts + outstanding invites).
  router.get('/users', ...requireAdmin, controller.list);

  // PATCH /api/v1/users/:id — replace an account's PBAC attributes.
  router.patch('/users/:id', ...requireAdmin, mutationLimiter, controller.updatePermissions);

  // POST /api/v1/users/:id/resend-invite — re-issue a pending invite link.
  router.post(
    '/users/:id/resend-invite',
    ...requireAdmin,
    mutationLimiter,
    controller.resendInvite,
  );

  return router;
}
