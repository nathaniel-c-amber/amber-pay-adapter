import bcrypt from 'bcryptjs';

/** bcrypt cost factor (12 — deliberately strong for credential storage). */
const SALT_ROUNDS = 12;

/**
 * Hash a plaintext password with bcrypt. Plaintext is never stored.
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * Verify a plaintext password against a stored bcrypt hash.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
