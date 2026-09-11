import bcrypt from 'bcryptjs';
import { ValidationError } from '../lib/errors.js';

/** bcrypt cost factor (12 — deliberately strong for credential storage). */
const SALT_ROUNDS = 12;

/** Strong-password rule: >= 12 chars with upper, lower and digit. */
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$/;

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

/**
 * Defense-in-depth password-strength validation. Throws `ValidationError` when
 * the password is weaker than the strong-password rule.
 */
export function assertStrongPassword(password: string): void {
  if (!PASSWORD_PATTERN.test(password)) {
    throw new ValidationError(
      'Password must be at least 12 characters and include upper, lower and digit characters',
    );
  }
}
