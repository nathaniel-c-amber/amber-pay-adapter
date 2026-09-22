import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { emailService } from '../shared/email.service.js';
import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from '../../utils/errors.js';
import { parseDurationMs } from '../../utils/duration.js';
import { assertGrantableByAdmin } from '../../utils/policyGrant.js';
import { assertStrongPassword, hashPassword } from '../../utils/passwords.js';
import { userStore as defaultUserStore } from './user.service.js';
import { getRepositories } from '../../repositories/index.js';
import { InMemoryInviteRepository } from '../../repositories/inMemory.js';
import type { UserStore } from './user.service.js';
import type { InviteRepository } from '../../types/repository.js';
import type { Invite, PolicyAttribute } from '../../types/auth.js';
import type { User } from '../../models/domain.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateInviteInput {
  email: string;
  policyAttributes: PolicyAttribute[];
}

export interface CreateInviteResult {
  invite: Invite;
  /** Raw token — returned exactly once; only its hash is persisted. */
  token: string;
}

/**
 * Seam for delivering an invite link/token by email. The token is delivered
 * via the SMTP-backed `emailService`; it is never logged.
 */
export interface InviteEmailSender {
  sendInvite(email: string, token: string): Promise<void>;
}

/** SMTP-backed sender — delivers the invite link via `emailService`. */
export const inviteEmailSender: InviteEmailSender = {
  async sendInvite(email: string, token: string): Promise<void> {
    await emailService.sendEmail({
      to: email,
      subject: 'Your Amber Pay invite',
      text: `Accept your invite: ${env.APP_BASE_URL}/accept-invite?token=${token}`,
    });
  },
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Defense-in-depth email validation (the route also validates via zod). */
function assertValidEmail(email: string): void {
  if (!EMAIL_PATTERN.test(email)) {
    throw new ValidationError('Invalid email address');
  }
}

/**
 * Manages invite-only account creation (FR-1.1 / FR-1.2 / FR-1.3).
 *
 * Persistence is delegated to an `InviteRepository` (Postgres or in-memory).
 * The only path that creates a user is `acceptInvite`; there is no public
 * registration.
 */
export class InviteService {
  constructor(
    private readonly userStore: UserStore = defaultUserStore,
    private readonly emailSender: InviteEmailSender = inviteEmailSender,
    private readonly invites: InviteRepository = new InMemoryInviteRepository(),
  ) {}

  async createInvite(
    input: CreateInviteInput,
    adminPolicy?: PolicyAttribute[],
  ): Promise<CreateInviteResult> {
    const email = input.email.trim().toLowerCase();
    assertValidEmail(email);
    if (input.policyAttributes.length === 0) {
      throw new ValidationError('At least one policy attribute is required');
    }
    if (await this.userStore.findByEmail(email)) {
      throw new ConflictError('A user with this email already exists');
    }

    // S2/M2: an admin may only grant policy they themselves hold. The allowed
    // set is derived from the caller's token policy, never from the request
    // body, so an admin on org-1 cannot plant an account in org-2, grant a
    // scope they don't hold, or grant actions they don't hold.
    if (adminPolicy) {
      assertGrantableByAdmin(input.policyAttributes, adminPolicy);
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const now = Date.now();

    const invite: Invite = {
      id: randomUUID(),
      email,
      policyAttributes: input.policyAttributes,
      tokenHash,
      expiresAt: new Date(now + parseDurationMs(env.INVITE_TTL)).toISOString(),
      createdAt: new Date(now).toISOString(),
    };

    await this.invites.create(invite);
    // Deliver via the email seam. The raw token is never returned by the API
    // in production (see routes/auth.ts).
    await this.emailSender.sendInvite(email, token);
    logger.info({ inviteId: invite.id }, 'Invite created');
    return { invite, token };
  }

  /**
   * Validate an invite token and return its invite. Throws on invalid,
   * expired or already-accepted tokens.
   */
  async verifyInviteToken(token: string): Promise<Invite> {
    if (!token) {
      throw new ValidationError('Invite token is required');
    }
    const invite = await this.invites.findByTokenHash(hashToken(token));
    if (!invite) {
      throw new UnauthorizedError('Invalid invite token');
    }
    if (invite.acceptedAt) {
      throw new ConflictError('Invite has already been accepted');
    }
    if (new Date(invite.expiresAt).getTime() <= Date.now()) {
      throw new UnauthorizedError('Invite token has expired');
    }
    return invite;
  }

  /**
   * Accept an invite: validate the token, create the user with a hashed
   * password, and mark the invite accepted. This is the ONLY user-creation
   * path (FR-1.1).
   */
  async acceptInvite(token: string, password: string): Promise<User> {
    assertStrongPassword(password);
    const invite = await this.verifyInviteToken(token);
    if (await this.userStore.findByEmail(invite.email)) {
      throw new ConflictError('A user with this email already exists');
    }

    const hashedPassword = await hashPassword(password);
    const user = await this.userStore.create(invite.email, hashedPassword, invite.policyAttributes);
    await this.invites.markAccepted(invite.id, new Date().toISOString());
    logger.info({ inviteId: invite.id, userId: user.id }, 'Invite accepted');
    return user;
  }
}

/** Singleton invite service backed by the shared repository container. */
export const inviteService = new InviteService(
  defaultUserStore,
  inviteEmailSender,
  getRepositories().invites,
);
