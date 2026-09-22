import { computeStageFlow, STAGE_THRESHOLDS, EVENT_WINDOW_LIMIT } from './stageFlow.service.js';
import type { LifecycleEvent, LifecycleEventType } from '../../models/domain.js';

/**
 * Stage-flow derivation tests.
 *
 * The invariant that matters most: an item must never be reported as healthy
 * merely because it is absent, and counts must be scoped to the window they
 * were derived from.
 */

function event(
  ref: string,
  type: LifecycleEventType,
  at: string,
  id = `${ref}-${type}`,
): LifecycleEvent {
  return {
    id,
    organizationId: 'org-1',
    at,
    type,
    channel: 'payment',
    ref,
    detail: 'operational detail',
  };
}

describe('computeStageFlow', () => {
  const now = new Date('2026-09-21T15:00:00.000Z');

  it('returns four stages in causal order', () => {
    const summary = computeStageFlow([], now);
    expect(summary.stages.map((s) => s.stage)).toEqual([
      'initiated',
      'collected',
      'ingested',
      'posted',
    ]);
  });

  it('tracks a fully completed item through to posted', () => {
    const summary = computeStageFlow(
      [
        event('r1', 'record-updated', '2026-09-21T14:50:03.000Z'),
        event('r1', 'webhook-received', '2026-09-21T14:50:02.000Z'),
        event('r1', 'collected', '2026-09-21T14:50:01.000Z'),
        event('r1', 'initiated', '2026-09-21T14:50:00.000Z'),
      ],
      now,
    );

    expect(summary.trackedRefs).toBe(1);
    for (const stage of summary.stages) {
      expect(stage.entered).toBe(1);
      expect(stage.inFlight).toBe(0);
      expect(stage.failed).toBe(0);
      expect(stage.notReporting).toBe(false);
      expect(stage.state).toBe('healthy');
    }
    // Every non-terminal stage measured a clean 1s hand-off.
    for (const stage of summary.stages.slice(0, 3)) {
      expect(stage.dwellP95Ms).toBe(1000);
      expect(stage.sampleSize).toBe(1);
    }
    // The final stage has nothing after it to measure dwell against, so it has
    // no dwell observations at all — and a completed item is finished, not waiting.
    expect(summary.stages[3]!.dwellP95Ms).toBeNull();
    expect(summary.stages[3]!.sampleSize).toBe(0);
    expect(summary.stages[3]!.completed).toBe(1);
    expect(summary.oldestInFlightAt).toBeNull();
  });

  it('reports a stalled item as in flight at the stage it reached', () => {
    const summary = computeStageFlow(
      [
        event('stuck', 'webhook-received', '2026-09-21T14:47:19.000Z'),
        event('stuck', 'collected', '2026-09-21T14:47:10.000Z'),
        event('stuck', 'initiated', '2026-09-21T14:47:00.000Z'),
      ],
      now,
    );

    const ingested = summary.stages.find((s) => s.stage === 'ingested')!;
    expect(ingested.entered).toBe(1);
    expect(ingested.inFlight).toBe(1);
    expect(ingested.oldestInFlightAt).toBe('2026-09-21T14:47:19.000Z');
    // 13 minutes waiting against a 60s warn / 600s fail target.
    expect(ingested.state).toBe('failed');

    const posted = summary.stages.find((s) => s.stage === 'posted')!;
    expect(posted.entered).toBe(0);
    expect(posted.notReporting).toBe(true);
    expect(posted.completed).toBe(0);
    expect(summary.oldestInFlightAt).toBe('2026-09-21T14:47:19.000Z');
  });

  it('never counts a completed terminal item as waiting', () => {
    const summary = computeStageFlow(
      [
        event('done', 'record-updated', '2026-09-21T14:59:04.000Z'),
        event('done', 'webhook-received', '2026-09-21T14:59:01.000Z'),
        event('done', 'collected', '2026-09-21T14:59:00.500Z'),
        event('done', 'initiated', '2026-09-21T14:59:00.000Z'),
      ],
      now,
    );
    const totalInFlight = summary.stages.reduce((n, s) => n + s.inFlight, 0);
    // A fully healthy payment must not register as backlog anywhere.
    expect(totalInFlight).toBe(0);
    expect(summary.oldestInFlightAt).toBeNull();
  });

  it('marks a stage nobody reached as not-reporting, never healthy', () => {
    const summary = computeStageFlow(
      [event('r1', 'initiated', '2026-09-21T14:59:00.000Z')],
      now,
    );
    const collected = summary.stages.find((s) => s.stage === 'collected')!;
    expect(collected.notReporting).toBe(true);
    expect(collected.state).toBe('not-reporting');
    expect(collected.state).not.toBe('healthy');
  });

  it('degrades a stage whose p95 dwell exceeds its warn target', () => {
    // 90s per item to leave `initiated`; warn is 30s, fail is 300s.
    const events: LifecycleEvent[] = [];
    for (let i = 0; i < 10; i += 1) {
      const base = new Date(Date.UTC(2026, 8, 21, 14, 0, i * 6));
      const next = new Date(base.getTime() + 90_000);
      events.push(event(`r${i}`, 'initiated', base.toISOString()));
      events.push(event(`r${i}`, 'collected', next.toISOString()));
    }
    const summary = computeStageFlow(events, now);
    const initiated = summary.stages.find((s) => s.stage === 'initiated')!;
    expect(initiated.dwellP95Ms).toBe(90_000);
    expect(initiated.state).toBe('degraded');
    expect(initiated.thresholds).toEqual(STAGE_THRESHOLDS.initiated);
  });

  it('counts a declined payment as a failure at its furthest stage', () => {
    const summary = computeStageFlow(
      [
        event('r1', 'payment-declined', '2026-09-21T14:49:00.000Z'),
        event('r1', 'initiated', '2026-09-21T14:48:00.000Z'),
      ],
      now,
    );
    const initiated = summary.stages.find((s) => s.stage === 'initiated')!;
    expect(initiated.failed).toBe(1);
    // A halted item is counted as failed, not as waiting: the two are different
    // states and double-counting them would inflate the blast radius.
    expect(initiated.inFlight).toBe(0);
    expect(initiated.state).toBe('failed');
    expect(summary.failedRefs).toBe(1);
  });

  it('keeps the earliest sighting when a stage is re-emitted (retry)', () => {
    const summary = computeStageFlow(
      [
        event('r1', 'initiated', '2026-09-21T14:58:00.000Z', 'dup'),
        event('r1', 'initiated', '2026-09-21T14:00:00.000Z', 'orig'),
        event('r1', 'collected', '2026-09-21T14:00:30.000Z'),
      ],
      now,
    );
    const initiated = summary.stages.find((s) => s.stage === 'initiated')!;
    expect(initiated.dwellP95Ms).toBe(30_000);
  });

  it('ignores events that carry no stage', () => {
    const summary = computeStageFlow(
      [event('r1', 'sync-change', '2026-09-21T14:00:00.000Z')],
      now,
    );
    expect(summary.trackedRefs).toBe(0);
    expect(summary.stages.every((s) => s.notReporting)).toBe(true);
  });

  it('flags a full event window as possibly truncated', () => {
    const events: LifecycleEvent[] = Array.from({ length: EVENT_WINDOW_LIMIT }, (_, i) =>
      event(`r${i}`, 'initiated', '2026-09-21T14:00:00.000Z'),
    );
    const summary = computeStageFlow(events, now);
    expect(summary.mayBeTruncated).toBe(true);
    expect(summary.eventsConsidered).toBe(EVENT_WINDOW_LIMIT);

    const small = computeStageFlow(events.slice(0, 5), now);
    expect(small.mayBeTruncated).toBe(false);
  });

  it('is deterministic for the same input', () => {
    const input = [event('r1', 'initiated', '2026-09-21T14:00:00.000Z')];
    expect(computeStageFlow(input, now)).toEqual(computeStageFlow(input, now));
  });
});
