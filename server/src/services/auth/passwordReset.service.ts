import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { emailService } from '../shared/email.service.js';
import { UnauthorizedError } from '../../utils/errors.js';
import { parseDurationMs } from '../../utils/duration.js';
import { assertStrongPassword, hashPassword } from '../../utils/passwords.js';
import { getRepositories } from '../../repositories/index.js';
import { InMemoryPasswordResetRepository } from '../../repositories/inMemory.js';
import { userStore as defaultUserStore } from './user.service.js';
import type { PasswordResetRepository } from '../../types/repository.js';
import type { PasswordReset } from '../../types/auth.js';
import type { UserStore } from './user.service.js';

/**
 * Seam for delivering a reset link. The raw token is delivered via the
 * SMTP-backed `emailService`; it is never logged and never returned by the API.
 */
export interface PasswordResetEmailSender {
  send(email: string, token: string): Promise<void>;
}

/** SMTP-backed sender — delivers the reset link via `emailService`. */
export const passwordResetEmailSender: PasswordResetEmailSender = {
  async send(email: string, token: string): Promise<void> {
    await emailService.sendEmail({
      to: email,
      subject: 'Reset your Amber Pay password',
      text: `Reset your password: ${env.APP_BASE_URL}/#/reset/${token}\n\nThis link expires shortly and can only be used once. If you did not request it, no action is needed — your password has not changed.`,
    });
  },
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Bcrypt comparison work for an address that has no account.
 *
 * `requestReset` must not reveal whether an email is registered — neither in
 * the response (which is always the same) nor in its timing. Hashing a
 * throwaway value keeps an unknown address costing roughly what a known one
 * costs. Cached so repeated requests pay bcrypt once, as the login controller
 * does for the same reason.
 */
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('password-reset-timing-equaliser');
  return dummyHashPromise;
}

/**
 * Self-service credential recovery.
 *
 * Invite-only access does not mean "no way back in": without a reset path a
 * user who forgets their password is locked out until an administrator
 * intervenes, and administrators previously had no way to help either. This
 * service adds the missing recovery path without adding a registration path —
 * a reset can only ever restore access to an account that already exists.
 *
 * Account-enumeration safety: `requestReset` always resolves, whether or not
 * the address exists. Callers must not branch on its outcome.
 */
export class PasswordResetService {
  constructor(
    private readonly userStore: UserStore = defaultUserStore,
    private readonly emailSender: PasswordResetEmailSender = passwordResetEmailSender,
    private readonly resets: PasswordResetRepository = new InMemoryPasswordResetRepository(),
  ) {}

  /**
   * Begin a reset. Resolves unconditionally — the caller must return the same
   * response for a known and an unknown address.
   *
   * Returns the raw token ONLY so a non-production caller can surface it for
   * local testing; in production the token reaches the user solely by email and
   * the response never contains it.
   */
  async requestReset(rawEmail: string): Promise<{ token: string } | null> {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.userStore.findByEmail(email);
    if (!user) {
      await getDummyHash();
      logger.info('Password reset requested for unknown address');
      return null;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    // Only the most recent link should ever work. Marking the outstanding ones
    // used means a second request does not leave two live links in a mailbox.
    await this.resets.invalidateForUser(user.id, nowIso);

    const token = randomBytes(32).toString('hex');
    const reset: PasswordReset = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + parseDurationMs(env.PASSWORD_RESET_TTL)).toISOString(),
      createdAt: nowIso,
    };
    await this.resets.create(reset);
    await this.emailSender.send(user.email, token);
    logger.info({ userId: user.id }, 'Password reset link issued');
    return { token };
  }

  /**
   * Redeem a reset token: validate it, replace the password, and consume the
   * token so the link cannot be replayed.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    assertStrongPassword(password);
    const reset = await this.resets.findByTokenHash(hashToken(token));
    if (!reset) {
      throw new UnauthorizedError('Invalid or expired password reset token');
    }
    if (reset.usedAt) {
      throw new UnauthorizedError('This password reset link has already been used');
    }
    if (new Date(reset.expiresAt).getTime() <= Date.now()) {
      await this.resets.markUsed(reset.id, new Date().toISOString());
      throw new UnauthorizedError('This password reset link has expired');
    }

    const hashedPassword = await hashPassword(password);
    const updated = await this.userStore.updatePassword(reset.userId, hashedPassword);
    if (!updated) {
      throw new UnauthorizedError('Account no longer exists');
    }
    await this.resets.markUsed(reset.id, new Date().toISOString());
    logger.info({ userId: reset.userId }, 'Password reset completed');
  }
}

/** Singleton reset service backed by the shared repository container. */
export const passwordResetService = new PasswordResetService(
  defaultUserStore,
  passwordResetEmailSender,
  getRepositories().passwordResets,
);
