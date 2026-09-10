import { WebhookProcessor } from './webhookProcessor.js';
import { EventLog } from '../events/eventLog.js';
import { FailureTracker } from '../events/failures.js';
import { QuickBooksAdaptor } from '../adaptors/quickbooks.js';
import type { WebhookEvent } from '../gateway/types.js';
import type { AccountingAdaptor } from '../adaptors/types.js';

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

describe('WebhookProcessor', () => {
  it('records a collected event and pushes to the adaptor', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = new WebhookProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);

    expect(eventLog.list()).toHaveLength(1);
    expect(eventLog.list()[0]?.type).toBe('collected');
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(1);
    expect(failureTracker.list()).toHaveLength(0);
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
    expect(failureTracker.list()).toHaveLength(0);
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

    expect(eventLog.list()).toHaveLength(1);
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

    expect(failureTracker.list()).toHaveLength(1);
    expect(failureTracker.list()[0]?.severity).toBe('critical');
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

    expect(failureTracker.list()).toHaveLength(1);
    expect(failureTracker.list()[0]?.severity).toBe('critical');
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

    expect(eventLog.list()).toHaveLength(1);
    expect(eventLog.list()[0]?.type).toBe('payment-declined');
    expect(failureTracker.list()).toHaveLength(1);
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

    expect(eventLog.list()[0]?.type).toBe('payment-failed');
  });
});
