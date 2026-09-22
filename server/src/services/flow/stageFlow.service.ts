import type {
  FlowStage,
  LifecycleEvent,
  LifecycleEventType,
  StageFlow,
  StageFlowSummary,
  StageThresholds,
} from '../../models/domain.js';

/**
 * Stage-flow derivation.
 *
 * REFRAMES THE MONITORING MODEL. The console's original unit was the
 * "connector" — is this SaaS integration up? That question has no stable
 * denominator (one of the four connectors was the console's own log sink) and
 * it does not answer the operator's real question, which is a FLOW question:
 * where are payments sitting, and is that normal?
 *
 * A payment moves through four stages, and those stages are already present in
 * the domain's own event vocabulary — no new instrumentation is required:
 *
 *   initiated        -> payment initiated at the gateway
 *   collected        -> funds collected
 *   ingested         -> webhook received and accepted by the pipeline
 *   posted           -> record written to the accounting adaptor
 *
 * (`sync-change` is a scheduled cadence, not a stage; it belongs to the pull.)
 *
 * CORRELATION. Every `LifecycleEvent` carries `ref`, a reference hash for the
 * related entity. Grouping events by `ref` and taking the furthest stage each
 * ref reached yields, per stage:
 *
 *   entered     refs that reached this stage
 *   inFlight    refs WAITING at this stage to advance (not the terminal stage)
 *   exited      refs that advanced past this stage
 *   completed   refs that finished at the terminal stage
 *   oldestInFlightAt  when the longest-waiting in-flight item entered
 *   dwellP95Ms  p95 of the time from entering this stage to entering the next
 *
 * "In flight" deliberately excludes the terminal stage: a posted payment has
 * finished, and counting it as waiting would show a permanent backlog on a
 * perfectly healthy system.
 *
 * IN-FLIGHT IS THE HONEST PROXY FOR QUEUE DEPTH. The domain model has no
 * broker/backlog field, so "how many items are waiting where" is derived
 * rather than measured. It is only trustworthy over a bounded window: the
 * event list is capped at 500 rows, so a ref whose later event falls outside
 * that window looks stalled when it is not. `mayBeTruncated` carries that
 * caveat to the UI, which is required to label the counts as sampled rather
 * than presenting them as authoritative.
 */

/** Event type -> the stage it advances an item to. */
const STAGE_OF_EVENT: Partial<Record<LifecycleEventType, FlowStage>> = {
  initiated: 'initiated',
  collected: 'collected',
  'webhook-received': 'ingested',
  'record-updated': 'posted',
};

/**
 * Terminal failure event types. A ref carrying one of these at a stage has
 * stopped advancing and will never reach a later stage.
 */
const FAILURE_EVENTS: LifecycleEventType[] = ['payment-declined', 'payment-failed'];

export const STAGE_SEQUENCE: readonly FlowStage[] = [
  'initiated',
  'collected',
  'ingested',
  'posted',
];

/**
 * Stage targets, defined ONCE and returned with the summary so the UI quotes
 * the same numbers the backend judged against instead of inventing its own.
 *
 * `dwell` is the time to LEAVE the stage (enter the next one). The `posted`
 * target is 5s because FR-2.x requires a completed payment event to reach the
 * active accounting adaptor within 5 seconds.
 */
export const STAGE_THRESHOLDS: Record<FlowStage, StageThresholds> = {
  initiated: { warnMs: 30_000, failMs: 300_000 },
  collected: { warnMs: 60_000, failMs: 600_000 },
  ingested: { warnMs: 60_000, failMs: 600_000 },
  posted: { warnMs: 5_000, failMs: 30_000 },
};

/** The event list is capped at 500 rows; at or above that, treat counts as sampled. */
export const EVENT_WINDOW_LIMIT = 500;

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function earliest(a: string | null, b: string): string {
  if (a === null) return b;
  return new Date(b).getTime() < new Date(a).getTime() ? b : a;
}

interface RefTrail {
  /** Stage index reached, or -1 if no stage-bearing event was seen. */
  furthest: number;
  /** Timestamp at which the ref entered each stage. */
  enteredAt: Partial<Record<FlowStage, string>>;
  failed: boolean;
}

/**
 * Build the stage-flow summary from a list of lifecycle events.
 *
 * Pure and synchronous: same input, same output, no clock access beyond the
 * supplied `now` (so it is deterministic under test).
 */
export function computeStageFlow(
  events: LifecycleEvent[],
  now: Date = new Date(),
): StageFlowSummary {
  const trails = new Map<string, RefTrail>();

  for (const event of events) {
    const failure = FAILURE_EVENTS.includes(event.type);
    const stage = STAGE_OF_EVENT[event.type];
    if (!stage && !failure) continue;

    const trail: RefTrail = trails.get(event.ref) ?? {
      furthest: -1,
      enteredAt: {},
      failed: false,
    };

    if (failure) {
      trail.failed = true;
    } else if (stage) {
      const index = STAGE_SEQUENCE.indexOf(stage);
      // Keep the earliest sighting of each stage, and advance `furthest` only
      // forwards: events arrive newest-first and a retry can re-emit an
      // earlier stage.
      const seen = trail.enteredAt[stage];
      if (seen === undefined || new Date(event.at).getTime() < new Date(seen).getTime()) {
        trail.enteredAt[stage] = event.at;
      }
      if (index > trail.furthest) trail.furthest = index;
    }

    trails.set(event.ref, trail);
  }

  const tracked = [...trails.values()].filter((t) => t.furthest >= 0);

  const stages: StageFlow[] = STAGE_SEQUENCE.map((stage, index) => {
    const isTerminal = index === STAGE_SEQUENCE.length - 1;
    let entered = 0;
    let inFlight = 0;
    let exited = 0;
    let completed = 0;
    let oldestInFlightAt: string | null = null;
    let failedHere = 0;
    const dwells: number[] = [];

    for (const trail of tracked) {
      const enteredStage = trail.enteredAt[stage];
      if (enteredStage !== undefined) entered += 1;

      const isFurthest = trail.furthest === index;
      if (isFurthest && trail.failed) failedHere += 1;

      // Waiting = reached this stage, not failed, and not yet at the next one.
      // The terminal stage never holds waiting items: a posted payment is done.
      if (isFurthest && !trail.failed && !isTerminal) {
        inFlight += 1;
        if (enteredStage !== undefined) oldestInFlightAt = earliest(oldestInFlightAt, enteredStage);
      }

      // Finished = reached the terminal stage and did not fail on the way.
      if (isFurthest && isTerminal && !trail.failed) completed += 1;

      if (trail.furthest > index) exited += 1;

      // Dwell: time from entering this stage to entering the next one.
      const nextStage = STAGE_SEQUENCE[index + 1];
      if (nextStage) {
        const left = trail.enteredAt[nextStage];
        if (enteredStage !== undefined && left !== undefined) {
          const ms = new Date(left).getTime() - new Date(enteredStage).getTime();
          if (Number.isFinite(ms) && ms >= 0) dwells.push(ms);
        }
      }
    }

    // A stage nobody reached is "not reporting" rather than "healthy": with
    // several independent paths, silence and success must not look alike.
    const notReporting = entered === 0;

    const dwellP95Ms = percentile(dwells, 0.95);
    const thresholds = STAGE_THRESHOLDS[stage];

    let state: StageFlow['state'] = 'healthy';
    if (notReporting) {
      state = 'not-reporting';
    } else if (failedHere > 0) {
      state = 'failed';
    } else if (dwellP95Ms !== null && dwellP95Ms > thresholds.failMs) {
      state = 'failed';
    } else if (dwellP95Ms !== null && dwellP95Ms > thresholds.warnMs) {
      state = 'degraded';
    } else if (inFlight > 0) {
      // Items waiting with no measured dwell yet: scale the wait against the
      // stage's own target rather than declaring health from absence of data.
      const oldest = oldestInFlightAt ? new Date(oldestInFlightAt).getTime() : null;
      const waited = oldest === null ? 0 : now.getTime() - oldest;
      state =
        waited > thresholds.failMs ? 'failed' : waited > thresholds.warnMs ? 'degraded' : 'healthy';
    }

    return {
      stage,
      state,
      entered,
      inFlight,
      exited,
      completed,
      failed: failedHere,
      oldestInFlightAt,
      dwellP95Ms,
      sampleSize: dwells.length,
      thresholds,
      notReporting,
    };
  });

  const trailsWithFailure = tracked.filter((t) => t.failed).length;
  const candidates = stages
    .map((s) => s.oldestInFlightAt)
    .filter((v): v is string => v !== null);
  const oldestInFlightAt =
    candidates.length === 0
      ? null
      : candidates.reduce((min, v) => (new Date(v).getTime() < new Date(min).getTime() ? v : min));

  return {
    stages,
    trackedRefs: tracked.length,
    oldestInFlightAt,
    failedRefs: trailsWithFailure,
    window: {
      from: events.length > 0 ? events[events.length - 1]!.at : null,
      to: events.length > 0 ? events[0]!.at : null,
    },
    eventsConsidered: events.length,
    mayBeTruncated: events.length >= EVENT_WINDOW_LIMIT,
    computedAt: now.toISOString(),
  };
}
