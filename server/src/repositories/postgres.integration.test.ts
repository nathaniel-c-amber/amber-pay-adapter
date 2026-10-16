import { Pool } from 'pg';
import { runMigrations } from '../db/migrator.js';
import { PostgresCheckoutIntentStore, createPostgresRepositories } from './postgres.js';
import {
  generateStatusToken,
  sealExpectedCharge,
  statusTokenExpiry,
} from '../services/gateway/amberPayWire.js';
import type { Repositories } from '../types/repository.js';

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

  it('dedup: a claimed id is never claimable twice, and a processed one stays claimed (M2)', async () => {
    const dedup = repos.webhookDedup;

    await expect(dedup.claim('wh-fail', '2026-01-01T00:00:00.000Z')).resolves.toBe(true);
    // Claimed but never marked processed -> still a duplicate on re-delivery,
    // so a retry cannot double-process it.
    await expect(dedup.claim('wh-fail', '2026-01-01T00:00:01.000Z')).resolves.toBe(false);

    await expect(dedup.claim('wh-ok', '2026-01-01T00:00:00.000Z')).resolves.toBe(true);
    await dedup.markProcessed('wh-ok', '2026-01-01T00:00:02.000Z');
    await expect(dedup.claim('wh-ok', '2026-01-01T00:00:03.000Z')).resolves.toBe(false);
  });

  it('recordOutcome settles a payment ONCE — a repeated callback cannot move it', async () => {
    /*
      ★ THE IDEMPOTENCY IS A DATABASE PROPERTY, SO IT IS TESTED AGAINST ONE.

      "`WHERE settled_at IS NULL` makes the write idempotent in the same
      direction the rest of the flow is: a repeated callback cannot move a
      settled payment backwards" (`repositories/postgres.ts`).

      It cannot be asserted with a stub: a stub store would agree with whatever
      the test told it to do, and the guard lives in the WHERE clause. So this
      settles a payment as `collected`, then delivers a SECOND, contradictory
      callback for the same id — exactly what the browser's arrival at the
      callback url can produce, since that arrival re-triggers processing on
      purpose — and reads the row back through the customer-facing read.

      The verdict the customer sees is what is asserted, because that is the
      value a second callback would corrupt: a page saying "declined" about a
      payment that cleared is the harm, not a stale column.
    */
    const intents = new PostgresCheckoutIntentStore(pool);
    const statusToken = generateStatusToken();
    const transactionId = 'TXSETTLE01';

    await intents.create({
      organizationId: 'org-outcome',
      transactionId,
      studentId: 'STU030',
      expectedSealed: sealExpectedCharge('250.00', 'JMD'),
      statusToken,
      statusTokenExpiresAt: statusTokenExpiry(),
    });

    // Before any callback: no verdict, and the row still reads.
    await expect(intents.findByStatusToken(statusToken)).resolves.toMatchObject({
      transactionId,
      outcome: null,
    });

    await intents.recordOutcome({
      organizationId: 'org-outcome',
      transactionId,
      outcome: 'collected',
      failureReason: null,
    });
    // A repeat that CONTRADICTS the first. Only the first may stick.
    await intents.recordOutcome({
      organizationId: 'org-outcome',
      transactionId,
      outcome: 'failed',
      failureReason: 'Invalid transaction',
    });

    const settled = await intents.findByStatusToken(statusToken);
    expect(settled).toMatchObject({
      transactionId,
      outcome: 'collected',
      // The second callback's decline text is not written either — there is no
      // partial overwrite of a settled row.
      failureReason: null,
    });

    // Another organization's callback cannot settle this one either.
    await intents.recordOutcome({
      organizationId: 'org-not-this-one',
      transactionId,
      outcome: 'failed',
      failureReason: 'Invalid transaction',
    });
    await expect(intents.findByStatusToken(statusToken)).resolves.toMatchObject({
      outcome: 'collected',
    });
  });

  it('findByStatusToken reports an EXPIRED token as no row, not as a payment', async () => {
    /*
      "an expired token is indistinguishable from one that never existed — which
      is the point, and is why it is not a filter applied after the row is read."

      The customer-facing read's contract: an expired token answers `unknown` with
      nulls, which is a waiting state, rather than naming a payment that is no
      longer reachable through that link.
    */
    const intents = new PostgresCheckoutIntentStore(pool);
    const statusToken = generateStatusToken();

    await intents.create({
      organizationId: 'org-outcome',
      transactionId: 'TXEXPIRED1',
      studentId: 'STU031',
      expectedSealed: sealExpectedCharge('99.99', 'JMD'),
      statusToken,
      // Already in the past, which is the only way to produce one in a test.
      statusTokenExpiresAt: new Date(Date.now() - 1000),
    });

    await expect(intents.findByStatusToken(statusToken)).resolves.toBeUndefined();
    // The row itself is untouched — expiry filters the READ, it does not settle
    // or delete anything, so refreshing a status page can never move a payment.
    await expect(
      intents.findByTransactionId('org-outcome', 'TXEXPIRED1'),
    ).resolves.toMatchObject({ studentId: 'STU031' });
  });
});