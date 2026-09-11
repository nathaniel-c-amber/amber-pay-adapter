import { seedSuperAdmin } from './seed.js';
import { createInMemoryRepositories } from '../repositories/inMemory.js';
import { verifyPassword } from '../auth/passwords.js';
import { ConflictError, ValidationError } from '../lib/errors.js';
import type { Repositories } from '../repositories/types.js';
import type { UserRepository } from '../repositories/types.js';
import type { AuthUser } from '../auth/types.js';

/** Simulates a concurrent instance: findByEmail misses, create hits a conflict. */
class RacingUserRepository implements UserRepository {
  async findByEmail(): Promise<AuthUser | undefined> {
    return undefined;
  }
  async create(): Promise<AuthUser> {
    throw new ConflictError('A user with this email already exists');
  }
  async findById(): Promise<AuthUser | undefined> {
    return undefined;
  }
}

describe('seedSuperAdmin', () => {
  let repositories: Repositories;

  beforeEach(() => {
    repositories = createInMemoryRepositories();
  });

  it('seeds a super admin when email and password are provided', async () => {
    const created = await seedSuperAdmin(repositories, {
      email: 'admin@example.com',
      password: 'SuperAdminPassw0rd!',
    });

    expect(created).toBe(true);
    const user = await repositories.users.findByEmail('admin@example.com');
    expect(user).toBeDefined();
    expect(user?.policyAttributes).toEqual([
      { scope: '*', organizationId: '*', actions: ['read', 'ack', 'write', 'admin'] },
    ]);
    // Password is stored hashed, never plaintext.
    expect(user?.hashedPassword).not.toBe('SuperAdminPassw0rd!');
    await expect(verifyPassword('SuperAdminPassw0rd!', user?.hashedPassword ?? '')).resolves.toBe(
      true,
    );
  });

  it('is idempotent — a second call does not overwrite the existing user', async () => {
    await seedSuperAdmin(repositories, {
      email: 'admin@example.com',
      password: 'SuperAdminPassw0rd!',
    });
    const before = await repositories.users.findByEmail('admin@example.com');

    const created = await seedSuperAdmin(repositories, {
      email: 'admin@example.com',
      password: 'ADifferentPassw0rd!',
    });

    expect(created).toBe(false);
    const after = await repositories.users.findByEmail('admin@example.com');
    expect(after?.id).toBe(before?.id);
    expect(after?.hashedPassword).toBe(before?.hashedPassword);
    // The original password still verifies; the new one does not.
    await expect(verifyPassword('SuperAdminPassw0rd!', after?.hashedPassword ?? '')).resolves.toBe(
      true,
    );
    await expect(verifyPassword('ADifferentPassw0rd!', after?.hashedPassword ?? '')).resolves.toBe(
      false,
    );
  });

  it('does nothing when only one env var is provided', async () => {
    const created = await seedSuperAdmin(repositories, { email: 'admin@example.com' });
    expect(created).toBe(false);
    await expect(repositories.users.findByEmail('admin@example.com')).resolves.toBeUndefined();
  });

  it('does nothing when no env vars are provided', async () => {
    const created = await seedSuperAdmin(repositories, {});
    expect(created).toBe(false);
    expect(repositories.users.findByEmail).toBeDefined();
  });

  it('does not throw on a concurrent create (ConflictError) and reports skipped (M3)', async () => {
    const racing = { ...createInMemoryRepositories(), users: new RacingUserRepository() };
    await expect(
      seedSuperAdmin(racing, { email: 'admin@example.com', password: 'SuperAdminPassw0rd!' }),
    ).resolves.toBe(false);
  });

  it('rejects a weak super admin password (m2)', async () => {
    await expect(
      seedSuperAdmin(repositories, { email: 'admin@example.com', password: 'weak' }),
    ).rejects.toThrow(ValidationError);
    await expect(repositories.users.findByEmail('admin@example.com')).resolves.toBeUndefined();
  });
});