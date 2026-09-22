import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { ConflictError } from '../utils/errors.js';
import { assertStrongPassword, hashPassword } from '../utils/passwords.js';
import type { PolicyAttribute } from '../types/auth.js';
import type { Repositories } from '../types/repository.js';

/** The super admin policy attribute: all actions, all scopes, all orgs. */
export const SUPER_ADMIN_POLICY_ATTRIBUTES: PolicyAttribute[] = [
  { scope: '*', organizationId: '*', actions: ['read', 'ack', 'write', 'admin'] },
];

export interface SeedSuperAdminOptions {
  /** Overrides `env.SUPER_ADMIN_EMAIL` (used by tests). */
  email?: string;
  /** Overrides `env.SUPER_ADMIN_PASSWORD` (used by tests). */
  password?: string;
}

/**
 * Seed a super admin (all privileges) on install, configurable from the
 * environment. Idempotent: if a user with the email already exists, it is
 * never overwritten or its password reset. A concurrent create (ConflictError)
 * is treated as "already exists" rather than propagated.
 *
 * Returns `true` when a new super admin was created, `false` when skipped
 * (env vars unset/incomplete, or the user already exists).
 *
 * The password is never logged.
 */
export async function seedSuperAdmin(
  repositories: Repositories,
  options: SeedSuperAdminOptions = {},
): Promise<boolean> {
  const email = options.email ?? env.SUPER_ADMIN_EMAIL;
  const password = options.password ?? env.SUPER_ADMIN_PASSWORD;

  // Seed only when BOTH env vars are configured.
  if (!email || !password) {
    if (email || password) {
      logger.warn(
        'Super admin not seeded: both SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set',
      );
    }
    return false;
  }

  const existing = await repositories.users.findByEmail(email);
  if (existing) {
    logger.info({ email }, 'Super admin already exists; skipping seed');
    return false;
  }

  assertStrongPassword(password);
  const hashedPassword = await hashPassword(password);
  try {
    await repositories.users.create(email, hashedPassword, SUPER_ADMIN_POLICY_ATTRIBUTES);
  } catch (err) {
    // A concurrent instance may have created the user between our check and
    // the create. Treat that as "already exists" instead of crashing startup.
    if (err instanceof ConflictError) {
      logger.info({ email }, 'Super admin already exists (concurrent); skipping seed');
      return false;
    }
    throw err;
  }
  logger.info({ email }, 'Super admin seeded on install');
  return true;
}