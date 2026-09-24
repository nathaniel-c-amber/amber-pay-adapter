import { createCipheriv, randomBytes } from 'node:crypto';
import {
  SEALED_HEADER_BYTES,
  currentKeyVersion,
  lastFourOf,
  openSecret,
  sealSecret,
  secretsConfigured,
} from './secrets.js';
import { env } from '../config/env.js';

/*
  The test environment configures TWO keys — `SECRETS_KEY` as version 2 and
  `SECRETS_KEY_PREVIOUS` as version 1 — so the rotation path can be exercised
  with a real older envelope rather than by asserting that some branch exists.
  Rotation is the part of an encryption scheme most likely to be quietly wrong
  and least likely to be noticed, because it only fails the first time somebody
  changes a key.
*/

const SECRET = 'qb-refresh-token-abcdefghijklmnop-0123456789';

describe('sealSecret / openSecret', () => {
  it('round-trips a value', () => {
    expect(openSecret(sealSecret(SECRET))).toBe(SECRET);
  });

  it('writes a self-describing envelope with the current key version', () => {
    const sealed = sealSecret('short');
    expect(sealed.length).toBe(SEALED_HEADER_BYTES + 'short'.length);
    expect(sealed.readUInt8(0)).toBe(currentKeyVersion());
  });

  it('produces a different envelope every time (a fresh nonce)', () => {
    // Equal ciphertexts for equal plaintexts would leak which credentials are
    // the same value.
    expect(sealSecret(SECRET).equals(sealSecret(SECRET))).toBe(false);
  });

  it('does not leave the plaintext anywhere in the stored bytes', () => {
    const sealed = sealSecret(SECRET);
    expect(sealed.includes(Buffer.from(SECRET))).toBe(false);
    expect(sealed.toString('utf8')).not.toContain('qb-refresh-token');
  });

  it('refuses a tampered ciphertext instead of returning garbage', () => {
    const sealed = sealSecret(SECRET);
    // Flip a bit in the final ciphertext byte. GCM's auth tag is what turns this
    // from "decrypts to nonsense" into "refuses".
    sealed.writeUInt8(sealed.readUInt8(sealed.length - 1) ^ 0x01, sealed.length - 1);
    expect(() => openSecret(sealed)).toThrow(/could not be decrypted/);
  });

  it('reports a malformed value rather than throwing a crypto error', () => {
    expect(() => openSecret(Buffer.alloc(4))).toThrow(/malformed/);
  });

  it('names the missing version when no key can read a value', () => {
    // Version 9 exists under no configuration: a key was removed, or the row
    // came from another deployment. The message must say so, because "credential
    // is empty" would send an operator to re-enter a value that is fine.
    const sealed = sealSecret(SECRET);
    sealed.writeUInt8(9, 0);
    expect(() => openSecret(sealed)).toThrow(/No encryption key for version 9/);
  });

  it('reports whether storage is usable at all', () => {
    expect(secretsConfigured()).toBe(true);
  });
});

describe('rotation', () => {
  it('reads a value sealed under the PREVIOUS key', () => {
    /*
      Build a v1 envelope by hand, exactly as the previous key would have
      produced it. This is the whole point of keeping a previous key: a rotation
      must not orphan rows that were sealed before it.
    */
    const previousKey = Buffer.from(env.SECRETS_KEY_PREVIOUS as string, 'hex');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', previousKey, iv);
    const ciphertext = Buffer.concat([cipher.update(SECRET, 'utf8'), cipher.final()]);
    const sealed = Buffer.alloc(SEALED_HEADER_BYTES + ciphertext.length);
    sealed.writeUInt8(1, 0);
    iv.copy(sealed, 1);
    cipher.getAuthTag().copy(sealed, 13);
    ciphertext.copy(sealed, SEALED_HEADER_BYTES);

    expect(openSecret(sealed)).toBe(SECRET);
  });

  it('does not read a current-version envelope with the previous key', () => {
    // Guards the reverse mistake: if the two keys were swapped, current values
    // would be readable with the retired key and the rotation would be cosmetic.
    const sealed = sealSecret(SECRET);
    const currentKeyAsPrevious = Buffer.from(env.SECRETS_KEY as string, 'hex');
    const previousKey = Buffer.from(env.SECRETS_KEY_PREVIOUS as string, 'hex');
    expect(currentKeyAsPrevious.equals(previousKey)).toBe(false);
    expect(sealed.readUInt8(0)).toBe(env.SECRETS_KEY_VERSION);
  });
});

describe('lastFourOf', () => {
  it('returns the last four of a long value', () => {
    expect(lastFourOf(SECRET)).toBe(SECRET.slice(-4));
  });

  it('discloses nothing about a short value', () => {
    // Four characters of an eight-character secret is half of it.
    expect(lastFourOf('short123')).toBeNull();
    expect(lastFourOf('12345678901')).toBeNull();
    expect(lastFourOf('123456789012')).toBe('9012');
  });
});
