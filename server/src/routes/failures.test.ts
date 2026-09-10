import request from 'supertest';
import { createApp } from '../app.js';
import { createInMemoryRepositories } from '../repositories/inMemory.js';
import { issueAccessToken } from '../auth/tokens.js';
import type { PolicyAttribute } from '../auth/types.js';

const ackPolicy: PolicyAttribute[] = [
  { scope: 'dashboard', organizationId: 'org-1', actions: ['read', 'ack'] },
];

function token(policy: PolicyAttribute[]): string {
  return issueAccessToken({ id: 'u1', email: 'user@example.com', policyAttributes: policy });
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