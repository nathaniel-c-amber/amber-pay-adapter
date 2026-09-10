import { getRepositories } from '../repositories/index.js';
import { InMemoryUserRepository } from '../repositories/inMemory.js';
import type { UserRepository } from '../repositories/types.js';
import type { UserId } from '../domain/types.js';
import type { AuthUser, PolicyAttribute } from './types.js';

export type { AuthUser } from './types.js';

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
}

/** Singleton user store backed by the shared repository container. */
export const userStore = new UserStore(getRepositories().users);
