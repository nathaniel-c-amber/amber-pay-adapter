import { createHash } from 'node:crypto';
import { InviteService } from './invites.js';
import { UserStore } from './users.js';
import { verifyPassword } from './passwords.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../lib/errors.js';
import type { InviteEmailSender } from './invites.js';
import type { PolicyAttribute } from './types.js';

const policy: PolicyAttribute[] = [
  { scope: 'payments', organizationId: 'org-1', actions: ['read'] },
];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Recording sender so tests can observe invite delivery. */
function recordingSender(): { sender: InviteEmailSender; sent: Array<{ email: string; token: string }> } {
  const sent: Array<{ email: string; token: string }> = [];
  const sender: InviteEmailSender = {
    async sendInvite(email: string, token: string): Promise<void> {
      sent.push({ email, token });
    },
  };
  return { sender, sent };
}

describe('InviteService', () => {
  it('returns the raw token once and stores only its hash', async () => {
    const service = new InviteService(new UserStore());
    const { invite, token } = await service.createInvite({
      email: 'new@example.com',
      policyAttributes: policy,
    });

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
    expect(invite.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(invite)).not.toContain(token);
  });

  it('delivers the invite via the email seam (not the return value)', async () => {
    const { sender, sent } = recordingSender();
    const service = new InviteService(new UserStore(), sender);
    const { token } = await service.createInvite({ email: 'new@example.com', policyAttributes: policy });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.email).toBe('new@example.com');
    expect(sent[0]?.token).toBe(token);
  });

  it('accepts a valid invite and creates a user with a hashed password', async () => {
    const users = new UserStore();
    const service = new InviteService(users);
    const { token } = await service.createInvite({ email: 'new@example.com', policyAttributes: policy });

    const user = await service.acceptInvite(token, 'Str0ngPassw0rd!');

    expect(user.email).toBe('new@example.com');
    expect(user.hashedPassword).not.toBe('Str0ngPassw0rd!');
    await expect(verifyPassword('Str0ngPassw0rd!', user.hashedPassword)).resolves.toBe(true);
    expect((await users.findByEmail('new@example.com'))?.id).toBe(user.id);
  });

  it('rejects a reused invite token', async () => {
    const service = new InviteService(new UserStore());
    const { token } = await service.createInvite({ email: 'new@example.com', policyAttributes: policy });
    await service.acceptInvite(token, 'Str0ngPassw0rd!');
    await expect(service.acceptInvite(token, 'Str0ngPassw0rd!')).rejects.toThrow(ConflictError);
  });

  it('rejects an invalid invite token', async () => {
    const service = new InviteService(new UserStore());
    await expect(service.verifyInviteToken('not-a-real-token')).rejects.toThrow(UnauthorizedError);
  });

  it('rejects an expired invite token', async () => {
    const service = new InviteService(new UserStore());
    const { invite, token } = await service.createInvite({
      email: 'new@example.com',
      policyAttributes: policy,
    });
    invite.expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(service.verifyInviteToken(token)).rejects.toThrow(UnauthorizedError);
  });

  it('rejects an invite for an existing user', async () => {
    const users = new UserStore();
    const service = new InviteService(users);
    await users.create('existing@example.com', 'hash', policy);
    await expect(
      service.createInvite({ email: 'existing@example.com', policyAttributes: policy }),
    ).rejects.toThrow(ConflictError);
  });

  it('rejects an invite with an invalid email (service-layer validation)', async () => {
    const service = new InviteService(new UserStore());
    await expect(
      service.createInvite({ email: 'not-an-email', policyAttributes: policy }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects accept-invite with a weak password (service-layer validation)', async () => {
    const service = new InviteService(new UserStore());
    const { token } = await service.createInvite({ email: 'new@example.com', policyAttributes: policy });
    await expect(service.acceptInvite(token, 'weak')).rejects.toThrow(ValidationError);
  });
});
