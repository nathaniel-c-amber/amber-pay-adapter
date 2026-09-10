import request from 'supertest';
import { createApp } from '../app.js';
import { UserStore } from '../auth/users.js';
import { InviteService } from '../auth/invites.js';
import { TwoFactorService } from '../auth/twoFactor.js';
import { hashPassword } from '../auth/passwords.js';
import { issueAccessToken } from '../auth/tokens.js';
import { env } from '../config/env.js';
import type { EmailSender } from '../auth/twoFactor.js';
import type { PolicyAttribute } from '../auth/types.js';

const adminPolicy: PolicyAttribute[] = [
  { scope: 'users', organizationId: 'org-1', actions: ['admin'] },
];

const inviteBody = {
  email: 'invitee@example.com',
  organizationId: 'org-1',
  policyAttributes: [{ scope: 'payments', organizationId: 'org-1', actions: ['read'] }],
};

function buildTestApp(): {
  app: ReturnType<typeof createApp>;
  userStore: UserStore;
  sent: Array<{ userId: string; code: string }>;
} {
  const sent: Array<{ userId: string; code: string }> = [];
  const emailSender: EmailSender = {
    async send(userId: string, code: string): Promise<void> {
      sent.push({ userId, code });
    },
  };
  const userStore = new UserStore();
  const inviteService = new InviteService(userStore);
  const twoFactorService = new TwoFactorService(emailSender);
  const app = createApp({ auth: { userStore, inviteService, twoFactorService } });
  return { app, userStore, sent };
}

async function seedAdmin(userStore: UserStore): Promise<string> {
  const user = await userStore.create(
    'admin@example.com',
    await hashPassword('AdminPassw0rd!'),
    adminPolicy,
  );
  return issueAccessToken({
    id: user.id,
    email: user.email,
    policyAttributes: user.policyAttributes,
  });
}

describe('auth routes', () => {
  it('rejects invite without a token (401)', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/v1/auth/invite').send(inviteBody);
    expect(res.status).toBe(401);
  });

  it('rejects invite when PBAC denies the body organization (403)', async () => {
    const { app, userStore } = buildTestApp();
    const token = await seedAdmin(userStore);
    const res = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...inviteBody, organizationId: 'org-2' });
    expect(res.status).toBe(403);
  });

  it('rejects an invite granting policy for an unauthorized organization (C1, 403)', async () => {
    const { app, userStore } = buildTestApp();
    const token = await seedAdmin(userStore); // admin on org-1 only
    const res = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'invitee@example.com',
        organizationId: 'org-1',
        // Body org is authorized, but the granted attribute targets org-2.
        policyAttributes: [{ scope: 'payments', organizationId: 'org-2', actions: ['admin'] }],
      });
    expect(res.status).toBe(403);
  });

  it('allows a same-organization invite (C1)', async () => {
    const { app, userStore } = buildTestApp();
    const token = await seedAdmin(userStore);
    const res = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${token}`)
      .send(inviteBody);
    expect(res.status).toBe(201);
  });

  it('rejects invite with an invalid body (400)', async () => {
    const { app, userStore } = buildTestApp();
    const token = await seedAdmin(userStore);
    const res = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'not-an-email', organizationId: 'org-1', policyAttributes: [] });
    expect(res.status).toBe(400);
  });

  it('does not return the invite token in production (M2)', async () => {
    const original = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      const { app, userStore } = buildTestApp();
      const token = await seedAdmin(userStore);
      const res = await request(app)
        .post('/api/v1/auth/invite')
        .set('Authorization', `Bearer ${token}`)
        .send(inviteBody);
      expect(res.status).toBe(201);
      expect(res.body.token).toBeUndefined();
      expect(res.body.delivery).toBe('email');
    } finally {
      env.NODE_ENV = original;
    }
  });

  it('completes the invite → accept-invite → login → 2FA verify flow', async () => {
    const { app, userStore, sent } = buildTestApp();
    const adminToken = await seedAdmin(userStore);

    const inviteRes = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(inviteBody);
    expect(inviteRes.status).toBe(201);
    const inviteToken = inviteRes.body.token as string;
    expect(typeof inviteToken).toBe('string');

    const acceptRes = await request(app)
      .post('/api/v1/auth/accept-invite')
      .send({ token: inviteToken, password: 'InviteePassw0rd!' });
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.status).toBe('accepted');

    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'invitee@example.com', password: 'InviteePassw0rd!' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.requiresTwoFactor).toBe(true);
    // No access token is issued until 2FA succeeds.
    expect(loginRes.body.accessToken).toBeUndefined();

    const challengeId = loginRes.body.challengeId as string;
    const challengeCode = sent[0]?.code;
    expect(typeof challengeCode).toBe('string');

    const verifyRes = await request(app)
      .post('/api/v1/auth/2fa/verify')
      .send({ challengeId, code: challengeCode });
    expect(verifyRes.status).toBe(200);
    expect(typeof verifyRes.body.accessToken).toBe('string');
  });

  it('rejects accept-invite with a weak password (400)', async () => {
    const { app, userStore } = buildTestApp();
    const adminToken = await seedAdmin(userStore);
    const inviteRes = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(inviteBody);
    const inviteToken = inviteRes.body.token as string;

    const res = await request(app)
      .post('/api/v1/auth/accept-invite')
      .send({ token: inviteToken, password: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects login with invalid input (400)', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'nope' });
    expect(res.status).toBe(400);
  });

  it('rejects 2fa/verify with a malformed code (400)', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/auth/2fa/verify')
      .send({ challengeId: 'c1', code: 'abc' });
    expect(res.status).toBe(400);
  });

  it('rejects login with wrong credentials (401)', async () => {
    const { app, userStore } = buildTestApp();
    await seedAdmin(userStore);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.com', password: 'WrongPassw0rd!' });
    expect(res.status).toBe(401);
  });

  it('rate limits login attempts with 429 after the limit (M1)', async () => {
    const { app } = buildTestApp();
    // Invalid body keeps the test fast (no bcrypt) while still counting.
    const body = { email: 'ratelimit@example.com' };
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app).post('/api/v1/auth/login').send(body);
      expect(res.status).toBe(400);
    }
    const limited = await request(app).post('/api/v1/auth/login').send(body);
    expect(limited.status).toBe(429);
  });
});
