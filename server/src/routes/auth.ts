import express from 'express';
import rateLimit from 'express-rate-limit';
import { TooManyRequestsError, toHttpError } from '../utils/errors.js';
import { requireAuth, requirePolicy } from '../middleware/auth.middleware.js';
import { organizationIdOf } from '../utils/policyResource.js';
import { createAuthController } from '../controllers/auth.controller.js';
import { inviteService as defaultInviteService } from '../services/auth/invite.service.js';
import { passwordResetService as defaultPasswordResetService } from '../services/auth/passwordReset.service.js';
import { twoFactorService as defaultTwoFactorService } from '../services/auth/twoFactor.service.js';
import { userStore as defaultUserStore } from '../services/auth/user.service.js';
import type { InviteService } from '../services/auth/invite.service.js';
import type { PasswordResetService } from '../services/auth/passwordReset.service.js';
import type { TwoFactorService } from '../services/auth/twoFactor.service.js';
import type { UserStore } from '../services/auth/user.service.js';

// --- Rate limiting (per-IP; login/reset are additionally per-email) --------
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = 10;
const TWO_FACTOR_RATE_LIMIT_MAX = 10;
const ACCEPT_INVITE_RATE_LIMIT_MAX = 5;
// Reading an invite is cheap, non-destructive and happens on every page load,
// so it gets its own, looser budget: sharing accept-invite's five would let an
// invitee lock themselves out of accepting by refreshing the page.
const READ_INVITE_RATE_LIMIT_MAX = 60;
// A reset request sends mail to a third party, so it is throttled per address:
// without this the endpoint is a free amplifier for mailing a stranger.
const FORGOT_PASSWORD_RATE_LIMIT_MAX = 5;
const RESET_PASSWORD_RATE_LIMIT_MAX = 10;
// Stamping the first-run tour is idempotent and writes one column, so the only
// thing worth stopping is a hot loop. A real user reaches it once, or twice if
// they replay from Profile.
const TOUR_RATE_LIMIT_MAX = 20;
// Per-IP ceilings. Deliberately LOOSER than the per-address caps above: an
// office behind one NAT legitimately holds several sessions, so a tight per-IP
// budget would lock out real users before it inconvenienced an attacker. The
// pair is what works — the per-address cap stops a targeted lockout, the
// per-IP cap stops the same host trying every address in turn.
const LOGIN_IP_RATE_LIMIT_MAX = 50;
const FORGOT_PASSWORD_IP_RATE_LIMIT_MAX = 20;

/** Key a limiter on the request's email field, with a shared fallback bucket. */
function emailKey(prefix: string) {
  return (req: express.Request): string => {
    const body = req.body as { email?: unknown } | undefined;
    return typeof body?.email === 'string'
      ? `${prefix}:${body.email.toLowerCase()}`
      : `${prefix}:anonymous`;
  };
}

function rateLimitHandler(_req: express.Request, res: express.Response): void {
  const { status, body } = toHttpError(new TooManyRequestsError());
  res.status(status).json(body);
}

export interface AuthRouteDeps {
  userStore?: UserStore;
  inviteService?: InviteService;
  twoFactorService?: TwoFactorService;
  passwordResetService?: PasswordResetService;
}

/**
 * Auth routes (invite-only + PBAC + email 2FA + rate limiting).
 *
 * Request handling lives in `controllers/auth.controller.ts`; this module owns
 * the route surface, the authorization policy and the per-IP/per-email
 * throttles.
 */
export function createAuthRouter(deps: AuthRouteDeps = {}): express.Router {
  const controller = createAuthController({
    userStore: deps.userStore ?? defaultUserStore,
    inviteService: deps.inviteService ?? defaultInviteService,
    twoFactorService: deps.twoFactorService ?? defaultTwoFactorService,
    passwordResetService: deps.passwordResetService ?? defaultPasswordResetService,
  });
  const router = express.Router();

  const loginEmailLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: LOGIN_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
    keyGenerator: emailKey('login'),
  });

  const loginIpLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: LOGIN_IP_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
    // Default keying on `req.ip`, which is only the real client because
    // `app.set('trust proxy', TRUSTED_PROXY_HOPS)` is configured.
  });

  const twoFactorLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: TWO_FACTOR_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  const acceptInviteLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: ACCEPT_INVITE_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  const readInviteLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: READ_INVITE_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  const forgotPasswordLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: FORGOT_PASSWORD_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
    keyGenerator: emailKey('forgot'),
  });

  const forgotPasswordIpLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: FORGOT_PASSWORD_IP_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  const resetPasswordLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: RESET_PASSWORD_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  const tourLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: TOUR_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  // POST /api/v1/auth/invite — Admin (PBAC) only.
  router.post(
    '/auth/invite',
    requireAuth,
    requirePolicy('admin', (req) => ({
      scope: 'users',
      organizationId: organizationIdOf(req),
    })),
    controller.inviteUser,
  );

  // POST /api/v1/auth/accept-invite — public (token-gated). Only user-creation path.
  router.post('/auth/accept-invite', acceptInviteLimiter, controller.acceptInvite);

  // GET /api/v1/auth/invite/:token — public (token-gated). Lets the accept page
  // describe the invite before the password is set. Never consumes the invite.
  router.get('/auth/invite/:token', readInviteLimiter, controller.getInvite);

  // POST /api/v1/auth/login — public. Password step only; 2FA still required.
  // Per-IP first: a host spraying many addresses must be stopped before the
  // per-address bucket (which each new address would reset) is consulted.
  router.post('/auth/login', loginIpLimiter, loginEmailLimiter, controller.login);

  // POST /api/v1/auth/2fa/verify — public. Verifies the code and issues a token.
  router.post('/auth/2fa/verify', twoFactorLimiter, controller.verifyTwoFactor);

  // GET /api/v1/auth/me — the caller's own identity and granted policy.
  router.get('/auth/me', requireAuth, controller.me);

  // POST /api/v1/auth/me/tour-complete — stamp the caller's OWN first-run tour
  // as seen. requireAuth only: this is deliberately NOT admin-gated, because
  // every user owns their own tour state. Idempotent, so it answers 204 on a
  // repeat as well as a first call.
  router.post('/auth/me/tour-complete', requireAuth, tourLimiter, controller.completeTour);

  // POST /api/v1/auth/forgot-password — public. Always 202 (no enumeration).
  router.post(
    '/auth/forgot-password',
    forgotPasswordIpLimiter,
    forgotPasswordLimiter,
    controller.forgotPassword,
  );

  // POST /api/v1/auth/reset-password — public, token-gated, single use.
  router.post('/auth/reset-password', resetPasswordLimiter, controller.resetPassword);

  return router;
}
