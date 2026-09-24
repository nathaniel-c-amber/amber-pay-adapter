/* Credential encryption.
 *
 * WHY THIS EXISTS: the onboarding wizard moves accounting and gateway
 * credentials out of `.env` and into the database (see
 * `005_deployment_settings.sql` for why they cannot stay in a file). A database
 * column holding a plaintext OAuth token is a worse place for it than a
 * deployment file with 0600 permissions, so the move is only defensible with
 * encryption at rest.
 *
 * THE ENVELOPE IS SELF-DESCRIBING, and that is deliberate:
 *
 *   [ version : 1 byte ][ iv : 12 bytes ][ auth tag : 16 bytes ][ ciphertext : n ]
 *
 * The key version travels INSIDE the value rather than in a sibling column. A
 * sibling column would have to describe two credentials written at different
 * times under different keys, which one column cannot do; and a row copied or
 * re-sealed between deployments would lose the association. Carrying the version
 * with the ciphertext means `openSecret` can always find the right key, and a
 * rotation leaves older rows readable instead of silently undecryptable.
 *
 * AES-256-GCM, not CBC: GCM authenticates as well as encrypts, so a tampered or
 * truncated ciphertext fails to open rather than decrypting to garbage that
 * would then be sent upstream as a credential.
 *
 * NO KEY DERIVATION. `SECRETS_KEY` is required to be 32 bytes as 64 hex
 * characters, given directly to the cipher. A password-style key would need a
 * KDF, and a KDF that is slow enough to be worth having is slow on every read;
 * one that is fast enough for a hot path is not worth having. Generation is one
 * command (`openssl rand -hex 32`) and it is stated in the runbook.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { InternalError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const VERSION_BYTES = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 1 + 12 + 16. Anything shorter than this is not an envelope. */
export const SEALED_HEADER_BYTES = VERSION_BYTES + IV_BYTES + TAG_BYTES;

const IV_OFFSET = VERSION_BYTES;
const TAG_OFFSET = IV_OFFSET + IV_BYTES;
const PAYLOAD_OFFSET = SEALED_HEADER_BYTES;

/**
 * The shortest secret whose last four characters are safe to display.
 *
 * Below this, four characters are a meaningful fraction of the whole value and
 * identifying a credential would not be worth disclosing part of it. The
 * projection reports `configured: true` with no suffix in that case.
 */
const MIN_LENGTH_FOR_SUFFIX = 12;

/**
 * The key for a version, or a refusal.
 *
 * Version `N` is the current key; `N - 1` is the previous one, which is
 * decrypt-only and exists so a rotation does not orphan rows sealed before it.
 * An unknown version is an operator error (a key was removed, or a row arrived
 * from another deployment), and it must be reported as exactly that rather than
 * as an empty credential.
 */
function keyFor(version: number): Buffer {
  const current = env.SECRETS_KEY_VERSION;
  if (env.SECRETS_KEY && version === current) {
    return Buffer.from(env.SECRETS_KEY, 'hex');
  }
  if (env.SECRETS_KEY_PREVIOUS && version === current - 1) {
    return Buffer.from(env.SECRETS_KEY_PREVIOUS, 'hex');
  }
  throw new InternalError(
    `No encryption key for version ${version}; this credential cannot be read (was a key removed?)`,
  );
}

/** Is credential storage usable at all? */
export function secretsConfigured(): boolean {
  return Boolean(env.SECRETS_KEY);
}

/** The version a value sealed right now would carry. */
export function currentKeyVersion(): number {
  return env.SECRETS_KEY_VERSION;
}

/**
 * Seal a plaintext secret for storage.
 *
 * Refuses rather than storing plaintext when no key is configured: a wizard that
 * appears to save a credential and has in fact written it in the clear is worse
 * than one that reports it cannot save at all.
 */
export function sealSecret(plaintext: string): Buffer {
  if (!env.SECRETS_KEY) {
    throw new InternalError(
      'SECRETS_KEY is not configured, so credentials cannot be stored. Generate one with `openssl rand -hex 32` and set it in the environment.',
    );
  }
  const version = env.SECRETS_KEY_VERSION;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFor(version), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  const sealed = Buffer.alloc(SEALED_HEADER_BYTES + ciphertext.length);
  sealed.writeUInt8(version, 0);
  iv.copy(sealed, IV_OFFSET);
  cipher.getAuthTag().copy(sealed, TAG_OFFSET);
  ciphertext.copy(sealed, PAYLOAD_OFFSET);
  return sealed;
}

/**
 * Open a sealed secret.
 *
 * Every failure is reported as "could not be decrypted" and NOTHING from the
 * input is echoed — not the version, not a byte, and never the plaintext.
 */
export function openSecret(sealed: Buffer): string {
  if (!Buffer.isBuffer(sealed) || sealed.length < SEALED_HEADER_BYTES) {
    throw new InternalError('Stored credential is malformed');
  }
  const version = sealed.readUInt8(0);
  const iv = sealed.subarray(IV_OFFSET, TAG_OFFSET);
  const tag = sealed.subarray(TAG_OFFSET, PAYLOAD_OFFSET);
  const ciphertext = sealed.subarray(PAYLOAD_OFFSET);

  const decipher = createDecipheriv(ALGORITHM, keyFor(version), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM's auth tag failed: the key is wrong or the row was altered.
    throw new InternalError(
      'Stored credential could not be decrypted (wrong key, or the stored value was altered)',
    );
  }
}

/**
 * The last four characters of a secret, or null when it is too short for that to
 * be a negligible disclosure.
 *
 * Used ONLY to let an operator tell two configured credentials apart. It must
 * never be combined with anything else that narrows the value.
 */
export function lastFourOf(secret: string): string | null {
  return secret.length >= MIN_LENGTH_FOR_SUFFIX ? secret.slice(-4) : null;
}
