import request from 'supertest';
import { createApp } from '../app.js';
import { UserStore } from '../services/auth/user.service.js';
import { InviteService } from '../services/auth/invite.service.js';
import { PasswordResetService } from '../services/auth/passwordReset.service.js';
import { TwoFactorService } from '../services/auth/twoFactor.service.js';
import { UsersService } from '../services/auth/users.service.js';
import { InMemoryInviteRepository } from '../repositories/inMemory.js';
import { hashPassword, verifyPassword } from '../utils/passwords.js';
import { issueAccessToken } from '../utils/tokens.js';
import type { EmailSender } from '../services/auth/twoFactor.service.js';
import type { InviteEmailSender } from '../services/auth/invite.service.js';
import type { PasswordResetEmailSender } from '../services/auth/passwordReset.service.js';
import type { PolicyAttribute } from '../types/auth.js';

/*
  bcrypt runs at cost 12 — deliberately, and weakening a production constant to
  speed up a test would be the wrong trade. But one hash is hundreds of
  milliseconds of real CPU, so this file's budget is about machine load under the
  rest of the suite, not about how long the endpoint is allowed to take.
*/
jest.setTimeout(30_000);

const adminPolicy: PolicyAttribute[] = [
  { scope: 'users', organizationId: 'org-1', actions: ['admin'] },
];

const operatorPolicy: PolicyAttribute[] = [
  { scope: 'dashboard', organizationId: 'org-1', actions: ['read', 'ack'] },
];

/**
 * A syntactically valid bcrypt digest that matches nothing.
 *
 * Most cases here only need an account to EXIST — they exercise the directory
 * and permission routes, which never compare a password. Hashing for them would
 * buy nothing and cost a few hundred milliseconds each, which under a full
 * parallel suite is enough to push unrelated tests past their timeout. The few
 * cases that genuinely verify a credential are marked `hash: true` below.
 */
const UNUSABLE_HASH = '$2a$12$0000000000000000000000000000000000000000000000000000A';

interface Harness {
  app: ReturnType<typeof createApp>;
  userStore: UserStore;
  resets: Array<{ email: string; token: string }>;
  invites: Array<{ email: string; token: string }>;
  codes: Array<{ email: string; code: string }>;
}

function buildHarness(): Harness {
  const resets: Array<{ email: string; token: string }> = [];
  const invites: Array<{ email: string; token: string }> = [];
  const codes: Array<{ email: string; code: string }> = [];

  const resetSender: PasswordResetEmailSender = {
    async send(email, token) {
      resets.push({ email, token });
    },
  };
  const inviteEmailSender: InviteEmailSender = {
    async sendInvite(email, token) {
      invites.push({ email, token });
    },
  };
  const codeSender: EmailSender = {
    async send(email, code) {
      codes.push({ email, code });
    },
  };

  const userStore = new UserStore();
  const inviteRepository = new InMemoryInviteRepository();
  const inviteService = new InviteService(userStore, inviteEmailSender, inviteRepository);
  const passwordResetService = new PasswordResetService(userStore, resetSender);
  const usersService = new UsersService(userStore, inviteRepository, inviteEmailSender);

  const app = createApp({
    auth: {
      userStore,
      inviteService,
      passwordResetService,
      twoFactorService: new TwoFactorService(codeSender),
    },
    users: { usersService },
  });

  return { app, userStore, resets, invites, codes };
}

/**
 * Seed an account and mint a token for it.
 *
 * `hash: true` performs the real bcrypt hash, which only the cases that verify a
 * credential need (the password-reset flow and anything that compares passwords).
 */
async function seedUser(
  userStore: UserStore,
  email: string,
  policy: PolicyAttribute[],
  options: { password?: string } = {},
): Promise<{ id: string; token: string }> {
  const hashedPassword =
    options.password !== undefined ? await hashPassword(options.password) : UNUSABLE_HASH;
  const user = await userStore.create(email, hashedPassword, policy);
  const token = issueAccessToken({
    id: user.id,
    email: user.email,
    policyAttributes: user.policyAttributes,
  });
  return { id: user.id, token };
}

describe('GET /auth/me', () => {
  it('rejects an unauthenticated request (401)', async () => {
    const { app } = buildHarness();
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the caller identity and granted policy', async () => {
    const { app, userStore } = buildHarness();
    const { token } = await seedUser(userStore, 'ops@example.com', operatorPolicy);
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('ops@example.com');
    expect(res.body.policyAttributes).toEqual(operatorPolicy);
    expect(res.body.policies).toHaveLength(1);
    // The credential hash must never leave the server.
    expect(JSON.stringify(res.body)).not.toContain('$2');
  });
});

describe('POST /auth/forgot-password', () => {
  it('answers 202 and sends a link for a known address', async () => {
    const { app, userStore, resets } = buildHarness();
    await seedUser(userStore, 'ops@example.com', operatorPolicy);
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'ops@example.com' });
    expect(res.status).toBe(202);
    expect(resets).toHaveLength(1);
    expect(resets[0]?.email).toBe('ops@example.com');
    // Dev/test only: the raw token is echoed so the flow can be walked through
    // without a mailbox. `exposeResetToken` gates it on NODE_ENV, exactly like
    // the invite token and the 2FA code.
    expect(res.body.token).toBe(resets[0]?.token);
  });

  it('answers 202 identically for an unknown address (no enumeration)', async () => {
    const { app, resets } = buildHarness();
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@example.com' });
    expect(res.status).toBe(202);
    expect(resets).toHaveLength(0);
    // No token to leak, so the dev convenience stays silent.
    expect(res.body.token).toBeUndefined();
  });

  it('rejects a malformed address (400)', async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/reset-password', () => {
  it('replaces the password and consumes the token', async () => {
    const { app, userStore, resets } = buildHarness();
    await seedUser(userStore, 'ops@example.com', operatorPolicy, { password: 'OperatorPass1!' });
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'ops@example.com' });
    const token = resets[0]?.token ?? '';

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'BrandNewPass2!' });
    expect(res.status).toBe(200);

    const user = await userStore.findByEmail('ops@example.com');
    await expect(verifyPassword('BrandNewPass2!', user?.hashedPassword ?? '')).resolves.toBe(true);
    await expect(verifyPassword('OperatorPass1!', user?.hashedPassword ?? '')).resolves.toBe(false);
  });

  it('rejects a replayed token (401)', async () => {
    const { app, userStore, resets } = buildHarness();
    await seedUser(userStore, 'ops@example.com', operatorPolicy);
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'ops@example.com' });
    const token = resets[0]?.token ?? '';

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'BrandNewPass2!' });
    const second = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'AnotherPass3!' });
    expect(second.status).toBe(401);
  });

  it('rejects an unknown token (401)', async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'nope', password: 'BrandNewPass2!' });
    expect(res.status).toBe(401);
  });

  it('rejects a weak password (400)', async () => {
    const { app, userStore, resets } = buildHarness();
    await seedUser(userStore, 'ops@example.com', operatorPolicy);
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'ops@example.com' });
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: resets[0]?.token ?? '', password: 'weak' });
    expect(res.status).toBe(400);
  });
});

describe('GET /users', () => {
  it('rejects a non-admin (403)', async () => {
    const { app, userStore } = buildHarness();
    const { token } = await seedUser(userStore, 'ops@example.com', operatorPolicy);
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('lists accounts the admin administers, and hides other organizations', async () => {
    const { app, userStore } = buildHarness();
    const { token } = await seedUser(userStore, 'admin@example.com', adminPolicy);
    await seedUser(userStore, 'ops@example.com', operatorPolicy);
    await seedUser(userStore, 'outsider@example.com', [
      { scope: 'dashboard', organizationId: 'org-2', actions: ['read'] },
    ]);

    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const emails = (res.body.users as Array<{ email: string }>).map((u) => u.email);
    expect(emails).toContain('ops@example.com');
    expect(emails).not.toContain('outsider@example.com');
    // A projection of the directory, never the user record itself.
    expect(JSON.stringify(res.body)).not.toContain('hashedPassword');
  });
});

describe('PATCH /users/:id', () => {
  it('updates permissions the admin can grant', async () => {
    const { app, userStore } = buildHarness();
    const { token } = await seedUser(userStore, 'admin@example.com', adminPolicy);
    const target = await seedUser(userStore, 'ops@example.com', operatorPolicy);

    const next: PolicyAttribute[] = [
      { scope: 'users', organizationId: 'org-1', actions: ['admin'] },
    ];
    const res = await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ policyAttributes: next });
    expect(res.status).toBe(200);

    const updated = await userStore.findById(target.id);
    expect(updated?.policyAttributes).toEqual(next);
  });

  it('refuses to grant policy the admin does not hold (403)', async () => {
    const { app, userStore } = buildHarness();
    const { token } = await seedUser(userStore, 'admin@example.com', adminPolicy);
    const target = await seedUser(userStore, 'ops@example.com', operatorPolicy);

    const res = await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        policyAttributes: [{ scope: '*', organizationId: '*', actions: ['admin'] }],
      });
    expect(res.status).toBe(403);
  });

  it('404s on a target in an organization the admin does not administer', async () => {
    const { app, userStore } = buildHarness();
    const { token } = await seedUser(userStore, 'admin@example.com', adminPolicy);
    const outsider = await seedUser(userStore, 'outsider@example.com', [
      { scope: 'dashboard', organizationId: 'org-2', actions: ['read'] },
    ]);

    const res = await request(app)
      .patch(`/api/v1/users/${outsider.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        policyAttributes: [{ scope: 'users', organizationId: 'org-1', actions: ['admin'] }],
      });
    expect(res.status).toBe(404);
  });
});

describe('POST /users/:id/resend-invite', () => {
  it('re-issues the invite for a pending entry', async () => {
    const { app, userStore, invites } = buildHarness();
    const { token } = await seedUser(userStore, 'admin@example.com', adminPolicy);

    const created = await request(app)
      .post('/api/v1/auth/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'pending@example.com',
        organizationId: 'org-1',
        policyAttributes: [{ scope: 'users', organizationId: 'org-1', actions: ['admin'] }],
      });
    expect(created.status).toBe(201);
    const inviteId = created.body.invite.id as string;
    const firstToken = invites[0]?.token ?? '';

    const res = await request(app)
      .post(`/api/v1/users/${inviteId}/resend-invite`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(202);
    expect(invites).toHaveLength(2);
    expect(invites[1]?.token).not.toBe(firstToken);

    // The superseded link no longer works.
    const stale = await request(app)
      .post('/api/v1/auth/accept-invite')
      .send({ token: firstToken, password: 'BrandNewPass2!' });
    expect(stale.status).not.toBe(200);
  });
});

describe('GET /health', () => {
  it('answers without a token, so the console can report status before sign-in', async () => {
    const { app } = buildHarness();
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('exposes nothing beyond liveness', async () => {
    const { app } = buildHarness();
    const res = await request(app).get('/api/v1/health');
    // An unauthenticated endpoint must not become a reconnaissance surface: no
    // version, uptime, storage backend, environment or row counts. All of that
    // belongs behind the authenticated /service/status.
    expect(Object.keys(res.body)).toEqual(['status']);
    const serialised = JSON.stringify(res.body);
    for (const leak of ['version', 'uptime', 'storage', 'environment', 'node', 'rows']) {
      expect(serialised).not.toContain(leak);
    }
  });
});
