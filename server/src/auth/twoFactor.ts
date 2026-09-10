import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { UnauthorizedError } from '../lib/errors.js';
import { parseDurationMs } from './duration.js';
import type { TwoFactorChallenge } from './types.js';

/** Maximum verification attempts before a challenge is rejected. */
export const MAX_TWO_FACTOR_ATTEMPTS = 5;

/**
 * Seam for delivering a 2FA code to a user. The real Twilio SendGrid
 * implementation lands in a later phase; the default stub only logs that a
 * code was issued (never the code itself).
 */
export interface EmailSender {
  send(userId: string, code: string): Promise<void>;
}

/** Stub sender — logs issuance WITHOUT logging the code. */
export const logEmailSender: EmailSender = {
  async send(userId: string, _code: string): Promise<void> {
    logger.info({ userId }, '2FA code issued (email delivery stubbed)');
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
 * a short expiry and attempt limit. In-memory store for now (DB is Phase 5).
 */
export class TwoFactorService {
  private readonly challengesById = new Map<string, TwoFactorChallenge>();

  constructor(private readonly emailSender: EmailSender = logEmailSender) {}

  async createChallenge(userId: string): Promise<TwoFactorChallenge> {
    const code = generateCode();
    const challenge: TwoFactorChallenge = {
      id: randomUUID(),
      userId,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + parseDurationMs(env.TWO_FACTOR_TTL)).toISOString(),
      attempts: 0,
    };
    this.challengesById.set(challenge.id, challenge);
    await this.emailSender.send(userId, code);
    logger.info({ userId }, '2FA challenge created');
    return challenge;
  }

  /**
   * Verify a code against the challenge identified by `challengeId`. Enforces
   * expiry and the attempt limit, and consumes the challenge on success.
   */
  verifyChallenge(challengeId: string, code: string): TwoFactorChallenge {
    const challenge = this.challengesById.get(challengeId);
    if (!challenge) {
      throw new UnauthorizedError('No active 2FA challenge');
    }
    if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
      this.consume(challenge);
      throw new UnauthorizedError('2FA challenge has expired');
    }
    if (challenge.attempts >= MAX_TWO_FACTOR_ATTEMPTS) {
      throw new UnauthorizedError('Too many 2FA attempts');
    }

    challenge.attempts += 1;
    if (!safeEqualHex(hashCode(code), challenge.codeHash)) {
      throw new UnauthorizedError('Invalid 2FA code');
    }

    this.consume(challenge);
    logger.info({ userId: challenge.userId }, '2FA challenge verified');
    return challenge;
  }

  private consume(challenge: TwoFactorChallenge): void {
    this.challengesById.delete(challenge.id);
  }
}

/** Singleton 2FA service. */
export const twoFactorService = new TwoFactorService();
