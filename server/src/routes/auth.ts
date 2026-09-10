import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
  toHttpError,
} from '../lib/errors.js';
import { requireAuth, requirePolicy } from '../auth/middleware.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { issueAccessToken, resolveAccessTokenTtlSeconds } from '../auth/tokens.js';
import { inviteService as defaultInviteService } from '../auth/invites.js';
import { twoFactorService as defaultTwoFactorService } from '../auth/twoFactor.js';
import { userStore as defaultUserStore } from '../auth/users.js';
import { organizationIdOf } from './policyResource.js';
import { env } from '../config/env.js';
import type { InviteService } from '../auth/invites.js';
import type { TwoFactorService } from '../auth/twoFactor.js';
import type { UserStore } from '../auth/users.js';

const policyActionSchema = z.enum(['read', 'ack', 'write', 'admin']);

const policyAttributeSchema = z.object({
  scope: z.string().min(1),
  organizationId: z.string().min(1),
  actions: z.array(policyActionSchema).min(1),
});

/** Strong-password rule for account setup. */
const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/\d/, 'Password must include a digit');

const inviteBodySchema = z.object({
  email: z.string().email(),
  organizationId: z.string().min(1),
  policyAttributes: z.array(policyAttributeSchema).min(1),
});

const acceptInviteBodySchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const verifyTwoFactorBodySchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});

// --- Rate limiting (per-IP; login is additionally per-email) ---------------
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = 10;
const TWO_FACTOR_RATE_LIMIT_MAX = 10;
const ACCEPT_INVITE_RATE_LIMIT_MAX = 5;

function rateLimitHandler(_req: express.Request, res: express.Response): void {
  const { status, body } = toHttpError(new TooManyRequestsError());
  res.status(status).json(body);
}

// Dummy bcrypt hash used to equalise login timing when the user is unknown.
let dummyPasswordHashPromise: Promise<string> | undefined;
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHashPromise ??= hashPassword('timing-attack-mitigation-placeholder');
  return dummyPasswordHashPromise;
}

export interface AuthRouteDeps {
  userStore?: UserStore;
  inviteService?: InviteService;
  twoFactorService?: TwoFactorService;
}

/**
 * Auth routes (invite-only + PBAC + email 2FA + rate limiting).
 *
 * The invite token is delivered via the email seam and is only included in the
 * API response in non-production (dev/test) environments for convenience.
 */
export function createAuthRouter(deps: AuthRouteDeps = {}): express.Router {
  const userStore = deps.userStore ?? defaultUserStore;
  const inviteService = deps.inviteService ?? defaultInviteService;
  const twoFactorService = deps.twoFactorService ?? defaultTwoFactorService;
  const router = express.Router();
  const exposeInviteToken = env.NODE_ENV !== 'production';

  const loginLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: LOGIN_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
    // Per-email throttling (fallback bucket for malformed/absent email).
    keyGenerator: (req) => {
      const body = req.body as { email?: unknown } | undefined;
      return typeof body?.email === 'string'
        ? `login:${body.email.toLowerCase()}`
        : 'login:anonymous';
    },
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

  // POST /api/v1/auth/invite — Admin (PBAC) only.
  router.post(
    '/auth/invite',
    requireAuth,
    requirePolicy('admin', (req) => ({
      scope: 'users',
      organizationId: organizationIdOf(req),
    })),
    asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const parsed = inviteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid invite payload');
      }

      // S2: the admin-grants-only-own-orgs rule lives in InviteService. The
      // allowed set is derived from the token policy, never the request body.
      const authorizedOrganizations = auth.policy
        .filter((attribute) => attribute.actions.includes('admin'))
        .map((attribute) => attribute.organizationId);

      const { invite, token } = await inviteService.createInvite(
        {
          email: parsed.data.email,
          policyAttributes: parsed.data.policyAttributes,
        },
        authorizedOrganizations,
      );

      const body: Record<string, unknown> = {
        invite: { id: invite.id, email: invite.email, expiresAt: invite.expiresAt },
        delivery: 'email',
      };
      if (exposeInviteToken) {
        // DEV/TEST ONLY. In production the token is emailed to the recipient
        // and is NEVER returned in the API response.
        body['token'] = token;
      }
      res.status(201).json(body);
    }),
  );

  // POST /api/v1/auth/accept-invite — public (token-gated). Only user-creation path.
  router.post(
    '/auth/accept-invite',
    acceptInviteLimiter,
    asyncHandler(async (req, res) => {
      const parsed = acceptInviteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid accept-invite payload');
      }
      const user = await inviteService.acceptInvite(parsed.data.token, parsed.data.password);
      res.status(200).json({ status: 'accepted', userId: user.id });
    }),
  );

  // POST /api/v1/auth/login — public. Password step only; 2FA still required.
  router.post(
    '/auth/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const parsed = loginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid login payload');
      }
      const user = await userStore.findByEmail(parsed.data.email);
      // Always run a bcrypt comparison — a dummy one when the user does not
      // exist — so response timing does not reveal user existence.
      const passwordHash = user?.hashedPassword ?? (await getDummyPasswordHash());
      const passwordOk = await verifyPassword(parsed.data.password, passwordHash);
      if (!user || !passwordOk) {
        throw new UnauthorizedError('Invalid credentials');
      }
      const challenge = await twoFactorService.createChallenge(user.id);
      // No access token yet — a valid 2FA code is required.
      res.status(200).json({ challengeId: challenge.id, requiresTwoFactor: true });
    }),
  );

  // POST /api/v1/auth/2fa/verify — public. Verifies the code and issues a token.
  router.post(
    '/auth/2fa/verify',
    twoFactorLimiter,
    asyncHandler(async (req, res) => {
      const parsed = verifyTwoFactorBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid 2FA payload');
      }
      const challenge = await twoFactorService.verifyChallenge(
        parsed.data.challengeId,
        parsed.data.code,
      );
      const user = await userStore.findById(challenge.userId);
      if (!user) {
        throw new UnauthorizedError('User not found');
      }
      const accessToken = issueAccessToken({
        id: user.id,
        email: user.email,
        policyAttributes: user.policyAttributes,
      });
      res.status(200).json({
        accessToken,
        tokenType: 'Bearer',
        expiresIn: resolveAccessTokenTtlSeconds(env.JWT_TTL),
      });
    }),
  );

  return router;
}
