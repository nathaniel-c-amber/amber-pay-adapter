import { AdaptorRegistry } from './registry.js';
import { QuickBooksAdaptor } from './quickbooks.service.js';
import { AdaptorAuthError } from './errors.js';
import { connectConfiguredAdaptors, probeAdaptors, resetConnectAttempts } from './health.service.js';
import { AdaptorEventRecorder } from '../events/adaptorEventRecorder.service.js';
import { EventLog } from '../events/eventLog.service.js';
import { FailureTracker } from '../events/failureTracker.service.js';
import type { AccountingAdaptor, AdaptorResponse } from '../../types/adaptor.js';

/**
 * The reported defect, pinned: the Overview could show "QuickBooks answered 401"
 * while the Event log page stayed empty, because a probe observation never
 * reached the event system. These tests drive a 401 through the real probe with
 * an injected transport — no network, no module mocking — and assert both the
 * panel's answer and the log entry.
 */

let respond: () => AdaptorResponse;

function harness() {
  const registry = new AdaptorRegistry();
  registry.register('quickbooks', () => new QuickBooksAdaptor(async () => respond()));
  const eventLog = new EventLog();
  const failureTracker = new FailureTracker();
  const recorder = new AdaptorEventRecorder(eventLog, failureTracker, 'org-1');
  return { registry, eventLog, failureTracker, recorder };
}

const unauthorized: AdaptorResponse = {
  status: 401,
  body: { Fault: { Error: [{ Message: 'AuthenticationFailed' }] } },
};
const ok: AdaptorResponse = { status: 200, body: {} };

beforeEach(() => {
  resetConnectAttempts();
  respond = () => unauthorized;
});

describe('probeAdaptors', () => {
  it('files a 401 in the event log instead of only showing it on the panel', async () => {
    const { registry, eventLog, failureTracker, recorder } = harness();

    const status = await probeAdaptors(registry, recorder);

    // The panel's answer (what the Overview renders)…
    expect(status[0]?.reachable).toBe(false);
    expect(status[0]?.message).toContain('401');
    // …and the event log's, which used to be empty.
    const events = await eventLog.list(['org-1']);
    expect(events.map((e) => e.type)).toEqual(['adaptor-auth-failed']);
    expect(events[0]?.detail).toContain('401');
    expect(await failureTracker.list(['org-1'])).toHaveLength(1);
  });

  it('records each state change once, however often the console polls', async () => {
    const { registry, eventLog, failureTracker, recorder } = harness();

    await probeAdaptors(registry, recorder);
    await probeAdaptors(registry, recorder);
    await probeAdaptors(registry, recorder);

    expect(await eventLog.list(['org-1'])).toHaveLength(1);
    expect(await failureTracker.list(['org-1'])).toHaveLength(1);
  });

  it('does not re-describe a throttled retry as a different problem', async () => {
    // The connect attempt is throttled for a minute; the probes inside that
    // window must keep reporting the SAME failure, or one outage is logged as
    // an auth failure followed by an unreachability.
    const { registry, eventLog, recorder } = harness();

    await probeAdaptors(registry, recorder);
    await probeAdaptors(registry, recorder);

    expect((await eventLog.list(['org-1'])).map((e) => e.type)).toEqual(['adaptor-auth-failed']);
  });

  it('records a recovery once the upstream answers again', async () => {
    const { registry, eventLog, recorder } = harness();
    await probeAdaptors(registry, recorder);

    respond = () => ok;
    const status = await probeAdaptors(registry, recorder);

    expect(status[0]?.reachable).toBe(true);
    // Sorted: the event list is newest-first by timestamp.
    expect((await eventLog.list(['org-1'])).map((e) => e.type).sort()).toEqual([
      'adaptor-auth-failed',
      'adaptor-restored',
    ]);
  });
});

describe('connectConfiguredAdaptors', () => {
  it('files a boot-time connection failure in the event log', async () => {
    const registry = new AdaptorRegistry();
    const failing: AccountingAdaptor = {
      id: 'sage',
      name: 'Sage',
      connect: async () => {
        // The real Sage path: credentials absent is an AUTH failure, not a
        // network one, and the two need different remedies.
        throw new AdaptorAuthError('Sage credentials are not configured');
      },
      disconnect: async () => undefined,
      status: async () => 'disconnected',
      pushCompletedPayment: async () => ({ externalRef: 'x', at: new Date().toISOString() }),
      pullSyncStatus: async () => ({
        status: 'ok',
        ranAt: new Date().toISOString(),
        matched: 0,
        unmatched: 0,
        anomalies: 0,
      }),
      healthCheck: async () => ({ ok: false, latencyMs: 0, reason: 'auth' }),
    };
    registry.register('sage', () => failing);
    const eventLog = new EventLog();
    const recorder = new AdaptorEventRecorder(eventLog, new FailureTracker(), 'org-1');

    await connectConfiguredAdaptors(registry, recorder);

    const events = await eventLog.list(['org-1']);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('adaptor-auth-failed');
    expect(events[0]?.detail).toContain('not configured');
  });

  it('records a probe failure even when connect() succeeded (a token can be stale)', async () => {
    const registry = new AdaptorRegistry();
    registry.register('quickbooks', () => new QuickBooksAdaptor(async () => unauthorized));
    const eventLog = new EventLog();
    const recorder = new AdaptorEventRecorder(eventLog, new FailureTracker(), 'org-1');

    // `connect()` succeeds — a bearer token is configured — but the upstream
    // refuses it, which only the probe discovers.
    await connectConfiguredAdaptors(registry, recorder);
    await probeAdaptors(registry, recorder);

    expect((await eventLog.list(['org-1'])).map((e) => e.type)).toEqual(['adaptor-auth-failed']);
  });
});
