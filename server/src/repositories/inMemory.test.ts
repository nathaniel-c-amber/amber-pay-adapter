import {
  createInMemoryRepositories,
  InMemoryConnectorStateRepository,
  InMemorySettingsRepository,
  InMemoryUserRepository,
} from './inMemory.js';
import type { Repositories } from '../types/repository.js';
import type { PolicyAttribute } from '../types/auth.js';

describe('InMemorySettingsRepository patch semantics', () => {
  const SEALED = Buffer.from('sealed-value');

  it('leaves absent fields alone and clears only on an explicit null', async () => {
    const settings = new InMemorySettingsRepository();
    await settings.update({ organizationName: 'Acme', gatewayWebhookSecret: SEALED });

    // Absent: untouched. This is what a form posting only its changed fields
    // depends on, and the distinction a plain `Partial` would otherwise blur.
    await settings.update({ organizationName: 'Acme Ltd' });
    const afterAbsent = await settings.get();
    expect(afterAbsent.organizationName).toBe('Acme Ltd');
    expect(afterAbsent.gatewayWebhookSecret).toEqual(SEALED);

    // Explicit undefined reads as "not mentioned", not as "clear it" —
    // spreading it would do the opposite of what the caller appears to be saying.
    await settings.update({ gatewayWebhookSecret: undefined });
    expect((await settings.get()).gatewayWebhookSecret).toEqual(SEALED);

    // Explicit null clears.
    await settings.update({ gatewayWebhookSecret: null });
    expect((await settings.get()).gatewayWebhookSecret).toBeNull();
  });

  it('hands out copies, so a caller cannot mutate stored state', async () => {
    const settings = new InMemorySettingsRepository();
    const first = await settings.get();
    first.organizationName = 'mutated by the caller';
    expect((await settings.get()).organizationName).toBeNull();
  });
});

describe('InMemoryUserRepository.markTourCompleted', () => {  const policy: PolicyAttribute[] = [
    { scope: 'dashboard', organizationId: 'org-1', actions: ['read'] },
  ];

  it('stamps once and reports whether THIS call did the writing', async () => {
    const users = new InMemoryUserRepository();
    const user = await users.create('ops@example.com', 'hash', policy);
    // A newly created account has never been offered the tour.
    expect(user.tourCompletedAt).toBeNull();

    await expect(users.markTourCompleted(user.id, '2026-01-01T00:00:00.000Z')).resolves.toBe(true);
    // The second call applies nothing, so it reports false — and crucially the
    // FIRST stamp survives, so a replay cannot rewrite when the user was toured.
    await expect(users.markTourCompleted(user.id, '2030-01-01T00:00:00.000Z')).resolves.toBe(
      false,
    );

    const stamped = await users.findById(user.id);
    expect(stamped?.tourCompletedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns false for an unknown account', async () => {
    const users = new InMemoryUserRepository();
    await expect(
      users.markTourCompleted('no-such-account', '2026-01-01T00:00:00.000Z'),
    ).resolves.toBe(false);
  });
});

describe('in-memory repositories org filtering', () => {
  let repositories: Repositories;

  beforeEach(() => {
    repositories = createInMemoryRepositories();
  });

  it('EventRepository.list(null) returns all rows; list([org]) filters', async () => {
    await repositories.events.append({
      id: 'e1',
      organizationId: 'org-1',
      at: '2026-01-01T00:00:00.000Z',
      type: 'collected',
      channel: 'payment',
      ref: 'ref-1',
      detail: 'Payment collected',
    });
    await repositories.events.append({
      id: 'e2',
      organizationId: 'org-2',
      at: '2026-01-02T00:00:00.000Z',
      type: 'collected',
      channel: 'payment',
      ref: 'ref-2',
      detail: 'Payment collected',
    });

    expect((await repositories.events.list(null)).map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    expect((await repositories.events.list(['org-1'])).map((e) => e.id)).toEqual(['e1']);
  });

  it('FailureRepository.list(null) returns all rows; list([org]) filters', async () => {
    await repositories.failures.append({
      id: 'f1',
      organizationId: 'org-1',
      severity: 'critical',
      channel: 'webhook',
      title: 'Webhook failed',
      detail: 'Processing error',
      since: '2026-01-01T00:00:00.000Z',
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

    expect((await repositories.failures.list(null)).map((f) => f.id).sort()).toEqual(['f1', 'f2']);
    expect((await repositories.failures.list(['org-1'])).map((f) => f.id)).toEqual(['f1']);
  });

  it('ConnectorStateRepository.list(null) returns all rows; list([org]) filters', async () => {
    // Use an empty-seeded repo so the default org-1 connectors don't interfere.
    const connectorStates = new InMemoryConnectorStateRepository([]);
    await connectorStates.upsert({
      id: 'c1',
      organizationId: 'org-1',
      label: 'Org 1',
      terminus: 'quickbooks',
      status: 'open',
      reading: 'Operational',
      note: 'org-1',
    });
    await connectorStates.upsert({
      id: 'c2',
      organizationId: 'org-2',
      label: 'Org 2',
      terminus: 'sage',
      status: 'open',
      reading: 'Operational',
      note: 'org-2',
    });

    expect((await connectorStates.list(null)).map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect((await connectorStates.list(['org-1'])).map((c) => c.id)).toEqual(['c1']);
  });

  it('PaymentRepository.findById with null orgs returns the payment regardless of org', async () => {
    await repositories.payments.create({
      id: 'p1',
      invoiceId: 'inv-1',
      organizationId: 'org-2',
      transactionId: 'ref-1',
      status: 'initiated',
      processedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(repositories.payments.findById('p1', null)).resolves.toMatchObject({
      id: 'p1',
    });
    await expect(repositories.payments.findById('p1', ['org-1'])).resolves.toBeUndefined();
  });
});