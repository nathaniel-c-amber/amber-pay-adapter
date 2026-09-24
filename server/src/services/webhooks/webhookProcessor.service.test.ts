import { WebhookProcessor } from './webhookProcessor.service.js';
import { EventLog } from '../events/eventLog.service.js';
import { FailureTracker } from '../events/failureTracker.service.js';
import { QuickBooksAdaptor } from '../adaptors/quickbooks.service.js';
import { env } from '../../config/env.js';
import type { WebhookEvent } from '../../types/gateway.js';
import type { AccountingAdaptor } from '../../types/adaptor.js';

const collectedEvent: WebhookEvent = {
  id: 'w1',
  type: 'payment.collected',
  reference: 'ref-0001',
  status: 'collected',
  at: '2026-01-01T00:00:00.000Z',
};

function makeAdaptor(overrides?: Partial<AccountingAdaptor>): AccountingAdaptor {
  return {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockResolvedValue('disconnected'),
    pushCompletedPayment: jest
      .fn()
      .mockResolvedValue({ externalRef: 'ref-0001', at: '2026-01-01T00:00:00.000Z' }),
    pullSyncStatus: jest.fn(),
    healthCheck: jest.fn(),
    ...overrides,
  };
}

describe('the push target is configured, not assumed', () => {
  it('resolves which accounting system to push to instead of defaulting to QuickBooks', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const resolver = { get: jest.fn().mockReturnValue(makeAdaptor()) };
    // No adaptor id passed: the processor must ask configuration.
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);

    // A Sage deployment used to push its completed payments to QuickBooks,
    // because the class defaulted to the literal 'quickbooks'.
    expect(resolver.get).toHaveBeenCalledWith(env.ADAPTOR_ID);
  });

  it('still honours an explicitly supplied adaptor id (the test seam)', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const resolver = { get: jest.fn().mockReturnValue(makeAdaptor()) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver, 5000, 'sage');

    await processor.processWebhook(collectedEvent);

    expect(resolver.get).toHaveBeenCalledWith('sage');
  });

  it('files the singleton\'s records under the configured organization, not a literal', async () => {
    /*
      The bug this pins was silent: the singleton passed the literal 'org-1' as
      its organization, which OVERRODE the configured default (an explicit
      argument beats a default parameter). Every row it wrote was then invisible
      to the organization that owned it — no error anywhere, just a console that
      read empty for everyone except a wildcard super admin.
    */
    const original = process.env.ORGANIZATION_ID;
    process.env.ORGANIZATION_ID = 'org-check';
    try {
      // A fresh module registry, so the configuration is parsed again with the
      // value above and the singleton is constructed against it.
      jest.resetModules();
      const fresh = await import('./webhookProcessor.service.js');
      const scope = (fresh.webhookProcessor as unknown as { organizationId: string })
        .organizationId;

      expect(scope).toBe('org-check');
    } finally {
      process.env.ORGANIZATION_ID = original;
    }
  });
});

describe('WebhookProcessor', () => {
  it('records a collected event and pushes to the adaptor', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);

    const events = await eventLog.list(['org-1']);
    // The complete pipeline trail for one collection: the money moved, the
    // notification was ingested, and the record reached the accounting system.
    // Compared sorted: `list` orders newest-first by timestamp, and two events
    // written inside the same millisecond keep insertion order instead.
    expect(events.map((e) => e.type).sort()).toEqual([
      'collected',
      'record-updated',
      'webhook-received',
    ]);
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(1);
    expect(await failureTracker.list(['org-1'])).toHaveLength(0);
  });

  it('connects the adaptor before pushing (real adaptor)', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const adaptor = new QuickBooksAdaptor(transport);
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);

    expect(await adaptor.status()).toBe('connected');
    expect(transport).toHaveBeenCalled();
    expect(await failureTracker.list(['org-1'])).toHaveLength(0);
  });

  it('uses the configured active adaptor id', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor({ id: 'sage', name: 'Sage' });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver, 5000, 'sage');

    await processor.processWebhook(collectedEvent);

    expect(resolver.get).toHaveBeenCalledWith('sage');
  });

  it('ignores duplicate webhook ids', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);
    await processor.processWebhook(collectedEvent);

    expect(await eventLog.list(['org-1'])).toHaveLength(3);
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(1);
  });

  it('does NOT dedup a failed webhook — a retry reprocesses it (M2)', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor({
      pushCompletedPayment: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver);

    // First delivery fails (adaptor push throws).
    await processor.processWebhook(collectedEvent);
    expect(await failureTracker.list(['org-1'])).toHaveLength(1);

    // Retry must reprocess (not be deduped): the failure is recorded again.
    await processor.processWebhook(collectedEvent);
    expect(await failureTracker.list(['org-1'])).toHaveLength(2);
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(2);
  });

  it('rejects a CONCURRENT duplicate — the second delivery never reaches the adaptor', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    let releasePush!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    const adaptor = makeAdaptor({
      pushCompletedPayment: jest.fn().mockImplementation(async () => {
        // Hold the first delivery inside the push so the second arrives while
        // the first is still in flight — the window the old
        // hasProcessed-then-markProcessing pair could not close.
        await gate;
        return { externalRef: 'ref-0001', at: '2026-01-01T00:00:00.000Z' };
      }),
    });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver);

    const first = processor.processWebhook(collectedEvent);
    const second = processor.processWebhook(collectedEvent);
    releasePush();
    await Promise.all([first, second]);

    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(1);
    expect(await eventLog.list(['org-1'])).toHaveLength(3);
    expect(await failureTracker.list(['org-1'])).toHaveLength(0);
  });

  it('pushes a refund with the refunded status and logs its own event type', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook({
      ...collectedEvent,
      id: 'w-refund',
      type: 'payment.refunded',
      status: 'refunded',
    });

    const events = await eventLog.list(['org-1']);
    expect(events.map((e) => e.type).sort()).toEqual(['payment-refunded', 'record-updated']);
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'refunded' }),
    );
  });

  it('dedups a successful webhook on a later retry (M2)', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);
    await processor.processWebhook(collectedEvent);

    expect(await eventLog.list(['org-1'])).toHaveLength(3);
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(1);
  });

  it('records a critical failure when the adaptor push fails, without throwing', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor({
      pushCompletedPayment: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver);

    await expect(processor.processWebhook(collectedEvent)).resolves.toBeUndefined();

    const failures = await failureTracker.list(['org-1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severity).toBe('critical');
  });

  it('records a critical failure when the adaptor push times out', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor({
      pushCompletedPayment: jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { externalRef: 'ref-0001', at: '2026-01-01T00:00:00.000Z' };
      }),
    });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver, 5);

    await processor.processWebhook(collectedEvent);

    const failures = await failureTracker.list(['org-1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severity).toBe('critical');
  });

  it('records a declined lifecycle event and a failure for declined payments', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const processor = new WebhookProcessor(eventLog, failureTracker, { get: jest.fn() });

    await processor.processWebhook({
      ...collectedEvent,
      type: 'payment.declined',
      status: 'failed',
    });

    const events = await eventLog.list(['org-1']);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('payment-declined');
    expect(await failureTracker.list(['org-1'])).toHaveLength(1);
  });

  it('records a payment-failed lifecycle event for failed payments', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const processor = new WebhookProcessor(eventLog, failureTracker, { get: jest.fn() });

    await processor.processWebhook({
      ...collectedEvent,
      type: 'payment.failed',
      status: 'failed',
    });

    const events = await eventLog.list(['org-1']);
    expect(events[0]?.type).toBe('payment-failed');
  });
});
