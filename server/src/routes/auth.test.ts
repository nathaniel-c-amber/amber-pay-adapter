import request from 'supertest';
import { createApp } from '../app.js';
import { UserStore } from '../services/auth/user.service.js';
import { InviteService } from '../services/auth/invite.service.js';
import { TwoFactorService } from '../services/auth/twoFactor.service.js';
import { hashPassword } from '../utils/passwords.js';
import { issueAccessToken } from '../utils/tokens.js';
import { env } from '../config/env.js';
import type { EmailSender } from '../services/auth/twoFactor.service.js';
import type { PolicyAttribute } from '../types/auth.js';

const adminPolicy: PolicyAttribute[] = [
  { scope: 'users', organizationId: 'org-1', actions: ['admin'] },
];

const inviteBody = {
  email: 'invitee@example.com',
  organizationId: 'org-1',
  // The admin holds `admin` on `users` scope for org-1, so a grant of the same
  // scope/action is allowed (M2).
  policyAttributes: [{ scope: 'users', organizationId: 'org-1', actions: ['admin'] }],
};

function buildTestApp(): {
  app: ReturnType<typeof createApp>;
  userStore: UserStore;
  sent: Array<{ email: string; code: string }>;
} {
  const sent: Array<{ email: string; code: string }> = [];
  const emailSender: EmailSender = {
    async send(email: string, code: string): Promise<void> {
      sent.push({ email, code });
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

/**
 * A syntactically valid bcrypt digest that matches nothing.
 *
 * The wildcard case below never verifies a credential, and one bcrypt hash at
 * cost 12 is hundreds of milliseconds of real CPU — enough, under the rest of
 * the parallel suite, to push unrelated tests past Jest's 5s default and look
 * like a regression.
 */
const UNUSABLE_HASH = '$2a$12$0000000000000000000000000000000000000000000000000000A';

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

  it('rejects an invite granting policy for a foreign organization (400)', async () => {
    /*
      This case used to be caught by the escalation guard with a 403, because the
      admin held org-1 while the attribute asked for org-2. It is now refused one
      step EARLIER, by the canonical-organization rule: this deployment serves
      exactly one organization, so org-2 is not a valid target for anyone,
      whatever the caller happens to hold. The escalation guard still covers the
      same-organization case — see "rejects granting a scope the admin does not
      hold" below.
    */
    const { app, userStore } = buildTestApp();
    const token = await seedAdmin(userStore); // admin on org-1 only
    const res = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'invitee@example.com',
        organizationId: 'org-1',
        // Body org is authorized, but the granted attribute targets a foreign org.
        policyAttributes: [{ scope: 'payments', organizationId: 'org-2', actions: ['admin'] }],
      });
    expect(res.status).toBe(400);
  });

  it('still allows a wildcard-organization grant from a wildcard holder', async () => {
    /*
      Guards the canonical-organization rule against over-reach. `'*'` is a POLICY
      wildcard, not a foreign organization, so a holder of it may still create
      another holder. Without this case a future tightening could refuse every
      super-admin invite and the symptom would look like a permissions bug.
    */
    const { app, userStore } = buildTestApp();
    const user = await userStore.create('root@example.com', UNUSABLE_HASH, [
      { scope: '*', organizationId: '*', actions: ['read', 'ack', 'write', 'admin'] },
    ]);
    const token = issueAccessToken({
      id: user.id,
      email: user.email,
      policyAttributes: user.policyAttributes,
    });
    const res = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'second-admin@example.com',
        organizationId: 'org-1',
        policyAttributes: [{ scope: '*', organizationId: '*', actions: ['read', 'admin'] }],
      });
    expect(res.status).toBe(201);
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

  it('rejects granting a scope the admin does not hold (M2, 403)', async () => {
    const { app, userStore } = buildTestApp();
    const token = await seedAdmin(userStore); // admin holds `users` scope only
    const res = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'invitee@example.com',
        organizationId: 'org-1',
        policyAttributes: [{ scope: 'payments', organizationId: 'org-1', actions: ['read'] }],
      });
    expect(res.status).toBe(403);
  });

  it('rejects granting a wildcard scope unless the admin holds one (M2, 403)', async () => {
    const { app, userStore } = buildTestApp();
    const token = await seedAdmin(userStore); // admin holds `users` scope only
    const res = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'invitee@example.com',
        organizationId: 'org-1',
        policyAttributes: [{ scope: '*', organizationId: 'org-1', actions: ['admin'] }],
      });
    expect(res.status).toBe(403);
  });

  it('rejects granting an action the admin does not hold (M2, 403)', async () => {
    const { app, userStore } = buildTestApp();
    const token = await seedAdmin(userStore); // admin holds `admin` only on `users`
    const res = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'invitee@example.com',
        organizationId: 'org-1',
        policyAttributes: [{ scope: 'users', organizationId: 'org-1', actions: ['read'] }],
      });
    expect(res.status).toBe(403);
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
