import request from 'supertest';
import { createApp } from '../app.js';
import { UserStore } from '../services/auth/user.service.js';
import { InviteService } from '../services/auth/invite.service.js';
import { PasswordResetService } from '../services/auth/passwordReset.service.js';
import { TwoFactorService } from '../services/auth/twoFactor.service.js';
import { UsersService } from '../services/auth/users.service.js';
import { InMemoryInviteRepository } from '../repositories/inMemory.js';
import { issueAccessToken } from '../utils/tokens.js';
import type { EmailSender } from '../services/auth/twoFactor.service.js';
import type { InviteEmailSender } from '../services/auth/invite.service.js';
import type { PasswordResetEmailSender } from '../services/auth/passwordReset.service.js';
import type { PolicyAttribute } from '../types/auth.js';

/*
  First-run tour completion (POST /auth/me/tour-complete).

  The endpoint is self-service, so the two things worth proving are that it is
  NOT reachable without a session, and that it cannot be used to touch anyone
  else's account. Idempotency is proven by a stamp that survives a second call
  unchanged — asserted against a deliberately old timestamp, because two calls in
  the same millisecond would pass a naive "timestamp did not move" check even if
  the row were rewritten.
*/

/** A syntactically valid bcrypt digest that matches nothing (no hashing needed here). */
const UNUSABLE_HASH = '$2a$12$0000000000000000000000000000000000000000000000000000A';

const adminPolicy: PolicyAttribute[] = [
  { scope: 'users', organizationId: 'org-1', actions: ['admin'] },
];

const operatorPolicy: PolicyAttribute[] = [
  { scope: 'dashboard', organizationId: 'org-1', actions: ['read', 'ack'] },
];

const ORIGINAL_STAMP = '2020-01-01T00:00:00.000Z';

function buildApp(userStore: UserStore) {
  const noopResetSender: PasswordResetEmailSender = { async send() {} };
  const noopInviteSender: InviteEmailSender = { async sendInvite() {} };
  const noopCodeSender: EmailSender = { async send() {} };
  const inviteRepository = new InMemoryInviteRepository();

  return createApp({
    auth: {
      userStore,
      inviteService: new InviteService(userStore, noopInviteSender, inviteRepository),
      passwordResetService: new PasswordResetService(userStore, noopResetSender),
      twoFactorService: new TwoFactorService(noopCodeSender),
    },
    users: {
      usersService: new UsersService(userStore, inviteRepository, noopInviteSender),
    },
  });
}

async function seedUser(
  userStore: UserStore,
  email: string,
  policy: PolicyAttribute[],
): Promise<{ id: string; token: string }> {
  const user = await userStore.create(email, UNUSABLE_HASH, policy);
  const token = issueAccessToken({
    id: user.id,
    email: user.email,
    policyAttributes: user.policyAttributes,
  });
  return { id: user.id, token };
}

async function readTourStamp(
  app: ReturnType<typeof buildApp>,
  token: string,
): Promise<string | null> {
  const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.tourCompletedAt as string | null;
}

describe('POST /auth/me/tour-complete', () => {
  it('rejects an unauthenticated request (401) and writes nothing', async () => {
    const userStore = new UserStore();
    const app = buildApp(userStore);
    const { token } = await seedUser(userStore, 'ops@example.com', operatorPolicy);

    const res = await request(app).post('/api/v1/auth/me/tour-complete');
    expect(res.status).toBe(401);

    // The account is untouched by the rejected call.
    expect(await readTourStamp(app, token)).toBeNull();
  });

  it('stamps the caller and is visible on the next GET /auth/me', async () => {
    const userStore = new UserStore();
    const app = buildApp(userStore);
    const { token } = await seedUser(userStore, 'ops@example.com', operatorPolicy);

    // A newly invited account starts unstamped — that is what makes the console
    // offer the tour once.
    expect(await readTourStamp(app, token)).toBeNull();

    const res = await request(app)
      .post('/api/v1/auth/me/tour-complete')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);

    expect(await readTourStamp(app, token)).not.toBeNull();
  });

  it('is idempotent — a repeat answers 204 and never rewrites the first stamp', async () => {
    const userStore = new UserStore();
    const app = buildApp(userStore);
    const { id, token } = await seedUser(userStore, 'ops@example.com', operatorPolicy);

    // Seed an OLD stamp so "unchanged" is a real claim rather than a same-ms tie.
    await userStore.markTourCompleted(id, ORIGINAL_STAMP);

    const first = await request(app)
      .post('/api/v1/auth/me/tour-complete')
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(204);
    expect(await readTourStamp(app, token)).toBe(ORIGINAL_STAMP);

    const second = await request(app)
      .post('/api/v1/auth/me/tour-complete')
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(204);
    expect(await readTourStamp(app, token)).toBe(ORIGINAL_STAMP);
  });

  it('stamps only the caller, never another account', async () => {
    const userStore = new UserStore();
    const app = buildApp(userStore);
    const caller = await seedUser(userStore, 'ops@example.com', operatorPolicy);
    const other = await seedUser(userStore, 'other@example.com', operatorPolicy);

    await request(app)
      .post('/api/v1/auth/me/tour-complete')
      .set('Authorization', `Bearer ${caller.token}`);

    expect(await readTourStamp(app, caller.token)).not.toBeNull();
    expect(await readTourStamp(app, other.token)).toBeNull();
  });

  it('needs no admin privilege — a read-only operator can stamp their own tour', async () => {
    const userStore = new UserStore();
    const app = buildApp(userStore);
    // `dashboard/read` only: this policy cannot reach /users at all.
    const { token } = await seedUser(userStore, 'viewer@example.com', [
      { scope: 'dashboard', organizationId: 'org-1', actions: ['read'] },
    ]);

    const res = await request(app)
      .post('/api/v1/auth/me/tour-complete')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
  });
});

describe('tour state does not leak into the admin directory', () => {
  it('GET /users carries no tour state for any account', async () => {
    const userStore = new UserStore();
    const app = buildApp(userStore);
    const { token } = await seedUser(userStore, 'admin@example.com', adminPolicy);
    await seedUser(userStore, 'ops@example.com', operatorPolicy);

    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThan(0);
    // The directory is a projection over OTHER people's accounts; tour state is
    // the caller's own business and has no place in it.
    expect(JSON.stringify(res.body)).not.toContain('tourCompletedAt');
    expect(JSON.stringify(res.body)).not.toContain('tour_completed_at');
  });
});
