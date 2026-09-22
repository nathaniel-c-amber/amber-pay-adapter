import { getRepositories } from '../../repositories/index.js';
import { InMemoryUserRepository } from '../../repositories/inMemory.js';
import type { UserRepository } from '../../types/repository.js';
import type { UserId } from '../../models/domain.js';
import type { AuthUser, PolicyAttribute } from '../../types/auth.js';

export type { AuthUser } from '../../types/auth.js';

/**
 * User service — delegates to a `UserRepository`. Defaults to a fresh
 * in-memory repository so unit tests remain isolated; the app singleton shares
 * the global repository container.
 *
 * INVARIANT (FR-1.1): production code MUST only create users via
 * `InviteService.acceptInvite` — there is no public registration path.
 */
export class UserStore {
  constructor(private readonly users: UserRepository = new InMemoryUserRepository()) {}

  /**
   * Create a user.
   *
   * @internal — only `InviteService.acceptInvite` (and tests) may call this.
   */
  async create(
    email: string,
    hashedPassword: string,
    policyAttributes: PolicyAttribute[],
  ): Promise<AuthUser> {
    return this.users.create(email, hashedPassword, policyAttributes);
  }

  async findByEmail(email: string): Promise<AuthUser | undefined> {
    return this.users.findByEmail(email);
  }

  async findById(id: UserId): Promise<AuthUser | undefined> {
    return this.users.findById(id);
  }

  /** Every account, ordered by email. Backs the admin user directory. */
  async list(): Promise<AuthUser[]> {
    return this.users.list();
  }

  /**
   * Replace a user's PBAC attributes.
   *
   * Authorization is the caller's problem: the controller passes the verified
   * token policy through `assertGrantableByAdmin` before calling this, so this
   * method is a plain persistence operation.
   */
  async updatePolicyAttributes(
    id: UserId,
    policyAttributes: PolicyAttribute[],
  ): Promise<AuthUser | undefined> {
    return this.users.updatePolicyAttributes(id, policyAttributes);
  }

  /**
   * Replace a user's password hash.
   *
   * @internal — called by `PasswordResetService` after the reset token has been
   * validated and the password strength-checked by the caller.
   */
  async updatePassword(id: UserId, hashedPassword: string): Promise<boolean> {
    return this.users.updatePassword(id, hashedPassword);
  }
}

/** Singleton user store backed by the shared repository container. */
export const userStore = new UserStore(getRepositories().users);
