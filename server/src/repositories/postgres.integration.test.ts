import { randomUUID } from 'node:crypto';
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

    /*
      ★ THE DATABASE IS EMPTIED BETWEEN RUNS, SO IT MUST BE A DISPOSABLE ONE.

      These tests assert on exact ids and counts, and for as long as they only
      ever skipped, nobody noticed that they inserted FIXED ids into a persistent
      database: the second run collided on the first one's rows and the suite
      could only ever pass once. A test that can only run once is a test that is
      not running.

      Resetting the schema is what makes it repeatable, and dropping `public` is
      only acceptable if this really is a scratch database — so the name is
      checked first, and a database called `amber` is refused rather than wiped.
    */
    const identity = await pool.query<{ name: string }>('SELECT current_database() AS name');
    const name = identity.rows[0]?.name ?? '';
    if (!/(^|_)test($|_)/i.test(name)) {
      throw new Error(
        `Refusing to run: this suite resets its database, and "${name}" is not named as disposable. ` +
          'Point DATABASE_URL at a scratch database such as `amber_test`.',
      );
    }

    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await runMigrations(pool);
    repos = createPostgresRepositories(pool);
    // Reset + a full migration run is well over jest's 5s default when the whole
    // suite is competing for CPU; the standalone run just happened to fit.
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('runMigrations applies the schema and is idempotent', async () => {
    await expect(runMigrations(pool)).resolves.toBeInstanceOf(Array);
  });

  it('scopes events/failures/connectors/reconciliation by organization (C1)', async () => {
    // UUIDs because these ids really are `uuid` columns in the schema — text
    // literals were rejected by Postgres outright, which is one reason this test
    // had never actually executed.
    const evtOrg1 = randomUUID();
    const evtOrg2 = randomUUID();
    const failOrg1 = randomUUID();
    const failOrg2 = randomUUID();
    const jobOrg1 = randomUUID();
    const jobOrg2 = randomUUID();

    await repos.events.append({
      id: evtOrg1,
      organizationId: 'org-1',
      at: '2026-01-01T00:00:00.000Z',
      type: 'collected',
      channel: 'payment',
      ref: 'ref-0001',
      detail: 'Payment collected',
    });
    await repos.events.append({
      id: evtOrg2,
      organizationId: 'org-2',
      at: '2026-01-02T00:00:00.000Z',
      type: 'collected',
      channel: 'payment',
      ref: 'ref-0002',
      detail: 'Payment collected',
    });

    const org1Events = await repos.events.list(['org-1']);
    expect(org1Events.map((e) => e.id)).toEqual([evtOrg1]);

    await repos.failures.append({
      id: failOrg1,
      organizationId: 'org-1',
      severity: 'critical',
      channel: 'webhook',
      title: 'Webhook failed',
      detail: 'Processing error',
      since: '2026-01-01T00:00:00.000Z',
    });
    await repos.failures.append({
      id: failOrg2,
      organizationId: 'org-2',
      severity: 'critical',
      channel: 'webhook',
      title: 'Webhook failed',
      detail: 'Processing error',
      since: '2026-01-02T00:00:00.000Z',
    });

    const org1Failures = await repos.failures.list(['org-1']);
    expect(org1Failures.map((f) => f.id)).toEqual([failOrg1]);

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
      id: jobOrg1,
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
      id: jobOrg2,
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
    expect(org1Jobs.map((j) => j.id)).toEqual([jobOrg1]);
  });

  it('scopes payment reads by organization and 404s cross-org (C1)', async () => {
    const payOrg1 = randomUUID();
    const payOrg2 = randomUUID();
    await repos.payments.create({
      id: payOrg1,
      invoiceId: 'inv-1',
      organizationId: 'org-1',
      transactionId: 'ref-0001',
      status: 'initiated',
      processedAt: '2026-01-01T00:00:00.000Z',
    });
    await repos.payments.create({
      id: payOrg2,
      invoiceId: 'inv-2',
      organizationId: 'org-2',
      transactionId: 'ref-0002',
      status: 'initiated',
      processedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(repos.payments.findById(payOrg1, ['org-1'])).resolves.toMatchObject({
      id: payOrg1,
    });
    await expect(repos.payments.findById(payOrg2, ['org-1'])).resolves.toBeUndefined();
  });

  it('exposes acknowledged status on failures (minor)', async () => {
    const failAck = randomUUID();
    await repos.failures.append({
      id: failAck,
      organizationId: 'org-1',
      severity: 'attention',
      channel: 'system',
      title: 'Sync warning',
      detail: 'A sync warning',
      since: '2026-01-01T00:00:00.000Z',
    });
    const acked = await repos.failures.acknowledge(failAck, '2026-01-03T00:00:00.000Z', ['org-1']);
    expect(acked?.acknowledgedAt).toBe('2026-01-03T00:00:00.000Z');
  });

  it('dedup: a claimed id is never claimable twice, and a processed one stays claimed (M2)', async () => {
    const dedup = repos.webhookDedup;

    /*
      ★ REAL TIMESTAMPS, because the lease is measured against the DATABASE clock.

      `claim` compares the stored `processed_at` to `now() - lease`, so a test
      that claims at a fixed 2026 date is ALWAYS outside a five-minute lease and
      the "second delivery" looks expired before it starts. The production caller
      passes `new Date()`, so the real thing behaves as intended; this fixture was
      the only thing disagreeing.
    */
    const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

    await expect(dedup.claim('wh-fail', at(0))).resolves.toBe(true);
    // Claimed but never marked processed -> still a duplicate on re-delivery,
    // so a retry cannot double-process it.
    await expect(dedup.claim('wh-fail', at(1000))).resolves.toBe(false);

    await expect(dedup.claim('wh-ok', at(0))).resolves.toBe(true);
    await dedup.markProcessed('wh-ok', at(2000));
    await expect(dedup.claim('wh-ok', at(3000))).resolves.toBe(false);
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

    const first = await intents.recordOutcome({
      organizationId: 'org-outcome',
      transactionId,
      outcome: 'collected',
      failureReason: null,
    });
    // A repeat that CONTRADICTS the first. Only the first may stick.
    const second = await intents.recordOutcome({
      organizationId: 'org-outcome',
      transactionId,
      outcome: 'failed',
      failureReason: 'Invalid transaction',
    });

    // ★ THE ANSWER THAT LETS THE CALLER WRITE THE EVENTS ONCE. The first
    // delivery owns the facts; the second is a duplicate of a payment already
    // settled, so it must not re-write `collected`/`webhook-received` — while
    // still being allowed to retry the accounting push.
    expect(first).toBe(true);
    expect(second).toBe(false);

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

  it('a transaction we never recorded still OWNS its facts, rather than losing them', async () => {
    /*
      ★ THE THIRD ANSWER, AND WHY `rowCount` ALONE WAS WRONG.

      "This payment was already settled" and "there is no intent row for this
      transaction" both leave the UPDATE at zero, so a caller keyed on that alone
      cannot tell them apart — and treating the second as a duplicate silently
      drops the `collected` and `webhook-received` events of a payment made
      outside our checkout. The money still arrived; the events are the only
      trace of it, so they must be written.

      Proven here rather than with a stub, because the distinction IS the query.
    */
    const intents = new PostgresCheckoutIntentStore(pool);

    await expect(
      intents.recordOutcome({
        organizationId: 'org-outcome',
        transactionId: 'TXNEVERRECORDED',
        outcome: 'collected',
        failureReason: null,
      }),
    ).resolves.toBe(true);
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