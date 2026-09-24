import { AdaptorEventRecorder } from './adaptorEventRecorder.service.js';
import { EventLog } from './eventLog.service.js';
import { FailureTracker } from './failureTracker.service.js';
import type { AdaptorOutcome } from './adaptorEventRecorder.service.js';
import type { EventLog as EventLogService } from './eventLog.service.js';

/**
 * The recorder's whole contract is "record the CHANGE, not the reading". The
 * console polls the service endpoint every 10 seconds, so a recorder that
 * logged every probe would append thousands of identical rows an hour and
 * crowd out the event window the flow aggregate is derived from.
 */

function harness() {
  const eventLog = new EventLog();
  const failureTracker = new FailureTracker();
  const recorder = new AdaptorEventRecorder(eventLog, failureTracker, 'org-1');
  return { eventLog, failureTracker, recorder };
}

function outcome(overrides: Partial<AdaptorOutcome> = {}): AdaptorOutcome {
  return {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    reachable: false,
    reason: 'auth',
    message: 'QuickBooks answered 401: AuthenticationFailed',
    ...overrides,
  };
}

describe('AdaptorEventRecorder', () => {
  it('records a rejected-token probe as an auth event and a critical finding', async () => {
    const { eventLog, failureTracker, recorder } = harness();

    await recorder.recordOutcomes([outcome()]);

    const events = await eventLog.list(['org-1']);
    expect(events.map((e) => e.type)).toEqual(['adaptor-auth-failed']);
    expect(events[0]?.channel).toBe('accounting');
    expect(events[0]?.ref).toBe('quickbooks');
    expect(events[0]?.detail).toContain('401');

    const failures = await failureTracker.list(['org-1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severity).toBe('critical');
    expect(failures[0]?.title).toContain('credentials');
  });

  it('records an unreachable adaptor as its own event type', async () => {
    const { eventLog, recorder } = harness();
    await recorder.recordOutcomes([outcome({ reason: 'unreachable', message: 'fetch failed' })]);

    const events = await eventLog.list(['org-1']);
    expect(events.map((e) => e.type)).toEqual(['adaptor-unreachable']);
  });

  it('does NOT record while the state is unchanged (the poll-flood guard)', async () => {
    const { eventLog, failureTracker, recorder } = harness();

    await recorder.recordOutcomes([outcome()]);
    await recorder.recordOutcomes([outcome()]);
    await recorder.recordOutcomes([outcome({ message: 'QuickBooks answered 401' })]);

    expect(await eventLog.list(['org-1'])).toHaveLength(1);
    expect(await failureTracker.list(['org-1'])).toHaveLength(1);
  });

  it('records a new event when the failure reason CHANGES', async () => {
    const { eventLog, recorder } = harness();

    await recorder.recordOutcomes([outcome()]);
    await recorder.recordOutcomes([outcome({ reason: 'unreachable', message: 'fetch failed' })]);

    // Sorted: `list` returns newest-first by timestamp, and two events written
    // in the same millisecond keep insertion order instead — so a strict array
    // assertion here would be a race, not a test.
    expect((await eventLog.list(['org-1'])).map((e) => e.type).sort()).toEqual([
      'adaptor-auth-failed',
      'adaptor-unreachable',
    ]);
  });

  it('records a recovery after a failure, and no new finding', async () => {
    const { eventLog, failureTracker, recorder } = harness();

    await recorder.recordOutcomes([outcome()]);
    await recorder.recordOutcomes([outcome({ reachable: true })]);

    expect((await eventLog.list(['org-1'])).map((e) => e.type).sort()).toEqual([
      'adaptor-auth-failed',
      'adaptor-restored',
    ]);
    // The finding stays open: acknowledging it is the operator's call, and the
    // restored event is what says the incident is over.
    expect(await failureTracker.list(['org-1'])).toHaveLength(1);
  });

  it('records nothing for an adaptor that was healthy from the first look', async () => {
    const { eventLog, failureTracker, recorder } = harness();

    await recorder.recordOutcomes([outcome({ reachable: true })]);
    await recorder.recordOutcomes([outcome({ reachable: true })]);

    expect(await eventLog.list(['org-1'])).toHaveLength(0);
    expect(await failureTracker.list(['org-1'])).toHaveLength(0);
  });

  it('files a rate limit as a warning, not a critical alarm', async () => {
    const { failureTracker, recorder } = harness();

    await recorder.recordOutcomes([outcome({ reason: 'rate-limited', message: '429' })]);

    const failures = await failureTracker.list(['org-1']);
    expect(failures[0]?.severity).toBe('attention');
  });

  it('never throws when the event write fails', async () => {
    const failingLog = {
      recordEvent: jest.fn().mockRejectedValue(new Error('database is down')),
    } as unknown as EventLogService;
    const failureTracker = new FailureTracker();
    const recorder = new AdaptorEventRecorder(failingLog, failureTracker, 'org-1');

    // The probe that calls this feeds the console: a monitoring write must not
    // be able to take the monitored process down.
    await expect(recorder.recordOutcomes([outcome()])).resolves.toBeUndefined();
  });

  it('keeps an adaptor id-keyed history, so two adaptors do not mask each other', async () => {
    const { eventLog, failureTracker, recorder } = harness();

    await recorder.recordOutcomes([outcome()]);
    await recorder.recordOutcomes([
      outcome({ id: 'sage', name: 'Sage', reason: 'auth', message: 'Sage credentials are not configured' }),
    ]);

    expect(await failureTracker.list(['org-1'])).toHaveLength(2);
    expect((await eventLog.list(['org-1'])).map((e) => e.ref).sort()).toEqual([
      'quickbooks',
      'sage',
    ]);
  });
});
