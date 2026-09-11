import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { emailService } from '../lib/email.js';
import { UnauthorizedError } from '../lib/errors.js';
import { parseDurationMs } from './duration.js';
import { getRepositories } from '../repositories/index.js';
import { InMemoryTwoFactorRepository } from '../repositories/inMemory.js';
import type { TwoFactorRepository } from '../repositories/types.js';
import type { TwoFactorChallenge } from './types.js';

/** Maximum verification attempts before a challenge is rejected. */
export const MAX_TWO_FACTOR_ATTEMPTS = 5;

/**
 * Seam for delivering a 2FA code to a user's email address. The code is
 * delivered via the SMTP-backed `emailService`; it is never logged.
 */
export interface EmailSender {
  send(email: string, code: string): Promise<void>;
}

/** SMTP-backed sender — delivers the 2FA code via `emailService`. */
export const emailSender: EmailSender = {
  async send(email: string, code: string): Promise<void> {
    await emailService.sendEmail({
      to: email,
      subject: 'Your Amber Pay verification code',
      text: `Your verification code is ${code}`,
    });
  },
};

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Constant-time comparison of two hex hashes. */
function safeEqualHex(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Email 2FA service. Only the SHA-256 hash of the 6-digit code is stored, with
 * a short expiry and attempt limit. Persistence is delegated to a
 * `TwoFactorRepository`.
 */
export class TwoFactorService {
  constructor(
    private readonly emailSender: EmailSender = emailSender,
    private readonly challenges: TwoFactorRepository = new InMemoryTwoFactorRepository(),
  ) {}

  async createChallenge(userId: string, email: string): Promise<TwoFactorChallenge> {
    const code = generateCode();
    const challenge: TwoFactorChallenge = {
      id: randomUUID(),
      userId,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + parseDurationMs(env.TWO_FACTOR_TTL)).toISOString(),
      attempts: 0,
      // Include raw code only in non-production environments for dev convenience
      code: env.NODE_ENV !== 'production' ? code : undefined,
    };
    await this.challenges.create(challenge);
    await this.emailSender.send(email, code);
    logger.info({ userId }, '2FA challenge created');
    return challenge;
  }

  /**
   * Verify a code against the challenge identified by `challengeId`. Enforces
   * expiry and the attempt limit, and consumes the challenge on success.
   */
  async verifyChallenge(challengeId: string, code: string): Promise<TwoFactorChallenge> {
    const challenge = await this.challenges.findById(challengeId);
    if (!challenge) {
      throw new UnauthorizedError('No active 2FA challenge');
    }
    if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
      await this.challenges.consume(challengeId);
      throw new UnauthorizedError('2FA challenge has expired');
    }
    if (challenge.attempts >= MAX_TWO_FACTOR_ATTEMPTS) {
      throw new UnauthorizedError('Too many 2FA attempts');
    }

    const attempts = await this.challenges.incrementAttempts(challengeId);
    if (!safeEqualHex(hashCode(code), challenge.codeHash)) {
      throw new UnauthorizedError('Invalid 2FA code');
    }

    await this.challenges.consume(challengeId);
    logger.info({ userId: challenge.userId }, '2FA challenge verified');
    return { ...challenge, attempts };
  }
}

/** Singleton 2FA service backed by the shared repository container. */
export const twoFactorService = new TwoFactorService(
  emailSender,
  getRepositories().twoFactor,
);
