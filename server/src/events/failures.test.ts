import { FailureTracker } from './failures.js';
import { NotFoundError } from '../lib/errors.js';

describe('FailureTracker', () => {
  it('recordFailure stores a failure and list returns it', async () => {
    const tracker = new FailureTracker();
    const failure = await tracker.recordFailure({
      severity: 'critical',
      channel: 'accounting',
      title: 'Push failed',
      detail: 'Could not push to QuickBooks',
    });

    expect(tracker.list()).toHaveLength(1);
    expect(tracker.list()[0]).toEqual(failure);
    expect(failure.severity).toBe('critical');
  });

  it('recordFailure sanitizes sensitive title/detail', async () => {
    const tracker = new FailureTracker();
    const failure = await tracker.recordFailure({
      severity: 'critical',
      channel: 'accounting',
      title: 'Card 4111 1111 1111 1111 failed',
      detail: 'Amount $1,234.56 for customer@example.com',
    });

    expect(failure.title).not.toContain('4111');
    expect(failure.detail).not.toContain('$');
    expect(failure.detail).not.toContain('@');
    expect(failure.detail).toContain('[REDACTED]');
  });

  it('acknowledge returns the failure', async () => {
    const tracker = new FailureTracker();
    const failure = await tracker.recordFailure({
      severity: 'critical',
      channel: 'payment',
      title: 'Declined',
      detail: 'Payment declined',
    });

    const acked = await tracker.acknowledge(failure.id);
    expect(acked.id).toBe(failure.id);
  });

  it('acknowledge throws NotFoundError for an unknown id', async () => {
    const tracker = new FailureTracker();
    await expect(tracker.acknowledge('unknown')).rejects.toThrow(NotFoundError);
  });
});
