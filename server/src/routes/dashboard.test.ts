import request from 'supertest';
import { createApp } from '../app.js';
import { createInMemoryRepositories } from '../repositories/inMemory.js';
import { issueAccessToken } from '../utils/tokens.js';
import { forbiddenKeysIn } from '../test/privacy.js';
import type { PolicyAttribute } from '../types/auth.js';
import type { ConnectorState, Failure, LifecycleEvent, PolicyScope } from '../models/domain.js';

const readPolicy: PolicyAttribute[] = [
  { scope: 'dashboard', organizationId: 'org-1', actions: ['read'] },
];

function token(policy: PolicyAttribute[]): string {
  return issueAccessToken({ id: 'u1', email: 'user@example.com', policyAttributes: policy });
}

describe('dashboard routes', () => {
  it('rejects GET /dashboard/metrics without a token (401)', async () => {
    const app = createApp({ repositories: createInMemoryRepositories() });
    const res = await request(app).get('/api/v1/dashboard/metrics');
    expect(res.status).toBe(401);
  });

  it('rejects when PBAC denies the scope (403)', async () => {
    const app = createApp({ repositories: createInMemoryRepositories() });
    const res = await request(app)
      .get('/api/v1/dashboard/metrics')
      .query({ organizationId: 'org-1' })
      .set('Authorization', `Bearer ${token([{ scope: 'payments', organizationId: 'org-1', actions: ['read'] }])}`);
    expect(res.status).toBe(403);
  });

  it('returns the dashboard payload matching the domain shapes (200)', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.events.append({
      id: 'e1',
      organizationId: 'org-1',
      at: '2026-01-01T00:00:00.000Z',
      type: 'collected',
      channel: 'payment',
      ref: 'ref-0001',
      detail: 'Payment collected',
    });
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
      .get('/api/v1/dashboard/metrics')
      .query({ organizationId: 'org-1' })
      .set('Authorization', `Bearer ${token(readPolicy)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.connectors)).toBe(true);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(Array.isArray(res.body.failures)).toBe(true);
    expect(Array.isArray(res.body.policies)).toBe(true);
    expect(typeof res.body.generatedAt).toBe('string');

    // Shape matches models/domain.ts exactly.
    expect((res.body.connectors as ConnectorState[]).every((c) => typeof c.terminus === 'string')).toBe(true);
    expect((res.body.events as LifecycleEvent[])[0]?.type).toBe('collected');
    expect((res.body.failures as Failure[])[0]?.severity).toBe('critical');
    expect((res.body.policies as PolicyScope[])[0]?.readOnly).toBe(true);

    expect(forbiddenKeysIn(res.body)).toEqual([]);
  });

  it('does not leak org-2 events/failures/connectors to an org-1 caller (C1)', async () => {
    const repositories = createInMemoryRepositories();
    // org-1 data (visible)
    await repositories.events.append({
      id: 'e1',
      organizationId: 'org-1',
      at: '2026-01-01T00:00:00.000Z',
      type: 'collected',
      channel: 'payment',
      ref: 'ref-0001',
      detail: 'Payment collected',
    });
    await repositories.failures.append({
      id: 'f1',
      organizationId: 'org-1',
      severity: 'critical',
      channel: 'webhook',
      title: 'Webhook failed',
      detail: 'Processing error',
      since: '2026-01-01T00:00:00.000Z',
    });
    // org-2 data (must NOT be visible)
    await repositories.events.append({
      id: 'e2',
      organizationId: 'org-2',
      at: '2026-01-02T00:00:00.000Z',
      type: 'collected',
      channel: 'payment',
      ref: 'ref-0002',
      detail: 'Payment collected',
    });
    await repositories.failures.append({
      id: 'f2',
      organizationId: 'org-2',
      severity: 'critical',
      channel: 'webhook',
      title: 'Webhook failed',
      detail: 'Processing error',
      since: '2026-01-02T00:00:00.000Z',
    });
    await repositories.connectorStates.upsert({
      id: 'org2-connector',
      organizationId: 'org-2',
      label: 'Org 2 Connector',
      terminus: 'sage',
      status: 'open',
      reading: 'Operational',
      note: 'org-2 only',
    });

    const res = await request(createApp({ repositories }))
      .get('/api/v1/dashboard/metrics')
      .query({ organizationId: 'org-1' })
      .set('Authorization', `Bearer ${token(readPolicy)}`);

    expect(res.status).toBe(200);
    expect((res.body.events as LifecycleEvent[]).map((e) => e.id)).toEqual(['e1']);
    expect((res.body.failures as Failure[]).map((f) => f.id)).toEqual(['f1']);
    expect((res.body.connectors as ConnectorState[]).map((c) => c.id)).not.toContain(
      'org2-connector',
    );
  });
});
