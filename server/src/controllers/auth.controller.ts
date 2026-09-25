import { z } from 'zod';
import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { UnauthorizedError, ValidationError } from '../utils/errors.js';
import { hashPassword, verifyPassword } from '../utils/passwords.js';
import {
  passwordSchema,
  policyAttributesSchema,
} from '../utils/policyAttributes.js';
import { policyScopesOf } from '../utils/policyScopes.js';
import { issueAccessToken, resolveAccessTokenTtlSeconds } from '../utils/tokens.js';
import { env } from '../config/env.js';
import type { InviteService } from '../services/auth/invite.service.js';
import type { PasswordResetService } from '../services/auth/passwordReset.service.js';
import type { TwoFactorService } from '../services/auth/twoFactor.service.js';
import type { UserStore } from '../services/auth/user.service.js';
import { settingsService as defaultSettingsService } from '../services/settings/settings.service.js';
import type { SettingsService } from '../services/settings/settings.service.js';

const inviteBodySchema = z.object({
  email: z.string().email(),
  organizationId: z.string().min(1),
  policyAttributes: policyAttributesSchema,
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

const forgotPasswordBodySchema = z.object({
  email: z.string().email(),
});

const resetPasswordBodySchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

// Dummy bcrypt hash used to equalise login timing when the user is unknown.
let dummyPasswordHashPromise: Promise<string> | undefined;
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHashPromise ??= hashPassword('timing-attack-mitigation-placeholder');
  return dummyPasswordHashPromise;
}

export interface AuthControllerDeps {
  userStore: UserStore;
  inviteService: InviteService;
  twoFactorService: TwoFactorService;
  passwordResetService: PasswordResetService;
  /**
   * Only the organization's NAME is read, and only to name the organization to
   * every signed-in user. It is a dependency rather than a module singleton so the
   * identity endpoint can be tested without reaching for shared state.
   */
  settingsService?: Pick<SettingsService, 'getOrganizationName'>;
}

export interface AuthController {
  /** POST /api/v1/auth/invite (PBAC 'admin' on scope 'users') */
  inviteUser: RequestHandler;
  /** POST /api/v1/auth/accept-invite (token-gated, public) */
  acceptInvite: RequestHandler;
  /** GET /api/v1/auth/invite/:token (token-gated, public) — reads, never consumes */
  getInvite: RequestHandler;
  /** POST /api/v1/auth/login (public; password step only) */
  login: RequestHandler;
  /** POST /api/v1/auth/2fa/verify (public) */
  verifyTwoFactor: RequestHandler;
  /** GET /api/v1/auth/me (Bearer) — the caller's own identity and policy */
  me: RequestHandler;
  /** POST /api/v1/auth/me/tour-complete (Bearer) — stamp first-run tour completion */
  completeTour: RequestHandler;
  /** POST /api/v1/auth/forgot-password (public; never reveals account existence) */
  forgotPassword: RequestHandler;
  /** POST /api/v1/auth/reset-password (public; token-gated) */
  resetPassword: RequestHandler;
}

/**
 * Auth request handling (invite-only + PBAC + email 2FA).
 *
 * The invite token is delivered via the email seam and is only included in the
 * API response in non-production (dev/test) environments for convenience.
 * Rate limiting stays a route-level middleware concern.
 */
export function createAuthController(deps: AuthControllerDeps): AuthController {
  const exposeInviteToken = env.NODE_ENV !== 'production';
  const exposeTwoFactorCode = env.NODE_ENV !== 'production';
  const exposeResetToken = env.NODE_ENV !== 'production';
  const settings = deps.settingsService ?? defaultSettingsService;

  return {
    inviteUser: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const parsed = inviteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid invite payload');
      }

      // S2/M2: the admin-grants-only-what-they-hold rule lives in
      // InviteService. The allowed set is derived from the token policy, never
      // the request body.
      const { invite, token } = await deps.inviteService.createInvite(
        {
          email: parsed.data.email,
          policyAttributes: parsed.data.policyAttributes,
        },
        auth.policy,
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

    acceptInvite: asyncHandler(async (req, res) => {
      const parsed = acceptInviteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid accept-invite payload');
      }
      const user = await deps.inviteService.acceptInvite(parsed.data.token, parsed.data.password);
      res.status(200).json({ status: 'accepted', userId: user.id });
    }),

    /*
      What an invite carries, so the accept page can say who it is for and what
      it grants BEFORE a password is chosen. Reading uses the same validation as
      accepting — expired, used and forged tokens are refused here — but creates
      nothing and does not consume the invite, so reloading the link is safe.

      The token is the bearer credential and is a 32-byte random value, so this
      discloses no more to its holder than the email that carried it already did.
    */
    getInvite: asyncHandler(async (req, res) => {
      const token = req.params.token ?? '';
      const invite = await deps.inviteService.verifyInviteToken(token);
      res.status(200).json({
        invite: {
          email: invite.email,
          policyAttributes: invite.policyAttributes,
          expiresAt: invite.expiresAt,
        },
      });
    }),

    login: asyncHandler(async (req, res) => {
      const parsed = loginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid login payload');
      }
      const user = await deps.userStore.findByEmail(parsed.data.email);
      // Always run a bcrypt comparison — a dummy one when the user does not
      // exist — so response timing does not reveal user existence.
      const passwordHash = user?.hashedPassword ?? (await getDummyPasswordHash());
      const passwordOk = await verifyPassword(parsed.data.password, passwordHash);
      if (!user || !passwordOk) {
        throw new UnauthorizedError('Invalid credentials');
      }
      const challenge = await deps.twoFactorService.createChallenge(user.id, user.email);
      // No access token yet — a valid 2FA code is required.
      // In dev/test mode, include the raw code so the frontend can auto-fill it.
      const body: Record<string, unknown> = {
        challengeId: challenge.id,
        requiresTwoFactor: true,
      };
      if (exposeTwoFactorCode && challenge.code) {
        body['code'] = challenge.code;
      }
      res.status(200).json(body);
    }),

    verifyTwoFactor: asyncHandler(async (req, res) => {
      const parsed = verifyTwoFactorBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid 2FA payload');
      }
      const challenge = await deps.twoFactorService.verifyChallenge(
        parsed.data.challengeId,
        parsed.data.code,
      );
      const user = await deps.userStore.findById(challenge.userId);
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

    /*
      The caller's own identity. The console needs this to say who is signed in
      — the token carries the subject and policy, but nothing the header or the
      profile page can render as an identity. Read from the token, so it also
      reflects the policy the session was actually issued under rather than a
      fresh database read that could have moved underneath it.
    */
    me: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const user = await deps.userStore.findById(auth.sub);
      res.status(200).json({
        id: auth.sub,
        email: auth.email,
        policyAttributes: auth.policy,
        policies: policyScopesOf(auth.policy),
        createdAt: user?.createdAt ?? null,
        updatedAt: user?.updatedAt ?? null,
        // `null` means this account has never been offered the guided tour.
        // Read from the account, NOT the token: a user who finished the tour
        // must not be re-toured because an older token is still valid.
        tourCompletedAt: user?.tourCompletedAt ?? null,
        /*
          THE ORGANIZATION'S NAME, on the identity endpoint rather than on
          `/settings`, and that placement is the point. `/settings` is gated on
          the `system` scope, but this is deployment-wide identity: it is on every
          page header and in every invitation. Reading it through a settings
          endpoint would mean an ordinary operator sees a blank organization field
          while holding perfectly valid access to everything it describes.

          A NAME, not the id, and not read from the row: the id is `env
          .ORGANIZATION_ID` and the two can disagree, which is the failure this
          area started with. The id still comes from the environment; the name is
          the one a human chose. Null before setup is finished, and the console
          falls back to the id rather than showing nothing.
        */
        organizationName: await settings.getOrganizationName(),
        tokenExpiresAt: new Date(auth.exp * 1000).toISOString(),
      });
    }),

    /*
      Mark the first-run guided tour as seen (finished or explicitly skipped).

      Self-service by design: the resource is the CALLER'S OWN account, which is
      exactly why it lives under /auth rather than /users. `PATCH /users/:id` is
      admin-gated and organization-scoped, so an ordinary invited user cannot
      reach it — and widening that route to accommodate this would hand admins a
      write path onto other people's rows.

      Idempotent: a second call writes nothing and still answers 204, so a retry
      after a dropped response can neither double-stamp nor fail. A replay from
      Profile never rewrites the original timestamp.
    */
    completeTour: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) {
        throw new UnauthorizedError('Authentication required');
      }
      await deps.userStore.markTourCompleted(auth.sub, new Date().toISOString());
      res.status(204).end();
    }),

    /*
      Start a reset. This handler answers 202 with the same body whether or not
      the address is registered — a distinguishable response would turn the
      endpoint into an account-enumeration oracle, which is exactly what the
      login flow's uniform "Invalid credentials" avoids elsewhere.
    */
    forgotPassword: asyncHandler(async (req, res) => {
      const parsed = forgotPasswordBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid password reset request');
      }
      const issued = await deps.passwordResetService.requestReset(parsed.data.email);
      const body: Record<string, unknown> = {
        status: 'accepted',
        message:
          'If an account exists for that address, a reset link has been sent. The link expires shortly and can be used once.',
      };
      if (exposeResetToken && issued) {
        // DEV/TEST ONLY. In production the link is emailed and is NEVER
        // returned in the API response. Guarded the same way as the invite
        // token and the 2FA code, so all three dev conveniences share one rule.
        body['token'] = issued.token;
      }
      res.status(202).json(body);
    }),

    resetPassword: asyncHandler(async (req, res) => {
      const parsed = resetPasswordBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid password reset payload');
      }
      await deps.passwordResetService.resetPassword(parsed.data.token, parsed.data.password);
      res.status(200).json({ status: 'reset' });
    }),
  };
}
