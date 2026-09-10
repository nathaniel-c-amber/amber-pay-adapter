import { Pool } from 'pg';
import { runMigrations } from '../db/migrator.js';
import { createPostgresRepositories } from './postgres.js';
import type { Repositories } from './types.js';

/**
 * Postgres persistence integration tests (M4).
 *
 * These exercise the real Postgres repositories and `runMigrations()`. They are
 * CONDITIONALLY SKIPPED when no database is configured (the test setup uses a
 * placeholder `DATABASE_URL`), so the default no-DB test run passes without
 * Docker or testcontainers. Phase 6 (Docker) will exercise them against a real
 * PostgreSQL 16 instance.
 */

// Synchronous guard: the test setup uses a placeholder URL. When a real
// DATABASE_URL is configured the suite runs against it.
const databaseUrl = process.env.DATABASE_URL ?? '';
const dbConfigured = databaseUrl.length > 0 && !databaseUrl.includes('placeholder');

// Use `describe.skip` when no DB is configured so the default no-DB run passes.
const runTests = dbConfigured ? describe : describe.skip;

runTests('Postgres repositories integration', () => {
  let pool: Pool;
  let repos: Repositories;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await runMigrations();
    repos = createPostgresRepositories(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('runMigrations applies the schema and is idempotent', async () => {
    await expect(runMigrations()).resolves.toBeInstanceOf(Array);
  });

  it('scopes events/failures/connectors/reconciliation by organization (C1)', async () => {
    await repos.events.append({
      id: 'evt-org1',
      organizationId: 'org-1',
      at: '2026-01-01T00:00:00.000Z',
      type: 'collected',
      channel: 'payment',
      ref: 'ref-0001',
      detail: 'Payment collected',
    });
    await repos.events.append({
      id: 'evt-org2',
      organizationId: 'org-2',
      at: '2026-01-02T00:00:00.000Z',
      type: 'collected',
      channel: 'payment',
      ref: 'ref-0002',
      detail: 'Payment collected',
    });

    const org1Events = await repos.events.list(['org-1']);
    expect(org1Events.map((e) => e.id)).toEqual(['evt-org1']);

    await repos.failures.append({
      id: 'fail-org1',
      organizationId: 'org-1',
      severity: 'critical',
      channel: 'webhook',
      title: 'Webhook failed',
      detail: 'Processing error',
      since: '2026-01-01T00:00:00.000Z',
    });
    await repos.failures.append({
      id: 'fail-org2',
      organizationId: 'org-2',
      severity: 'critical',
      channel: 'webhook',
      title: 'Webhook failed',
      detail: 'Processing error',
      since: '2026-01-02T00:00:00.000Z',
    });

    const org1Failures = await repos.failures.list(['org-1']);
    expect(org1Failures.map((f) => f.id)).toEqual(['fail-org1']);

    await repos.connectorStates.upsert({
      id: 'conn-org1',
      organizationId: 'org-1',
      label: 'Org 1',
      terminus: 'quickbooks',
      status: 'open',
      reading: 'Operational',
      note: 'org-1',
    });
    await repos.connectorStates.upsert({
      id: 'conn-org2',
      organizationId: 'org-2',
      label: 'Org 2',
      terminus: 'sage',
      status: 'open',
      reading: 'Operational',
      note: 'org-2',
    });

    const org1Connectors = await repos.connectorStates.list(['org-1']);
    expect(org1Connectors.map((c) => c.id)).toEqual(['conn-org1']);

    await repos.reconciliation.create({
      id: 'job-org1',
      organizationId: 'org-1',
      runAt: '2026-01-01T00:00:00.000Z',
      status: 'completed',
      summary: {
        status: 'completed',
        matched: 1,
        unmatched: 0,
        anomalies: 0,
        ranAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await repos.reconciliation.create({
      id: 'job-org2',
      organizationId: 'org-2',
      runAt: '2026-01-02T00:00:00.000Z',
      status: 'completed',
      summary: {
        status: 'completed',
        matched: 2,
        unmatched: 0,
        anomalies: 0,
        ranAt: '2026-01-02T00:00:00.000Z',
      },
    });

    const org1Jobs = await repos.reconciliation.list(['org-1']);
    expect(org1Jobs.map((j) => j.id)).toEqual(['job-org1']);
  });

  it('scopes payment reads by organization and 404s cross-org (C1)', async () => {
    await repos.payments.create({
      id: 'pay-org1',
      invoiceId: 'inv-1',
      organizationId: 'org-1',
      transactionId: 'ref-0001',
      status: 'initiated',
      processedAt: '2026-01-01T00:00:00.000Z',
    });
    await repos.payments.create({
      id: 'pay-org2',
      invoiceId: 'inv-2',
      organizationId: 'org-2',
      transactionId: 'ref-0002',
      status: 'initiated',
      processedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(repos.payments.findById('pay-org1', ['org-1'])).resolves.toMatchObject({
      id: 'pay-org1',
    });
    await expect(repos.payments.findById('pay-org2', ['org-1'])).resolves.toBeUndefined();
  });

  it('exposes acknowledged status on failures (minor)', async () => {
    await repos.failures.append({
      id: 'fail-ack',
      organizationId: 'org-1',
      severity: 'attention',
      channel: 'system',
      title: 'Sync warning',
      detail: 'A sync warning',
      since: '2026-01-01T00:00:00.000Z',
    });
    const acked = await repos.failures.acknowledge('fail-ack', '2026-01-03T00:00:00.000Z', [
      'org-1',
    ]);
    expect(acked?.acknowledgedAt).toBe('2026-01-03T00:00:00.000Z');
  });

  it('two-phase dedup: failed webhooks stay retryable, successful ones dedup (M2)', async () => {
    const dedup = repos.webhookDedup;
    await dedup.markProcessing('wh-fail', '2026-01-01T00:00:00.000Z');
    // Not processed yet -> retryable.
    await expect(dedup.hasProcessed('wh-fail')).resolves.toBe(false);

    await dedup.markProcessed('wh-ok', '2026-01-01T00:00:00.000Z');
    await expect(dedup.hasProcessed('wh-ok')).resolves.toBe(true);
  });
});