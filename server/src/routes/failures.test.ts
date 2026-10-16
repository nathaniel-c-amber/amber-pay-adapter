import request from 'supertest';
import { createApp } from '../app.js';
import { createInMemoryRepositories } from '../repositories/inMemory.js';
import { issueAccessToken } from '../utils/tokens.js';
import type { PolicyAttribute } from '../types/auth.js';
import type { Failure } from '../models/domain.js';

const ackPolicy: PolicyAttribute[] = [
  { scope: 'dashboard', organizationId: 'org-1', actions: ['read', 'ack'] },
];

function token(policy: PolicyAttribute[]): string {
  return issueAccessToken({ id: 'u1', email: 'user@example.com', policyAttributes: policy });
}

/** A second operator on the same organization, for the attribution tests. */
function tokenAs(id: string, email: string, policy: PolicyAttribute[] = ackPolicy): string {
  return issueAccessToken({ id, email, policyAttributes: policy });
}

function failure(over: Partial<Failure> & Pick<Failure, 'id' | 'organizationId'>): Failure {
  return {
    severity: 'critical',
    channel: 'webhook',
    title: 'Webhook failed',
    detail: 'Processing error',
    since: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('failures routes', () => {
  it('rejects POST /failures/:id/acknowledge without a token (401)', async () => {
    const app = createApp({ repositories: createInMemoryRepositories() });
    const res = await request(app).post('/api/v1/failures/f1/acknowledge');
    expect(res.status).toBe(401);
  });

  it('rejects when the caller has no ack on any org (403)', async () => {
    const app = createApp({ repositories: createInMemoryRepositories() });
    const res = await request(app)
      .post('/api/v1/failures/f1/acknowledge')
      .set('Authorization', `Bearer ${token([{ scope: 'dashboard', organizationId: 'org-1', actions: ['read'] }])}`);
    expect(res.status).toBe(403);
  });

  it('acknowledges a failure the caller can ack (200)', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.failures.append({
      id: 'f1',
      organizationId: 'org-1',
      severity: 'critical',
      channel: 'webhook',
      title: 'Webhook failed',
      detail: 'Processing error',
      since: '2026-01-01T00:00:00.000Z',
    });

    const res = await request(createApp({ repositories }))
      .post('/api/v1/failures/f1/acknowledge')
      .set('Authorization', `Bearer ${token(ackPolicy)}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('f1');
    expect(typeof res.body.acknowledgedAt).toBe('string');
  });

  it('cannot acknowledge another org\'s failure (org-scoping)', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.failures.append({
      id: 'f2',
      organizationId: 'org-2',
      severity: 'critical',
      channel: 'webhook',
      title: 'Webhook failed',
      detail: 'Processing error',
      since: '2026-01-02T00:00:00.000Z',
    });

    // Caller has ack on org-1 only; the failure belongs to org-2.
    const res = await request(createApp({ repositories }))
      .post('/api/v1/failures/f2/acknowledge')
      .set('Authorization', `Bearer ${token(ackPolicy)}`);

    expect(res.status).toBe(404);
  });
});

/*
 * ATTRIBUTION. An acknowledgement used to record only a timestamp, so the
 * console could not say who acted and — because nothing read the value back —
 * an acknowledgement made by one operator reappeared for another. These tests
 * pin the actor to the token.
 */
describe('acknowledgement attribution', () => {
  it('records the acknowledging operator from the token, not the request', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.failures.append(failure({ id: 'f1', organizationId: 'org-1' }));

    const res = await request(createApp({ repositories }))
      .post('/api/v1/failures/f1/acknowledge')
      // A client claiming to be somebody else must not be believed.
      .send({ acknowledgedBy: 'attacker@example.com' })
      .set('Authorization', `Bearer ${tokenAs('u9', 'real-operator@example.com')}`);

    expect(res.status).toBe(200);
    expect(res.body.acknowledgedBy).toBe('real-operator@example.com');
  });

  it('keeps one operator\'s acknowledgement visible to another (regression)', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.failures.append(failure({ id: 'f1', organizationId: 'org-1' }));
    const app = createApp({ repositories });

    await request(app)
      .post('/api/v1/failures/f1/acknowledge')
      .set('Authorization', `Bearer ${tokenAs('u1', 'alice@example.com')}`)
      .expect(200);

    // A DIFFERENT operator on the same org reads the console feed. The finding
    // must come back already acknowledged and attributed to Alice. This is the
    // symptom that made an acknowledgement look like it had never happened:
    // the row used to reappear for Bob as though nobody had touched it, because
    // the acknowledgement was written but never read back.
    const res = await request(app)
      .get('/api/v1/dashboard/metrics')
      .query({ organizationId: 'org-1' })
      .set('Authorization', `Bearer ${tokenAs('u2', 'bob@example.com')}`);

    expect(res.status).toBe(200);
    const rows = res.body.failures as Array<{ id: string; acknowledgedAt?: string; acknowledgedBy?: string }>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe('f1');
    expect(typeof row.acknowledgedAt).toBe('string');
    expect(row.acknowledgedBy).toBe('alice@example.com');
  });

  it('records the actor again when a second operator re-acknowledges', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.failures.append(failure({ id: 'f1', organizationId: 'org-1' }));
    const app = createApp({ repositories });

    await request(app)
      .post('/api/v1/failures/f1/acknowledge')
      .set('Authorization', `Bearer ${tokenAs('u1', 'alice@example.com')}`)
      .expect(200);

    // Re-acknowledging is a fresh action, so it takes a fresh attribution.
    const res = await request(app)
      .post('/api/v1/failures/f1/acknowledge')
      .set('Authorization', `Bearer ${tokenAs('u2', 'bob@example.com')}`);

    expect(res.status).toBe(200);
    expect(res.body.acknowledgedBy).toBe('bob@example.com');
  });

  it('leaves an actor absent on a row acknowledged before attribution existed', async () => {
    const repositories = createInMemoryRepositories();
    // A pre-migration row: acknowledged, but the database never saw a who.
    // The console must be able to render this honestly rather than as a blank
    // cell that reads as "not acknowledged".
    await repositories.failures.append(
      failure({ id: 'f1', organizationId: 'org-1', acknowledgedAt: '2026-01-05T00:00:00.000Z' }),
    );

    const res = await request(createApp({ repositories }))
      .get('/api/v1/dashboard/metrics')
      .query({ organizationId: 'org-1' })
      .set('Authorization', `Bearer ${tokenAs('u2', 'bob@example.com')}`);

    const rows = res.body.failures as Array<{ acknowledgedAt?: string; acknowledgedBy?: string }>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.acknowledgedAt).toBe('2026-01-05T00:00:00.000Z');
    expect(row.acknowledgedBy).toBeUndefined();
  });
});

describe('POST /failures/acknowledge (batch)', () => {
  async function seeded() {
    const repositories = createInMemoryRepositories();
    await repositories.failures.append(failure({ id: 'f1', organizationId: 'org-1' }));
    await repositories.failures.append(failure({ id: 'f2', organizationId: 'org-1', severity: 'attention' }));
    await repositories.failures.append(failure({ id: 'f3', organizationId: 'org-1' }));
    return repositories;
  }

  it('rejects a batch without a token (401)', async () => {
    const res = await request(createApp({ repositories: await seeded() }))
      .post('/api/v1/failures/acknowledge')
      .send({ ids: ['f1'] });
    expect(res.status).toBe(401);
  });

  it('rejects a batch when the caller has no ack (403)', async () => {
    const res = await request(createApp({ repositories: await seeded() }))
      .post('/api/v1/failures/acknowledge')
      .send({ ids: ['f1'] })
      .set('Authorization', `Bearer ${token([{ scope: 'dashboard', organizationId: 'org-1', actions: ['read'] }])}`);
    expect(res.status).toBe(403);
  });

  it('acknowledges every failure in the batch as one action', async () => {
    const repositories = await seeded();

    const res = await request(createApp({ repositories }))
      .post('/api/v1/failures/acknowledge')
      .send({ ids: ['f1', 'f2', 'f3'] })
      .set('Authorization', `Bearer ${tokenAs('u1', 'alice@example.com')}`);

    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(3);
    const stored = await repositories.failures.list(['org-1']);
    expect(stored.every((f) => typeof f.acknowledgedAt === 'string')).toBe(true);
    expect(stored.every((f) => f.acknowledgedBy === 'alice@example.com')).toBe(true);
  });

  it('stamps one shared timestamp across the batch (one operator gesture)', async () => {
    const repositories = await seeded();

    const res = await request(createApp({ repositories }))
      .post('/api/v1/failures/acknowledge')
      .send({ ids: ['f1', 'f2', 'f3'] })
      .set('Authorization', `Bearer ${tokenAs('u1', 'alice@example.com')}`);

    const stamps = new Set(
      (res.body.failures as Array<{ acknowledgedAt: string }>).map((f) => f.acknowledgedAt),
    );
    expect(stamps.size).toBe(1);
  });

  it('skips another org\'s failure instead of failing the whole batch', async () => {
    const repositories = await seeded();
    await repositories.failures.append(failure({ id: 'foreign', organizationId: 'org-2' }));

    const res = await request(createApp({ repositories }))
      .post('/api/v1/failures/acknowledge')
      .send({ ids: ['f1', 'foreign'] })
      .set('Authorization', `Bearer ${tokenAs('u1', 'alice@example.com')}`);

    // 200, not an error: a stale console legitimately sends ids it can no
    // longer see. What matters is that `foreign` is neither acknowledged nor
    // returned — an invisible row must not be distinguishable from a real one.
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(1);
    const ids = (res.body.failures as Array<{ id: string }>).map((f) => f.id);
    expect(ids).not.toContain('foreign');

    const org2 = await repositories.failures.list(['org-2']);
    expect(org2[0]?.acknowledgedAt).toBeUndefined();
  });

  it('treats an unknown id as absent rather than as an error', async () => {
    const res = await request(createApp({ repositories: await seeded() }))
      .post('/api/v1/failures/acknowledge')
      .send({ ids: ['f1', 'does-not-exist'] })
      .set('Authorization', `Bearer ${tokenAs('u1', 'alice@example.com')}`);

    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(1);
  });

  it.each([
    ['a missing ids field', {}],
    ['an empty array', { ids: [] }],
    ['a non-array', { ids: 'f1' }],
    ['a non-string entry', { ids: ['f1', 7] }],
    ['a blank entry', { ids: ['f1', '  '] }],
  ])('rejects %s (400)', async (_label, body) => {
    const res = await request(createApp({ repositories: await seeded() }))
      .post('/api/v1/failures/acknowledge')
      .send(body)
      .set('Authorization', `Bearer ${tokenAs('u1', 'alice@example.com')}`);
    expect(res.status).toBe(400);
  });

  it('rejects a batch over the 500 cap rather than silently truncating it', async () => {
    const res = await request(createApp({ repositories: await seeded() }))
      .post('/api/v1/failures/acknowledge')
      .send({ ids: Array.from({ length: 501 }, (_, i) => `f${i}`) })
      .set('Authorization', `Bearer ${tokenAs('u1', 'alice@example.com')}`);

    expect(res.status).toBe(400);
  });
});