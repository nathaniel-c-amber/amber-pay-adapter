import { randomUUID } from 'node:crypto';
import { ConflictError } from '../lib/errors.js';
import type { User, UserId } from '../domain/types.js';
import type { PolicyAttribute } from './types.js';

/**
 * Internal auth user: the domain `User` plus the PBAC attributes granted at
 * invite time. This is an auth-internal type (not stored in the domain model).
 */
export interface AuthUser extends User {
  policyAttributes: PolicyAttribute[];
}

/**
 * In-memory user store. DB persistence is Phase 5 — data is lost on restart.
 *
 * NOTE: users only ever exist via invitation acceptance (FR-1.1); this store
 * exposes no public registration path.
 */
export class UserStore {
  private readonly byId = new Map<UserId, AuthUser>();
  private readonly byEmail = new Map<string, AuthUser>();

  /**
   * Create a user.
   *
   * INVARIANT (FR-1.1): production code MUST only call this from
   * `InviteService.acceptInvite` — there is no public registration path. This
   * is public so the invite service (and tests) can seed users; do not add
   * any other caller.
   *
   * @internal
   */
  create(email: string, hashedPassword: string, policyAttributes: PolicyAttribute[]): AuthUser {
    const normalizedEmail = email.trim().toLowerCase();
    if (this.byEmail.has(normalizedEmail)) {
      throw new ConflictError('A user with this email already exists');
    }
    const now = new Date().toISOString();
    const user: AuthUser = {
      id: randomUUID(),
      email: normalizedEmail,
      hashedPassword,
      createdAt: now,
      updatedAt: now,
      policyAttributes,
    };
    this.byId.set(user.id, user);
    this.byEmail.set(normalizedEmail, user);
    return user;
  }

  findByEmail(email: string): AuthUser | undefined {
    return this.byEmail.get(email.trim().toLowerCase());
  }

  findById(id: UserId): AuthUser | undefined {
    return this.byId.get(id);
  }
}

/** Singleton user store. */
export const userStore = new UserStore();
