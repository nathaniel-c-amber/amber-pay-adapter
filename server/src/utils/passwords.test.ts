import { hashPassword, verifyPassword } from './passwords.js';

describe('passwords', () => {
  it('hashes and verifies a password round-trip', async () => {
    const hash = await hashPassword('Str0ngPassw0rd!');
    expect(hash).not.toBe('Str0ngPassw0rd!');
    expect(hash.startsWith('$2')).toBe(true); // bcrypt hash prefix
    await expect(verifyPassword('Str0ngPassw0rd!', hash)).resolves.toBe(true);
  });

  it('fails verification for the wrong password', async () => {
    const hash = await hashPassword('Str0ngPassw0rd!');
    await expect(verifyPassword('WrongPassw0rd!', hash)).resolves.toBe(false);
  });

  it('produces different hashes for the same password (salted)', async () => {
    const first = await hashPassword('Str0ngPassw0rd!');
    const second = await hashPassword('Str0ngPassw0rd!');
    expect(first).not.toBe(second);
  });
});
