import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { createInMemoryRepositories } from './inMemory.js';
import { createPostgresRepositories } from './postgres.js';
import type { Repositories } from '../types/repository.js';

export * from '../types/repository.js';
export { createInMemoryRepositories } from './inMemory.js';
export { createPostgresRepositories } from './postgres.js';

/**
 * Whether a real database should be used. Tests never use a live DB — the
 * in-memory implementations are used instead so the suite runs with no
 * PostgreSQL available.
 */
export function isDatabaseConfigured(): boolean {
  if (env.NODE_ENV === 'test') {
    return false;
  }
  return env.DATABASE_URL.trim().length > 0;
}

/** Pick Postgres when a DB is configured, otherwise in-memory. */
export function createRepositories(): Repositories {
  return isDatabaseConfigured()
    ? createPostgresRepositories(getPool())
    : createInMemoryRepositories();
}

let singleton: Repositories | undefined;

/** Shared repository container used by the default service singletons. */
export function getRepositories(): Repositories {
  singleton ??= createRepositories();
  return singleton;
}

/**
 * Override the shared container (used by bootstrap/tests).
 *
 * LIMITATION: the service singletons (`eventLog`, `failureTracker`,
 * `webhookProcessor`, `inviteService`, `userStore`, `twoFactorService`) capture
 * their repository references at module load, so calling `setRepositories`
 * after those modules have been imported does NOT rewire them. Prefer injecting
 * repositories via the `createApp`/route/service constructors (as the test
 * suite does) rather than relying on this setter.
 */
export function setRepositories(repositories: Repositories): void {
  singleton = repositories;
}
