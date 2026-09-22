import { randomBytes, randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { parseDurationMs } from '../../utils/duration.js';
import { assertGrantableByAdmin } from '../../utils/policyGrant.js';
import { getRepositories } from '../../repositories/index.js';
import { InMemoryInviteRepository } from '../../repositories/inMemory.js';
import { userStore as defaultUserStore } from './user.service.js';
import { inviteEmailSender } from './invite.service.js';
import type { InviteEmailSender } from './invite.service.js';
import type { UserStore } from './user.service.js';
import type { InviteRepository } from '../../types/repository.js';
import type { AuthUser, Invite, PolicyAttribute } from '../../types/auth.js';

/**
 * One row in the administrator's user directory.
 *
 * Deliberately NOT `User` or `AuthUser`: this is an API projection that must
 * never carry `hashedPassword`, and it unifies two storage shapes into the one
 * list the directory shows. `email` is present because `User` is the single
 * entity in the domain allowed to hold an email (see models/domain.ts); it is
 * an auth identity, never customer PII.
 */
export interface UserDirectoryEntry {
  id: string;
  email: string;
  /** `invite-pending` means the account does not exist yet — only the invite does. */
  status: 'active' | 'invite-pending';
  policyAttributes: PolicyAttribute[];
  /** Union of the organizations the entry's policy can reach (`*` when wildcard). */
  organizations: string[];
  createdAt: string;
  updatedAt: string;
  /** Invite only: when the outstanding link stops working. */
  inviteExpiresAt?: string;
}

/** Derive the organizations an entry's policy attributes reach. */
function organizationsOf(attributes: PolicyAttribute[]): string[] {
  return [...new Set(attributes.map((attribute) => attribute.organizationId))].sort();
}

/**
 * The organizations an administrator may administer, derived from their
 * VERIFIED token policy. `null` means every organization (wildcard), which is
 * what a super admin holds.
 */
export function administeredOrganizations(policy: PolicyAttribute[]): string[] | null {
  const adminAttributes = policy.filter(
    (attribute) =>
      (attribute.scope === 'users' || attribute.scope === '*') &&
      attribute.actions.includes('admin'),
  );
  if (adminAttributes.some((attribute) => attribute.organizationId === '*')) {
    return null;
  }
  return [...new Set(adminAttributes.map((attribute) => attribute.organizationId))];
}

/** Does at least one of the entry's organizations fall inside the admin's set? */
function withinAdministration(
  attributes: PolicyAttribute[],
  organizations: string[] | null,
): boolean {
  if (organizations === null) return true;
  return attributes.some((attribute) => organizations.includes(attribute.organizationId));
}

function toEntry(user: AuthUser): UserDirectoryEntry {
  return {
    id: user.id,
    email: user.email,
    status: 'active',
    policyAttributes: user.policyAttributes,
    organizations: organizationsOf(user.policyAttributes),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function toPendingEntry(invite: Invite): UserDirectoryEntry {
  return {
    id: invite.id,
    email: invite.email,
    status: 'invite-pending',
    policyAttributes: invite.policyAttributes,
    organizations: organizationsOf(invite.policyAttributes),
    createdAt: invite.createdAt,
    updatedAt: invite.createdAt,
    inviteExpiresAt: invite.expiresAt,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Administrator-facing user and permission management.
 *
 * Access is invite-only, so this service exists to answer the three questions
 * an administrator actually has — who has access, to what, and how do I change
 * it — without ever handing out more than the administrator holds. Every
 * mutation re-checks the grant against the caller's verified token policy
 * (`assertGrantableByAdmin`), the same rule the invite path uses.
 */
export class UsersService {
  constructor(
    private readonly userStore: UserStore = defaultUserStore,
    private readonly invites: InviteRepository = new InMemoryInviteRepository(),
    private readonly emailSender: InviteEmailSender = inviteEmailSender,
  ) {}

  /**
   * The directory: real accounts plus outstanding invites, narrowed to the
   * organizations the administrator controls.
   *
   * Pending invites appear because an administrator who cannot see an invite
   * cannot tell "I sent it and they have not accepted" apart from "I never
   * sent it", and would send a duplicate.
   */
  async listDirectory(adminPolicy: PolicyAttribute[]): Promise<UserDirectoryEntry[]> {
    const organizations = administeredOrganizations(adminPolicy);
    const [users, invites] = await Promise.all([
      this.userStore.list(),
      this.invites.list(),
    ]);

    const active = users
      .filter((user) => withinAdministration(user.policyAttributes, organizations))
      .map(toEntry);

    // Only invites that have not been accepted or superseded: an accepted
    // invite is represented by the account it created.
    const pending = invites
      .filter(
        (invite) =>
          !invite.acceptedAt &&
          new Date(invite.expiresAt).getTime() > Date.now() &&
          withinAdministration(invite.policyAttributes, organizations),
      )
      .map(toPendingEntry);

    return [...active, ...pending].sort((a, b) => a.email.localeCompare(b.email));
  }

  /**
   * Replace an account's permissions.
   *
   * The requested attributes must be grantable by the caller (M2/S2) and the
   * target account must already be inside the caller's administration, so an
   * administrator cannot take over an account in another organization by
   * rewriting its policy.
   */
  async updatePermissions(
    userId: string,
    policyAttributes: PolicyAttribute[],
    adminPolicy: PolicyAttribute[],
  ): Promise<UserDirectoryEntry> {
    if (policyAttributes.length === 0) {
      throw new ValidationError('At least one policy attribute is required');
    }
    const organizations = administeredOrganizations(adminPolicy);
    const target = await this.userStore.findById(userId);
    if (!target || !withinAdministration(target.policyAttributes, organizations)) {
      throw new NotFoundError('User not found');
    }
    assertGrantableByAdmin(policyAttributes, adminPolicy);

    const updated = await this.userStore.updatePolicyAttributes(userId, policyAttributes);
    if (!updated) {
      throw new NotFoundError('User not found');
    }
    logger.info({ userId, actor: 'admin' }, 'User permissions updated');
    return toEntry(updated);
  }

  /**
   * Re-issue an outstanding invite for a pending entry.
   *
   * The original token is unrecoverable by design (only its hash is stored), so
   * "resending" means issuing a fresh link and invalidating the previous one —
   * which is also what makes a lost invite safe to replace.
   */
  async resendInvite(inviteId: string, adminPolicy: PolicyAttribute[]): Promise<void> {
    const organizations = administeredOrganizations(adminPolicy);
    const invites = await this.invites.list();
    const previous = invites.find((invite) => invite.id === inviteId);
    if (
      !previous ||
      previous.acceptedAt ||
      !withinAdministration(previous.policyAttributes, organizations)
    ) {
      throw new NotFoundError('Invite not found');
    }
    assertGrantableByAdmin(previous.policyAttributes, adminPolicy);

    // Supersede the outstanding link so only the new one works.
    await this.invites.markAccepted(previous.id, new Date().toISOString());

    const token = randomBytes(32).toString('hex');
    const now = new Date();
    await this.invites.create({
      id: randomUUID(),
      email: previous.email,
      policyAttributes: previous.policyAttributes,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + parseDurationMs(env.INVITE_TTL)).toISOString(),
      createdAt: now.toISOString(),
    });
    await this.emailSender.sendInvite(previous.email, token);
    logger.info({ inviteId: previous.id }, 'Invite re-issued');
  }
}

/** Singleton users service backed by the shared repository container. */
export const usersService = new UsersService(
  defaultUserStore,
  getRepositories().invites,
  inviteEmailSender,
);
