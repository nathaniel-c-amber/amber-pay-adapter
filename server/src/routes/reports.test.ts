import request from 'supertest';
import { createApp } from '../app.js';
import { createInMemoryRepositories } from '../repositories/inMemory.js';
import { issueAccessToken } from '../auth/tokens.js';
import { forbiddenKeysIn } from '../test/privacy.js';
import type { PolicyAttribute } from '../auth/types.js';

const readPolicy: PolicyAttribute[] = [
  { scope: 'reports', organizationId: 'org-1', actions: ['read'] },
];

function token(policy: PolicyAttribute[]): string {
  return issueAccessToken({ id: 'u1', email: 'user@example.com', policyAttributes: policy });
}

describe('reports routes', () => {
  it('rejects GET /reports/reconciliation without a token (401)', async () => {
    const app = createApp({ repositories: createInMemoryRepositories() });
    const res = await request(app).get('/api/v1/reports/reconciliation');
    expect(res.status).toBe(401);
  });

  it('rejects when PBAC denies the scope (403)', async () => {
    const app = createApp({ repositories: createInMemoryRepositories() });
    const res = await request(app)
      .get('/api/v1/reports/reconciliation')
      .query({ organizationId: 'org-1' })
      .set('Authorization', `Bearer ${token([{ scope: 'payments', organizationId: 'org-1', actions: ['read'] }])}`);
    expect(res.status).toBe(403);
  });

  it('returns operational reconciliation counts (200) with no monetary values', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.reconciliation.create({
      id: 'job-1',
      organizationId: 'org-1',
      runAt: '2026-01-01T00:00:00.000Z',
      status: 'completed',
      summary: {
        status: 'completed',
        matched: 12,
        unmatched: 2,
        anomalies: 1,
        ranAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const res = await request(createApp({ repositories }))
      .get('/api/v1/reports/reconciliation')
      .query({ organizationId: 'org-1' })
      .set('Authorization', `Bearer ${token(readPolicy)}`);

    expect(res.status).toBe(200);
    expect(res.body.reconciliation.matched).toBe(12);
    expect(res.body.reconciliation.unmatched).toBe(2);
    expect(res.body.reconciliation.anomalies).toBe(1);
    expect(res.body.jobs).toHaveLength(1);
    expect(typeof res.body.generatedAt).toBe('string');
    expect(forbiddenKeysIn(res.body)).toEqual([]);
  });

  it('does not leak org-2 reconciliation jobs to an org-1 caller (C1)', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.reconciliation.create({
      id: 'job-1',
      organizationId: 'org-1',
      runAt: '2026-01-01T00:00:00.000Z',
      status: 'completed',
      summary: {
        status: 'completed',
        matched: 12,
        unmatched: 2,
        anomalies: 1,
        ranAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await repositories.reconciliation.create({
      id: 'job-2',
      organizationId: 'org-2',
      runAt: '2026-01-02T00:00:00.000Z',
      status: 'completed',
      summary: {
        status: 'completed',
        matched: 99,
        unmatched: 0,
        anomalies: 0,
        ranAt: '2026-01-02T00:00:00.000Z',
      },
    });

    const res = await request(createApp({ repositories }))
      .get('/api/v1/reports/reconciliation')
      .query({ organizationId: 'org-1' })
      .set('Authorization', `Bearer ${token(readPolicy)}`);

    expect(res.status).toBe(200);
    expect((res.body.jobs as Array<{ id: string }>).map((j) => j.id)).toEqual(['job-1']);
  });
});
