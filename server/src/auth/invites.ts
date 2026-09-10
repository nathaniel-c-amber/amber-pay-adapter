import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '../lib/errors.js';
import { parseDurationMs } from './duration.js';
import { hashPassword } from './passwords.js';
import { userStore as defaultUserStore } from './users.js';
import { getRepositories } from '../repositories/index.js';
import { InMemoryInviteRepository } from '../repositories/inMemory.js';
import type { UserStore } from './users.js';
import type { InviteRepository } from '../repositories/types.js';
import type { Invite, PolicyAttribute } from './types.js';
import type { User } from '../domain/types.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$/;

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
 * Seam for delivering an invite link/token by email. The real Twilio SendGrid
 * implementation lands in a later phase; the default stub only logs issuance
 * and never logs the token itself.
 */
export interface InviteEmailSender {
  sendInvite(email: string, token: string): Promise<void>;
}

/** Stub sender — logs issuance WITHOUT logging the token. */
export const logInviteEmailSender: InviteEmailSender = {
  async sendInvite(email: string, _token: string): Promise<void> {
    logger.info({ email }, 'Invite email delivery stubbed (token not logged)');
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

/** Defense-in-depth password-strength validation (the route also validates). */
function assertStrongPassword(password: string): void {
  if (!PASSWORD_PATTERN.test(password)) {
    throw new ValidationError(
      'Password must be at least 12 characters and include upper, lower and digit characters',
    );
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
    private readonly emailSender: InviteEmailSender = logInviteEmailSender,
    private readonly invites: InviteRepository = new InMemoryInviteRepository(),
  ) {}

  async createInvite(
    input: CreateInviteInput,
    authorizedOrganizationIds?: string[],
  ): Promise<CreateInviteResult> {
    const email = input.email.trim().toLowerCase();
    assertValidEmail(email);
    if (input.policyAttributes.length === 0) {
      throw new ValidationError('At least one policy attribute is required');
    }
    if (await this.userStore.findByEmail(email)) {
      throw new ConflictError('A user with this email already exists');
    }

    // S2: an admin may only grant policy for organizations they themselves
    // hold `admin` on. The allowed set is derived from the caller's token
    // policy, never from the request body, so an admin on org-1 cannot plant
    // an account in org-2.
    if (authorizedOrganizationIds) {
      const authorized = new Set(authorizedOrganizationIds);
      const unauthorizedOrganization = input.policyAttributes
        .map((attribute) => attribute.organizationId)
        .find((organizationId) => !authorized.has(organizationId));
      if (unauthorizedOrganization !== undefined) {
        throw new ForbiddenError(
          `Cannot grant policy for organization '${unauthorizedOrganization}'`,
        );
      }
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
  logInviteEmailSender,
  getRepositories().invites,
);
