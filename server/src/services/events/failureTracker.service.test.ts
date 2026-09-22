import { FailureTracker } from './failureTracker.service.js';
import { NotFoundError } from '../../utils/errors.js';

describe('FailureTracker', () => {
  it('recordFailure stores a failure and list returns it', async () => {
    const tracker = new FailureTracker();
    const failure = await tracker.recordFailure({
      severity: 'critical',
      channel: 'accounting',
      title: 'Push failed',
      detail: 'Could not push to QuickBooks',
      organizationId: 'org-1',
    });

    const failures = await tracker.list(['org-1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual(failure);
    expect(failure.severity).toBe('critical');
  });

  it('recordFailure sanitizes sensitive title/detail', async () => {
    const tracker = new FailureTracker();
    const failure = await tracker.recordFailure({
      severity: 'critical',
      channel: 'accounting',
      title: 'Card 4111 1111 1111 1111 failed',
      detail: 'Amount $1,234.56 for customer@example.com',
      organizationId: 'org-1',
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
      organizationId: 'org-1',
    });

    const acked = await tracker.acknowledge(failure.id, ['org-1']);
    expect(acked.id).toBe(failure.id);
    expect(acked.acknowledgedAt).toBeDefined();
  });

  it('acknowledge throws NotFoundError for an unknown id', async () => {
    const tracker = new FailureTracker();
    await expect(tracker.acknowledge('unknown', ['org-1'])).rejects.toThrow(NotFoundError);
  });

  it('acknowledge throws NotFoundError for a failure in another org (C1)', async () => {
    const tracker = new FailureTracker();
    const failure = await tracker.recordFailure({
      severity: 'critical',
      channel: 'payment',
      title: 'Declined',
      detail: 'Payment declined',
      organizationId: 'org-2',
    });

    await expect(tracker.acknowledge(failure.id, ['org-1'])).rejects.toThrow(NotFoundError);
  });
});
